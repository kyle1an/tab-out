# Context

## Domain Language

- **Dashboard**: The Tab Out new-tab surface that shows open tabs and related sources grouped for cleanup.
- **Source**: The selected dashboard input: open tabs, bookmarks, or history.
- **Domain Card**: A dashboard group for one registrable domain or fixed system group.
- **Domain Card Identity**: The stable `domain-*` key shared by card order memory, Domain Card view data, React keys, and card move animation DOM hooks.
- **Page Chip**: A clickable row or icon inside a Domain Card that represents one page, duplicate set, app, or folded cross-subdomain page.
- **Website Path Section**: A visible group inside a Domain Card keyed by the shortest meaningful website path prefix on a known host.
- **Path Group**: A visible group inside a Website Path Section or subdomain section keyed by a site-specific object such as a repository, project key, space key, or environment.
- **Title Suppression Scope**: The smallest visible group that owns suppressed title tokens and their matching chip markers.
- **Filter Search**: A Dashboard query flow that decides when bookmark and history side results are requested, when those side results are current, and when filter-only controls appear.
- **Tab Action**: A user intent from the dashboard that mutates tabs or history, records undo/toast feedback, and refreshes the Dashboard.

## Relationships

- A **Website Path Section** is used only when a known host's URL path carries stable user-facing meaning; generic first-segment path splitting is not a Domain concept.
- A **Website Path Section** may contain one or more **Path Groups**, and a **Path Group** may contain one or more **Page Chips**.
- A **Title Suppression Scope** is owned by exactly one visible group: a **Domain Card**, Website Path Section, subdomain section, or Path Group.
- A **Title Suppression Scope** owns its summary tokens and matching chip markers; visible scopes coordinate palette colors within a **Domain Card** so two visible suppression meanings do not use the same color.
- **Title Suppression Summary** tokens render in source-title reading order, so the summary reconstructs where suppressed text came from instead of ranking tokens by frequency.
- **Title Suppression Scope** colors are allocated by token coverage before summary position; broad, high-coverage tokens can keep stable early palette colors even when they render later in the summary.
- A single-token **Title Suppression Scope** uses the same local palette as a multi-token scope for its summary token and matching chip markers when those markers span multiple rendered child groups and the **Domain Card** has more than one visible title-suppression meaning.
- Title suppression color assignment is stable across collapsed and expanded child groups.
- Title suppression colors may be reused only after the available palette colors are exhausted within a **Domain Card**.
- Neutral single-token **Title Suppression Scopes** do not consume palette colors.
