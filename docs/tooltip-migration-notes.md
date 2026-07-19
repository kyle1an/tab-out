# Tooltip Migration Notes

Last updated: 2026-05-25

This note records the tooltip migration decisions, the reasons behind them, and the parts that are still unresolved. It is intentionally not a completion report: the current page-chip wrap issues are still open.

## 2026-05-25 Handoff

The page-chip tooltip width / line-break behavior matches the chip's visible wrap:

- one-line chip → one-line tooltip that widens up to `maxContentWidth` so the expanded markers stay on a single row;
- multi-line chip whose last visible line carries only the trailing suppression marker → two-row tooltip using the structural-tail split, so the expanded structural label stays on row 1 with the head and the trailing marker drops onto row 2.

Fix landed in this branch:

- `wrappedMarkerTailTooltipLineHtml()` in `src/components/PageChip.tsx` produces the head/tail pair by locating the first `.chip-title-suppression-marker` or `.chip-strip-indicator` whose visible top sits on a wrapped line, then splitting the source content immediately before that marker. This handles both the Contentful structural+trailing chip and the JIRA-style chip that has only a trailing suppression marker.
- `getRegularChipTooltipLineHtml()` falls back to `wrappedMarkerTailTooltipLineHtml()` when `visibleLineCount > 1` but the multi-line walker can't anchor enough line starts (because chip line 2 contains only a marker SVG with no text node). Without the fallback the multi-line path returns `[]` and the tooltip stays glued on one row, leaving the expanded label overflowing.
- One-line chips skip the split entirely and let `getRegularChipTooltipWidth()` widen the tooltip naturally via `getTooltipSingleLineNaturalWidth()`.
- Empty cloned `.chip-strip-indicator` nodes are still removed during tooltip fragment hydration and a small width guard is applied to pre-split tooltip lines so head/tail lines do not visually overflow.
- `getRegularChipTooltipWidth()` uses `Math.max(visibleLineCount, lineHtml.length)` as the target line count so split tooltips compute the right binary-search bounds.

Test coverage:

- `tests/fixtures/dashboard-resize.html` carries three synthetic Contentful tabs (`Tooltip Screenshot Alpha`, `Tooltip Screenshot Beta`, `Tooltip Screenshot Gamma`) plus two JIRA-style tabs (`Wrap Trailing Marker Alpha`, `Wrap Trailing Marker Beta`) that reproduce the chip shapes from the screenshots, using generic placeholders instead of the real company / product names.
- `tests/browser/dashboard-smoke.spec.ts` keeps the `oneLineStructuralTailTooltip` assertion that the tooltip widens to stay on one line, adds `wrappedContentfulScreenshotTooltip` covering the structural-tail wrap, and `wrappedTrailingMarkerTooltip` covering the trailing-suppression-only wrap.
- `pnpm verify:browser` (typecheck, lint, build, bundle check, unit tests, browser smoke) passes.

If the tooltip still renders incorrectly in the real extension after pulling this change, reload the unpacked extension from `chrome://extensions` so Chrome picks up the rebuilt `extension/dist/app.js`. The in-memory `chipTooltipLayoutCache` is module-scoped, so a fresh page load is enough; no manual cache invalidation is required once the new bundle is loaded.

If the bug returns, the next live-debug script remains:

1. Open the real Tab Out extension page in Chrome with the failing chip visible.
2. Hover the failing page chip and keep the tooltip open.
3. Run a console snippet that collects source and tooltip layout data from the actual DOM.
4. Compare the real data against the synthetic fixture before changing code again.

Useful console snippet for the live page (replace `YOUR_CHIP_TEXT` with the visible chip text you want to inspect):

```js
(() => {
  const source = [...document.querySelectorAll('.page-chip .chip-text')]
    .find((el) => !el.closest('[data-slot="tooltip-content"]') && el.textContent?.includes('YOUR_CHIP_TEXT'));
  const tooltip = document.querySelector('[data-slot="tooltip-content"]');
  const tooltipText = tooltip?.querySelector('.chip-text');
  const pick = (el) => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const styles = getComputedStyle(el);
    return {
      text: el.textContent,
      html: el.innerHTML,
      className: el.className,
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom
      },
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      display: styles.display,
      whiteSpace: styles.whiteSpace,
      overflowWrap: styles.overflowWrap,
      wordBreak: styles.wordBreak,
      width: styles.width,
      maxWidth: styles.maxWidth,
      lineHeight: styles.lineHeight
    };
  };
  const lines = tooltipText
    ? [...tooltipText.querySelectorAll('.page-chip-tooltip-line')].map(pick)
    : [];
  return {
    source: pick(source),
    tooltip: pick(tooltip),
    tooltipText: pick(tooltipText),
    tooltipLines: lines,
    sourceMarkers: source ? [...source.querySelectorAll('.chip-title-suppression-marker, .chip-strip-indicator')].map(pick) : [],
    tooltipMarkers: tooltip ? [...tooltip.querySelectorAll('.chip-title-suppression-marker, .chip-strip-indicator')].map(pick) : []
  };
})()
```

If the bug returns, capture:

- `chipTooltipLineHtml` equivalent from the live DOM by checking whether `.page-chip-tooltip-line` nodes exist in the open tooltip.
- source `.chip-text` `innerHTML`, not only text content.
- tooltip `.chip-text` `innerHTML`.
- source and tooltip marker order (specifically whether a `.chip-title-suppression-marker` follows the `.chip-strip-indicator`).
- exact `extension/dist/app.js` reload state in Chrome.

## Landed Behavior

Native `title` attributes were replaced with the shared `TooltipAnchor` component in `src/components/ui/tooltip.tsx`.

Reason: native browser tooltips cannot be styled and cannot render structured content such as highlighted filter matches, env pills, or page-chip path labels. The shared wrapper lets the app use Base UI behavior while keeping the Tab Out visual style.

`TooltipAnchor` is built on `@base-ui/react/tooltip`.

Reason: this keeps the implementation close to the shadcn/Base UI primitive style already used elsewhere in the app. The wrapper centralizes timing, positioning, collision behavior, and styling instead of repeating tooltip code in each component.

The provider uses `delay = 500`, `closeDelay = 0`, and `timeout = 0`.

Reason: this is intended to feel closer to the browser-native title tooltip: delayed open, immediate close, and no separate hoverable tooltip interaction window.

Tooltip cursor anchoring captures the pointer position and freezes it when the tooltip opens.

Reason: the requested behavior was that the tooltip appears at the initial mouse location, then does not track later mouse movement. The implementation stores the latest pointer coordinates, creates a zero-size `DOMRect` anchor at that point, and uses fixed positioning while open.

The frozen pointer anchor is cleared after a short close delay.

Reason: without keeping the frozen anchor briefly during close animation, the tooltip can flash at the default trigger position while disappearing.

The default position is bottom/start with `sideOffset = 10`, `alignOffset = 1`, and collision flipping for side and alignment.

Reason: the pointer should align with the tooltip edge border in normal cases, while still flipping to stay visible when the cursor is near the viewport edge.

The tooltip has no arrow.

Reason: the requested style replaced the arrow with a square, unrounded anchor corner. The popup applies zero radius on the corner nearest the pointer using Base UI `data-side` and `data-align` attributes.

The tooltip surface uses `bg-[canvas]`, warm-gray outline/shadow, squircle corners where still rounded, and Base UI popup state attributes for transitions.

Reason: this follows the Base UI style direction while keeping Tab Out's local visual language.

## Page-Chip Tooltip Decisions

Page-chip tooltips are shown only for icon-only chips or when the text is actually truncated.

Reason: showing a tooltip for text that is fully visible adds noise. Truncation is detected from the real rendered element using `scrollHeight`, `clientHeight`, `scrollWidth`, and `clientWidth`, with a `ResizeObserver` and font-ready callbacks.

Horizontal overflow is included in truncation detection.

Reason: `chip-path` is normally rendered as a nowrap suffix, so a long path can overflow horizontally without increasing the chip height. Vertical-only detection misses that case.

Page-chip tooltip content reuses the chip text renderer.

Reason: the user wanted the tooltip to preserve source text style and filter highlights so they can locate where the truncated match occurs. Reusing the renderer preserves path-group pills, env pills, text color, font size, filter marks, and source-like structure.

The tooltip text width is currently set from the measured source `.chip-text` width.

Reason: this was meant to align tooltip line breaks with the visible chip text so the hover state maps back to the source row. This is also one of the causes of the remaining failures because tooltip text can need more width than the clipped source row.

The current tooltip path suffix has tooltip-specific wrapping classes.

Reason: this was added to keep long URL/path suffixes visible in the tooltip instead of staying nowrap forever. However, it is now suspect because it can make `chip-path` wrap independently from the main title flow.

## Source Chip Breakpoints

`injectBreakPoints()` in `src/extension/domain-card-view-model.ts` inserts zero-width spaces into long alphanumeric tokens.

Reason: source chips are compact, height-limited, and faded. Long identifiers, hashes, usernames, and slugs need break opportunities so they do not force horizontal overflow. Using zero-width spaces avoids global `word-break: break-all`, which would split normal words too aggressively.

The current threshold is 15 or more letters, digits, or underscores, split every 5 characters.

Reason: normal English words mostly stay untouched, while long code-like tokens get invisible break opportunities.

`highlightedTextNodes()` (now in `src/components/filter-highlight-text.tsx`) ignores zero-width spaces when finding filter matches.

Reason: filter highlighting should still match user-visible text, even when the displayed chip string contains invisible breakpoints.

## Reverted Or Rejected Attempts

Changing `injectBreakPoints()` to avoid one- or two-character orphan tails was rejected.

Reason: it was a magic breakpoint tweak. It reduced one visible symptom, but it reintroduced the path wrapping issue and did not solve the broader line-wrap mismatch.

Adding separate raw `tooltipSegments` was tried and then reverted.

Reason: the idea was sound: source chips could keep ZWSP breakpoints while tooltips rendered truthful raw text. In practice, with tooltip width still fixed to the source width, raw text chose different line breaks and did not solve the screenshots.

Growing tooltip width to fit the longest raw token was tried and then reverted.

Reason: allowing a wider tooltip is acceptable, but that implementation added complexity and still did not fix the real visual issue in the user's screenshots.

Adding Prettier-style or arbitrary breakpoints is not the right fix.

Reason: the failure is layout behavior, not just string content. More inserted breakpoints can move the bug around and create new path/title wrapping regressions.

`pretext` was discussed but not added.

Reason: it may help if we decide to model text layout outside the browser, but it would introduce another layout engine to keep in sync. The next pass should first measure the browser's actual rendered line boxes with DOM `Range` APIs before adding a dependency.

## Known Open Issues

The tooltip title still does not reliably align with the source chip line breaks in the screenshot cases.

Observed examples:

- `[SITE-312] Decouple some P version frames with original frames - JIRA ...`
- `[BUG] Character under cursor is illegible when terminal has CustomCursorTextColor set (Konsole) ...`

The `chip-path` tooltip can still wrap in a surprising place.

Likely contributing factors:

- source chip and tooltip share a renderer but use different wrapper constraints;
- tooltip is fixed to the measured source width;
- source text contains ZWSP breakpoints while the desired tooltip may need raw text;
- `TooltipContent` has `[overflow-wrap:anywhere]` at the popup level;
- tooltip-specific `chip-path` classes use inline-block and max-content behavior.

The current browser smoke tests do not prove the screenshot-specific visual behavior.

They prove generic behavior such as no tooltip for non-truncated short text, frozen cursor position, no arrow, edge alignment, and collision flip. They need stronger assertions around actual line boxes for title and path text.

## Recommended Next Pass

Start from a clean tree and reproduce in the real Chrome extension page, not only the browser fixture.

Reason: the issue is visual layout in the real extension surface. Fixture tests are useful after the cause is understood, but they have already missed screenshot-level regressions.

Measure real line boxes for both source and tooltip using DOM `Range.getClientRects()`.

Reason: this can show exactly where the browser places each word or token, and whether the mismatch comes from width, inherited wrapping, ZWSP, inline-block path behavior, or popup-level CSS.

Trace these values for a failing chip:

- source `.chip-text` rect, computed font, line-height, width, height, scrollWidth, and scrollHeight;
- tooltip `.chip-text` rect and computed style;
- source and tooltip text node contents, including whether `\u200B` exists;
- rects for important substrings such as `CustomCursorTextColor`, `illegible`, and the long path suffix;
- computed `overflow-wrap`, `word-break`, `white-space`, `hyphens`, `display`, `max-width`, and `width` on `.chip-text`, `.chip-path`, and `[data-slot="tooltip-content"]`.

Do not change `injectBreakPoints()` until the measurements prove that source chip breakpoints are the root cause.

Reason: `injectBreakPoints()` exists for a real source-chip constraint and past magic tweaks caused regressions.

Treat `chip-path` as its own investigation branch.

Reason: path suffix layout has different constraints from title text: source wants compact/faded nowrap behavior, while tooltip wants readability. The current shared renderer plus tooltip-specific `chip-path` override may be too coupled.

If the final UX goal is exact source-line mapping, prefer using real browser layout data over a separate text-layout library.

Reason: the browser is already the layout engine. A `Range`-based approach can answer where text actually broke without guessing. A separate dependency such as `pretext` should be considered only if the browser data cannot support the desired UI.
