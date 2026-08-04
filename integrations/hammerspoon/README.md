# Tab Out Hammerspoon Integration

This optional macOS integration routes the global Tab Out shortcuts to the
active Space on the display under the pointer while preserving every other
display. Tab Out owns the Spoon, its private exact-window helper, the Native
Placement Bridge protocol, and their regression tests.

## Install

Copy the unpacked extension's 32-character ID from `chrome://extensions`, then
run from the Tab Out checkout:

```bash
scripts/install-macos-integration <extension-id>
```

The installer builds the private helper, links `TabOut.spoon` into
`~/.hammerspoon/Spoons`, and installs the user-level native-messaging host.
Reload Tab Out in `chrome://extensions`, then reload Hammerspoon.

Configure the Spoon from `~/.hammerspoon/init.lua`:

```lua
assert(hs.loadSpoon("TabOut"), "Tab Out Spoon is not installed")

spoon.TabOut:start({
  chromeProfileDirectory = "Profile 3",
  shortcuts = {
    filter = { key = "k", modifiers = { "cmd", "shift" } },
    newPage = { key = "space", modifiers = { "cmd", "shift" } },
  },
})
```

`chromeProfileDirectory` selects the Chrome profile used by the automation.
The Chrome bundle ID, user-data directory, native-host path, and private-helper
path use standard per-user defaults. Set `privateFocusEnabled = false` as a
kill switch; both shortcuts then Safe Abort rather than fall back to ordinary
Chrome activation.

For a manual install, run:

```bash
pnpm hammerspoon:build
scripts/hammerspoon/install
scripts/native-host/install <extension-id>
```

## Runtime contract

The Spoon captures one target display and active Space for each invocation. It
reuses only a verified window from the configured profile on that destination,
or sends the destination kind and full display bounds through the Native
Placement Bridge for inactive creation. Tab Out creates the new Chrome window
with `focused: false` and its final target-display bounds in the same call.
Existing unverified or other-profile Chrome windows do not block that fallback
and are never focused by it.
An unfocused window can be verified without bringing Chrome forward: the
profile-scoped extension reports its normal window IDs, and the Spoon correlates
them to a unique native window using Chrome AppleScript and Accessibility data.
If the correlation is unavailable or ambiguous, the existing safe creation
fallback remains in effect.

If Chrome is stopped, the Spoon starts the configured profile in the background
without a startup window, waits for the Native Placement Bridge to connect, and
then performs the same directly placed creation. On a fullscreen Space, it
reuses a verified Chrome window in place; otherwise it switches to an available
regular Desktop on that display before creating the destination.

Before creation, the Spoon snapshots only the target display into a
non-focusable transition shield. It validates the new native window ID,
privately focuses that exact window, focuses the destination control, and then
removes the shield so Chrome's first exposed frame is already frontmost.

Creation and activation have no fallback to application activation,
`window:focus()`, a synthetic click, or remote z-order restoration. If the
target identity, Accessibility capability, native bridge, or private helper is
unavailable, the shortcut Safe Aborts before mutation.

When closing a bridge-created window would otherwise promote another Chrome
window, the Spoon handles the red close button, Command-Shift-W, and a
single-tab Command-W before Chrome. It first restores the eligible non-Chrome
window that was focused when the shortcut ran, then closes the created window.
The prior window may be on the target display or another display; on the target
display it must still be directly beneath the created window. Command-W remains
Chrome-owned when multiple tabs are present. Unhandled close paths receive
best-effort final focus repair but may still show a transient Chrome frame.

The private helper uses undocumented WindowServer calls. It resolves the
required private symbols and connection at runtime and Safe Aborts when those
capabilities are unavailable; it is not restricted to an exact macOS build.
After a macOS update, exercise both create and reuse routes with both shortcuts
against the live Remote Display Preservation oracle.

## Source layout

The Spoon keeps its public interface and wiring in `init.lua` and delegates each
invocation through a small set of deep modules:

- `window_router.lua` owns pointer-display and Space selection, existing-window
  choice, request queueing, cold Chrome launch, and Native Placement Bridge creation.
- `chrome_catalog.lua` owns configured-profile discovery and its window cache.
- `window_transition.lua` owns exact activation, the transition shield, destination
  focus, and the bridge-created window close lifecycle.
- `bridge.lua` owns the local Native Placement Bridge client protocol.

Keep orchestration in `init.lua`; keep mutable lifecycle state inside the module
that owns it. Tests exercise the public Spoon interface through the reusable
scenario adapter under `tests/support/`.

## Verify and diagnose

Run the isolated router, bridge, and installer regressions after changing the
integration:

```bash
pnpm hammerspoon:test
pnpm native-host:test
```

The Lua tests use a fake Hammerspoon API and do not open or focus live Chrome
windows. Inspect the loaded Spoon from a terminal with:

```bash
hs -c 'return hs.inspect(spoon.TabOut.status())'
scripts/native-host/status
```

Hammerspoon needs Accessibility permission. Screen Recording permission enables
the target-display transition shield; without it, routing still works but the
normal inactive-to-front transition may be visible. The verified destination
window also requires Automation permission for Hammerspoon to send navigation
to Google Chrome.

## Uninstall

```bash
scripts/uninstall-macos-integration
```

The Spoon is a link to this checkout, and the uninstall scripts remove only
artifacts they own. The integration installs no LaunchAgent, login item, root
file, or network listener. Chrome starts the native host on demand.
