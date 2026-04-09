# Defer & Checklist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Save for Later" system where users can defer tabs to a persistent checklist on the dashboard, with manual check-off and a searchable archive for aged-out items. Also improve the UX of individual tab close buttons.

**Architecture:** New `deferred_tabs` table in SQLite stores saved tabs. Four new API endpoints handle CRUD. The dashboard gets a new right-side column for the checklist + collapsed archive. Each tab chip gets a visible save button alongside a larger, always-visible close button.

**Tech Stack:** better-sqlite3 (DB), Express.js (API), vanilla JS + CSS (frontend)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `server/db.js` | Modify | Add `deferred_tabs` table + prepared statements |
| `server/routes.js` | Modify | Add 4 new `/api/deferred*` endpoints |
| `dashboard/index.html` | Modify | Add Saved for Later column + archive HTML skeleton |
| `dashboard/style.css` | Modify | Styles for checklist column, archive, bigger chip buttons |
| `dashboard/app.js` | Modify | Defer/check/dismiss handlers, render checklist, chip button UX |

No new files — everything fits into the existing structure.

---

### Task 1: Database — Add `deferred_tabs` Table and Prepared Statements

**Files:**
- Modify: `server/db.js:60-122` (schema section), `server/db.js:298-310` (exports)

- [ ] **Step 1: Add the `deferred_tabs` table to the schema**

In `server/db.js`, add this table definition inside the existing `db.exec(...)` block, after the `meta` table (after line 121, before the closing backtick+`);`):

```js
  -- ──────────────────────────────────────────────────────────────────────────
  -- deferred_tabs table
  -- Tabs the user has "saved for later." They're closed in the browser but
  -- live here until the user checks them off, dismisses them, or they age
  -- out after 30 days. Think of it like a reading list with an expiry date.
  --   checked = 1   → user checked it off (read it)
  --   dismissed = 1  → user clicked X (skipped it intentionally)
  --   archived = 1   → moved to archive (via check, dismiss, or 30-day age-out)
  -- ──────────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS deferred_tabs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    url            TEXT    NOT NULL,
    title          TEXT    NOT NULL,
    favicon_url    TEXT,
    source_mission TEXT,
    deferred_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    checked        INTEGER NOT NULL DEFAULT 0,
    checked_at     TEXT,
    dismissed      INTEGER NOT NULL DEFAULT 0,
    archived       INTEGER NOT NULL DEFAULT 0,
    archived_at    TEXT
  );
```

- [ ] **Step 2: Add prepared statements for deferred tabs**

Add these after the existing `setMeta` prepared statement (after line 256), before the `clearAllMissions` function:

```js
// ── DEFERRED TABS QUERIES ─────────────────────────────────────────────────

/**
 * getDeferredActive
 * Returns all deferred tabs that haven't been archived yet.
 * Ordered by most recently deferred first (newest at top of checklist).
 */
const getDeferredActive = db.prepare(`
  SELECT *
  FROM   deferred_tabs
  WHERE  archived = 0
  ORDER BY deferred_at DESC
`);

/**
 * getDeferredArchived
 * Returns all archived deferred tabs (checked off, dismissed, or aged out).
 * Most recently archived first.
 */
const getDeferredArchived = db.prepare(`
  SELECT *
  FROM   deferred_tabs
  WHERE  archived = 1
  ORDER BY archived_at DESC
`);

/**
 * insertDeferred
 * Saves a new deferred tab. Called when the user clicks the save/bookmark
 * icon on a tab chip.
 */
const insertDeferred = db.prepare(`
  INSERT INTO deferred_tabs (url, title, favicon_url, source_mission)
  VALUES (:url, :title, :favicon_url, :source_mission)
`);

/**
 * checkDeferred
 * Marks a deferred tab as checked off (user read it) and archives it.
 */
const checkDeferred = db.prepare(`
  UPDATE deferred_tabs
  SET    checked = 1,
         checked_at = datetime('now'),
         archived = 1,
         archived_at = datetime('now')
  WHERE  id = :id
`);

/**
 * dismissDeferred
 * Marks a deferred tab as dismissed (user skipped it) and archives it.
 */
const dismissDeferred = db.prepare(`
  UPDATE deferred_tabs
  SET    dismissed = 1,
         archived = 1,
         archived_at = datetime('now')
  WHERE  id = :id
`);

/**
 * ageOutDeferred
 * Archives any deferred tabs older than 30 days that haven't been
 * checked or dismissed yet. Called on each dashboard load.
 */
const ageOutDeferred = db.prepare(`
  UPDATE deferred_tabs
  SET    archived = 1,
         archived_at = datetime('now')
  WHERE  archived = 0
    AND  deferred_at < datetime('now', '-30 days')
`);

/**
 * searchDeferredArchived
 * Search archived deferred tabs by title or URL. Uses LIKE for
 * simple substring matching.
 */
const searchDeferredArchived = db.prepare(`
  SELECT *
  FROM   deferred_tabs
  WHERE  archived = 1
    AND  (title LIKE '%' || :q || '%' OR url LIKE '%' || :q || '%')
  ORDER BY archived_at DESC
  LIMIT 50
`);
```

- [ ] **Step 3: Export the new prepared statements**

Update the `module.exports` block at the bottom of `db.js` to include the new statements. Add these lines before the closing `};`:

```js
  getDeferredActive,    // () → array of active (non-archived) deferred tabs
  getDeferredArchived,  // () → array of archived deferred tabs
  insertDeferred,       // ({ url, title, favicon_url, source_mission })
  checkDeferred,        // ({ id }) → marks as checked + archived
  dismissDeferred,      // ({ id }) → marks as dismissed + archived
  ageOutDeferred,       // () → archives tabs older than 30 days
  searchDeferredArchived, // ({ q }) → search archived by title/url
```

- [ ] **Step 4: Verify the server starts without errors**

Run: `cd "/Users/zara/Documents/For Claude/tab-mission-control" && node -e "const db = require('./server/db'); console.log('Tables:', Object.keys(db).filter(k => typeof db[k] !== 'function' && k !== 'db').join(', ')); console.log('OK')"`

Expected: No errors, prints the list of exported names including the new deferred ones.

- [ ] **Step 5: Commit**

```bash
git add server/db.js
git commit -m "feat(db): add deferred_tabs table and prepared statements"
```

---

### Task 2: API — Add Deferred Tab Endpoints

**Files:**
- Modify: `server/routes.js:27-35` (imports), append new routes at end of file

- [ ] **Step 1: Import the new DB helpers in routes.js**

In `server/routes.js`, update the destructuring import from `./db` (lines 27-35). Add the new names to the existing import block:

```js
const {
  getMissions,
  getMissionUrls,
  dismissMission,
  archiveMission,
  getMeta,
  db,
  getDeferredActive,
  getDeferredArchived,
  insertDeferred,
  checkDeferred,
  dismissDeferred,
  ageOutDeferred,
  searchDeferredArchived,
} = require('./db');
```

- [ ] **Step 2: Add the POST /defer endpoint**

Add this at the end of `routes.js`, just before the `module.exports = router;` line:

```js
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/defer
//
// Save one or more tabs for later. The browser closes them; we store them here
// so they appear in the "Saved for Later" checklist on the dashboard.
//
// Expects: { tabs: [{ url, title, favicon_url?, source_mission? }] }
// Returns: { success: true, deferred: [{ id, url, title, ... }] }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/defer', (req, res) => {
  try {
    const { tabs } = req.body;
    if (!tabs || !Array.isArray(tabs) || tabs.length === 0) {
      return res.status(400).json({ error: 'tabs array is required' });
    }

    const created = [];
    for (const tab of tabs) {
      if (!tab.url || !tab.title) continue; // skip incomplete entries
      const result = insertDeferred.run({
        url: tab.url,
        title: tab.title,
        favicon_url: tab.favicon_url || null,
        source_mission: tab.source_mission || null,
      });
      created.push({
        id: result.lastInsertRowid,
        url: tab.url,
        title: tab.title,
        favicon_url: tab.favicon_url || null,
        source_mission: tab.source_mission || null,
        deferred_at: new Date().toISOString(),
      });
    }

    res.json({ success: true, deferred: created });
  } catch (err) {
    console.error('[TMC] Error deferring tabs:', err);
    res.status(500).json({ error: 'Failed to defer tabs' });
  }
});
```

- [ ] **Step 3: Add the GET /deferred endpoint**

Add this after the POST /defer route:

```js
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/deferred
//
// Returns both active and archived deferred tabs. Also runs the 30-day
// age-out check — any deferred tab older than 30 days gets auto-archived.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/deferred', (req, res) => {
  try {
    // Auto-archive anything older than 30 days
    ageOutDeferred.run();

    const active = getDeferredActive.all();
    const archived = getDeferredArchived.all();

    res.json({ active, archived });
  } catch (err) {
    console.error('[TMC] Error fetching deferred tabs:', err);
    res.status(500).json({ error: 'Failed to fetch deferred tabs' });
  }
});
```

- [ ] **Step 4: Add the PATCH /deferred/:id endpoint**

```js
// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/deferred/:id
//
// Update a deferred tab — either check it off or dismiss it.
// Expects: { checked: true } or { dismissed: true }
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/deferred/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });

    if (req.body.checked) {
      checkDeferred.run({ id });
    } else if (req.body.dismissed) {
      dismissDeferred.run({ id });
    } else {
      return res.status(400).json({ error: 'Must provide checked or dismissed' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[TMC] Error updating deferred tab:', err);
    res.status(500).json({ error: 'Failed to update deferred tab' });
  }
});
```

- [ ] **Step 5: Add the GET /deferred/search endpoint**

```js
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/deferred/search?q=query
//
// Search archived deferred tabs by title or URL. Returns up to 50 matches.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/deferred/search', (req, res) => {
  try {
    const q = req.query.q || '';
    if (q.length < 2) {
      return res.json({ results: [] });
    }
    const results = searchDeferredArchived.all({ q });
    res.json({ results });
  } catch (err) {
    console.error('[TMC] Error searching deferred tabs:', err);
    res.status(500).json({ error: 'Failed to search deferred tabs' });
  }
});
```

- [ ] **Step 6: Test the endpoints manually**

Start the server and test with curl:

```bash
cd "/Users/zara/Documents/For Claude/tab-mission-control" && node server/index.js &
sleep 2

# Create a deferred tab
curl -s -X POST http://localhost:3456/api/defer \
  -H "Content-Type: application/json" \
  -d '{"tabs":[{"url":"https://example.com/article","title":"Test Article"}]}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)))"

# Fetch active deferred tabs
curl -s http://localhost:3456/api/deferred | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)))"

# Kill the test server
kill %1
```

Expected: POST returns `{ success: true, deferred: [{id: 1, ...}] }`. GET returns `{ active: [{...}], archived: [] }`.

- [ ] **Step 7: Commit**

```bash
git add server/routes.js
git commit -m "feat(api): add deferred tab endpoints (defer, list, update, search)"
```

---

### Task 3: Frontend — Bigger, Always-Visible Tab Chip Buttons

**Files:**
- Modify: `dashboard/style.css:387-442` (chip styles)
- Modify: `dashboard/app.js:506-512` (chip HTML in renderOpenTabsMissionCard)
- Modify: `dashboard/app.js:835-844` (chip HTML in renderDomainCard)

This task improves the existing close button UX AND adds the save button to each chip — both at once, since they share the same HTML structure.

- [ ] **Step 1: Update the chip HTML in `renderOpenTabsMissionCard`**

In `dashboard/app.js`, replace the `pageChips` map inside `renderOpenTabsMissionCard` (lines 506-512). Find this code:

```js
  const pageChips = visibleTabs.map(tab => {
    const label   = tab.title || tab.url || '';
    const display = label.length > 45 ? label.slice(0, 45) + '…' : label;
    const dupeCount = dupeMap[tab.url];
    const dupeTag = dupeCount ? ` <span style="color:var(--accent-amber);font-weight:600">(${dupeCount}x)</span>` : '';
    return `<span class="page-chip clickable" data-action="focus-tab" data-tab-url="${(tab.url || '').replace(/"/g, '&quot;')}" title="${label.replace(/"/g, '&quot;')}"><span class="chip-text">${display}${dupeTag}</span><button class="chip-close" data-action="close-single-tab" data-tab-url="${(tab.url || '').replace(/"/g, '&quot;')}" title="Close this tab">&times;</button></span>`;
  }).join('') + (extraCount > 0 ? `<span class="page-chip"><span class="chip-text">+${extraCount} more</span></span>` : '');
```

Replace with:

```js
  const pageChips = visibleTabs.map(tab => {
    const label   = tab.title || tab.url || '';
    const display = label.length > 45 ? label.slice(0, 45) + '…' : label;
    const dupeCount = dupeMap[tab.url];
    const dupeTag = dupeCount ? ` <span style="color:var(--accent-amber);font-weight:600">(${dupeCount}x)</span>` : '';
    const safeUrl = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    return `<span class="page-chip clickable" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      <span class="chip-text">${display}${dupeTag}</span>
      <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
      </button>
      <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </span>`;
  }).join('') + (extraCount > 0 ? `<span class="page-chip"><span class="chip-text">+${extraCount} more</span></span>` : '');
```

- [ ] **Step 2: Update the chip HTML in `renderDomainCard`**

In `dashboard/app.js`, find the equivalent `pageChips` map inside `renderDomainCard` (lines 835-844):

```js
  const pageChips = visibleTabs.map(tab => {
    const label   = tab.title || tab.url || '';
    const display = label.length > 45 ? label.slice(0, 45) + '…' : label;
    const count   = urlCounts[tab.url];
    const dupeTag = count > 1
      ? ` <span style="color:var(--accent-amber);font-weight:600">(${count}x)</span>`
      : '';
    const chipStyle = count > 1 ? ' style="border-color: rgba(200, 113, 58, 0.3);"' : '';
    return `<span class="page-chip clickable"${chipStyle} data-action="focus-tab" data-tab-url="${(tab.url || '').replace(/"/g, '&quot;')}" title="${label.replace(/"/g, '&quot;')}"><span class="chip-text">${display}${dupeTag}</span><button class="chip-close" data-action="close-single-tab" data-tab-url="${(tab.url || '').replace(/"/g, '&quot;')}" title="Close this tab">&times;</button></span>`;
  }).join('') + (extraCount > 0 ? `<span class="page-chip"><span class="chip-text">+${extraCount} more</span></span>` : '');
```

Replace with:

```js
  const pageChips = visibleTabs.map(tab => {
    const label   = tab.title || tab.url || '';
    const display = label.length > 45 ? label.slice(0, 45) + '…' : label;
    const count   = urlCounts[tab.url];
    const dupeTag = count > 1
      ? ` <span style="color:var(--accent-amber);font-weight:600">(${count}x)</span>`
      : '';
    const chipStyle = count > 1 ? ' style="border-color: rgba(200, 113, 58, 0.3);"' : '';
    const safeUrl = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    return `<span class="page-chip clickable"${chipStyle} data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      <span class="chip-text">${display}${dupeTag}</span>
      <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
      </button>
      <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </span>`;
  }).join('') + (extraCount > 0 ? `<span class="page-chip"><span class="chip-text">+${extraCount} more</span></span>` : '');
```

- [ ] **Step 3: Update chip CSS for always-visible, larger action buttons**

In `dashboard/style.css`, replace the existing chip button styles (lines 410-432) — everything from `.chip-close {` through `.chip-close:hover {` closing brace:

```css
.chip-close {
  display: none;
  background: none;
  border: none;
  color: var(--muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
  margin-left: 4px;
  opacity: 0.5;
  transition: opacity 0.15s, color 0.15s;
  flex-shrink: 0;
}

.page-chip:hover .chip-close {
  display: inline-flex;
}

.chip-close:hover {
  opacity: 1;
  color: var(--status-abandoned);
}
```

Replace all of the above with:

```css
/* ---- Chip action buttons (save + close) ---- */
/* Always visible, no hover required — easy to click */
.chip-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  padding: 2px;
  margin-left: 2px;
  opacity: 0.4;
  transition: opacity 0.15s, color 0.15s, transform 0.15s;
  flex-shrink: 0;
}

.chip-action svg {
  width: 13px;
  height: 13px;
}

.chip-action:hover {
  opacity: 1;
  transform: scale(1.15);
}

.chip-save:hover {
  color: var(--accent-sage);
}

.chip-close:hover {
  color: var(--status-abandoned);
}
```

- [ ] **Step 4: Add "Save all" button to mission card actions**

In `dashboard/app.js`, inside `renderOpenTabsMissionCard` (around line 523-530), find:

```js
  let actionsHtml = '';
  if (tabCount > 0) {
    actionsHtml += `
      <button class="action-btn close-tabs" data-action="close-open-tabs" data-open-mission-id="${stableId}">
        ${ICONS.close}
        Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
      </button>`;
  }
```

Replace with:

```js
  let actionsHtml = '';
  if (tabCount > 0) {
    actionsHtml += `
      <button class="action-btn save-tabs" data-action="defer-mission-tabs" data-open-mission-id="${stableId}">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:12px;height:12px"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        Save all for later
      </button>
      <button class="action-btn close-tabs" data-action="close-open-tabs" data-open-mission-id="${stableId}">
        ${ICONS.close}
        Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
      </button>`;
  }
```

- [ ] **Step 5: Add "Save all" button to domain card actions**

In `dashboard/app.js`, inside `renderDomainCard` (around line 850-855), find:

```js
  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;
```

Replace with:

```js
  let actionsHtml = `
    <button class="action-btn save-tabs" data-action="defer-domain-tabs" data-domain-id="${stableId}">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:12px;height:12px"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
      Save all for later
    </button>
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;
```

- [ ] **Step 6: Add CSS for the "Save all" button style**

In `dashboard/style.css`, add after the `.action-btn.close-tabs:hover` block (after line 520):

```css
.action-btn.save-tabs {
  border-color: rgba(90, 122, 98, 0.3);
  color: var(--accent-sage);
  background: rgba(90, 122, 98, 0.04);
}

.action-btn.save-tabs:hover {
  background: rgba(90, 122, 98, 0.1);
  border-color: var(--accent-sage);
}
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/app.js dashboard/style.css
git commit -m "feat(ui): bigger always-visible chip buttons + save-for-later buttons on cards"
```

---

### Task 4: Frontend — Saved for Later Column HTML + CSS

**Files:**
- Modify: `dashboard/index.html:129-137` (open tabs section area)
- Modify: `dashboard/style.css` (append new styles)

- [ ] **Step 1: Restructure the dashboard layout for two columns**

In `dashboard/index.html`, find the open tabs section (lines 129-137):

```html
  <div class="active-section" id="openTabsSection" style="display:none">
    <div class="section-header">
      <h2 id="openTabsSectionTitle">Right now</h2>
      <div class="section-line"></div>
      <div class="section-count" id="openTabsSectionCount"></div>
    </div>
    <!-- Mission cards injected here by renderOpenTabsMissionCard() or renderDomainCard() in app.js -->
    <div class="missions" id="openTabsMissions"></div>
  </div>
```

Replace with:

```html
  <!-- ================================================================
       MAIN CONTENT AREA — two-column layout
       Left: open tabs (domain/mission cards)
       Right: saved for later checklist
       The right column only renders when it has items (JS controls this)
       ================================================================ -->
  <div class="dashboard-columns" id="dashboardColumns">

    <!-- LEFT COLUMN: Open tabs -->
    <div class="active-section" id="openTabsSection" style="display:none">
      <div class="section-header">
        <h2 id="openTabsSectionTitle">Right now</h2>
        <div class="section-line"></div>
        <div class="section-count" id="openTabsSectionCount"></div>
      </div>
      <div class="missions" id="openTabsMissions"></div>
    </div>

    <!-- RIGHT COLUMN: Saved for Later checklist -->
    <div class="deferred-column" id="deferredColumn" style="display:none">
      <div class="section-header">
        <h2>Saved for later</h2>
        <div class="section-line"></div>
        <div class="section-count" id="deferredCount"></div>
      </div>

      <!-- Active checklist items — injected by renderDeferredList() in app.js -->
      <div class="deferred-list" id="deferredList"></div>

      <!-- Empty state — shown when no active deferred tabs -->
      <div class="deferred-empty" id="deferredEmpty" style="display:none">
        Nothing saved. Living in the moment.
      </div>

      <!-- Archive section — collapsed by default -->
      <div class="deferred-archive" id="deferredArchive" style="display:none">
        <button class="archive-toggle" id="archiveToggle">
          <svg class="archive-chevron" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
          Archive
          <span class="archive-count" id="archiveCount"></span>
        </button>
        <div class="archive-body" id="archiveBody" style="display:none">
          <input type="text" class="archive-search" id="archiveSearch" placeholder="Search archived tabs...">
          <div class="archive-list" id="archiveList"></div>
        </div>
      </div>
    </div>

  </div><!-- end .dashboard-columns -->
```

- [ ] **Step 2: Add CSS for the two-column layout and checklist**

Append this to the end of `dashboard/style.css`:

```css
/* ================================================================
   SAVED FOR LATER — Checklist Column + Archive
   ================================================================ */

/* ---- Two-column layout ---- */
.dashboard-columns {
  display: flex;
  gap: 32px;
  align-items: flex-start;
}

/* Open tabs column takes most of the space */
.dashboard-columns .active-section {
  flex: 1;
  min-width: 0;
}

/* Saved for later column — fixed width on the right */
.deferred-column {
  width: 300px;
  flex-shrink: 0;
  position: sticky;
  top: 32px;
}

/* On narrow screens, stack vertically */
@media (max-width: 800px) {
  .dashboard-columns {
    flex-direction: column;
  }
  .deferred-column {
    width: 100%;
    position: static;
  }
}

/* ---- Checklist items ---- */
.deferred-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid rgba(154, 145, 138, 0.12);
  animation: fadeUp 0.3s ease both;
}

.deferred-item:last-child {
  border-bottom: none;
}

/* Custom checkbox */
.deferred-checkbox {
  appearance: none;
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  border: 2px solid var(--warm-gray);
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
  margin-top: 1px;
  transition: all 0.2s;
  position: relative;
}

.deferred-checkbox:hover {
  border-color: var(--accent-sage);
}

.deferred-checkbox:checked {
  background: var(--accent-sage);
  border-color: var(--accent-sage);
}

/* Checkmark inside the checkbox */
.deferred-checkbox:checked::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 5px;
  width: 4px;
  height: 8px;
  border: solid white;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

/* Item content (title, domain, time) */
.deferred-info {
  flex: 1;
  min-width: 0;
}

.deferred-title {
  font-size: 13px;
  color: var(--ink);
  text-decoration: none;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 0.15s;
}

.deferred-title:hover {
  color: var(--accent-amber);
}

.deferred-meta {
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
  display: flex;
  gap: 8px;
}

/* Checked-off item — strikethrough + faded */
.deferred-item.checked .deferred-title {
  text-decoration: line-through;
  color: var(--muted);
}

.deferred-item.checked .deferred-meta {
  opacity: 0.5;
}

/* Dismiss (X) button */
.deferred-dismiss {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  padding: 2px;
  opacity: 0.3;
  transition: opacity 0.15s, color 0.15s;
  flex-shrink: 0;
  margin-top: 1px;
}

.deferred-dismiss svg {
  width: 14px;
  height: 14px;
}

.deferred-dismiss:hover {
  opacity: 1;
  color: var(--status-abandoned);
}

/* Slide-out animation for items being removed */
.deferred-item.removing {
  opacity: 0;
  transform: translateX(20px);
  transition: opacity 0.3s ease, transform 0.3s ease;
}

/* ---- Empty state ---- */
.deferred-empty {
  font-size: 13px;
  color: var(--muted);
  font-style: italic;
  padding: 24px 0;
  text-align: center;
}

/* ---- Archive section ---- */
.deferred-archive {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--warm-gray);
}

.archive-toggle {
  font-family: 'DM Sans', sans-serif;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  background: none;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  width: 100%;
  text-align: left;
  transition: color 0.15s;
}

.archive-toggle:hover {
  color: var(--ink);
}

.archive-chevron {
  width: 14px;
  height: 14px;
  transition: transform 0.2s;
}

.archive-toggle.open .archive-chevron {
  transform: rotate(180deg);
}

.archive-count {
  font-size: 11px;
  color: var(--muted);
  opacity: 0.7;
}

.archive-body {
  padding-top: 12px;
}

.archive-search {
  font-family: 'DM Sans', sans-serif;
  font-size: 12px;
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--warm-gray);
  border-radius: 6px;
  background: var(--card-bg);
  color: var(--ink);
  outline: none;
  transition: border-color 0.2s;
  margin-bottom: 12px;
}

.archive-search:focus {
  border-color: var(--accent-amber);
}

.archive-search::placeholder {
  color: var(--muted);
}

/* Archive items are simpler — just title + domain + date */
.archive-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(154, 145, 138, 0.08);
}

.archive-item:last-child {
  border-bottom: none;
}

.archive-item-title {
  font-size: 12px;
  color: var(--muted);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
  transition: color 0.15s;
}

.archive-item-title:hover {
  color: var(--ink);
}

.archive-item-date {
  font-size: 10px;
  color: var(--muted);
  opacity: 0.6;
  flex-shrink: 0;
}
```

- [ ] **Step 3: Add staggered fadeUp animations for deferred items**

In `dashboard/style.css`, add after the existing animation rules (after line 636):

```css
.deferred-list .deferred-item:nth-child(1) { animation-delay: 0.05s; }
.deferred-list .deferred-item:nth-child(2) { animation-delay: 0.1s; }
.deferred-list .deferred-item:nth-child(3) { animation-delay: 0.15s; }
.deferred-list .deferred-item:nth-child(4) { animation-delay: 0.2s; }
.deferred-list .deferred-item:nth-child(5) { animation-delay: 0.25s; }
.deferred-column .section-header { animation: fadeUp 0.5s ease 0.1s both; }
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/index.html dashboard/style.css
git commit -m "feat(ui): add Saved for Later column HTML skeleton + full CSS"
```

---

### Task 5: Frontend — Render Checklist + Archive from API

**Files:**
- Modify: `dashboard/app.js` (add rendering functions + call them from renderStaticDashboard and renderAIDashboard)

- [ ] **Step 1: Add the `timeAgo` helper reference check**

The codebase already has a `timeAgo()` function used elsewhere. Verify it exists by searching for it. We'll reuse it for "3 days ago" in the checklist. If it doesn't exist, we'll need to add one.

Run: `grep -n "function timeAgo" "/Users/zara/Documents/For Claude/tab-mission-control/dashboard/app.js"`

Expected: A line number showing the existing function.

- [ ] **Step 2: Add the `renderDeferredColumn` function**

In `dashboard/app.js`, add this function before the `renderStaticDashboard` function (before line 908):

```js
/* ----------------------------------------------------------------
   DEFERRED TABS — "Saved for Later" checklist column

   Fetches deferred tabs from the server and renders:
   1. Active items as a checklist (checkbox + title + dismiss)
   2. Archived items in a collapsible section with search
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Fetches all deferred tabs (active + archived) from the API and
 * renders them into the right-side column. Called on every dashboard
 * load — both static and AI views.
 */
async function renderDeferredColumn() {
  const column    = document.getElementById('deferredColumn');
  const list      = document.getElementById('deferredList');
  const empty     = document.getElementById('deferredEmpty');
  const countEl   = document.getElementById('deferredCount');
  const archiveEl = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const res = await fetch('/api/deferred');
    if (!res.ok) throw new Error('Failed to fetch deferred tabs');
    const data = await res.json();

    const active   = data.active || [];
    const archived = data.archived || [];

    // Show or hide the entire column based on whether there's anything to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[TMC] Could not load deferred tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds the HTML for a single checklist item in the Saved for Later column.
 * Each item has: checkbox, title (clickable link), domain, time ago, dismiss X.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.deferred_at);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds the HTML for a single item in the collapsed archive list.
 * Simpler than active items — just title link + date.
 */
function renderArchiveItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const ago = item.archived_at ? timeAgo(item.archived_at) : '';

  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}
```

- [ ] **Step 3: Call `renderDeferredColumn()` from `renderStaticDashboard`**

In `dashboard/app.js`, inside `renderStaticDashboard()`, add a call to `renderDeferredColumn()` at the end of the function — right after the footer stats section (after the line `if (nudgeBanner) nudgeBanner.style.display = 'none';` around line 1040):

```js
  // ── Step 9: Render the "Saved for Later" checklist column ────────────────
  await renderDeferredColumn();
```

- [ ] **Step 4: Call `renderDeferredColumn()` from `renderAIDashboard`**

Find the `renderAIDashboard` function and add the same call at the end of it. Search for where it finishes rendering (look for the last `showToast` or footer update in that function) and add:

```js
  // Render the "Saved for Later" checklist column
  await renderDeferredColumn();
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/app.js
git commit -m "feat(ui): render Saved for Later checklist and archive from API"
```

---

### Task 6: Frontend — Defer, Check, Dismiss, and Search Event Handlers

**Files:**
- Modify: `dashboard/app.js:1218+` (event delegation block)

- [ ] **Step 1: Add the `defer-single-tab` handler**

In `dashboard/app.js`, inside the `document.addEventListener('click', ...)` block, add this handler after the `close-single-tab` handler (after line 1282, after `return;`):

```js
  // ---- defer-single-tab: save one tab for later, then close it ----
  if (action === 'defer-single-tab') {
    e.stopPropagation(); // don't trigger the parent chip's focus-tab
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to the deferred list on the server
    try {
      await fetch('/api/defer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabs: [{ url: tabUrl, title: tabTitle }] }),
      });
    } catch (err) {
      console.error('[TMC] Failed to defer tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in the browser
    await sendToExtension('closeTabs', { urls: [tabUrl] });
    await fetchOpenTabs();

    // Animate the chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity = '0';
      chip.style.transform = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    // Refresh the deferred column to show the new item
    await renderDeferredColumn();
    return;
  }
```

- [ ] **Step 2: Add the `defer-mission-tabs` handler**

Add this after the `defer-single-tab` handler:

```js
  // ---- defer-mission-tabs: save all tabs in an AI mission for later ----
  if (action === 'defer-mission-tabs') {
    const stableId = actionEl.dataset.openMissionId;
    const mission = openTabMissions.find(m => m._stableId === stableId);
    if (!mission) return;

    const tabs = (mission.tabs || []).map(t => ({
      url: t.url,
      title: t.title || t.url,
      source_mission: mission.name || null,
    }));

    try {
      await fetch('/api/defer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabs }),
      });
    } catch (err) {
      console.error('[TMC] Failed to defer mission tabs:', err);
      showToast('Failed to save tabs');
      return;
    }

    // Close all tabs in the mission
    const urls = tabs.map(t => t.url);
    await closeTabsByUrls(urls);

    // Animate the card out
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    const idx = openTabMissions.indexOf(mission);
    if (idx !== -1) openTabMissions.splice(idx, 1);

    showToast(`Saved ${tabs.length} tab${tabs.length !== 1 ? 's' : ''} for later`);
    await renderDeferredColumn();
    return;
  }
```

- [ ] **Step 3: Add the `defer-domain-tabs` handler**

Add this after the `defer-mission-tabs` handler:

```js
  // ---- defer-domain-tabs: save all tabs in a domain group for later ----
  if (action === 'defer-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group = domainGroups.find(g => {
      const id = 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-');
      return id === domainId;
    });
    if (!group) return;

    const tabs = (group.tabs || []).map(t => ({
      url: t.url,
      title: t.title || t.url,
      source_mission: group.domain || null,
    }));

    try {
      await fetch('/api/defer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabs }),
      });
    } catch (err) {
      console.error('[TMC] Failed to defer domain tabs:', err);
      showToast('Failed to save tabs');
      return;
    }

    // Close all tabs in the domain group
    const urls = tabs.map(t => t.url);
    await closeTabsByUrls(urls);

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    showToast(`Saved ${tabs.length} tab${tabs.length !== 1 ? 's' : ''} from ${group.domain}`);
    await renderDeferredColumn();
    return;
  }
```

- [ ] **Step 4: Add the `check-deferred` handler**

Add this after the `defer-domain-tabs` handler:

```js
  // ---- check-deferred: check off a deferred tab (mark as read) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    try {
      await fetch(`/api/deferred/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checked: true }),
      });
    } catch (err) {
      console.error('[TMC] Failed to check deferred tab:', err);
      return;
    }

    // Animate the item: add strikethrough, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh to update counts and archive
        }, 300);
      }, 800);
    }
    return;
  }
```

- [ ] **Step 5: Add the `dismiss-deferred` handler**

Add this after the `check-deferred` handler:

```js
  // ---- dismiss-deferred: dismiss a deferred tab without reading ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    try {
      await fetch(`/api/deferred/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dismissed: true }),
      });
    } catch (err) {
      console.error('[TMC] Failed to dismiss deferred tab:', err);
      return;
    }

    // Animate the item out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn(); // refresh counts and archive
      }, 300);
    }
    return;
  }
```

- [ ] **Step 6: Add archive toggle and search handlers**

Add this **outside** the main click event listener (after it closes), as separate event listeners:

```js
// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  if (q.length < 2) {
    // Show all archived items (re-fetch from the already-loaded data)
    await renderDeferredColumn();
    // Re-open the archive after re-render
    const toggle = document.getElementById('archiveToggle');
    const body = document.getElementById('archiveBody');
    if (toggle) toggle.classList.add('open');
    if (body) body.style.display = 'block';
    return;
  }

  try {
    const res = await fetch(`/api/deferred/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return;
    const data = await res.json();
    archiveList.innerHTML = (data.results || []).map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[TMC] Archive search failed:', err);
  }
});
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/app.js
git commit -m "feat(ui): add defer, check, dismiss, archive toggle + search handlers"
```

---

### Task 7: Integration Testing — Full Flow Verification

**Files:** None (testing only)

- [ ] **Step 1: Start the server**

```bash
cd "/Users/zara/Documents/For Claude/tab-mission-control" && node server/index.js &
sleep 2
```

- [ ] **Step 2: Test the full defer → check → archive flow via API**

```bash
# 1. Defer a tab
curl -s -X POST http://localhost:3456/api/defer \
  -H "Content-Type: application/json" \
  -d '{"tabs":[{"url":"https://example.com/long-article","title":"A Very Long Article About AI"}]}' | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))"

# 2. Verify it appears as active
curl -s http://localhost:3456/api/deferred | node -p "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('Active:', d.active.length, 'Archived:', d.archived.length)"

# 3. Check it off (replace 1 with actual ID from step 1)
curl -s -X PATCH http://localhost:3456/api/deferred/1 \
  -H "Content-Type: application/json" \
  -d '{"checked":true}'

# 4. Verify it moved to archived
curl -s http://localhost:3456/api/deferred | node -p "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('Active:', d.active.length, 'Archived:', d.archived.length)"

# 5. Test search
curl -s "http://localhost:3456/api/deferred/search?q=article" | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))"
```

Expected: Tab moves from active (1) to archived (1). Search returns the archived item.

- [ ] **Step 3: Test the dashboard visually**

Open `http://localhost:3456` in a browser. Defer a few more test tabs via curl. Verify:
- The "Saved for Later" column appears on the right
- Items show with checkboxes, favicons, titles, domain, time ago
- Checking a box triggers strikethrough → slide out animation
- Dismissing (X) triggers slide out
- Archive section appears and toggles open/closed
- Search filters the archive

- [ ] **Step 4: Stop the test server**

```bash
kill %1
```

- [ ] **Step 5: Commit any fixes**

If any fixes were needed during testing:

```bash
git add -A
git commit -m "fix: address issues found during integration testing"
```

---

### Task 8: Final Cleanup + FORZARA Documentation

**Files:**
- Create: `FORZARA-DEFER.md` (in project root)

- [ ] **Step 1: Write the FORZARA documentation**

Create `FORZARA-DEFER.md` in the project root that explains:
- What the defer feature does and why it exists (loss aversion, tab hoarding psychology)
- The technical architecture (SQLite table → Express endpoints → vanilla JS frontend)
- How the three tab states work (Open → Deferred → Archived)
- The 30-day age-out mechanism
- How the two-column layout works
- The chip button UX improvement and why it matters
- Lessons learned and potential pitfalls

Write in an engaging, non-technical style per Zara's preferences.

- [ ] **Step 2: Commit the documentation**

```bash
git add FORZARA-DEFER.md
git commit -m "docs: add FORZARA-DEFER explaining the defer & checklist feature"
```
