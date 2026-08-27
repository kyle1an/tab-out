import { readFile } from 'node:fs/promises'

import { prerender } from 'react-dom/static'

import { TabActionsPopup } from './components/TabActionsPopup.js'

const POPUP_MARKUP_SLOT = '<!-- TAB_OUT_PRERENDERED_POPUP -->'
const POPUP_HTML_TEMPLATE_URL = new URL('./popup-html.template.html', import.meta.url)

function injectPopupMarkup(popupHtmlTemplate: string, popupMarkup: string): string {
  const templateParts = popupHtmlTemplate.split(POPUP_MARKUP_SLOT)
  if (templateParts.length !== 2) {
    throw new Error('Popup HTML template must contain exactly one prerendered-popup slot')
  }
  return `${templateParts[0]}${popupMarkup}${templateParts[1]}`
}

/**
 * Builds `extension/popup.html`. `scripts/build-extension.ts` writes the
 * result during `pnpm build`, prerendering the same TabActionsPopup that the
 * client attaches so the first-render markup has one declaration.
 */
export async function createPopupHtml(): Promise<string> {
  const [popupHtmlTemplate, { prelude }] = await Promise.all([
    readFile(POPUP_HTML_TEMPLATE_URL, 'utf8'),
    prerender(<TabActionsPopup />),
  ])
  const popupMarkup = await new Response(prelude).text()
  return injectPopupMarkup(popupHtmlTemplate, popupMarkup)
}
