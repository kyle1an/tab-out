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
- **Tab Action**: A user intent from the dashboard that mutates tabs or history, records undo/toast feedback, and refreshes the Dashboard.

## Relationships

- A **Website Path Section** uses known-host URL path rules first, then falls back to a generic first-segment section only when that segment has multiple pages in the current root/subdomain section and grouping reduces clutter.
- Tenant-style **Domain Cards** keep subdomain sections outside **Website Path Sections**, so unrelated tenants are not mixed before their website paths are grouped.
- A **Website Path Section** is visible only when it reduces ambiguity: multiple website path sections are present, or one section groups multiple pages while sibling pages remain outside it.
- **Website Path Sections** do not introduce a new indentation level unless their title-suppression summaries can stay visually aligned with the group that owns them.
- A **Website Path Section** may contain one or more **Path Groups**, and a **Path Group** may contain one or more **Page Chips**.
- **Path Group** singleton behavior belongs to the Path Group rule itself; adding a **Website Path Section** does not change whether a single site-specific object stays grouped.
- A **Page Chip** shows a URL path suffix only when another chip in the same rendered group has the same visible title; sibling Website Path Sections and Path Groups already provide enough context.
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
