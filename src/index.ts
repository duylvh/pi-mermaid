import type { ExtensionAPI, MarkdownTransformContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Color, colorToHex, colorToOklch, getCapabilities, getCellDimensions, Image, Marked } from "@earendil-works/pi-tui";
import { type Layout, layoutDiagram, MONO_ADVANCE, PELE_FONT_SIZE, type Palette, rasterize, sliceStrips } from "./render.ts";

/** SVG units per terminal column: one monospace glyph at Pele's font size. */
const UNITS_PER_CELL = MONO_ADVANCE * PELE_FONT_SIZE;
/** Rows per strip: an image row plus the blank row Markdown puts after every paragraph. */
const STRIP_ROWS = 2;
const CACHE_LIMIT = 16;

type Laid = { ok: true; layout: Layout } | { ok: false; error: string };

const lexer = new Marked();
const layouts = new Map<string, Laid>();
/** A diagram's strips at one column count; `render(renderWidth)` yields each strip's Kitty sequence. */
interface StripSet {
	images: Image[];
	renderWidth: number;
}
const stripSets = new Map<string, StripSet>();

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

/** Largest glyph size over the terminal's own: a diagram grows with the pane up to this, then stops. */
const MAX_ZOOM = 1.2;

/** Below this many pixels per glyph, rounding the advance down would shrink a diagram too much. */
const MIN_WHOLE_ADVANCE_PX = 4;

interface Fit {
	/** Pixels from SVG units: one glyph advance is a whole number of pixels where possible. */
	scale: number;
	columns: number;
}

/**
 * Size a diagram so a label glyph is a whole number of pixels wide, no wider than MAX_ZOOM times the
 * terminal's own glyph, and narrower only when the pane cannot fit it. A whole-pixel advance keeps every
 * glyph stem on the pixel grid.
 */
function fit(layout: Layout, availableWidth: number, cellWidthPx: number): Fit {
	const characters = layout.width / UNITS_PER_CELL;
	const largest = Math.max(1, Math.floor(cellWidthPx * MAX_ZOOM));
	const fitting = ((availableWidth - 1) * cellWidthPx) / characters;
	const advance = fitting >= largest ? largest : fitting >= MIN_WHOLE_ADVANCE_PX ? Math.floor(fitting) : fitting;
	const scale = advance / UNITS_PER_CELL;
	return { scale, columns: Math.max(1, Math.ceil((layout.width * scale) / cellWidthPx)) };
}

/**
 * A diagram is drawn as a stack of short image strips rather than one tall image. A Kitty image only
 * shows while its first row is on screen, and pi-tui re-places a partly scrolled image only for
 * full-width scroll views, which layouts with a gutter (pi-geek-tui) are not. Each strip is its own
 * paragraph, so the blank row after it is the strip's second row.
 *
 * A strip sits in a code span because themes style a code span as one unit, while text styling such as
 * number highlighting would split the escape sequence. Each strip row starts with U+2800 and a
 * U+2800 row follows the last strip: it draws nothing but is not whitespace, so renderers that trim
 * blank rows at a message's edges after stripping escape sequences (pi-geek-tui does) keep them.
 */
function diagramMarkdown({ images, renderWidth }: StripSet): string {
	const rows = images.map((strip) => codeSpan(`\u2800${strip.render(renderWidth)[0] ?? ""}`));
	return `${rows.join("\n\n")}\n\n\u2800\n\n`;
}

/**
 * Strips are rasterized at exactly the terminal's cell size, so the terminal shows every pixel 1:1:
 * no resampling softens the text and no strip is scaled differently from its neighbours. A narrower
 * pane re-rasterizes at a smaller scale rather than shrinking the image.
 */
function createStrips(layout: Layout, { scale, columns }: Fit, fallbackColor: (text: string) => string): StripSet {
	const cell = getCellDimensions();
	const width = columns * cell.widthPx;
	const raster = rasterize(layout, scale);
	const images = sliceStrips(raster, width, STRIP_ROWS * cell.heightPx).map(
		(base64) => new Image(base64, "image/png", { fallbackColor }, { maxWidthCells: columns, maxHeightCells: STRIP_ROWS }),
	);
	return { images, renderWidth: columns + 2 };
}

export default function piMermaid(pi: ExtensionAPI) {
	let ui: { readonly theme: Theme } | undefined;
	let warnedAboutCore = false;

	// Rex drops uploaded Kitty image data when a pane is resized, while pi-tui only re-places images it
	// already uploaded. Re-rendering a strip registers a new transmission for its image id, so the next
	// frame uploads it again even when the rendered line is unchanged, as after a height-only resize.
	const reuploadStrips = () => {
		for (const { images, renderWidth } of stripSets.values()) {
			for (const strip of images) {
				strip.invalidate();
				strip.render(renderWidth);
			}
		}
	};
	process.stdout.on("resize", reuploadStrips);
	pi.on("session_shutdown", () => {
		process.stdout.off("resize", reuploadStrips);
	});

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
		let ordinal = 0;

		return lexer
			.lexer(markdown)
			.map((token) => {
				if (!isMermaid(token) || !isClosedFence(token.raw)) return token.raw;
				const source = (token as { text: string }).text;
				const key = `${paletteKey}|${source}`;
				const laid = remember(layouts, key, (): Laid => {
					try {
						return { ok: true, layout: layoutDiagram(source, palette) };
					} catch (error) {
						return { ok: false, error: error instanceof Error ? error.message : String(error) };
					}
				});
				if (!laid.ok) {
					if (context.isStreaming) return token.raw;
					return `${token.raw}\n\n${theme.fg("warning", escapeMarkdown(`Mermaid diagram not rendered: ${laid.error}`))}\n\n`;
				}
				const { layout } = laid;
				const cell = getCellDimensions();
				const size = fit(layout, context.availableWidth, cell.widthPx);
				const stripsKey = `${context.messageId ?? "live"}|${ordinal++}|${size.scale}|${cell.widthPx}x${cell.heightPx}|${key}`;
				return diagramMarkdown(remember(stripSets, stripsKey, () => createStrips(layout, size, (s) => theme.fg("muted", s))));
			})
			.join("");
	});
}
