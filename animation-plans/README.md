# Animation Plans

| # | Plan | Severity | Status |
| --- | --- | --- | --- |
| 001 | [Animate only visible pointer-driven Activation History reorders](001-pointer-only-activation-history-reorder.md) | LOW | SUPERSEDED |
| 002 | [Animate observable Activation History reorders](002-visible-activation-history-reorders.md) | LOW | DONE |

## Recommended execution order

1. Plans 001 and 002 are complete; plan 002 is the active visibility-first
   behavior contract.

## Dependencies and constraints

- Baseline commit: `0a1f9dab`.
- Existing dependency: `src/extension/history-entry-move-animation.ts` and its
  shared `src/extension/move-animation.ts` lifecycle.
- No new package dependency, manifest permission, or background-service change
  is allowed.
- The general engineering-plan history remains in `plans/README.md`; active
  motion work is indexed here because `plans/` already serves a broader ledger.
