# ADR 0014: Use Runtime Capability Checks for Private Activation

- Status: Accepted
- Date: 2026-08-04

## Context

Private Exact-Window Activation uses undocumented WindowServer symbols and an
encoded event record. The first implementation restricted the helper to one
exact macOS build after live qualification. That compile-time allowlist rejected
other user-approved builds before the helper could inspect the capabilities it
actually needs, and every macOS update required a source and setup-diagnostic
change even when the symbols and behavior remained available.

The helper already resolves every private symbol dynamically, checks that the
WindowServer connection is usable, requires Accessibility permission, validates
the exact Chrome process and window, and verifies routing postconditions. The
Spoon Safe Aborts rather than falling back to ordinary application activation
when any of those checks fail.

## Decision

- Remove the exact macOS build equality check from the private helper.
- Keep runtime symbol, WindowServer connection, Accessibility, target identity,
  and routing postcondition checks as the availability boundary.
- Make setup diagnostics verify the helper source and build prerequisites rather
  than treating one build number as an installation prerequisite.
- Continue to require live create and reuse acceptance for both shortcuts after
  macOS updates or changes to Private Exact-Window Activation.

## Consequences

The integration can run on macOS builds that expose the required runtime
capabilities without a source edit for each build number. Explicit capability
failures still Safe Abort before routing.

Runtime symbol discovery cannot prove that an undocumented implementation kept
identical semantics or event-record layout. Live Remote Display Preservation
acceptance therefore remains required, and the user accepts that responsibility
when enabling the integration on a new macOS build.
