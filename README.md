# Tab Out

**Keep tabs on your tabs.**

Tab Out is a Chrome extension for Apple silicon Macs that replaces your new tab page with a dashboard of everything you have open. Tabs are grouped by domain so each site's homepages and content pages stay together. Close tabs with a polished collapse animation and undo toast.

The supported target is Chrome on Apple silicon. The unpacked extension does not block other Mac architectures, but they are outside the release and compatibility contract.

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
- **Close tabs with style** with a polished collapse animation, undoable via toast
- **Duplicate detection** flags when you have the same page open twice, with one-click Dedupe per card, a global Dedupe in the header, and a toolbar badge that shows how many duplicates can be safely closed — clicking the icon opens the Tab Actions menu whose Dedupe option cleans them up
- **Pin domain cards** to keep important sites at the top of the dashboard, plus per-card section and page-chip pins that keep important pages first inside their card
- **Click any tab to jump to it** across Chrome windows
- **Dashboard views** — start with **All Tabs**, narrow the page to open tabs and Saved Pages with **Open + Saved**, or browse **Bookmarks**
- **Move or open with a modifier-click** — Cmd-click any chip or history row to pull that tab into the current window in the background, Cmd+Shift-click to pull it here and switch to it, or Shift-click to move the tab into a new Chrome window; if the page has no live tab, the current-window move gesture opens it in a new tab and Shift-click opens it in a new window
- **Move the page you are viewing** — click the Tab Out toolbar icon and choose **Move current tab to new window** to detach that exact tab without opening the Dashboard
- **Merge this macOS Desktop into one window** — with the optional local Hammerspoon integration, the final option in the toolbar Tab Actions menu safely combines eligible Chrome windows from the same active Desktop while preserving tab order, pins, mute/discard state, and whole tab groups
- **Activation history column** — your chronological tab-switching path with working-set hints and recently closed rows you can restore or forget
- **Saved pages** — explicitly keep a page on its card after the tab closes, and reopen it with one click (local state, not a Chrome bookmark)
- **Closed-page retention** — genuinely closed pages remain available in **All Tabs** on their usual cards for up to 30 days, using the same closed-chip presentation as Saved Pages; reopen them, save them permanently, or remove them from Tabs
- **Audio at a glance** — chips and history rows show Chrome-style play/mute indicators with a click-to-mute toggle
- **Suspend tabs** — bulk-suspend a card from its actions menu, or suspend a single page from its right-click menu, through your own suspender extension
- **Right-click menus** — copy a page title, save a page, or suspend it from any chip or history row; group chips can close all their URL variants at once
- **Filter-match highlighting** — matched terms are marked in chip and history-row titles while you filter
- **Live filter** — type in the filter input to show only matching dashboard items; the clear button restores the selected Dashboard View. Matching bookmarks and recent history appear below Tabs-source matches, with a remembered history range menu for last day/week/month/3 months
- **Keyboard-driven filter results** — typing keeps selection in the filter input; press Arrow Down to select the first visible result or Arrow Up to select the last, then use those arrows to move in result order and Arrow Left/Right to move by the results' on-screen positions. Enter opens or switches to the selected result (or the first result before selection), Shift+Enter uses a new window, Cmd+Enter brings it into the current window in the background, and Cmd+Shift+Enter brings it here and switches
- **Filter keyboard shortcut** — press Cmd+K to focus the filter input
- **Filter shortcut support** — assign "Open Tab Out with the filter focused" in `chrome://extensions/shortcuts` to open a fresh dashboard tab ready for typing
- **Global new-tab shortcut support** — assign "Open a new Tab Out tab" in `chrome://extensions/shortcuts` and set it to Global to create a fresh Tab Out page even when Chrome is not focused
- **Shared-page fold** — if the same path and visible title are open in multiple subdomains (e.g. `dev2`, `dev11`, `qa`), they collapse into one chip with a row of clickable env pills; same-path tabs with different titles stay separate, and each pill jumps to its specific tab
- **URL preview on hover** — Chrome-style bottom-left status bar shows the target URL for any chip or env pill
- **Suspended-tab support** — unwraps Marvellous / Great Suspender URLs and titles so chips read normally, recovers the real page favicon over the suspender's faded copy, and unsuspends through the owning suspender when activated
- **Liveness at a glance** — favicon strength shows whether an awake tab backs each chip or history row: live pages stay full color, suspended and closed ones dim; standalone apps wear a ringed favicon with their raw window titles in both the Apps card and history
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

### Optional macOS Hammerspoon integration

The companion Hammerspoon shortcuts can create Tab Out on the display under the
pointer without assigning hidden Chrome shortcuts. The same local integration
enables **Merge windows on this desktop…** in the toolbar Tab Actions menu. Copy
Tab Out's 32-character ID from `chrome://extensions`, then install the Spoon and
user-level native host, refresh dependencies and generated output, configure the
Git hooks, and run the integration doctor with one command:

```bash
pnpm setup:local <extension-id>
```

Later repository updates normally need only `pnpm setup:local`; it reuses the
installed native-host manifest. When the selected Hammerspoon configuration is
not `~/.hammerspoon`, pass its directory as the optional second argument or set
`TAB_OUT_HAMMERSPOON_CONFIG_DIR`.

Configure `spoon.TabOut:start(config)` through your Hammerspoon configuration;
the companion `hammerspoon-config` repository keeps its profile and keybindings
in ignored `tab-out.local.lua`. Then reload Tab Out from `chrome://extensions`.
On first setup, open its toolbar menu in that intended profile and choose **Use
this Chrome profile for macOS integration**. Tab Out may be loaded in additional
profiles later without transferring that selection. To intentionally choose a
different owner, run `pnpm setup:local --reset-profile`; it revokes any live
owner before returning. Then reload the extension and select again from the
intended profile. The complete configuration,
diagnostic, permission, and live-acceptance guide is in
[`integrations/hammerspoon/README.md`](integrations/hammerspoon/README.md).

Run the read-only integration doctor, inspect the lower-level host, or remove
the whole macOS integration with:

```bash
scripts/doctor-macos-integration ~/.hammerspoon
scripts/native-host/status
scripts/uninstall-macos-integration ~/.hammerspoon
```

Chrome starts the host only while the extension is connected. Installation
adds a checkout-owned Spoon link and per-user native-host files, but no
LaunchAgent, login item, root file, or network listener.

---

## How it works

```
You open a new tab
  -> Tab Out shows your open tabs grouped by domain
  -> Homepages stay inside their site's own domain card
  -> Click any tab title to jump to it
  -> Close groups you're done with, with undo
```

Everything runs inside the Chrome extension. No external server, no API calls, no data sent anywhere.

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 (service worker + new-tab override) |
| Rendering | React + TSX source under `src/`, bundled by Vite into `extension/dist/app.js` |
| Styling | Semantic CSS classes plus Tailwind v4 utilities, bundled by Vite into `extension/dist/assets/app.css` |
| Service worker | Source under `src/extension/background.ts`, bundled by Vite into `extension/dist/background.js` |
| macOS integration | Optional Swift native-messaging host and Hammerspoon Spoon for placement shortcuts and same-Desktop window merge, installed per user |
| Layout | JS-driven Pinterest-style masonry |
| Animations | CSS transitions + JS-driven close and move animations |
| State | In-memory cache over `chrome.tabs` / `chrome.tabGroups` / `chrome.windows`; trusted extension storage keeps user state such as pins, Saved Pages, temporary closed-page retention, activation history, working-set activity, and the detected suspender |

## Development

Use the Node and pnpm versions pinned by `.node-version` and `package.json#packageManager` before running the toolchain. With Mise configured to read those version files, `mise install` provisions both tools. Once Mise is active, use the normal `pnpm` commands below; `mise exec -- pnpm <script>` is the fallback when shell activation is unavailable. pnpm remains the installer and lockfile authority.

```bash
pnpm install
pnpm setup:hooks
pnpm dev
```

Load the `extension/` folder in Chrome. Keep `pnpm dev` running while editing source files under `src/`, `extension/base.css`, package metadata, or the manifest and page writers; the repo watcher runs manifest and `index.html` generation plus Vite rebuilds for the packaged `extension/dist/app.js` dashboard bundle, `extension/dist/filter-focus-boot.js` early-filter bundle, `extension/dist/assets/app.css` stylesheet bundle, and `extension/dist/background.js` service-worker bundle after each source change.

Refresh the Tab Out page to see rebuilt dashboard changes. Reload the extension in `chrome://extensions` when changing `src/extension/manifest.ts`, permissions, or service-worker behavior. `pnpm build` regenerates `extension/manifest.json` and `extension/index.html`. Changes to `src/styles/app.css` or `extension/base.css` flow through the Vite stylesheet bundle, so keep `pnpm dev` running for those too. Edit the dashboard's static wrapper through `src/index-html.template.html` and its prerender logic through `src/index-html.tsx` rather than editing `extension/index.html`, then reload the page or extension to pick the rebuilt HTML up.

The `extension/` folder is the unpacked Chrome package surface. Runtime source lives under `src/`; generated bundles live under `extension/dist/`.

Before committing:

```bash
pnpm verify
```

When changing the macOS integration, also run `pnpm native-host:test` and
`pnpm hammerspoon:test`.

`pnpm verify` regenerates `extension/index.html`, `extension/manifest.json`, and `extension/dist/**`, then fails if any committed package output is out of sync with the source.

For a faster iteration-only pass, `pnpm verify:quick` runs typechecking, lint, architecture, peer-dependency, unused-code, React Doctor, and React Compiler checks in parallel. It does not build bundles or run tests, so it does not replace `pnpm verify` before committing. When shell activation is unavailable, run the pinned-tool form with `mise exec -- pnpm verify:quick`.

Before the first browser-harness run, install the pinned minimum-version browser with `pnpm exec playwright install chromium`. Use `pnpm test:browser:smoke`, `pnpm test:browser:layout`, or `pnpm test:browser:first-paint` for a focused iteration. `pnpm test:browser` and `pnpm test:browser:all` run every HTTP-fixture browser spec, while `pnpm verify:browser` runs the normal verification pipeline followed by that complete browser suite. `pnpm verify:extension` instead runs normal verification plus every non-benchmark packaged-extension spec. These commands use the bundled Chromium; real Chrome is still required to verify extension APIs, service workers, and other `chrome.*` behavior.

`pnpm setup:hooks` enables the repo's pre-commit, commit-message, and pre-push hooks for this clone. The pre-commit hook runs `pnpm verify`; the other hooks reject GitHub reference and mention syntax before an immutable commit message can create an unintended link or notification. See [`docs/agents/commit-reference-hygiene.md`](docs/agents/commit-reference-hygiene.md) for the wording policy and legacy-worktree boundary.

Use `pnpm build:debug` when you need a local sourcemap.

---

## License

MIT

---

Built by [Zara](https://x.com/zarazhangrui)
