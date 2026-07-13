# 007 — Reunite Title Suppression tones behind the view-model seam

- **Status**: TODO
- **Commit**: 65a90ab
- **Strength**: Worth exploring (architecture review 2026-07-12, candidate 4; carried twice, re-verified)
- **Category**: in-process
- **Estimated scope**: view-model + DomainCard + title-suppression.ts + chip/summary consumers, 1-2 commits

## Problem

One CONTEXT.md concept — the **Title Suppression Scope** and its palette rules (CONTEXT.md lines 97-103: coverage-before-position, cross-group stability, reuse-after-exhaustion, neutral single-token scopes) — is implemented on both sides of the view-model seam. The view-model decides scope *ownership* but emits bare `suppressedTitleParts: string[]` (`domain-card-view-model.ts:42/65/352`). `DomainCard.tsx:208-227` then re-walks the VM tree **during render with a mutable accumulating counter** (`nextTitleSuppressionToneIndex`) to allocate tones, threading `TitleSuppressionToneScope` through four prop interfaces (`DomainCard.tsx:176/181/187/194`). The palette rules are testable only by rendering.

## Target (grilled decisions)

1. **Tone as plain data on the VM.** `suppressedTitleParts` (and the pre-structural-tail variant) become part objects — `{ text, toneIndex, spansRenderedChildGroups, … }` (exact field set discovered during implementation; tone stays an index/id, never a class string — the VM remains paint-agnostic). Chip suppression markers get their tone the same way.
2. **Allocation joins the one walk that already exists** in `computeDomainCardViewModel` (`domain-card-view-model.ts:608`) — card scope, subdomain sections, website-path sections, path groups, in the same order the render walk uses today, so allocation output is identical.
3. **`title-suppression.ts` shrinks to tone→class tables** (`titleSuppressionToneForIndex`, token/marker class builders). `createTitleSuppressionToneScope`/`mergeTitleSuppressionToneMaps` move into the VM implementation (or are absorbed by the walk).
4. **DomainCard sheds the walk**: the allocator (`:208-227`), the mutable counter, and the four-interface tone-scope threading are deleted; `TitleSuppressionSummary` and chip markers read `part.toneIndex` / the chip's marker tone directly.
5. **Tests**: new plain-data decision-table suite on the VM asserting the CONTEXT.md palette rules (the Chip Trim suite `tests/chip-trim.test.ts` is the style exemplar). Existing render-path tests stay as integration cover; update any that assert the old prop threading.

## Boundaries

- Do NOT let CSS class names cross the seam — tone is an index.
- Do NOT change any palette rule or allocation order — output must be pixel-identical; if a rule turns out ambiguous mid-implementation, STOP and surface it rather than deciding silently.
- Do NOT touch Title Suppression *scope ownership* logic (already VM-side and correct).

## Verification

- `pnpm verify` green; build + dist staged.
- Decision-table suite covers: multi-token scope tone order (coverage before summary position), stability across collapsed/expanded child groups, palette reuse only after exhaustion, neutral single-token scopes consuming no color, cross-scope coordination within one Domain Card.
- Feel check (unpacked extension or fixture): a Domain Card with 2+ visible suppression scopes renders the same token/marker colors before and after (screenshot-compare if in doubt).
- **Done when**: `rg "ToneScope" src/components/DomainCard.tsx` returns nothing, tone rules are asserted as plain data, and rendering is visually unchanged.
