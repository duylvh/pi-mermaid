import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

const FALLBACK_FAMILY = "Menlo";
const FONT_DIRS = [join(homedir(), "Library/Fonts"), "/Library/Fonts", "/System/Library/Fonts", "/System/Library/Fonts/Supplemental"];
const UNICODE_FALLBACK = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf";

/** The terminal's font family: PI_MERMAID_FONT, else Rex's configured terminal font, else Menlo. */
function terminalFontFamily(): string {
	if (process.env.PI_MERMAID_FONT) return process.env.PI_MERMAID_FONT;
	if (process.env.TERM_PROGRAM?.toLowerCase() === "rex") {
		try {
			const name = execFileSync("defaults", ["read", "com.superlogical.rex", "Workspace.terminalFontName"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 1000,
			}).trim();
			if (name) return name;
		} catch {}
	}
	return FALLBACK_FAMILY;
}

const squash = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Font files whose name starts with the family name, as font files conventionally are. */
function fontFilesFor(family: string): string[] {
	const prefix = squash(family);
	return FONT_DIRS.flatMap((dir) => {
		try {
			return readdirSync(dir)
				.filter((file) => /\.(ttf|otf|ttc)$/i.test(file) && squash(file).startsWith(prefix))
				.map((file) => join(dir, file));
		} catch {
			return [];
		}
	});
}

const requestedFamily = terminalFontFamily();
const requestedFiles = fontFilesFor(requestedFamily);
const MONO = requestedFiles.length > 0 ? requestedFamily : FALLBACK_FAMILY;
const FONT_FILES = [...(requestedFiles.length > 0 ? requestedFiles : fontFilesFor(FALLBACK_FAMILY)), UNICODE_FALLBACK].filter((path) =>
	existsSync(path),
);

/** Advance width of a monospace glyph, in em: Menlo's is 1233/2048, most other coding fonts use 0.6. */
export const MONO_ADVANCE = squash(MONO).startsWith("menlo") ? 1233 / 2048 : 0.6;

const fontOptions: ResvgRenderOptions["font"] =
	FONT_FILES.length > 0
		? { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: MONO, sansSerifFamily: MONO, monospaceFamily: MONO }
		: { loadSystemFonts: true, defaultFontFamily: "monospace", sansSerifFamily: "monospace" };

/** Labels are set in a monospace font and measured in terminal cells, so N characters span N cells. */
const cellMeasurer: TextMeasurer = { width: (text, size) => visibleWidth(text) * size * MONO_ADVANCE };

const NODE_SPACING = 20;
const RANK_SPACING = 24;
const ACTOR_MARGIN = 40;

/**
 * Spacing tighter than Pele's defaults to suit a terminal, widened by `spread` to use a wide pane. Only
 * the spacing across the diagram grows, so text stays its size. A diagram's frontmatter config still wins.
 */
function spacingConfig(spread: number) {
	const graph = { nodeSpacing: NODE_SPACING * spread, rankSpacing: RANK_SPACING };
	return { flowchart: graph, state: graph, class: graph, er: graph, sequence: { actorMargin: ACTOR_MARGIN * spread } };
}
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
export function layoutDiagram(source: string, palette: Palette, spread = 1): Layout {
	const { svg, width } = renderSvg(source, {
		fontFamily: MONO,
		fontFamilyMono: MONO,
		measurer: cellMeasurer,
		config: spacingConfig(spread),
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

/** The raster as a PNG of exactly `width` x `height` pixels, cropped or padded with transparency. */
export function encodeCanvas(raster: Raster, width: number, height: number): string {
	const sourceStride = raster.widthPx * 4;
	const stride = width * 4;
	const rgba = Buffer.alloc(height * stride);
	for (let y = 0; y < height && y < raster.heightPx; y++) {
		raster.pixels.copy(rgba, y * stride, y * sourceStride, y * sourceStride + Math.min(sourceStride, stride));
	}
	return encodePng(rgba, width, height).toString("base64");
}
