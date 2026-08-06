# ADR 0008: Use Native Messaging For macOS Window Placement

- Status: Accepted
- Date: 2026-08-01

## Context

The macOS Hammerspoon integration must create an inactive Chrome window on the
pointer display before privately activating that exact native window. The first
working bridge encoded filtered/new-page intent and desktop position into four
global extension commands. That limited direct placement to two displays,
consumed Chrome shortcut assignments, and required another command for every
new route or display position.

Chrome extensions cannot accept arbitrary local process messages directly.
Chrome Native Messaging provides a user-authorized stdio channel to one local
host, while Hammerspoon can invoke the same executable in a short-lived client
mode.

## Decision

- Tab Out owns a `com.tabout.native_bridge` host, its versioned JSON protocol,
  and user-level build/install/uninstall/status scripts.
- Chrome starts the host through Native Messaging. The host exposes one
  owner-only Unix-domain socket and forwards validated requests and responses;
  it owns no display, profile, window-creation, or focus policy.
- Hammerspoon sends the operation, pointer-display bounds, request ID, and
  deadline. The extension uniquely maps those bounds to an enabled Chrome
  display and retains ownership of inactive Chrome window creation. ADR 0010
  refines the creation-to-focus handoff so the initial create call contains the
  final target bounds and a target-display snapshot covers the inactive-to-front
  transition until exact activation completes.
- The same protocol exposes a read-only configured-profile inventory. Because
  Chrome runs the extension separately in each profile, the response contains
  only that profile's normal, non-minimized browser window IDs. The host merely
  forwards the response; it does not inspect windows or browser data.
- Hammerspoon continues to observe the created native window, validate its
  display, Space, profile, PID, and window ID, and perform Private Exact-Window
  Activation. A bridge failure remains a Safe Abort.
- The native host is installed only for the current user. It has no LaunchAgent,
  login item, root files, or network listener. Chrome's host manifest allows one
  exact extension origin, and the local socket accepts only the current user.

## Consequences

The same two visible Hammerspoon shortcuts now work with any display count and
the four hidden Chrome shortcut assignments disappear. Installation adds one
compiled executable and one Chrome Native Messaging manifest. While the native
port is connected, Chrome keeps one small host process and the extension service
worker alive; closing Chrome ends the process. After a disconnect, a short
fast-reconnect sequence ends in a delay longer than Chrome's normal service-worker
idle window. An unavailable optional host therefore lets an otherwise idle worker
terminate; the extension retries from the fast sequence on its next ordinary wake,
without a reconnect alarm. Extension or protocol upgrades may require rebuilding
the host and reloading the unpacked extension.

The host socket still has one active extension peer, so the supported setup
installs Tab Out only in the configured automation profile. Hammerspoon uses the
profile-scoped IDs for focus-independent native-window correlation as described
by ADR 0012; the bridge does not transmit tab URLs or other matching data.

## Qualification

The Remote Display Preservation oracle runs recorded on 2026-07-31 predate this
Native Messaging transport and do not qualify its creation path. The installed
host, reloaded extension bundle, and Hammerspoon route must complete fresh live
oracle runs for both shortcuts, creation and reuse, and each relevant remote
display starting state before this transport is described as qualified on the
acceptance machine.
