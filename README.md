# Tab Out

**Keep tabs on your tabs.**

Tab Out is a Chrome extension that replaces your new tab page with a dashboard of everything you have open. Tabs are grouped by domain so each site's homepages and content pages stay together. Close tabs with a satisfying confetti burst.

No server. No account. No external API calls. Just a Chrome extension.

---

## Install with a coding agent

Send your coding agent (Claude Code, Codex, etc.) this repo and say **"install this"**:

```
https://github.com/zarazhangrui/tab-out
```

The agent will walk you through it. Takes about 1 minute.

---

## Features

- **See all your tabs at a glance** on a clean grid, grouped by domain
- **Homepages stay with their site** so Gmail, GitHub, YouTube, and similar start pages remain in their own domain cards
- **Close tabs with style** with a confetti burst, undoable via toast
- **Duplicate detection** flags when you have the same page open twice, with one-click Dedupe per card + a global Dedupe in the header
- **Pin domain cards** to keep important sites at the top of the dashboard
- **Click any tab to jump to it** across Chrome windows
- **Live filter** — type in the filter input to narrow the dashboard; Esc clears. Matching bookmarks and recent history appear below open-tab matches, with a history range menu for last day/week/month/3 months, and non-matching tabs move to an "Other tabs" section so every tab stays accounted for
- **Filter keyboard shortcut** — press Cmd+K on macOS or Ctrl+K on Windows/Linux to focus the filter input
- **Filter shortcut support** — assign "Open Tab Out with the filter focused" in `chrome://extensions/shortcuts` to open a fresh dashboard tab ready for typing
- **Shared-page fold** — if the same path is open in multiple subdomains (e.g. `dev2`, `dev11`, `qa`), it collapses into one chip with a row of clickable env pills; each pill jumps to that specific tab
- **URL preview on hover** — Chrome-style bottom-left status bar shows the target URL for any chip or env pill
- **Suspended-tab support** — unwraps Marvellous / Great Suspender URLs and titles so chips read normally
- **Localhost grouping** shows port numbers next to each tab so you can tell your dev projects apart
- **Path-group clusters** — GitHub repos, Jira projects, Confluence spaces, Contentful envs, Figma files, and subreddits each cluster under a labeled sub-section within their domain card
- **Expandable sections** show the first 5 chips with a clickable "+N more" (skipped when N would be 1)
- **100% local** your data never leaves your machine
- **Pure Chrome extension runtime** no server, no account, no external API calls; the dashboard UI is built from React + TSX with Vite and packaged locally

---

## Manual Setup

**1. Clone the repo**

```bash
git clone https://github.com/zarazhangrui/tab-out.git
```

**2. Load the Chrome extension**

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Navigate to the `extension/` folder inside the cloned repo and select it

**3. Open a new tab**

You'll see Tab Out.

---

## How it works

```
You open a new tab
  -> Tab Out shows your open tabs grouped by domain
  -> Homepages stay inside their site's own domain card
  -> Click any tab title to jump to it
  -> Close groups you're done with (confetti burst)
```

Everything runs inside the Chrome extension. No external server, no API calls, no data sent anywhere.

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 (service worker + new-tab override) |
| Rendering | React + TSX, bundled by Vite into `extension/dist/app.js` |
| Layout | JS-driven Pinterest-style masonry |
| Animations | CSS transitions + JS confetti particles |
| State | In-memory cache over `chrome.tabs` / `chrome.tabGroups` / `chrome.windows`; `chrome.storage.local` only stores pinned domain-card order |

## Development

```bash
npm install
npm run setup:hooks
npm run dev
```

Load the `extension/` folder in Chrome. Keep `npm run dev` running while editing React/TSX files under `src/`; Vite rebuilds the packaged `extension/dist/app.js` bundle after each source change.

Refresh the Tab Out page to see rebuilt UI changes. Reload the extension in `chrome://extensions` when changing `manifest.json`, `background.js`, permissions, or service-worker behavior. Changes to plain extension files such as `extension/style.css`, `extension/render.js`, or `extension/index.html` do not need a Vite rebuild, but Chrome still needs a page or extension reload to pick them up.

Before committing:

```bash
npm run verify
```

`npm run verify` rebuilds `extension/dist/app.js` and fails if the committed bundle is out of sync with the source.

`npm run setup:hooks` enables the repo's pre-commit hook for this clone. The hook runs `npm run verify` before each commit, so stale bundled output is caught before it lands.

Use `npm run build:debug` when you need a local sourcemap.

---

## License

MIT

---

Built by [Zara](https://x.com/zarazhangrui)
