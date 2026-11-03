import { beforeAll, expect, test } from "bun:test";
import { getMarkdownTheme, initTheme, type MarkdownTransformContext, type MarkdownTransformer, Theme } from "@earendil-works/pi-coding-agent";
import { getCellDimensions, Markdown, setCapabilities, setCellDimensions, visibleWidth } from "@earendil-works/pi-tui";

import piMermaid from "./index.ts";

const isImageLine = (line: string) => line.includes("\x1b_G");
const THEME_MODULE = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js", import.meta.url).href;

const FLOWCHART = "```mermaid\nflowchart TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]\n```";

let transform: MarkdownTransformer;
let getThemeByName: (name: string) => Theme | undefined;
const ui = { theme: undefined as unknown as Theme, notify() {} };

beforeAll(async () => {
	initTheme("dark");
	({ getThemeByName } = await import(THEME_MODULE));
	ui.theme = getThemeByName("dark")!;
	const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
	piMermaid({
		on: (name: string, handler: (event: unknown, ctx: unknown) => void) => (handlers[name] = handler),
		registerMarkdownTransformer: (t: MarkdownTransformer) => (transform = t),
		getSettings: () => ({ markdown: { mermaid: "off" } }),
	} as never);
	handlers.session_start!({}, { ui });
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
});

function renderMessage(text: string, overrides: Partial<MarkdownTransformContext> = {}, width = 100): string[] {
	const markdown = new Markdown(text, 1, 0, getMarkdownTheme(), undefined, {
		transform: (md, availableWidth) =>
			transform(md, { messageType: "assistant", isStreaming: false, availableWidth, ...overrides }),
	});
	return markdown.render(width);
}

const placement = (line: string) => {
	const [, columns, rows] = /\bc=(\d+),r=(\d+)/.exec(line) ?? [];
	return { columns: Number(columns), rows: Number(rows) };
};
const visible = (line: string) => line.replace(/\x1b\[[0-9;]*m|\u2800/g, "").trim();

test("a diagram renders as a stack of 2-row image strips, each anchored on its own row, keeping surrounding text", () => {
	const lines = renderMessage(`Before\n\n${FLOWCHART}\n\nAfter`);
	const anchors = lines.flatMap((line, row) => (isImageLine(line) ? [row] : []));
	expect(anchors.length).toBeGreaterThan(2);
	expect(anchors.every((row) => placement(lines[row]!).rows === 2 && visible(lines[row + 1]!) === "")).toBe(true);
	expect(anchors.slice(1).every((row, i) => row - anchors[i]! === 2)).toBe(true);
	expect(new Set(anchors.map((row) => placement(lines[row]!).columns)).size).toBe(1);
	expect(lines.every((line) => !line.includes("\n"))).toBe(true);
	const text = lines.join("\n");
	expect(text).toContain("Before");
	expect(text).toContain("After");
	expect(text).not.toContain("flowchart TD");
});

test("an image never exceeds the available width", () => {
	const wide = "```mermaid\nflowchart LR\n" + Array.from({ length: 12 }, (_, i) => `  N${i}[Node number ${i}] --> N${i + 1}[Node number ${i + 1}]`).join("\n") + "\n```";
	const strips = renderMessage(wide, {}, 40).filter(isImageLine);
	expect(strips.every((line) => placement(line).columns <= 37)).toBe(true);
});

test("an unclosed block while streaming stays as source", () => {
	const lines = renderMessage("```mermaid\nflowchart TD\n  A --> B", { isStreaming: true });
	expect(lines.some(isImageLine)).toBe(false);
	expect(lines.join("\n")).toContain("A --> B");
});

test("invalid mermaid keeps the source and explains why", () => {
	const lines = renderMessage("```mermaid\nnotadiagram\n  ???\n```");
	expect(lines.some(isImageLine)).toBe(false);
	expect(lines.join("\n")).toContain("Mermaid diagram not rendered");
	expect(lines.join("\n")).toContain("notadiagram");
});

test("terminals without image support see the source untouched", () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	try {
		const lines = renderMessage(FLOWCHART);
		expect(lines.some(isImageLine)).toBe(false);
		expect(lines.map((l) => visibleWidth(l)).every((w) => w <= 100)).toBe(true);
		expect(lines.join("\n")).toContain("A[Start]");
	} finally {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	}
});

test("the diagram follows the live theme, including one swapped in after session start", () => {
	const payload = () => renderMessage(FLOWCHART).filter(isImageLine).join().replace(/\bi=\d+/g, "");
	const dark = payload();
	ui.theme = getThemeByName("light")!;
	try {
		expect(payload()).not.toBe(dark);
	} finally {
		ui.theme = getThemeByName("dark")!;
	}
	expect(payload()).toBe(dark);
});

test("a diagram survives renderers that trim blank rows at a message's edges", () => {
	const blank = (line: string) => line.replace(/\x1b_G[^\x1b]*\x1b\\|\x1b\[[0-9;]*m/g, "").trim() === "";
	const lines = renderMessage(FLOWCHART);
	const strips = lines.filter(isImageLine).length;
	while (lines.length && blank(lines[0]!)) lines.shift();
	while (lines.length && blank(lines.at(-1)!)) lines.pop();
	expect(lines.filter(isImageLine)).toHaveLength(strips);
	const lastStrip = lines.findLastIndex(isImageLine);
	expect(lines.length - lastStrip).toBeGreaterThanOrEqual(placement(lines[lastStrip]!).rows);
});

const pngSize = (line: string) => {
	const png = Buffer.from([...line.matchAll(/\x1b_G[^;]*;([^\x1b]*)\x1b\\/g)].map((m) => m[1]).join(""), "base64");
	return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
};

test("strips are drawn pixel for pixel at any terminal cell size", () => {
	const original = getCellDimensions();
	try {
		for (const [widthPx, heightPx] of [[7, 15], [8, 16], [9, 18], [10, 22], [16, 34]] as const) {
			setCellDimensions({ widthPx, heightPx });
			const strips = renderMessage(FLOWCHART).filter(isImageLine);
			const { columns } = placement(strips[0]!);
			expect(strips.every((line) => placement(line).columns === columns && placement(line).rows === 2)).toBe(true);
			expect(new Set(strips.map(pngSize))).toEqual(new Set([`${columns * widthPx}x${2 * heightPx}`]));
		}
	} finally {
		setCellDimensions(original);
	}
});
