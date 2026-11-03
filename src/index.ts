import type { ExtensionAPI, MarkdownTransformContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Color, colorToHex, colorToOklch, getCapabilities, getCellDimensions, Image, Marked } from "@earendil-works/pi-tui";
import { MONO_ADVANCE, PELE_FONT_SIZE, type Palette, type Raster, renderDiagram, sliceStrips } from "./render.ts";

/** SVG units per terminal column: one monospace glyph at Pele's font size. */
const UNITS_PER_CELL = MONO_ADVANCE * PELE_FONT_SIZE;
/** Rows per strip: an image row plus the blank row Markdown puts after every paragraph. */
const STRIP_ROWS = 2;
const CACHE_LIMIT = 16;

type Rendered = { ok: true; raster: Raster } | { ok: false; error: string };

const lexer = new Marked();
const diagrams = new Map<string, Rendered>();
const stripImages = new Map<string, Image[]>();

function remember<V>(cache: Map<string, V>, key: string, make: () => V): V {
	const hit = cache.get(key);
	if (hit !== undefined) {
		cache.delete(key);
		cache.set(key, hit);
		return hit;
	}
	const value = make();
	cache.set(key, value);
	if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
	return value;
}

const SERIES_TOKENS = [
	"accent",
	"success",
	"warning",
	"error",
	"mdLink",
	"syntaxString",
	"syntaxKeyword",
	"syntaxNumber",
	"syntaxFunction",
	"syntaxType",
	"mdHeading",
	"mdCode",
] as const satisfies readonly (keyof Theme["colors"])[];

const MIN_SERIES_DISTANCE = 0.08;

function oklab(color: Color): [number, number, number] {
	const { l, c, h } = colorToOklch(color);
	const radians = (h * Math.PI) / 180;
	return [l, c * Math.cos(radians), c * Math.sin(radians)];
}

/** Theme hues for chart series, skipping any that look like one already chosen. */
function distinctSeries(theme: Theme): string[] {
	const chosen: [number, number, number][] = [];
	const series: string[] = [];
	for (const token of SERIES_TOKENS) {
		const color = theme.colors[token];
		const lab = oklab(color);
		if (chosen.some((other) => Math.hypot(lab[0] - other[0], lab[1] - other[1], lab[2] - other[2]) < MIN_SERIES_DISTANCE)) continue;
		chosen.push(lab);
		series.push(colorToHex(color));
		if (series.length === 8) break;
	}
	return series;
}

/** Read from the live theme on every render, so built-in, JSON, system, and runtime `setTheme()` themes all apply. */
function paletteFrom(theme: Theme): Palette {
	const hex = (token: keyof Theme["colors"]) => colorToHex(theme.colors[token]);
	const text = hex("text");
	const surface = hex("toolPendingBg");
	const [onDark, onLight] =
		colorToOklch(theme.colors.text).l >= colorToOklch(theme.colors.toolPendingBg).l ? [text, surface] : [surface, text];
	return {
		"--pele-bg": surface,
		"--pele-fg": text,
		"--pele-muted": hex("muted"),
		"--pele-line": hex("accent"),
		"--pele-surface": surface,
		"--pele-surface-alt": hex("selectedBg"),
		"--pele-border": hex("border"),
		"--pele-accent": hex("accent"),
		"--pele-critical": hex("error"),
		"--pele-error": hex("error"),
		"--pele-fg-on-dark": onDark,
		"--pele-fg-on-light": onLight,
		...Object.fromEntries(distinctSeries(theme).map((color, i) => [`--pele-series-${i + 1}`, color])),
	};
}

function isMermaid(token: { type: string; lang?: string }): boolean {
	return token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

const isClosedFence = (raw: string) => /\n[ \t]*(`{3,}|~{3,})[ \t]*$/.test(raw.trimEnd());

function codeSpan(content: string): string {
	const longestRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length));
	const fence = "`".repeat(longestRun + 1);
	const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${pad}${content}${pad}${fence}`;
}

const escapeMarkdown = (text: string) => text.replace(/[!-/:-@[-`{-~]/g, "\\$&");

/** Columns at which diagram text is exactly terminal text: one character per cell. */
const naturalColumns = (raster: Raster) => Math.max(1, Math.ceil(raster.layoutWidth / UNITS_PER_CELL));

/** Twice the on-screen pixel density, so lines stay sharp on HiDPI displays. */
const rasterScale = () => Math.min(4, Math.max(2, (2 * getCellDimensions().widthPx) / UNITS_PER_CELL));

/**
 * A diagram is drawn as a stack of short image strips rather than one tall image. A Kitty image only
 * shows while its first row is on screen, and pi-tui re-places a partly scrolled image only for
 * full-width scroll views, which layouts with a gutter (pi-geek-tui) are not. Each strip is its own
 * paragraph, so the blank row after it is the strip's second row.
 *
 * A strip sits in a code span because themes style a code span as one unit, while text styling such as
 * number highlighting would split the escape sequence. The trailing U+2800 row reserves the last
 * strip's second row even when a renderer trims trailing blank rows, since it is not whitespace.
 */
function diagramMarkdown(strips: Image[], columns: number): string {
	const rows = strips.map((strip) => codeSpan(`\u00a0${strip.render(columns + 2)[0] ?? ""}`));
	return `${rows.join("\n\n")}\n\n\u2800\n\n`;
}

function createStrips(raster: Raster, columns: number, fallbackColor: (text: string) => string): Image[] {
	const cell = getCellDimensions();
	const stripHeightPx = Math.max(1, Math.floor((STRIP_ROWS * cell.heightPx * raster.widthPx) / (columns * cell.widthPx)));
	return sliceStrips(raster, stripHeightPx).map(
		(base64) => new Image(base64, "image/png", { fallbackColor }, { maxWidthCells: columns, maxHeightCells: STRIP_ROWS }),
	);
}

export default function piMermaid(pi: ExtensionAPI) {
	let ui: { readonly theme: Theme } | undefined;
	let warnedAboutCore = false;

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		const coreMode = pi.getSettings().markdown?.mermaid ?? "streaming";
		if (coreMode !== "off" && !warnedAboutCore) {
			warnedAboutCore = true;
			ctx.ui.notify(
				`pi-mermaid: built-in Mermaid rendering is "${coreMode}" and runs first. Set "markdown": { "mermaid": "off" } in settings.json so Pele renders diagrams.`,
				"warning",
			);
		}
	});

	pi.registerMarkdownTransformer((markdown: string, context: MarkdownTransformContext) => {
		const theme = ui?.theme;
		if (!theme || context.messageType === "assistant-thinking" || !getCapabilities().images) return markdown;
		if (!/^[ \t]*(`{3,}|~{3,})[ \t]*mermaid/im.test(markdown)) return markdown;

		const palette = paletteFrom(theme);
		const paletteKey = Object.values(palette).join();
		const scale = rasterScale();
		let ordinal = 0;

		return lexer
			.lexer(markdown)
			.map((token) => {
				if (!isMermaid(token) || !isClosedFence(token.raw)) return token.raw;
				const source = (token as { text: string }).text;
				const key = `${paletteKey}|${scale}|${source}`;
				const rendered = remember(diagrams, key, (): Rendered => {
					try {
						return { ok: true, raster: renderDiagram(source, palette, scale) };
					} catch (error) {
						return { ok: false, error: error instanceof Error ? error.message : String(error) };
					}
				});
				if (!rendered.ok) {
					if (context.isStreaming) return token.raw;
					return `${token.raw}\n\n${theme.fg("warning", escapeMarkdown(`Mermaid diagram not rendered: ${rendered.error}`))}\n\n`;
				}
				const { raster } = rendered;
				const columns = Math.max(1, Math.min(naturalColumns(raster), context.availableWidth - 1));
				const cell = getCellDimensions();
				const stripsKey = `${context.messageId ?? "live"}|${ordinal++}|${columns}|${cell.widthPx}x${cell.heightPx}|${key}`;
				const strips = remember(stripImages, stripsKey, () => createStrips(raster, columns, (s) => theme.fg("muted", s)));
				return diagramMarkdown(strips, columns);
			})
			.join("");
	});
}
