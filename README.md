# Tab Out

**Keep tabs on your tabs.**

Tab Out is a Chrome extension that replaces your new tab page with a dashboard of everything you have open. Tabs are grouped by domain, with homepages (Gmail, X, LinkedIn, etc.) pulled into their own group. Close tabs with a satisfying confetti burst.

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
- **Homepages group** pulls Gmail inbox, X home, YouTube, LinkedIn, GitHub homepages into one card
- **Close tabs with style** with a confetti burst, undoable via toast
- **Duplicate detection** flags when you have the same page open twice, with one-click Dedupe per card + a global Dedupe in the header
- **Click any tab to jump to it** across windows; a pinned Tab Out is auto-planted in every window so the dashboard is always one click away
- **Live filter** with type-anywhere — start typing and keystrokes route into the filter input; Esc clears; paste works too. Non-matching tabs move to an "Other tabs" section so every tab stays accounted for
- **Cross-subdomain fold** — a page that exists in multiple subdomains (e.g. `dev2`, `dev11`, `qa` envs) collapses into one chip with a row of clickable env pills; each pill jumps to that specific env's tab
- **URL preview on hover** — Chrome-style bottom-left status bar shows the target URL for any chip or env pill
- **Suspended-tab support** — unwraps Marvellous / Great Suspender URLs and titles so chips read normally
- **Localhost grouping** shows port numbers next to each tab so you can tell your dev projects apart
- **Path-group clusters** — GitHub repos, Jira projects, Confluence spaces, Contentful envs, Figma files, and subreddits each cluster under a labeled sub-section within their domain card
- **Expandable sections** show the first 5 chips with a clickable "+N more" (skipped when N would be 1)
- **100% local** your data never leaves your machine
- **Pure Chrome extension** no server, no Node.js, no npm, no build step — Preact + HTM are vendored as ES modules so edits reload instantly

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
  -> Homepages (Gmail, X, etc.) get their own group at the top
  -> Click any tab title to jump to it
  -> Close groups you're done with (confetti burst)
```

Everything runs inside the Chrome extension. No external server, no API calls, no data sent anywhere.

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 (service worker + new-tab override) |
| Rendering | Preact 10 + HTM (both vendored as ES modules, no build step) |
| Layout | JS-driven Pinterest-style masonry |
| Animations | CSS transitions + JS confetti particles |
| State | In-memory cache over `chrome.tabs` / `chrome.tabGroups` / `chrome.windows`; no server, no storage |

---

## License

MIT

---

Built by [Zara](https://x.com/zarazhangrui)
