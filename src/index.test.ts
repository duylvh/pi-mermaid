import { afterEach, beforeAll, expect, test } from "bun:test";
import { getMarkdownTheme, initTheme, type MarkdownTransformContext, type MarkdownTransformer, Theme } from "@earendil-works/pi-coding-agent";
import { getCellDimensions, Markdown, setCapabilities, setCellDimensions, visibleWidth } from "@earendil-works/pi-tui";

import piMermaid from "./index.ts";

const THEME_MODULE = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js", import.meta.url).href;
const flowchart = (end = "Done") => `\`\`\`mermaid\nflowchart TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[${end}]\n\`\`\``;
const FLOWCHART = flowchart();
const PLACEHOLDER_CELL = /\u{10eeee}[\u0300-\u{1d244}]{2}/gu;

let transform: MarkdownTransformer;
let getThemeByName: (name: string) => Theme | undefined;
const ui = { theme: undefined as unknown as Theme, notify() {} };
let terminal: string[] = [];

beforeAll(async () => {
	process.env.TERM_PROGRAM = "rex";
	initTheme("dark");
	({ getThemeByName } = await import(THEME_MODULE));
	ui.theme = getThemeByName("dark")!;
	(process.stdout as { write: unknown }).write = (data: string) => terminal.push(String(data)) > 0;
	const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
	piMermaid({
		on: (name: string, handler: (event: unknown, ctx: unknown) => void) => (handlers[name] = handler),
		registerMarkdownTransformer: (t: MarkdownTransformer) => (transform = t),
		getSettings: () => ({ markdown: { mermaid: "off" } }),
	} as never);
	handlers.session_start!({}, { ui });
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
});

afterEach(() => {
	terminal = [];
});

function renderMessage(text: string, overrides: Partial<MarkdownTransformContext> = {}, width = 100): string[] {
	const markdown = new Markdown(text, 1, 0, getMarkdownTheme(), undefined, {
		transform: (md, availableWidth) =>
			transform(md, { messageType: "assistant", isStreaming: false, availableWidth, ...overrides }),
	});
	return markdown.render(width);
}

const diagramRows = (lines: string[]) => lines.filter((line) => line.includes("\u{10eeee}"));
const cellsIn = (line: string) => line.match(PLACEHOLDER_CELL)?.length ?? 0;

interface Upload {
	id: number;
	columns: number;
	rows: number;
	width: number;
	height: number;
}

/** Kitty uploads written to the terminal, joined across chunks. */
function uploads(): Upload[] {
	const found: Upload[] = [];
	for (const [, controls, first, rest] of terminal.join("").matchAll(/\x1b_G(a=T[^;]*);([^\x1b]*)\x1b\\((?:\x1b_Gm=[01];[^\x1b]*\x1b\\)*)/g)) {
		const png = Buffer.from(first! + [...rest!.matchAll(/;([^\x1b]*)\x1b/g)].map((m) => m[1]).join(""), "base64");
		const value = (key: string) => Number(new RegExp(`\\b${key}=(\\d+)`).exec(controls!)?.[1]);
		expect(controls).toContain("U=1");
		found.push({ id: value("i"), columns: value("c"), rows: value("r"), width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
	}
	return found;
}

test("a diagram renders as plain text rows of placeholder cells, keeping surrounding text", () => {
	const lines = renderMessage(`Before\n\n${FLOWCHART}\n\nAfter`);
	const rows = diagramRows(lines);
	const [upload] = uploads();
	expect(rows).toHaveLength(upload!.rows);
	expect(rows.every((row) => cellsIn(row) === upload!.columns)).toBe(true);
	expect(lines.every((line) => !line.includes("\x1b_G") && !line.includes("\n"))).toBe(true);
	const text = lines.join("\n");
	expect(text).toContain("Before");
	expect(text).toContain("After");
	expect(text).not.toContain("flowchart TD");
});

test("each image is uploaded once, and again after a resize", () => {
	const source = flowchart("Uploaded once");
	renderMessage(source);
	renderMessage(source);
	expect(uploads()).toHaveLength(1);
	const [{ id }] = uploads() as [Upload];
	process.stdout.emit("resize");
	expect(uploads().filter((upload) => upload.id === id)).toHaveLength(2);
});

test("images are drawn pixel for pixel at any terminal cell size", () => {
	const original = getCellDimensions();
	try {
		for (const [widthPx, heightPx] of [[7, 15], [8, 16], [9, 18], [10, 22], [16, 34]] as const) {
			setCellDimensions({ widthPx, heightPx });
			terminal = [];
			renderMessage(flowchart(`Cell ${widthPx}x${heightPx}`));
			const [upload] = uploads();
			expect(`${upload!.width}x${upload!.height}`).toBe(`${upload!.columns * widthPx}x${upload!.rows * heightPx}`);
		}
	} finally {
		setCellDimensions(original);
	}
});

test("a diagram grows with the pane up to a cap and shrinks to fit a narrow pane", () => {
	const columnsAt = (width: number) => cellsIn(diagramRows(renderMessage(FLOWCHART, {}, width))[0]!);
	expect(columnsAt(12)).toBeLessThanOrEqual(9);
	expect(columnsAt(200)).toBeGreaterThan(columnsAt(12));
	expect(columnsAt(400)).toBe(columnsAt(200));
	const wide = "```mermaid\nflowchart LR\n" + Array.from({ length: 12 }, (_, i) => `  N${i}[Node number ${i}] --> N${i + 1}[Node number ${i + 1}]`).join("\n") + "\n```";
	expect(renderMessage(wide, {}, 40).every((line) => visibleWidth(line) <= 40)).toBe(true);
});

test("an unclosed block while streaming stays as source", () => {
	const lines = renderMessage("```mermaid\nflowchart TD\n  A --> B", { isStreaming: true });
	expect(diagramRows(lines)).toHaveLength(0);
	expect(lines.join("\n")).toContain("A --> B");
});

test("invalid mermaid keeps the source and explains why", () => {
	const lines = renderMessage("```mermaid\nnotadiagram\n  ???\n```");
	expect(diagramRows(lines)).toHaveLength(0);
	expect(lines.join("\n")).toContain("Mermaid diagram not rendered");
	expect(lines.join("\n")).toContain("notadiagram");
});

test("terminals that cannot draw placeholders see the source untouched", () => {
	process.env.TERM_PROGRAM = "WezTerm";
	try {
		const lines = renderMessage(FLOWCHART);
		expect(diagramRows(lines)).toHaveLength(0);
		expect(lines.join("\n")).toContain("A[Start]");
	} finally {
		process.env.TERM_PROGRAM = "rex";
	}
});

test("terminals without image support see the source untouched", () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	try {
		const lines = renderMessage(FLOWCHART);
		expect(diagramRows(lines)).toHaveLength(0);
		expect(uploads()).toHaveLength(0);
		expect(lines.join("\n")).toContain("A[Start]");
	} finally {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	}
});

test("the diagram follows the live theme, including one swapped in after session start", () => {
	const image = () => {
		terminal = [];
		renderMessage(FLOWCHART);
		return terminal.join("").replace(/\bi=\d+/g, "");
	};
	const dark = image();
	ui.theme = getThemeByName("light")!;
	try {
		expect(image()).not.toBe(dark);
	} finally {
		ui.theme = getThemeByName("dark")!;
	}
	renderMessage(FLOWCHART);
	process.stdout.emit("resize");
	expect(terminal.join("")).toContain(dark.slice(40, 400));
});

test("a diagram survives renderers that trim blank rows at a message's edges", () => {
	const blank = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").trim() === "";
	const lines = renderMessage(FLOWCHART);
	const rows = diagramRows(lines).length;
	while (lines.length && blank(lines[0]!)) lines.shift();
	while (lines.length && blank(lines.at(-1)!)) lines.pop();
	expect(diagramRows(lines)).toHaveLength(rows);
});

test("a wide pane spreads a diagram out instead of enlarging its text", () => {
	const sequence = "```mermaid\nsequenceDiagram\n  Client->>Server: request\n  Server->>Store: read\n  Store-->>Server: rows\n  Server-->>Client: response\n```";
	const at = (width: number) => {
		terminal = [];
		const rows = diagramRows(renderMessage(sequence, {}, width));
		return { columns: cellsIn(rows[0]!), rows: rows.length, fits: renderMessage(sequence, {}, width).every((line) => visibleWidth(line) <= width) };
	};
	const narrow = at(60);
	const wide = at(200);
	expect(wide.columns).toBeGreaterThan(narrow.columns);
	expect(wide.rows).toBe(narrow.rows);
	expect(narrow.fits && wide.fits).toBe(true);
});
