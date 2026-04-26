import { h } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'

const html = htm.bind(h)

export function UrlPreview({ url, visible = !!url }) {
  const isVisible = visible && !!url
  const className = 'url-preview' + (isVisible ? ' visible' : '')
  return html`
    <div class=${className} aria-hidden=${isVisible ? 'false' : 'true'}>
      <span>${url || ''}</span>
    </div>
  `
}
