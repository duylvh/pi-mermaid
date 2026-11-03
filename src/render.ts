import { existsSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";
import { render as renderSvg, type TextMeasurer } from "pele";

export type Palette = Readonly<Record<`--pele-${string}`, string>>;

/** A Pele layout with every CSS variable resolved, ready to rasterize at any scale. */
export interface Layout {
	svg: string;
	/** Width in SVG user units. */
	width: number;
}

export interface Raster {
	/** RGBA, row-major. */
	pixels: Buffer;
	widthPx: number;
	heightPx: number;
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

/** Lay Mermaid source out with the theme's colors. Throws a PeleError on invalid or unsupported source. */
export function layoutDiagram(source: string, palette: Palette): Layout {
	const { svg, width } = renderSvg(source, {
		fontFamily: MONO,
		fontFamilyMono: MONO,
		measurer: cellMeasurer,
		config: COMPACT_CONFIG,
	});
	return { svg: resolveCssVars(svg, { ...palette, ...FONT_VARS }), width };
}

/** Stroke added around glyphs, in output pixels, standing in for the stem darkening macOS gives terminal text. */
const STEM_DARKENING_PX = 0.35;

/**
 * Prepare labels for an unhinted rasterizer at a known scale. Each label's left edge and baseline go on a
 * whole output pixel, so with a whole-pixel glyph advance every stem lands on the pixel grid, and each
 * glyph is stroked in its own inherited fill so thin light-on-dark text keeps its weight.
 */
function crispText(svg: string, scale: number): string {
	type Scope = { fill: string; fontSize: number; offset: [number, number] | undefined };
	const scopes: Scope[] = [{ fill: "#000", fontSize: PELE_FONT_SIZE, offset: [0, 0] }];
	const pixel = (value: number) => Math.round(value * scale) / scale;
	return svg.replace(
		/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>([^<]*)/g,
		(tag, closing: string, name: string, attrs: string, selfClosing: string, content: string) => {
			if (closing) {
				scopes.pop();
				return tag;
			}
			const parent = scopes.at(-1)!;
			const fill = /\bfill="([^"]+)"/.exec(attrs)?.[1] ?? parent.fill;
			const fontSize = Number(/\bfont-size="([\d.]+)"/.exec(attrs)?.[1] ?? parent.fontSize);
			const transform = /\btransform="([^"]*)"/.exec(attrs)?.[1];
			const translate = transform && /^\s*translate\(\s*([\d.e+-]+)(?:[\s,]+([\d.e+-]+))?\s*\)\s*$/.exec(transform);
			const offset: Scope["offset"] = !transform
				? parent.offset
				: translate && parent.offset
					? [parent.offset[0] + Number(translate[1]), parent.offset[1] + Number(translate[2] ?? 0)]
					: undefined;
			if (!selfClosing) scopes.push({ fill, fontSize, offset });
			if (name !== "text") return tag;
			let snapped = attrs;
			if (offset) {
				const anchor = /\btext-anchor="(middle|end)"/.exec(attrs)?.[1];
				const width = visibleWidth(content) * fontSize * MONO_ADVANCE;
				const lead = anchor === "middle" ? width / 2 : anchor === "end" ? width : 0;
				snapped = attrs
					.replace(/\bx="([\d.e+-]+)"/, (_, x: string) => `x="${pixel(offset[0] + Number(x) - lead) + lead - offset[0]}"`)
					.replace(/\by="([\d.e+-]+)"/, (_, y: string) => `y="${pixel(offset[1] + Number(y)) - offset[1]}"`);
			}
			const stroke = ` stroke="${fill}" stroke-width="${STEM_DARKENING_PX / scale}" stroke-linejoin="round" paint-order="stroke"`;
			return `<text${snapped}${stroke}${selfClosing}>${content}`;
		},
	);
}

export function rasterize(layout: Layout, scale: number): Raster {
	const image = new Resvg(crispText(layout.svg, scale), { fitTo: { mode: "zoom", value: scale }, font: fontOptions }).render();
	return { pixels: Buffer.from(image.pixels), widthPx: image.width, heightPx: image.height };
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
	for (let y = 0; y < height; y++) rgba.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(scanlines)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

/** Cut the raster into PNG strips of exactly `width` x `height` pixels, cropping or padding with transparency. */
export function sliceStrips(raster: Raster, width: number, height: number): string[] {
	const sourceStride = raster.widthPx * 4;
	const stride = width * 4;
	const copyBytes = Math.min(sourceStride, stride);
	const strips: string[] = [];
	for (let top = 0; top < raster.heightPx; top += height) {
		const rgba = Buffer.alloc(height * stride);
		for (let y = 0; y < height && top + y < raster.heightPx; y++) {
			raster.pixels.copy(rgba, y * stride, (top + y) * sourceStride, (top + y) * sourceStride + copyBytes);
		}
		strips.push(encodePng(rgba, width, height).toString("base64"));
	}
	return strips;
}
