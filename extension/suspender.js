/* ================================================================
   Suspender URL helpers

   Tab-suspender extensions (The Marvellous Suspender, The Great
   Suspender, etc.) rewrite a tab's URL to:
     chrome-extension://<id>/suspended.html#...&uri=<real>
   The real URL is in the fragment's `uri=` param. Because the real
   URL can itself contain `&` and `#`, it is always the LAST param —
   so we split on the literal `&uri=` marker (or leading `uri=`)
   instead of URLSearchParams, which would truncate at the first
   inner `&`.
   ================================================================ */

export function unwrapSuspenderUrl(url) {
  if (!url || !url.startsWith('chrome-extension://')) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith('/suspended.html')) return url;
    const frag = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : '';
    const marker = '&uri=';
    let encoded;
    const idx = frag.indexOf(marker);
    if (idx >= 0) encoded = frag.slice(idx + marker.length);
    else if (frag.startsWith('uri=')) encoded = frag.slice(4);
    else return url;
    return decodeURIComponent(encoded) || url;
  } catch {
    return url;
  }
}
