import { beforeAll, expect, test } from "bun:test";
import { getMarkdownTheme, initTheme, type MarkdownTransformContext, type MarkdownTransformer, Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";

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

function renderMessage(text: string, overrides: Partial<MarkdownTransformContext> = {}, width = 100, markdownTheme = getMarkdownTheme()): string[] {
	const markdown = new Markdown(text, 1, 0, markdownTheme, undefined, {
		transform: (md, availableWidth) =>
			transform(md, { messageType: "assistant", isStreaming: false, availableWidth, ...overrides }),
	});
	return markdown.render(width);
}

test("a mermaid block renders as one kitty image with reserved rows, keeping surrounding text", () => {
	const lines = renderMessage(`Before\n\n${FLOWCHART}\n\nAfter`);
	const imageLines = lines.filter(isImageLine);
	expect(imageLines).toHaveLength(1);
	const rows = Number(/\x1b_G[^;]*\br=(\d+)/.exec(imageLines[0]!)?.[1]);
	const start = lines.indexOf(imageLines[0]!);
	expect(rows).toBeGreaterThan(3);
	expect(lines.every((line) => !line.includes("\n"))).toBe(true);
	expect(lines.slice(start + 1, start + rows).every((line) => line.replace(/\x1b\[[0-9;]*m|\u2800/g, "").trim() === "")).toBe(true);
	expect(lines[start + rows]!.trim()).toBe("");
	expect(lines[start + rows + 1]).toContain("After");
	expect(lines.join("\n")).toContain("Before");
	expect(lines.join("\n")).toContain("After");
	expect(lines.join("\n")).not.toContain("flowchart TD");
});

test("an image never exceeds the available width", () => {
	const wide = "```mermaid\nflowchart LR\n" + Array.from({ length: 12 }, (_, i) => `  N${i}[Node number ${i}] --> N${i + 1}[Node number ${i + 1}]`).join("\n") + "\n```";
	const imageLine = renderMessage(wide, {}, 40).find(isImageLine)!;
	expect(Number(/\bc=(\d+)/.exec(imageLine)?.[1])).toBeLessThanOrEqual(37);
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
	const payload = () => renderMessage(FLOWCHART).find(isImageLine)!.replace(/\bi=\d+/g, "");
	const dark = payload();
	ui.theme = getThemeByName("light")!;
	try {
		expect(payload()).not.toBe(dark);
	} finally {
		ui.theme = getThemeByName("dark")!;
	}
	expect(payload()).toBe(dark);
});

test("themes that decorate inline code draw nothing on the rows an image covers", () => {
	const backtickedCode = { ...getMarkdownTheme(), code: (text: string) => `\`${text}\`` };
	const lines = renderMessage(FLOWCHART, {}, 100, backtickedCode);
	const start = lines.findIndex(isImageLine);
	const rows = Number(/\x1b_G[^;]*\br=(\d+)/.exec(lines[start]!)?.[1]);
	const covered = lines.slice(start + 1, start + rows).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\u2800/g, "").trim());
	expect(covered.every((line) => line === "")).toBe(true);
});

test("a diagram that ends a message keeps its height when trailing blank rows are trimmed", () => {
	const lines = renderMessage(FLOWCHART);
	while (lines.length && lines.at(-1)!.replace(/\x1b\[[0-9;]*m/g, "").trim() === "") lines.pop();
	const start = lines.findIndex(isImageLine);
	const rows = Number(/\x1b_G[^;]*\br=(\d+)/.exec(lines[start]!)?.[1]);
	expect(lines.length - start).toBeGreaterThanOrEqual(rows);
});
