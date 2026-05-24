# AGENTS.md -- Tab Out Coding Agent Guide

This repo is a Chrome Manifest V3 extension. Treat `AGENTS.md` as the day-to-day operating guide for coding agents. Use `README.md` for the public product tour and end-user install copy.

## Operating Priorities

- Start by checking the current code path before changing or documenting behavior.
- Keep changes narrow. Avoid broad UI rewrites, formatting churn, dependency updates, or generated bundle changes unrelated to the task.
- Edit source files first; regenerate bundles through the build scripts.
- Do not stage, commit, amend, rewrite history, or push unless the user explicitly asks for that action.
- Check `git status --short` before edits and before handoff. Leave unrelated dirty files untouched.

## Product Behavior Contracts

Update this section in the same patch when a change intentionally alters one of these durable behaviors. Do not update it for copy tweaks, CSS-only polish, temporary experiments, or internal refactors.

- The dashboard groups open tab-like items by registrable domain. Homepage-like routes stay inside their site's normal domain card instead of being split into special homepage groups.
- The tab source shows real web tabs plus Tab Out/new-tab pages. Chrome internal pages and unrelated extension pages are otherwise excluded from normal dashboard cards.
- Standalone app/PWA windows are shown in the `Apps` utility card, do not receive active-tab highlighting, and are treated as low-score activation-history entries.
- `New tabs` (`__tab-out__`) and `Apps` (`__standalone-apps__`) are utility cards. They are unpinned by default, but the user can explicitly pin them like other pinnable cards.
- Domain-card pins are user-facing dashboard ordering state stored in `chrome.storage.local`; they are separate from Chrome's native `tab.pinned` flag.
- Within each rendered domain card, open-tab subdomain sections, Website Path Sections, Path Groups, and Page Chips may rank by Working Set priority so frequently used pages stay visible; non-prioritized chips keep their remembered effective-URL order across refreshes, and title/loading/favIcon changes update the chip in place instead of re-sorting existing chips.
- Saved Pages are explicit user-kept Tabs-source items stored in `chrome.storage.local`, not Chrome bookmarks. A saved page merges with its matching open tab; when closed, it stays in the normal domain card, opens in a new active tab, can match filtering, and stays out of open-tab counts, close-all targets, and dedupe extras.
- Duplicate handling renders one chip per effective URL with a count badge and keeps one copy according to the shared dedupe policy. Bulk close and dedupe preserve Chrome tab groups; Tab Out dedupe preserves pinned Tab Out tabs.
- Same-title pages with different effective URLs inside one rendered group merge visually into one title row with per-URL distinguishers. They are not URL duplicates; focus and close/delete actions stay scoped to the selected distinguisher.
- Filtering keeps matching open tabs in their normal cards and moves non-matching open tabs into the secondary "Other tabs" grid so every open tab remains accounted for.
- While filtering the tab source, bookmark matches and history matches may appear as companion results. Bookmark and history results are read-only dashboard items; tab mutation actions must stay disabled for them.
- History companion results are controlled by the history range menu: off, last day, last week, last month, or last 3 months.
- A page open at the same path across two or more named subdomains folds into one headerless shared chip at the top of the card. Env pills focus the exact tab for that subdomain, and closing the folded chip closes every env copy.
- Chip hover/focus updates the bottom-left URL preview for the exact target URL, including env pills.
- Activating a suspended page from Tab Out asks the owning suspender extension to unsuspend that exact tab first, then falls back to navigating the same tab to the unwrapped target URL if the extension cannot be messaged.
- Undo for close/dedupe actions restores tabs with `chrome.tabs.create({ active: false })` so the dashboard does not lose focus. Do not switch to `chrome.sessions.restore()` unless intentionally changing that UX contract.
- Source-specific behavior and terminology live in `CONTEXT.md`; consult it before changing grouping, filtering, title suppression, website path sections, path groups, or source composition.

## Source And Build

- Runtime source lives under `src/`.
- The unpacked Chrome extension surface is `extension/`.
- Vite builds:
  - `src/app.tsx` to `extension/dist/app.js`
  - `src/extension/background.ts` to `extension/dist/background.js`
  - `src/styles/app.css` plus extension styles to `extension/dist/assets/app.css`
- `pnpm build` intentionally runs entry-specific Vite builds so the MV3 service worker stays a standalone `extension/dist/background.js`; use the package scripts instead of raw `vite build` when regenerating committed bundles.
- `extension/base.css`, `extension/style.css`, and `vite.config.ts` are watched by `pnpm dev`.
- `extension/index.html` and `extension/manifest.json` are runtime package files. HTML changes need a page or extension reload; manifest, permission, and service-worker changes need an extension reload in `chrome://extensions`.
- Do not hand-edit `extension/dist/*` except for emergency diagnosis. Regenerate generated output with `pnpm build` or `pnpm verify`.
- When source or style changes legitimately alter `extension/dist/*`, include the generated bundle changes in the final ready-to-commit diff.

## Development Loop

```bash
pnpm install
pnpm setup:hooks
pnpm dev
```

- Run `pnpm install` when dependencies are missing or `pnpm-lock.yaml` changes.
- Run `pnpm dev` while editing source or bundled styles.
- Refresh the Tab Out page for dashboard/UI changes.
- Reload the extension in `chrome://extensions` for manifest, permission, service-worker, or extension package changes.
- Use `pnpm build:debug` only when a local sourcemap is needed.

## Verification

- Code changes: run `pnpm verify` before handoff unless there is a clear blocker.
- UI/layout changes: run `pnpm verify`; also run `pnpm test:browser`, `pnpm verify:browser`, or perform real Chrome visual inspection when practical. If skipped, say why.
- Extension API, shortcut, service-worker, tab/window, new-tab override, or focus behavior: prefer real Chrome inspection because harness tests cannot prove `chrome.*` runtime behavior.
- Docs-only changes: focused checks are enough, such as `git diff --check -- AGENTS.md README.md`.
- Commits: the pre-commit hook runs `pnpm verify`; enable it once per clone with `pnpm setup:hooks`.

## Live QA And Inspection

- For live Tab Out behavior, inspect the real Chrome extension page, not the Codex in-app browser.
- The in-app browser or a localhost/file harness can render the shell, but it does not prove real `chrome.*` behavior, service-worker behavior, tab/window data, extension shortcuts, new-tab overrides, or extension-page focus.
- Prefer `@Computer` for visible real-Chrome checks of the Tab Out new-tab page.
- Prefer a working Chrome DevTools/CDP endpoint when DOM, console, service-worker, or network-level evidence is needed.
- Clearly label any harness-only verification as limited.

## Git And Commits

- Do not stage files unless the user explicitly asks to stage, commit, or prepare a commit.
- Do not commit, amend, rewrite history, or push unless explicitly requested.
- When asked to commit, use a conventional commit subject such as `fix(ui): ...`, `refactor(ui): ...`, or `feat(ui): ...`.
- For Codex-authored or Codex-assisted commits, include `Co-authored-by: Codex <noreply@openai.com>` as the final non-empty line.
- Do not leave an extra blank line after the `Co-authored-by` trailer. GitHub may fail to render the co-author even when local `git interpret-trailers` still parses it.
- For metadata-only commit-message rewrites, preserve author and committer timestamps.
- Before rewriting published history, create a backup branch.
- Push rewritten published history only with `git push --force-with-lease`.

## React Compiler

- React Compiler is enabled for this repo.
- Do not add `useMemo`, `useCallback`, or `React.memo` as default render-performance guards in new code.
- Use manual memoization only when function or object identity is part of the behavior contract, such as stable values passed through React context, callbacks returned from custom hooks where consumers depend on stable identity, effect/listener/timer cleanup patterns that require stable references, or third-party component APIs that depend on referential equality.
- When touching existing manual memoization, remove it only with focused verification. Existing hooks may be preserving behavior or compiler output.

## UI Implementation

- Preserve the compact dashboard density and existing visual language during narrow fixes.
- Prefer existing local components and wrappers under `src/components/ui/`.
- The repo uses Base UI, shadcn configuration, Tailwind v4 utilities, and `lucide-react`. Use those patterns for new UI where they fit, but do not churn existing inline SVGs during unrelated fixes.
- Add stable UI anchors to user-facing surfaces and actions that agents, tests, or live QA need to identify. Prefer existing semantic classes when they also serve styling, `data-slot` for shared UI primitive parts, `data-tabout="<landmark>"` for stable product-level landmarks, and `data-tabout-part="<part>"` for important sub-actions inside them. Do not use `data-testid` as the default anchor, and do not name every wrapper element; use anchors for meaningful surfaces, actions, and rare repeatedly-debugged layout parts.
- Use `data-tabout` values that match `CONTEXT.md` domain language for product landmarks, such as `domain-card`, `page-chip`, `activation-history`, `working-set`, or `filter-query` when it maps to the visible filter. Use plain DOM/action part names for `data-tabout-part`, such as `close-button`, `pin-button`, or `source-option`; avoid React component names unless the component name is also the product term.
- Place `data-tabout` and `data-tabout-part` near the front of JSX props, after element-defining props such as `type`, `role`, `href`, `value`, or `tabIndex`, and before `className`, accessibility props, and event handlers.
- Use explicit `data-*` state attributes instead of semantic class names when a marker exists only for tests, QA, or state inspection and is not consumed by CSS, layout, animation, or runtime selectors.
- Tests may use UI anchors for layout surfaces, repeated dashboard items, and extension/browser-smoke checks where role or text selectors are weak. Prefer role, label, or text selectors for true controls when those selectors are stable and user-meaningful.
- Do not mass-retrofit UI anchors across untouched surfaces. Add or adjust anchors when changing or debugging that surface; a focused pass is acceptable only for frequently referenced top-level landmarks such as the dashboard shell, source switch, filter, Domain Card, Page Chip, Activation History, Working Set, tooltip content, or menu content.
- Add `corner-shape: squircle` to non-round UI elements that use `border-radius`.
- Do not add squircle styling to true circles or pills such as `border-radius: 50%` or `999px`.
- Squircle corners read less rounded than ordinary rounded corners. As a visual rule of thumb, a `4px` squircle looks similar to a `2px` non-squircle corner.

## Privacy Hygiene

- Do not commit real/private URLs, customer domains, tenant names, account names, project keys, space IDs, entry IDs, route paths, content titles, or screenshot-derived labels in comments, tests, fixtures, documentation, or example data.
- Use fake or generic values that preserve only the structural shape needed for the behavior under test, such as `example.com`, `example.test`, `example-space`, `env-alpha`, `entry-alpha`, and neutral titles like `Example Article`.
- Public product hosts are allowed in implementation code when the feature depends on them, such as host-specific path-group rules, but tests should still use generic tenants, paths, IDs, and titles.
- When adapting a real repro into a test or doc, replace all customer, product, content, and route wording with neutral examples before committing.
- `extension/config.local.js` is gitignored personal config. Inspect it only when debugging user-specific local grouping behavior, never commit it, and never copy real local values from it into tracked files.

## First-Time Install Requests

Use this section only when the user asks to install or onboard Tab Out. For ordinary coding, review, debugging, or QA tasks, skip the product pitch and go straight to repo work.

Short intro:

> Tab Out replaces your new tab page with a local Chrome dashboard of open tabs grouped by domain. It helps you jump between tabs, close clutter with undo, dedupe repeated pages, filter tabs/bookmarks/history, and fold matching pages across subdomains. No server, no account, no external API calls.

If the repo is not cloned yet:

```bash
git clone https://github.com/zarazhangrui/tab-out.git
cd tab-out
```

Then help the user load the unpacked extension:

```bash
extension_path="$(cd extension && pwd)"
echo "Extension folder: $extension_path"
printf "%s" "$extension_path" | pbcopy && echo "Path copied to clipboard"
open "chrome://extensions"
open "$extension_path"
```

Manual steps to give the user:

1. In Chrome's extensions page, turn on Developer mode.
2. Click Load unpacked.
3. Paste the copied `extension/` path into the file picker.
4. Select the folder and open a new tab.

For Linux, use `xclip` or print the path if clipboard support is unavailable. For Windows, use `clip` and `explorer extension\\`.

## Local Workflow Docs

- Issue tracker: local markdown issues live under `.scratch/<feature>/`; see `docs/agents/issue-tracker.md`.
- Triage labels: use the default five-status vocabulary; see `docs/agents/triage-labels.md`.
- Domain docs: this is a single-context repo with root `CONTEXT.md` and optional `docs/adr/`; see `docs/agents/domain.md`.
- `docs/superpowers/*` contains historical plans/specs; read those only when the task names them or touches that exact work.
