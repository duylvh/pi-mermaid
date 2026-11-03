import { existsSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";
import { render as renderSvg, type TextMeasurer } from "pele";

export type Palette = Readonly<Record<`--pele-${string}`, string>>;

export interface Raster {
	/** RGBA, row-major. */
	pixels: Buffer;
	widthPx: number;
	heightPx: number;
	/** Pele layout width, in SVG user units, before rasterization. */
	layoutWidth: number;
}

/** Pele's default font size, in SVG user units. */
export const PELE_FONT_SIZE = 16;
/** Advance width of a monospace glyph, in em. Menlo, DejaVu Sans Mono, and most terminal fonts use 0.6. */
export const MONO_ADVANCE = 0.602;

const MONO = "Menlo";
const FONT_FILES = ["/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"].filter((path) =>
	existsSync(path),
);

const fontOptions: ResvgRenderOptions["font"] =
	FONT_FILES.length > 0
		? { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: MONO, sansSerifFamily: MONO, monospaceFamily: MONO }
		: { loadSystemFonts: true, defaultFontFamily: "monospace", sansSerifFamily: "monospace" };

/** Labels are set in a monospace font and measured in terminal cells, so N characters span N cells. */
const cellMeasurer: TextMeasurer = { width: (text, size) => visibleWidth(text) * size * MONO_ADVANCE };

const COMPACT = { nodeSpacing: 20, rankSpacing: 24 };
/** Tighter than Pele's defaults to suit a terminal. A diagram's own frontmatter config still wins. */
const COMPACT_CONFIG = { flowchart: COMPACT, state: COMPACT, class: COMPACT, er: COMPACT };
const FONT_VARS = { "--pele-font": MONO, "--pele-font-mono": MONO };

/** resvg ignores CSS custom properties, so substitute every `var()` with its concrete value. */
export function resolveCssVars(svg: string, palette: Palette): string {
	const values: Record<string, string> = { ...palette };
	for (const [, name, value] of svg.matchAll(/(--[\w-]+):([^;"]+)/g)) values[name] ??= value;
	const substitute = (text: string): string => {
		let previous: string;
		do {
			previous = text;
			text = text.replace(/var\((--[\w-]+)(?:,([^()]*))?\)/g, (_, name: string, fallback?: string) => values[name] ?? fallback ?? "");
		} while (text !== previous);
		return text;
	};
	return substitute(svg);
}

/** Render Mermaid source to transparent RGBA pixels. Throws a PeleError on invalid or unsupported source. */
export function renderDiagram(source: string, palette: Palette, scale: number): Raster {
	const { svg, width } = renderSvg(source, {
		fontFamily: MONO,
		fontFamilyMono: MONO,
		measurer: cellMeasurer,
		config: COMPACT_CONFIG,
	});
	const png = new Resvg(resolveCssVars(svg, { ...palette, ...FONT_VARS }), { fitTo: { mode: "zoom", value: scale }, font: fontOptions }).render();
	return { pixels: Buffer.from(png.pixels), widthPx: png.width, heightPx: png.height, layoutWidth: width };
}

function pngChunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, crc]);
}

function encodePng(rgba: Buffer, width: number, height: number): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 6, 0, 0, 0], 8);
	const stride = width * 4;
	const scanlines = Buffer.alloc(height * (stride + 1));
	const sourceRows = Math.min(height, rgba.length / stride);
	for (let y = 0; y < sourceRows; y++) rgba.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(scanlines)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

/** Cut the raster into PNG strips of `stripHeightPx` rows, padding the last strip with transparency. */
export function sliceStrips(raster: Raster, stripHeightPx: number): string[] {
	const stride = raster.widthPx * 4;
	const strips: string[] = [];
	for (let top = 0; top < raster.heightPx; top += stripHeightPx) {
		const rgba = raster.pixels.subarray(top * stride, Math.min(raster.heightPx, top + stripHeightPx) * stride);
		strips.push(encodePng(rgba, raster.widthPx, stripHeightPx).toString("base64"));
	}
	return strips;
}
