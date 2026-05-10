# Context

## Domain Language

- **Dashboard**: The Tab Out new-tab surface that shows open tabs and related sources grouped for cleanup.
- **Source**: The selected dashboard input: open tabs, bookmarks, or history.
- **Domain Card**: A dashboard group for one registrable domain or fixed system group.
- **Domain Card Identity**: The stable `domain-*` key shared by card order memory, Domain Card view data, React keys, and card move animation DOM hooks.
- **Page Chip**: A clickable row or icon inside a Domain Card that represents one page, duplicate set, app, or folded cross-subdomain page.
- **Title Suppression Scope**: The smallest visible group that owns suppressed title tokens and their matching chip markers.
- **Filter Search**: A Dashboard query flow that decides when bookmark and history side results are requested, when those side results are current, and when filter-only controls appear.
- **Tab Action**: A user intent from the dashboard that mutates tabs or history, records undo/toast feedback, and refreshes the Dashboard.

## Relationships

- A **Title Suppression Scope** is owned by exactly one visible group: a **Domain Card**, subdomain section, or pathgroup section.
- A **Title Suppression Scope** assigns colors locally; a single-token scope is neutral, and only multi-token scopes use the palette.
