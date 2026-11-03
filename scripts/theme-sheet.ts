#!/usr/bin/env bun
// Usage: bun scripts/theme-sheet.ts [out.png] [pi-themes-dir] [pi-geek-tui-dir]
// Renders sample diagrams through the real transformer under every theme it can load and writes one contact sheet.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import type { MarkdownTransformer, Theme } from "@earendil-works/pi-coding-agent";
import { colorToHex, parseColor, setCapabilities } from "@earendil-works/pi-tui";
import piMermaid from "../src/index.ts";

const root = join(import.meta.dir, "..");
const hostEntries: Record<string, string> = {
	"@earendil-works/pi-coding-agent": Bun.fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
	"@earendil-works/pi-tui": Bun.fileURLToPath(import.meta.resolve("@earendil-works/pi-tui")),
};
Bun.plugin({
	setup(build) {
		build.onResolve({ filter: /^@earendil-works\/pi-(coding-agent|tui)$/ }, (args) =>
			args.importer.startsWith(root) ? undefined : { path: hostEntries[args.path]! },
		);
	},
});

const gitDir = join(homedir(), ".pi/agent/git/github.com");
const [out = "theme-sheet.png", piThemesDir = join(gitDir, "sting8k/pi-themes/themes"), geekDir = join(gitDir, "duylvh/pi-geek-tui")] =
	process.argv.slice(2);

const themeModule = await import(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"));
const { getThemeByName, loadThemeFromPath, setTerminalColors } = themeModule as {
	getThemeByName(name: string): Theme | undefined;
	loadThemeFromPath(path: string): Theme;
	setTerminalColors(colors: object): void;
};

const SAMPLES = [
	"flowchart TD\n  A[Request] --> B{Cached?}\n  B -->|yes| C[Serve]\n  B -->|no| D[Fetch]\n  D --> C",
	'pie title Traffic\n  "Web" : 42\n  "API" : 28\n  "Batch" : 18\n  "Other" : 12',
	"sequenceDiagram\n  Client->>Server: request\n  Server-->>Client: response",
];

type Entry = { name: string; theme: Theme; pageBg: string };

function jsonPageBg(path: string, theme: Theme): string {
	const json = JSON.parse(readFileSync(path, "utf8")) as { vars?: Record<string, string>; export?: { pageBg?: string } };
	let value = json.export?.pageBg ?? json.vars?.bg;
	for (let i = 0; i < 8 && value && json.vars?.[value] !== undefined; i++) value = json.vars[value];
	try {
		if (value) return colorToHex(parseColor(value));
	} catch {}
	return theme.appearance === "light" ? "#ffffff" : "#000000";
}

const entries: Entry[] = [
	{ name: "dark", theme: getThemeByName("dark")!, pageBg: "#16181d" },
	{ name: "light", theme: getThemeByName("light")!, pageBg: "#ffffff" },
];
for (const file of readdirSync(piThemesDir).filter((f) => f.endsWith(".json")).sort()) {
	const path = join(piThemesDir, file);
	try {
		const theme = loadThemeFromPath(path);
		entries.push({ name: file.replace(/\.json$/, ""), theme, pageBg: jsonPageBg(path, theme) });
	} catch (error) {
		console.warn(`skip ${file}: ${(error as Error).message}`);
	}
}
try {
	const { createGeekTheme } = await import(join(geekDir, "theme/geek-theme.ts"));
	const { GEEK_PALETTE } = await import(join(geekDir, "theme/geek-palette.ts"));
	entries.push({ name: "pi-geek", theme: createGeekTheme("truecolor"), pageBg: GEEK_PALETTE.bg });
} catch (error) {
	console.warn(`skip pi-geek: ${(error as Error).message}`);
}

const ui = { theme: entries[0]!.theme, notify() {} };
let transform!: MarkdownTransformer;
const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
piMermaid({
	on: (name: string, handler: (event: unknown, ctx: unknown) => void) => (handlers[name] = handler),
	registerMarkdownTransformer: (t: MarkdownTransformer) => (transform = t),
	getSettings: () => ({ markdown: { mermaid: "off" } }),
} as never);
handlers.session_start!({}, { ui });
setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

type Strip = { data: string; height: number };

/** The diagram's strips, top to bottom, as the transformer emits them. */
function renderStrips(source: string): { strips: Strip[]; width: number; height: number } {
	const output = transform(`\`\`\`mermaid\n${source}\n\`\`\``, { messageType: "assistant", isStreaming: false, availableWidth: 400 });
	const strips = output
		.split("\n\n")
		.filter((paragraph) => paragraph.includes("\x1b_G"))
		.map((paragraph) => [...paragraph.matchAll(/\x1b_G[^;]*;([^\x1b]*)\x1b\\/g)].map((m) => m[1]).join(""))
		.map((data) => ({ data, png: Buffer.from(data, "base64") }));
	if (strips.length === 0) throw new Error(`no image for:\n${output.slice(0, 300)}`);
	const width = strips[0]!.png.readUInt32BE(16);
	const list = strips.map(({ data, png }) => ({ data, height: png.readUInt32BE(20) }));
	return { strips: list, width, height: list.reduce((sum, strip) => sum + strip.height, 0) };
}

function systemEntry(name: string, background: string, foreground: string): Entry {
	const rgb = (hex: string) => ({ r: Number.parseInt(hex.slice(1, 3), 16), g: Number.parseInt(hex.slice(3, 5), 16), b: Number.parseInt(hex.slice(5, 7), 16) });
	setTerminalColors({ background: rgb(background), foreground: rgb(foreground) });
	return { name, theme: getThemeByName("system")!, pageBg: background };
}

const CELL_H = 260;
const LABEL_H = 28;
const rows: string[] = [];
let sheetWidth = 0;
let y = 0;
const renderEntry = (entry: Entry) => {
	ui.theme = entry.theme;
	let x = 12;
	const images = SAMPLES.map((source) => {
		const diagram = renderStrips(source);
		const scale = Math.min(1, (CELL_H - 16) / diagram.height);
		const w = diagram.width * scale;
		let top = y + LABEL_H;
		const tag = diagram.strips
			.map((strip) => {
				const bottom = Math.round(top + strip.height * scale);
				const image = `<image x="${x}" y="${Math.round(top)}" width="${w}" height="${bottom - Math.round(top)}" preserveAspectRatio="none" href="data:image/png;base64,${strip.data}"/>`;
				top += strip.height * scale;
				return image;
			})
			.join("");
		x += w + 24;
		return tag;
	});
	sheetWidth = Math.max(sheetWidth, x);
	const label = colorToHex(entry.theme.colors.text);
	rows.push(
		`<rect x="0" y="${y}" width="100%" height="${CELL_H + LABEL_H}" fill="${entry.pageBg}"/>`,
		`<text x="12" y="${y + 20}" font-family="Menlo" font-size="14" fill="${label}">${entry.name} (${entry.theme.appearance})</text>`,
		...images,
	);
	y += CELL_H + LABEL_H;
};

for (const entry of entries) renderEntry(entry);
renderEntry(systemEntry("system on dark terminal", "#101216", "#d0d4dc"));
renderEntry(systemEntry("system on light terminal", "#fbfaf7", "#24262b"));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(sheetWidth)}" height="${y}">${rows.join("")}</svg>`;
await Bun.write(out, new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng());
console.log(`${entries.length + 2} themes -> ${out}`);
