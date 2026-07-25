# AGENTS.md -- Tab Out Coding Agent Guide

This repo is a Chrome Manifest V3 extension. Treat `AGENTS.md` as the day-to-day operating guide for coding agents. Use `README.md` for the public product tour and end-user install copy.

## Operating Priorities

- Start by checking the current code path before changing or documenting behavior.
- Keep changes narrow. Avoid broad UI rewrites, formatting churn, dependency updates, or generated bundle changes unrelated to the task.
- Edit source files first; regenerate bundles through the build scripts.
- Check `git status --short` before edits and before handoff. Leave unrelated dirty files untouched.

## Product Behavior Contracts

`CONTEXT.md` is the canonical durable behavior contract. Keep this guide operational: route behavior changes there rather than duplicating its rules.

- Before changing dashboard grouping, sources, cards, tab actions, history, Working Set, filtering, startup/hydration, or interaction behavior, read the relevant `CONTEXT.md` rules.
- Update `CONTEXT.md` in the same patch only when intentional durable behavior changes; do not update it for copy tweaks, CSS-only polish, temporary experiments, or internal refactors.
- Preserve the cross-cutting privacy boundary: Tab Out is unavailable in Incognito, and private browsing data must never enter shared extension storage.
- Put decision rationale or historical tradeoffs in a focused `docs/adr/` record rather than expanding this file.

## Source And Build

- Runtime source lives under `src/`.
- The unpacked Chrome extension surface is `extension/`.
- Manifest source lives in `src/extension/manifest.ts`; `pnpm build` regenerates `extension/manifest.json`.
- Dashboard page generation lives in `src/index-html.tsx`, beside `src/app.tsx`, because it renders UI rather than extension-layer logic; its static wrapper lives in `src/index-html.template.html`. `pnpm build` imports that wrapper as text and regenerates `extension/index.html`. The generator prerenders the same `AppRoot` that `src/app.tsx` attaches, so the generated shell and the client's first render share one component declaration.
- Vite builds:
  - `src/app.tsx` to `extension/dist/app.js`
  - `src/extension/filter-focus-boot.ts` to `extension/dist/filter-focus-boot.js`
  - `src/extension/background.ts` to `extension/dist/background.js`
  - `src/styles/app.css` plus extension styles to `extension/dist/assets/app.css`
- `pnpm build` intentionally runs entry-specific Vite builds so the MV3 service worker stays a standalone `extension/dist/background.js`; use the package scripts instead of raw `vite build` when regenerating committed bundles.
- `src/`, `extension/base.css`, `chrome-support.json`, `package.json`, `scripts/write-manifest.ts`, and `vite.config.ts` are watched by `pnpm dev`.
- `extension/index.html` and `extension/manifest.json` are generated runtime package files. HTML changes need a page or extension reload; manifest, permission, and service-worker changes need an extension reload in `chrome://extensions`.
- Do not hand-edit `extension/dist/*`, `extension/index.html`, or `extension/manifest.json` except for emergency diagnosis. Regenerate generated output with `pnpm build` or `pnpm verify`.
- When source or style changes legitimately alter `extension/dist/*`, include the generated bundle changes in the final ready-to-commit diff.

## Chrome Support Policy

- `chrome-support.json` records the approved minimum Chrome major and when it last changed. The updater computes the latest-two floor as one less than the slowest Windows, macOS, or Linux Stable feed.
- Vite's exact build target and the manifest's `minimum_chrome_version` derive from that policy. Do not add a Browserslist configuration unless a concrete compatibility tool will consume it; Browserslist is not the Vite or extension-install authority.
- `pnpm chrome-support:check` is deterministic and offline. It validates the policy, generated manifest, and the Chromium major bundled by Playwright for minimum-version browser tests; it runs first in `pnpm verify` and therefore in the pre-commit hook.
- `pnpm chrome-support:bump` forces a fresh complete platform check, updates the policy only when the common floor advances, rebuilds generated output, and checks consistency. A floor advance also requires an `@playwright/test` release whose bundled Chromium has that major. Review the diff; the command never stages, commits, pushes, or lowers the floor.
- `pnpm chrome-support:release-check` performs the same fresh observation without writing. The weekly read-only workflow uses it to surface a stale floor.
- `lastBumpedAt` is audit metadata, not a reason to skip scheduled checks. See `docs/adr/0003-rolling-chrome-support-floor.md`.

## Development Loop

```bash
pnpm install
pnpm exec playwright install chromium
pnpm setup:hooks
pnpm dev
```

- Use the exact Node version pinned in `.node-version`. Activate it with a version manager that reads the file. With Nub, `nub node install` provisions the pin and `nub run --node <script>` runs a package script through it; pnpm remains authoritative for installs and the lockfile.
- Run `pnpm install` when dependencies are missing or `pnpm-lock.yaml` changes.
- Run `pnpm dev` while editing source or bundled styles.
- Use `pnpm verify:quick` for an iteration-only parallel pass over typechecking, lint, React Doctor, and the React Compiler baseline check. It does not replace the full verification pipeline.
- Use `pnpm lint:tailwind` to run the official Tailwind language server across repository source documents; it checks all enabled diagnostics, including canonical-class suggestions and CSS conflicts, and runs inside both verification pipelines.
- Refresh the Tab Out page for dashboard/UI changes.
- Reload the extension in `chrome://extensions` for manifest, permission, service-worker, or extension package changes.
- Use `pnpm build:debug` only when a local sourcemap is needed.

## Verification

- Code changes: run `pnpm verify` before handoff unless there is a clear blocker.
- UI/layout changes: run `pnpm verify`; also run `pnpm test:browser`, `pnpm verify:browser`, or perform real Chrome visual inspection when practical. The Playwright harness runs its bundled Chromium at the declared minimum Chrome major, owns its local server instead of reusing another worktree's process, and accepts `TAB_OUT_PLAYWRIGHT_PORT` for concurrent worktree runs; install Chromium once with `pnpm exec playwright install chromium`. If browser verification is skipped, say why.
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

- For implementation tasks, commit each independently verified logical change as soon as it is ready; do not accumulate unrelated fixes in one commit.
- Stage only the files that belong to that logical change.
- Do not amend, rewrite history, or push unless explicitly requested.
- Use a Conventional Commit subject that makes the touched product or code area obvious, such as `fix(page-chip): keep expansion anchored`, `perf(filter): focus input before app mount`, or `build: generate typed extension manifest`.
- Prefer domain-specific scopes over broad buckets like `ui`; examples include `page-chip`, `domain-card`, `activation-history`, `working-set`, `suspend`, `build`, or another clear repo-local area.
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
## First-Time Install Requests

For installation or onboarding, use the canonical product copy and setup flow in `README.md` (`Install with a coding agent` and `Manual Setup`). Do not duplicate that flow here.

## Local Workflow Docs

- Issue tracker: local markdown issues live under `.scratch/<feature>/`; see `docs/agents/issue-tracker.md`.
- Triage labels: use the default five-status vocabulary; see `docs/agents/triage-labels.md`.
- Domain docs: this is a single-context repo with root `CONTEXT.md` and optional `docs/adr/`; see `docs/agents/domain.md`.
- UI debugging: `docs/debugging-the-dashboard.md` covers fixture-based inspection and real-extension geometry probes; completed engineering audits are summarized in `docs/engineering-change-ledger.md`.
