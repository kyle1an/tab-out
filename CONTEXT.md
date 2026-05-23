# Context

## Domain Language

- **Dashboard**: The Tab Out new-tab surface that shows open tabs and related sources grouped for cleanup.
- **Source**: The selected dashboard input: open tabs, bookmarks, or history.
- **Dashboard Item**: A tab-shaped page from any Source that can be grouped and rendered on the Dashboard.
- **Domain Card**: A dashboard group for one registrable domain or fixed system group.
- **Domain Card Identity**: The stable `domain-*` key shared by card order memory, Domain Card view data, React keys, and card move animation DOM hooks.
- **Page Chip**: A clickable row or icon inside a Domain Card that represents one page, duplicate set, app, or folded cross-subdomain page.
- **Website Path Section**: A visible group inside a Domain Card keyed by the shortest meaningful website path prefix on a known host.
- **Path Group**: A visible group inside a Website Path Section or subdomain section keyed by a site-specific object such as a repository, project key, space key, or environment.
- **Title Suppression Scope**: The smallest visible group that owns suppressed title tokens and their matching chip markers.
- **Filter Query**: The user's parsed filter intent for app-owned matching, first applied to open-tab and bookmark Dashboard Items.
- **Filter Match**: A decision that a Dashboard Item satisfies the current Filter Query.
- **Companion Results**: Bookmark and history results shown alongside open-tab Filter Matches.
- **Activation History**: The chronological open-tab focus path used for previous/next tab switching and close-recovery behavior.
- **Working Set**: A ranking signal over open-tab Dashboard Items that the user is likely to return to before scanning Domain Cards or using a Filter Query.
- **Tab Action**: A user intent from the dashboard that mutates tabs or history, records undo/toast feedback, and refreshes the Dashboard.

## Relationships

- A **Website Path Section** uses known-host URL path rules first, then falls back to a generic first-segment section only when that segment has multiple pages in the current root/subdomain section and grouping reduces clutter.
- Tenant-style **Domain Cards** keep subdomain sections outside **Website Path Sections**, so unrelated tenants are not mixed before their website paths are grouped.
- A **Website Path Section** is visible only when it reduces ambiguity: multiple website path sections are present, or one section groups multiple pages while sibling pages remain outside it.
- **Website Path Sections** do not introduce a new indentation level unless their title-suppression summaries can stay visually aligned with the group that owns them.
- A **Website Path Section** may contain one or more **Path Groups**, and a **Path Group** may contain one or more **Page Chips**.
- **Path Group** singleton behavior belongs to the Path Group rule itself; adding a **Website Path Section** does not change whether a single site-specific object stays grouped.
- A **Page Chip** shows a URL path suffix only when another chip in the same rendered group has the same visible title; sibling Website Path Sections and Path Groups already provide enough context.
- Same-title **Page Chips** with different effective URLs inside the same rendered group merge visually into one title row with per-URL distinguishers; the distinguishers remain the focus and close/delete targets.
- For `docs.google.com`, **Website Path Sections** start with document-creation product paths: `/document`, `/spreadsheets`, `/presentation`, `/forms`, and `/drawings`.
- For `*.atlassian.net`, **Website Path Sections** start with workflow/product path prefixes: `/browse`, `/issues`, `/wiki`, `/jira`, and `/servicedesk`.
- For other sites, **Website Path Sections** may use the first path segment such as `/resource`, but singleton generic segments stay flat.
- A **Filter Query** is the app-owned matching contract for open-tab and bookmark **Dashboard Items**.
- A **Dashboard Item's** first-pass searchable text is its title and URL.
- Unquoted multi-word **Filter Queries** use tokenized AND semantics, so each term must appear somewhere in the Dashboard Item's searchable text.
- Quoted terms inside a **Filter Query** are exact contiguous phrase matches against a Dashboard Item's searchable text.
- Unquoted **Filter Query** tokens may have app-owned aliases; `pr` matches `pull request` in first-pass matching.
- An unmatched quote in a **Filter Query** treats the rest of the input as a quoted phrase.
- Deterministic **Filter Matches** from tokens and quoted phrases are eligible for existing filtered Tab Actions.
- First-pass **Filter Matches** preserve existing Dashboard Item order rather than ranking by match quality.
- Filter highlighting marks each parsed term or quoted phrase that contributes to an app-owned **Filter Match**.
- **Companion Results** are loaded only while open tabs are the selected **Source**, so they do not replace the selected source view.
- Bookmark **Filter Matches** and history **Companion Results** remain read-only **Dashboard Items** even though they render as Page Chips.
- A **Working Set** is merged into **Activation History**: overlapping items mark their history rows, and high-ranked items missing from history appear as supplemental history-panel rows.
- A **Working Set** is not a **Source** and does not include bookmark or history **Dashboard Items**.
- A **Working Set** crosses **Domain Card** boundaries because it is optimized for return switching rather than domain cleanup.
- A **Working Set** prefers currently relevant open tabs: recent activations, repeated same-day navigation/use, and repeated current-week navigation/use can all raise an item, while older or monthly habits are only weak tie-breakers.
- A **Working Set** may use historical activity signals to rank items, but every visible item must focus an existing open tab.
- A **Working Set** treats active tab activation and active meaningful navigation as strong activity signals.
- A **Working Set** treats repeated same-day exact page/path use as a medium activity signal, repeated current-week exact page/path use and same-domain habit as weak activity signals, and passive open duration or background tab churn as non-signals.
- A **Working Set** ranks items by recency-dominant frecency and exposes a bounded top set as history hints, supplemental rows, and open-tab priority inside existing Domain Card scopes.
- A **Working Set** excludes Tab Out pages, folds duplicate effective URLs, and does not treat Domain Card pins as a primary ranking signal.
- A **Working Set** does not render as a standalone strip before **Domain Cards**; the fallback flow is **Activation History**, stable **Domain Cards**, then **Filter Query**.
- A **Working Set** is for switching: its items support focus and URL preview, while cleanup actions remain in owning **Domain Cards**.
- **Working Set** activity is local, bounded, and open-tab oriented; it identifies candidates by effective page identity for ranking and by live tab identity only for focusing.
- **Working Set** activity scores should mostly come from recent days, with older activity pruned or retained only as a weak tie-breaker.
- **Working Set** page identity should distinguish meaningful path changes while avoiding noisy query, hash, redirect, or background-update churn.
- **Activation History** and **Working Set** may use overlapping activity evidence, but **Activation History** is chronological switching state while **Working Set** is ranked shortcut discovery.
- **Activation History** treats browser utility pages such as Tab Out, new-tab, settings, internal Chrome, and extension pages as low-score rows even when they are current or active; suspended extension URLs unwrap to their real page before this decision.
- A **Working Set** does not change **Domain Card** ordering; it may prioritize sibling subdomain sections, Website Path Sections, Path Groups, and Page Chips within a Domain Card, and any future **Filter Match** ranking use should treat Working Set activity as a tie-breaker rather than replacing match semantics.
- A **Working Set** excludes utility pages such as Tab Out pages and should drop non-open pages from the visible set while retaining recent activity only as historical ranking evidence.
- A **Title Suppression Scope** is owned by exactly one visible group: a **Domain Card**, Website Path Section, subdomain section, or Path Group.
- Repeated title noise inside a visible **Website Path Section** is scoped to that section when no narrower **Path Group** owns it.
- A **Title Suppression Scope** owns its summary tokens and matching chip markers; visible scopes coordinate palette colors within a **Domain Card** so two visible suppression meanings do not use the same color.
- **Title Suppression Summary** tokens render in source-title reading order, so the summary reconstructs where suppressed text came from instead of ranking tokens by frequency.
- **Title Suppression Scope** colors are allocated by token coverage before summary position; broad, high-coverage tokens can keep stable early palette colors even when they render later in the summary.
- A single-token **Title Suppression Scope** uses the same local palette as a multi-token scope for its summary token and matching chip markers when those markers span multiple rendered child groups and the **Domain Card** has more than one visible title-suppression meaning.
- Title suppression color assignment is stable across collapsed and expanded child groups.
- Title suppression colors may be reused only after the available palette colors are exhausted within a **Domain Card**.
- Neutral single-token **Title Suppression Scopes** do not consume palette colors.

## Flagged Ambiguities

- **History Companion Results** still rely on Chrome history search semantics; whether to fetch broad history candidates and apply app-owned **Filter Query** matching is deferred.
