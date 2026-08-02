# ADR 0013: Route From Cold Chrome And Fullscreen Spaces

- Status: Accepted
- Date: 2026-08-02

## Context

The pointer-display shortcuts must open Tab Out regardless of whether Chrome is
already running. The original Native Placement Bridge required Chrome and its
extension peer to be active, so a stopped browser Safe Aborted before creation.
Launching Chrome normally was not acceptable because its startup window could
appear on another display before the bridge supplied the target bounds.

The original fullscreen route also left the current Space immediately and
required a previously stored regular Desktop ID. That failed on a newly seen
display even when an existing regular Desktop was available, and it needlessly
left a fullscreen Space that already contained a reusable configured-profile
Chrome window.

## Decision

- When creation is required and Chrome is stopped, the Spoon invokes the macOS
  application launcher in background mode with the configured profile and
  Chrome's no-startup-window flag. It waits for a successful profile-scoped
  Native Placement Bridge inventory response before sending the normal creation
  request. The launch has a bounded timeout and never treats a PID alone as
  readiness.
- The cold path uses the same inactive final-bounds creation, native-window
  validation, transition shield, and Private Exact-Window Activation as a warm
  creation. It adds no daemon, LaunchAgent, login item, or persistent listener.
- On a fullscreen Space, the Spoon first attempts normal verified-window reuse
  in that Space. Creation does not occur in a non-Chrome fullscreen Space.
- If fullscreen reuse is unavailable, the Spoon selects a regular Desktop on
  the pointer display: first the last observed ID when it remains a valid user
  Space, otherwise the first current user Space reported for that display. It
  switches there and runs the normal reuse-or-create route.

## Consequences

A stopped Chrome can be started without exposing an untargeted startup window,
then Tab Out creates and focuses only the requested destination. Failure to
launch Chrome, wake the extension, connect the bridge, or find a regular
Desktop remains a Safe Abort.

Fullscreen Chrome reuse avoids an unnecessary Space transition. A fullscreen
non-Chrome application may be left for a regular Desktop because Chrome cannot
place a normal browser window inside that application's fullscreen Space.

Cold-start visual qualification requires Chrome to be fully stopped and must
not be run by automation while the user's active browser session is needed.
Automated regressions cover launch arguments, bridge readiness sequencing,
creation, fullscreen reuse, and regular-Desktop fallback; the live acceptance
matrix covers both shortcuts when a cold-start test is safe to perform.
