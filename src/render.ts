import { existsSync } from "node:fs";
import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";
import { render as renderSvg } from "pele";

export type Palette = Readonly<Record<`--pele-${string}`, string>>;

export interface DiagramImage {
	base64: string;
	widthPx: number;
	heightPx: number;
	/** Pele layout size, in SVG user units, before rasterization. */
	layoutWidth: number;
	layoutHeight: number;
}

const SANS = "Helvetica";
const MONO = "Menlo";
const FONT_FILES = [
	"/System/Library/Fonts/Helvetica.ttc",
	"/System/Library/Fonts/Menlo.ttc",
	"/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
].filter((path) => existsSync(path));

const fontOptions: ResvgRenderOptions["font"] =
	FONT_FILES.length > 0
		? { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: SANS, sansSerifFamily: SANS, monospaceFamily: MONO }
		: { loadSystemFonts: true };

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

/** Render Mermaid source to a transparent PNG. Throws a PeleError on invalid or unsupported source. */
export function renderDiagram(source: string, palette: Palette, scale: number): DiagramImage {
	const { svg, width, height } = renderSvg(source, { fontFamily: SANS, fontFamilyMono: MONO });
	const png = new Resvg(resolveCssVars(svg, palette), { fitTo: { mode: "zoom", value: scale }, font: fontOptions }).render();
	return {
		base64: Buffer.from(png.asPng()).toString("base64"),
		widthPx: png.width,
		heightPx: png.height,
		layoutWidth: width,
		layoutHeight: height,
	};
}
