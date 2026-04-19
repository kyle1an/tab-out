/* ================================================================
   Tab inventory — dev utility

   PURPOSE
     Produces a markdown digest of currently-open tabs, grouped by
     window and then by hostname, with sample path shapes. Used to
     inform site-specific path-grouping adapter design.

   USAGE
     1. Open a new tab (the Tab Out dashboard loads).
     2. Open DevTools on that page:  ⌘⌥J  (Mac)  /  Ctrl+Shift+J  (Win/Linux)
     3. Paste the entire contents of this file into the Console and press Enter.
     4. Output is logged to the console AND copied to the clipboard.

   WHY THE TAB OUT PAGE?
     The `chrome.tabs` API is only exposed to extension contexts. Running
     this snippet on a normal web page will throw. The Tab Out new-tab
     page runs in the extension's own origin with `tabs` permission, so
     it's the one place a local snippet can reach every open tab.

   PRIVACY
     - Runs 100% locally. No network calls. Only writes to your clipboard.
     - Output contains real URL paths. Scrub sensitive segments (tokens,
       private IDs, workspace slugs) before sharing the digest.
     - The script itself contains no personal data — safe to commit.
   ================================================================ */

(async () => {
  const tabs = await chrome.tabs.query({});

  // Unwrap Marvellous/Great-Suspender URLs so we see the real site, not
  // the suspender extension's own host. Mirrors extension/suspender.js —
  // the real URL lives in the hash under `&uri=...` and can itself
  // contain `&` and `#`, so we split on the literal marker rather than
  // URLSearchParams (which would truncate at the first inner `&`).
  const unwrap = (url) => {
    if (!url || !url.startsWith('chrome-extension://')) return url;
    try {
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith('/suspended.html')) return url;
      const frag = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : '';
      const marker = '&uri=';
      const idx = frag.indexOf(marker);
      let encoded;
      if (idx >= 0) encoded = frag.slice(idx + marker.length);
      else if (frag.startsWith('uri=')) encoded = frag.slice(4);
      else return url;
      return decodeURIComponent(encoded) || url;
    } catch {
      return url;
    }
  };

  const host = (u) => { try { return new URL(unwrap(u)).hostname; } catch { return null; } };
  const path = (u) => { try { const x = new URL(unwrap(u)); return `${x.pathname}${x.search}${x.hash}`; } catch { return u; } };

  // Group tabs by window first — Chrome windows usually correspond to
  // separate contexts (personal / work), so keeping them apart lets
  // the reader label each window and scan one context at a time.
  const byWindow = new Map();
  for (const t of tabs) {
    if (!t.url || !host(t.url)) continue;
    if (!byWindow.has(t.windowId)) byWindow.set(t.windowId, []);
    byWindow.get(t.windowId).push(t);
  }

  const lines = [];
  lines.push(`# Tab inventory — ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`Total: ${tabs.length} tabs across ${byWindow.size} window(s)`);
  lines.push('');
  lines.push('> Label each window below as personal / work by editing [LABEL ME].');
  lines.push('> Redact sensitive path segments (tokens, private IDs, workspace slugs) before sharing.');
  lines.push('');

  for (const [winId, winTabs] of byWindow) {
    lines.push('---');
    lines.push(`## Window ${winId} — ${winTabs.length} tabs   [LABEL ME: personal | work]`);
    lines.push('');

    const byHost = new Map();
    for (const t of winTabs) {
      const h = host(t.url);
      if (!byHost.has(h)) byHost.set(h, []);
      byHost.get(h).push(t);
    }

    // Sort hostnames by tab count desc — biggest piles rank first,
    // so adapter candidates surface at the top of each window.
    const sorted = [...byHost.entries()].sort((a, b) => b[1].length - a[1].length);

    // Split at threshold=3: fewer than that rarely justifies an adapter
    // (single/double occurrences are usually drive-by visits).
    const hi = sorted.filter(([, t]) => t.length >= 3);
    const lo = sorted.filter(([, t]) => t.length < 3);

    if (hi.length) {
      lines.push('### Adapter candidates (≥ 3 tabs)');
      lines.push('');
      for (const [h, hostTabs] of hi) {
        lines.push(`#### ${h} — ${hostTabs.length} tabs`);
        const samples = hostTabs.slice(0, 5).map(t => `- ${path(t.url)}`);
        lines.push(...samples);
        if (hostTabs.length > 5) lines.push(`- …and ${hostTabs.length - 5} more`);
        lines.push('');
      }
    }

    if (lo.length) {
      lines.push('### Long tail (< 3 tabs — probably skip adapter)');
      lines.push(lo.map(([h, t]) => `${h} (${t.length})`).join(', '));
      lines.push('');
    }
  }

  const text = lines.join('\n');
  console.log(text);

  // `copy` is a DevTools Command Line API helper — present only when
  // this snippet is run from the Console. It bypasses the Clipboard
  // API's "document must be focused" requirement, which would otherwise
  // always fail here (focus is in DevTools, not the page).
  // `navigator.clipboard.writeText` is kept as a last-ditch fallback
  // for non-DevTools contexts (snippets panel, extension popups, etc).
  if (typeof copy === 'function') {
    copy(text);
    console.log('%c✓ Copied to clipboard (via DevTools copy())', 'color:#4caf50;font-weight:bold');
  } else {
    try {
      await navigator.clipboard.writeText(text);
      console.log('%c✓ Copied to clipboard', 'color:#4caf50;font-weight:bold');
    } catch {
      console.warn('Clipboard copy failed — select the console output above manually.');
    }
  }
})();
