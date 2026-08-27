# ADR 0022: Target Chrome Through Native-Host Process Authority

- Status: Accepted
- Date: 2026-08-26

## Context

macOS can run multiple Google Chrome application processes with the same name,
executable, and bundle identifier. Tab Out's Native Placement Bridge remains
profile-scoped, but its Hammerspoon AppleScript inventory and navigation used
Chrome's application name. When an isolated automation process was also
running, macOS could direct those Apple events to that process after Tab Out had
privately focused a different native window. Bounds checks made the common case
fail closed, but equal bounds could still authorize mutation of the wrong
Chrome instance.

## Decision

- Every placement and desktop-control exchange carries the fresh parent PID of
  the persistent native-messaging host. The Spoon admits that request-scoped PID
  only when it equals the live process recorded by the configured Chrome
  user-data directory's `SingletonLock` and the Configured Profile is the only
  profile in that directory whose extension settings expose Tab Out's shortcut
  commands. An application name, bundle identifier, executable path, command
  line, profile menu, or window geometry cannot substitute for that combined
  process-and-profile authority.
- Hammerspoon keeps display, Space, ordering, retry, and Safe Abort policy. Its
  native Chrome-control module targets ScriptingBridge and Accessibility through
  the authorized PID, correlates browser and native window IDs internally, and
  returns identifiers only. Active-tab URLs may be read ephemerally inside that
  module but never cross the native protocol or enter logs.
- Every focus, navigation, finalization, or creation cleanup revalidates the
  authorized PID plus browser and native window identity immediately before
  mutation. A pre-mutation identity change may restart once from a fresh bridge
  exchange. After mutation begins, Tab Out never replays the route; it closes a
  bridge-created window only while its PID, browser ID, native ID, and creation
  token still prove the same untouched bootstrap window.
- Chrome may expose a destination control before its ScriptingBridge URL,
  Accessibility document, and focusability have converged. After the single
  navigation mutation, Hammerspoon may retry only read-only correlation and
  destination focus within one bound. Every focus attempt revalidates the PID,
  browser window ID, and native window ID; timeout Safe Aborts without replaying
  navigation.
- If no configured-instance authority is available, Tab Out explicitly launches
  the configured user-data directory and profile, waits for a fresh native-host
  exchange, and never adopts another same-bundle process. Placement and control
  protocol versions advance together with the new required process field, so a
  staggered installation Safe Aborts instead of using name-based compatibility
  behavior.
- An Isolated Chrome Instance is excluded using process and native-window
  metadata only. Tab Out does not read its browser content or navigate, create,
  close, move, resize, terminate, or reconfigure it. The ordinary macOS focus
  change caused by routing to the Configured Chrome Instance remains allowed.
- A full browser/native window correlation produces an opaque, short-lived token
  stored only inside the Hammerspoon native module. Later focus, navigation, and
  destination-focus checks reuse that snapshot only after re-reading the exact
  browser/native pair and current focused state. This removes repeated
  process-wide Chrome inventories from the shortcut path without broadening the
  authority to another Chrome process.
- The shared local endpoint remains an availability mechanism, not identity. A
  native host launched by a different user-data directory may answer it, but its
  PID cannot pass the configured data lock. Another profile in the same Chrome
  process could share that PID, so loading Tab Out in more than one profile of
  the configured user-data directory fails closed before browser IDs are cached
  or used.
- Placement protocol v5 adds the inventory-derived expected PID to each local
  create request. The host rejects a mismatch before forwarding to Chrome and
  removes the local-only field from the extension request. New-page finalization
  and failed-route cleanup also require one exact bootstrap tab and mutate or
  close only after a final tab-ID and token recheck.

## Consequences

This amends the process-selection parts of ADR 0018 and ADR 0020 while preserving
their creation-token, inactive-placement, same-Desktop, and fail-closed rules.
Mixed integration versions become unavailable until the extension, native host,
and Spoon are rebuilt and reloaded together. Live qualification must run both
shortcuts through reuse, creation, and cold-start paths while another same-bundle
Chrome process has matching geometry; that isolated process's windows, tabs,
profile, command line, and lifecycle must remain unchanged.

Profile binding reads only Chrome's local process lock, profile-directory keys,
and extension command metadata. It does not inspect another browser process's
command line or content and does not reconfigure any automation launcher.

Changing the external automation launcher or inspecting Chrome command lines was
rejected because neither is necessary to identify the configured instance and
both would couple Tab Out to unrelated tooling. Bundle/name targeting with
additional bounds checks was rejected because equal geometry cannot establish
process identity.

The process-wide correlation had initially been repeated before focus,
navigation, and every destination-focus attempt. On machines with several Chrome
windows, those Apple Events dominated shortcut latency and let a nominal
six-second retry loop exceed its bound. Reusing a short-lived internal authority
while revalidating the exact pair preserves the fail-closed rule; a wall-clock
deadline with remaining-time scripting limits makes the visible shortcut bound
real rather than attempt-count based.
