import { h } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'

const html = htm.bind(h)

export function UrlPreview({ url }) {
  const className = 'url-preview' + (url ? ' visible' : '')
  return html`
    <div class=${className} aria-hidden=${url ? 'false' : 'true'}>
      <span>${url || ''}</span>
    </div>
  `
}
