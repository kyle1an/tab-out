# ADR 0012: Create A Profile-Owned Window On Occupied macOS Spaces

- Status: Accepted
- Date: 2026-08-02

## Context

The Spoon identifies an existing Chrome window's profile from Chrome's Profiles
menu and caches that identity after the window receives focus. If a non-Chrome
window is frontmost when the shortcut runs, an existing target-Space Chrome
window may therefore be unverified even when it belongs to the configured
profile.

The router correctly refused to focus that unverified window, but its creation
fallback also required the target Space to be Chrome-empty. The combination
made both shortcuts Safe Abort solely because an untouched Chrome window was
behind the user's active non-Chrome window. Native Placement Bridge creation
does not require that restriction: Hammerspoon snapshots the existing native
window IDs before the request and observes the newly created window separately.

## Decision

- Existing-window reuse continues to require a verified configured-profile
  identity.
- Unverified and known other-profile Chrome windows remain untouched and are
  never used as focus or navigation targets.
- When no verified configured-profile target window remains, the Native
  Placement Bridge may create a configured-profile window on the target Space
  even when other normal Chrome windows already occupy that Space.
- The created window retains the existing final-bounds placement, transition
  shield, native-window validation, Private Exact-Window Activation, and
  destination-control focus sequence.

## Consequences

Both shortcuts remain available when a non-Chrome app is frontmost over an
unverified or other-profile Chrome window. If an unverified window actually
belongs to the configured profile, the safe fallback can create an additional
Chrome window rather than risk focusing the wrong profile. Improving
focus-independent profile attribution is a separate decision.

This decision does not change same-display close behavior. After the additional
window closes, Chrome may make an existing target-Space Chrome window frontmost;
Remote Display Preservation continues to cover only non-target displays.

Occupied-target creation joins Chrome-empty creation and verified-window reuse
in the live Remote Display Preservation qualification matrix.
