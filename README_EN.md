# Folder Pin

Pin folders as tabs in the Obsidian file explorer. Switch project contexts in one click instead of scrolling and collapsing folders.

## Why

Working across many large projects in a single vault means constantly expanding, collapsing, and scrolling the file tree to switch context. Folder Pin lets you pin a folder as the root of an explorer tab, so each project gets its own focused view, and switching between them is a single click.

## Features

- **Pin any folder as a tab** — each tab shows that folder as its root, hiding everything else.
- **Multiple explorer views** — open additional Folder Pin explorers via the command `Open another Folder Pin explorer`.
- **Per-tab state** — expand state, scroll position, and selected file are remembered per tab.
- **Layout options** — switch the tab bar between grid and other layouts.
- **Optional Go Up button** — quickly jump from a pinned subfolder back to its parent.

## Demo

![demo](./assets/demo.gif)

## Installation

### From the Community Plugin marketplace (after listing)

1. Open Obsidian → **Settings → Community plugins**.
2. Browse and search for **Folder Pin**.
3. Install, then enable.

### Manual install (current method while review is pending)

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [release](https://github.com/42MilesZ/obsidian-folder-pin/releases).
2. Place them under `<your-vault>/.obsidian/plugins/folder-pin/`.
3. Reload Obsidian → enable the plugin in **Settings → Community plugins**.

## Usage

1. Open the Folder Pin explorer view from the ribbon, or run `Open another Folder Pin explorer` from the command palette.
2. Right-click any folder in the explorer → **Pin as tab**. The folder becomes a new tab.
3. Click between tabs to switch contexts. Each tab keeps its own expand state and scroll position.

## Settings

| Setting | What it does |
|---|---|
| Show "Go up" button | Show a quick parent-folder button at the top of each tab |
| Tab layout | `grid`, `vertical`, or `horizontal` layout for the tab bar |

## Compatibility

- **Minimum Obsidian version:** 1.6.2
- **Desktop only** — uses Node APIs not available on mobile.

## Development

```bash
npm install
npm run dev      # esbuild watch mode
npm run build    # one-shot production build → main.js
```

To test in a vault, symlink or copy the build output and `manifest.json` / `styles.css` into `.obsidian/plugins/folder-pin/`.

## License

[MIT](./LICENSE) © 2026 Chu HanYu
