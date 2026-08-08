# ADR 0017: Correlate Bridge Creation Before Private Activation

- Status: Accepted
- Date: 2026-08-08

## Context

Chrome can publish a normal window created with `focused: false` to
Accessibility before WindowServer reports its optional onscreen metadata. The
window already has the intended display, Space, frame, Chrome PID, and native
window ID, but rejecting the missing metadata prevents Private Exact-Window
Activation. On a Chrome-empty target Desktop this leaves the created window
inactive and offscreen and reports that it could not be focused privately.

Allowing every apparently new native window through that check would weaken the
privacy boundary. The original router treated the first baseline-excluded
Chrome window observed after bridge acceptance as the created window. A
concurrent user, extension, or other-profile window could satisfy that timing
test even though it was not created by the bridge request.

## Decision

- The extension uses the already validated request ID as a unique creation
  token, places it in the Tab Out bootstrap document's `tabOutPlacement` query
  parameter, and returns the exact `browserWindowId` received from
  `chrome.windows.create` in the accepted creation response. Protocol v3 also
  keeps its original request-ID token echo so an already-loaded v3 Hammerspoon
  client remains compatible during an extension-only reload. Current
  Hammerspoon retains its generated request ID as the known token instead of
  depending on that echo. Both routes use this tokenized extension document;
  the filter route also starts with `focusFilter=1`, while the new-page route
  focuses Chrome's address bar after exact activation.
- Hammerspoon excludes every native Chrome window present before the request
  and considers only standard, non-minimized candidates on the captured display
  and active Space. A window-created event wakes matching but never proves
  identity by itself.
- The Chrome catalog parses the exact `tabOutPlacement` query parameter rather
  than comparing a full URL, because the page may remove `focusFilter=1` before
  Accessibility publishes it. Exactly one AppleScript inventory record must
  carry the token and its browser ID must equal the returned ID; exactly one
  eligible Accessibility candidate must then carry the same token. Generic
  bounds or document fingerprints never authorize created-window focus across
  these asynchronous snapshots.
- The configured-profile identity is cached against the native window only
  after that correlation succeeds. Missing, changing, or ambiguous identity
  remains pending until the bounded request expires and then Safe Aborts.
- The private helper permits the correlated created path to proceed only when
  WindowServer omitted the optional onscreen key. It still rejects an explicit
  offscreen value. Immediately before that call, the Spoon revalidates the
  exact PID, standard and non-minimized state, non-hidden application, captured
  display, still-active Space, and correlated profile.
- Existing-window reuse never receives the missing-metadata allowance.

## Consequences

An inactive bridge-created window can now be materialized by the exact private
activation that makes its WindowServer state complete, fixing creation on an
otherwise Chrome-empty Desktop. The allowance cannot be transferred to the
first unrelated window that happens to appear during the request.

Creation becomes intentionally availability-conservative when Chrome and
Accessibility cannot expose the unique token before the deadline. A window
with missing document metadata Safe Aborts even when its bounds appear unique,
instead of risking another profile or Space. The bridge protocol advances to
version 3 so an older extension rejects the new request before creating a
window; independently reloaded peers cannot mutate and only afterward discover
that the created-window identity field is unavailable.
