/* ================================================================
   Preact + HTM sanity check — temporary.

   Verifies that the vendored Preact and HTM modules load and render
   correctly inside the extension's MV3 CSP. Mounts a small badge in
   the top-right corner that reads "✓ Preact + HTM ready" if the
   whole pipeline (vendor/ imports → htm.bind(h) → render()) works.

   Remove this file and its <script> tag in index.html once the
   first real component migration lands.
   ================================================================ */

import { h, render } from './vendor/preact.mjs';
import htm from './vendor/htm.mjs';

const html = htm.bind(h);

function SanityBadge() {
  return html/* html */`
    <div style="
      position: fixed;
      top: 8px;
      right: 8px;
      padding: 6px 10px;
      background: #16a34a;
      color: white;
      font-size: 12px;
      font-family: sans-serif;
      border-radius: 6px;
      z-index: 9999;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      pointer-events: none;
    ">
      ✓ Preact + HTM ready
    </div>
  `;
}

const mount = document.createElement('div');
document.body.appendChild(mount);
render(html`<${SanityBadge} />`, mount);

console.log('[preact-sanity] h:', typeof h, 'render:', typeof render, 'html:', typeof html);
