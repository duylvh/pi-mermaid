import type { ExtensionAPI, MarkdownTransformContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Color, colorToHex, colorToOklch, getCapabilities, getCellDimensions, Marked } from "@earendil-works/pi-tui";
import { DIACRITICS } from "./diacritics.ts";
import { encodeCanvas, type Layout, layoutDiagram, MONO_ADVANCE, PELE_FONT_SIZE, type Palette, rasterize } from "./render.ts";

/** SVG units per terminal column: one monospace glyph at Pele's font size. */
const UNITS_PER_CELL = MONO_ADVANCE * PELE_FONT_SIZE;
const CACHE_LIMIT = 16;

type Laid = { ok: true; layout: Layout } | { ok: false; error: string };

const lexer = new Marked();
const layouts = new Map<string, Laid>();

/** One diagram at one size: a PNG of exactly `columns` x `rows` cells, shown through Unicode placeholders. */
interface Diagram {
	/** Kitty image id, carried by the placeholder cells as their 24-bit foreground color. */
	id: number;
	png: string;
	columns: number;
	rows: number;
}
const diagrams = new Map<string, Diagram>();

function remember<V>(cache: Map<string, V>, key: string, make: () => V, evict?: (value: V) => void): V {
	const hit = cache.get(key);
	if (hit !== undefined) {
		cache.delete(key);
		cache.set(key, hit);
		return hit;
	}
	const value = make();
	cache.set(key, value);
	if (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next().value!;
		evict?.(cache.get(oldest)!);
		cache.delete(oldest);
	}
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

/** Spacing multipliers tried, widest last, to let a diagram use a wide pane without larger text. */
const SPREADS = [1, 1.5, 2, 3];

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

const KITTY_CHUNK = 4096;
const PLACEHOLDER = String.fromCodePoint(0x10eeee);

/** Upload the PNG and create a virtual placement of `columns` x `rows` cells for its placeholders. */
function uploadSequence({ id, png, columns, rows }: Diagram): string {
	let sequence = "";
	for (let offset = 0; offset < png.length; offset += KITTY_CHUNK) {
		const more = offset + KITTY_CHUNK < png.length ? 1 : 0;
		const controls = offset === 0 ? `a=T,U=1,f=100,q=2,i=${id},c=${columns},r=${rows},m=${more}` : `m=${more}`;
		sequence += `\x1b_G${controls};${png.slice(offset, offset + KITTY_CHUNK)}\x1b\\`;
	}
	return sequence;
}

const CELL_SIZE_QUERY = "\x1b[16t";

const deleteSequence = (id: number) => `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;

/**
 * Each diagram row is ordinary text: Kitty Unicode placeholder cells whose diacritics name the row and
 * column and whose foreground color names the image, so the terminal paints the image into exactly
 * those cells. pi-tui then treats diagrams as text, so its scrollbar, scrolling, clipping and resize
 * handling all apply as they do to prose. Rows sit in code spans because themes style a code span as one
 * unit, while text styling such as number highlighting would split the color sequence.
 */
function diagramMarkdown({ id, columns, rows }: Diagram): string {
	const color = `\x1b[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m`;
	const lines = Array.from({ length: rows }, (_, row) => {
		let cells = "";
		for (let column = 0; column < columns; column++) cells += PLACEHOLDER + String.fromCodePoint(DIACRITICS[row]!, DIACRITICS[column]!);
		return codeSpan(`${color}${cells}\x1b[39m`);
	});
	return `${lines.join("  \n")}\n\n`;
}

const MAX_PLACEHOLDER_CELLS = DIACRITICS.length;

/** Kitty graphics terminals known to draw Unicode placeholders; elsewhere the Mermaid source is shown. */
function drawsPlaceholders(): boolean {
	if (getCapabilities().images !== "kitty" || process.env.TMUX) return false;
	const program = process.env.TERM_PROGRAM?.toLowerCase() ?? "";
	return program === "rex" || program === "ghostty" || program === "kitty" || Boolean(process.env.KITTY_WINDOW_ID) || Boolean(process.env.GHOSTTY_RESOURCES_DIR);
}

/** Rasterized at exactly the terminal's cell size, so the terminal shows every pixel 1:1. */
function createDiagram(layout: Layout, { scale, columns }: Fit): Diagram {
	const cell = getCellDimensions();
	const raster = rasterize(layout, scale);
	const rows = Math.min(MAX_PLACEHOLDER_CELLS, Math.max(1, Math.ceil(raster.heightPx / cell.heightPx)));
	return {
		id: 1 + Math.floor(Math.random() * 0xfffffe),
		png: encodeCanvas(raster, columns * cell.widthPx, rows * cell.heightPx),
		columns,
		rows,
	};
}

export default function piMermaid(pi: ExtensionAPI) {
	let ui: { readonly theme: Theme } | undefined;
	let warnedAboutCore = false;

	// Image data lives in the terminal, outside pi-tui's frames, so it is written directly. Rex drops
	// uploaded image data when a pane is resized, so every live diagram is uploaded again then.
	const uploaded = new Set<number>();
	const upload = (diagram: Diagram) => {
		if (uploaded.has(diagram.id)) return;
		uploaded.add(diagram.id);
		process.stdout.write(uploadSequence(diagram));
	};
	// pi-tui asks for the cell size only at startup, but a pane's cells change size when it first shows
	// on screen or moves to a display with another scale. Asking again on resize lets pi-tui take the
	// answer and redraw, so diagrams are rasterized for the cells the terminal really draws.
	const reupload = () => {
		uploaded.clear();
		for (const diagram of diagrams.values()) upload(diagram);
		process.stdout.write(CELL_SIZE_QUERY);
	};
	const forget = (diagram: Diagram) => {
		uploaded.delete(diagram.id);
		process.stdout.write(deleteSequence(diagram.id));
	};
	process.stdout.on("resize", reupload);
	pi.on("session_shutdown", () => {
		process.stdout.off("resize", reupload);
		for (const diagram of diagrams.values()) forget(diagram);
		diagrams.clear();
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
		if (!theme || context.messageType === "assistant-thinking" || !drawsPlaceholders()) return markdown;
		if (!/^[ \t]*(`{3,}|~{3,})[ \t]*mermaid/im.test(markdown)) return markdown;

		const palette = paletteFrom(theme);
		const paletteKey = Object.values(palette).join();

		return lexer
			.lexer(markdown)
			.map((token) => {
				if (!isMermaid(token) || !isClosedFence(token.raw)) return token.raw;
				const source = (token as { text: string }).text;
				const layoutAt = (spread: number) =>
					remember(layouts, `${paletteKey}|${spread}|${source}`, (): Laid => {
						try {
							return { ok: true, layout: layoutDiagram(source, palette, spread) };
						} catch (error) {
							return { ok: false, error: error instanceof Error ? error.message : String(error) };
						}
					});
				const laid = layoutAt(1);
				if (!laid.ok) {
					if (context.isStreaming) return token.raw;
					return `${token.raw}\n\n${theme.fg("warning", escapeMarkdown(`Mermaid diagram not rendered: ${laid.error}`))}\n\n`;
				}
				const cell = getCellDimensions();
				const { scale } = fit(laid.layout, context.availableWidth, cell.widthPx);
				const columnsOf = (layout: Layout) => Math.max(1, Math.ceil((layout.width * scale) / cell.widthPx));
				let layout = laid.layout;
				let spread = 1;
				for (const wider of SPREADS.slice(1)) {
					const candidate = layoutAt(wider);
					if (!candidate.ok || columnsOf(candidate.layout) > context.availableWidth - 1) break;
					layout = candidate.layout;
					spread = wider;
				}
				const size = { scale, columns: columnsOf(layout) };
				const key = `${paletteKey}|${spread}|${source}`;
				const diagramKey = `${size.scale}|${cell.widthPx}x${cell.heightPx}|${key}`;
				const diagram = remember(diagrams, diagramKey, () => createDiagram(layout, size), forget);
				upload(diagram);
				return diagramMarkdown(diagram);
			})
			.join("");
	});
}
