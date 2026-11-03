import type { ExtensionAPI, MarkdownTransformContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Color, colorToHex, colorToOklch, getCapabilities, getCellDimensions, Image, Marked } from "@earendil-works/pi-tui";
import { type DiagramImage, type Palette, renderDiagram } from "./render.ts";

const PELE_FONT_PX = 16;
const TEXT_TO_CELL_HEIGHT = 1.1;
const CACHE_LIMIT = 64;

type Rendered = { ok: true; diagram: DiagramImage } | { ok: false; error: string };

const lexer = new Marked();
const diagrams = new Map<string, Rendered>();
const images = new Map<string, Image>();

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

/**
 * Rows under an image hold U+2800, which draws nothing but is not whitespace: Markdown keeps the line, and
 * renderers that trim trailing blank rows with `trim()` (pi-geek-tui does) keep the image's height.
 */
const reservedRows = (count: number) => `${Array.from({ length: Math.max(1, count) }, () => "\u2800").join("  \n")}\n\n`;

/**
 * The Markdown component keeps a block with an image sequence as one unsplit row, so the sequence gets
 * its own paragraph, and the blank row Markdown puts between paragraphs is the first reserved row. The
 * sequence sits in a code span because themes style a code span as one unit, while text styling such
 * as number highlighting would split it. Reserved rows stay plain text so themes that decorate code
 * spans draw nothing on them.
 */
function imageMarkdown(lines: string[]): string {
	const [first = "", ...rest] = lines;
	if (!first.includes("\x1b_G")) return `${lines.map(codeSpan).join("  \n")}\n\n`;
	return `${codeSpan(`\u00a0${first}`)}\n\n${reservedRows(rest.length - 1)}`;
}

/** Columns that make diagram text about as tall as terminal text. */
function naturalColumns(diagram: DiagramImage): number {
	const cell = getCellDimensions();
	const pxPerUnit = (cell.heightPx * TEXT_TO_CELL_HEIGHT) / PELE_FONT_PX;
	return Math.max(1, Math.ceil((diagram.layoutWidth * pxPerUnit) / cell.widthPx));
}

function rasterScale(): number {
	const cell = getCellDimensions();
	return Math.min(4, Math.max(2, (cell.heightPx * TEXT_TO_CELL_HEIGHT * 2) / PELE_FONT_PX));
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
						return { ok: true, diagram: renderDiagram(source, palette, scale) };
					} catch (error) {
						return { ok: false, error: error instanceof Error ? error.message : String(error) };
					}
				});
				if (!rendered.ok) {
					if (context.isStreaming) return token.raw;
					return `${token.raw}\n\n${theme.fg("warning", escapeMarkdown(`Mermaid diagram not rendered: ${rendered.error}`))}\n\n`;
				}
				const { diagram } = rendered;
				const imageKey = `${context.messageId ?? "live"}|${ordinal++}|${key}`;
				const image = remember(
					images,
					imageKey,
					() =>
						new Image(diagram.base64, "image/png", { fallbackColor: (s) => theme.fg("muted", s) }, {
							maxWidthCells: naturalColumns(diagram),
							maxHeightCells: 10_000,
						}),
				);
				return imageMarkdown(image.render(context.availableWidth + 1));
			})
			.join("");
	});
}
