# pi-mermaid

Renders Mermaid diagrams inline in the pi TUI with [Pele](https://pele.run) instead of pi's built-in Unicode box art. Pele computes a real graph layout, so arrows meet their nodes and labels do not overlap.

Each closed ```` ```mermaid ```` fence in a user or assistant message becomes a terminal image:

1. Pele lays the diagram out as SVG.
2. The SVG's CSS variables are resolved to the active pi theme's colors.
3. resvg rasterizes it to a transparent PNG.
4. pi-tui's `Image` component draws it with the Kitty graphics protocol.

Diagrams are sized so their text matches the terminal text, and they shrink to fit narrow panes.

## Requirements

- A terminal with Kitty graphics that pi detects, such as Rex, Ghostty, Kitty, WezTerm, or Herdr. Under tmux, or in any terminal without image support, the Mermaid source is shown unchanged.
- pi's built-in renderer turned off. It runs before extension transformers and would consume the blocks first:

  ```json
  { "markdown": { "mermaid": "off" } }
  ```

  The extension warns at session start while it is still on.

## Install

```sh
bun install
pi install /absolute/path/to/pi-mermaid
```

## Develop

```sh
bun test          # transformer through pi-tui's real Markdown component
bun run typecheck
pi -e ./src/index.ts
```

The pi entry is TypeScript source on purpose. pi loads `.ts` extensions through jiti with its own module aliases, so the extension shares the host's `@earendil-works/pi-tui`. A compiled `.js` entry is imported natively and resolves the dev copy in `node_modules`, so the host never sees the image metadata (diagrams vanish once their top row scrolls out of view) and the reported cell size falls back to 9x18.

## Themes

Diagrams take their colors from the active pi theme at render time, so they follow every theme source pi supports: the `system` theme built from the terminal palette, the built-in `dark` and `light`, JSON themes from `~/.pi/agent/themes`, projects, or packages such as [pi-themes](https://github.com/sting8k/pi-themes), and theme instances installed at runtime with `ctx.ui.setTheme()`, as [pi-geek-tui](https://github.com/duylvh/pi-geek-tui) does. Every color form in the [theme docs](https://pi.dev/docs/latest/themes) works, including OKHSL, OKLCH, 256-color indices, and `""` for the terminal default.

When the theme changes through `/settings`, light/dark auto-switching, hot reload of a theme file, or `setTheme()`, pi invalidates the chat and visible diagrams are redrawn in the new colors.

| Pele variable | pi theme color |
|---|---|
| `--pele-fg` | `text` |
| `--pele-muted` | `muted` |
| `--pele-line`, `--pele-accent` | `accent` |
| `--pele-border` | `border` |
| `--pele-surface`, `--pele-bg` | `toolPendingBg` |
| `--pele-surface-alt` | `selectedBg` |
| `--pele-critical`, `--pele-error` | `error` |
| `--pele-fg-on-dark`, `--pele-fg-on-light` | the lighter and darker of `text` and `toolPendingBg` |
| `--pele-series-1` to `8` | the first eight perceptually distinct of `accent`, `success`, `warning`, `error`, `mdLink`, and the `syntax*` colors |

Edge-label chips use the node fill, so no terminal background color is needed.

To check a palette change against every theme at once, render a contact sheet:

```sh
bun scripts/theme-sheet.ts theme-sheet.png [pi-themes/themes] [pi-geek-tui]
```

It runs the real transformer under `dark`, `light`, each pi-themes theme, the pi-geek-tui theme, and `system` on a simulated dark and light terminal.

## Behavior

- An unclosed fence while streaming stays as source until the closing fence arrives.
- Invalid Mermaid keeps the source and adds a one-line reason.
- Thinking blocks are left alone.
- Rendered PNGs are cached per source and theme, so re-renders and resizes do not rasterize again.
