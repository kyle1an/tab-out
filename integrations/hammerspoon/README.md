# Tab Out Hammerspoon Integration

This optional macOS integration routes the global Tab Out shortcuts to the
active Space on the display under the pointer while preserving every other
display. It also enables the header action that merges eligible Chrome windows
on the invoking Tab Out page's active Desktop. Tab Out owns the Spoon, its
private exact-window helper, the Native Placement Bridge and desktop-control
protocols, installation and diagnosis, and their regression tests.

The Chrome-launched native host supplies the fresh process identity of the
configured Chrome instance for each route. A separately launched automation or
MCP Chrome process may use the same Google Chrome app bundle and executable; Tab
Out excludes that isolated process without changing its launcher, profile,
flags, windows, or tabs.

## Install and configure

This is the canonical setup and acceptance guide for the integration. It works
with any existing Hammerspoon configuration directory; the personal
`hammerspoon-config` repository is one supported configuration layout.

### Scope and safety

The following procedure does not clone, pull, reset, or switch branches. It
does not replace an existing `~/.hammerspoon`, grant macOS permissions, or
operate Chrome's unpacked-extension controls without the user.

Set these variables to the existing Tab Out checkout and the Hammerspoon
configuration directory that should load the Spoon:

```zsh
TAB_OUT_CHECKOUT=/path/to/tab-out
HAMMERSPOON_CONFIG_DIRECTORY=/path/to/hammerspoon-config
```

The diagnostic is read-only and does not create or focus Chrome windows. A
nonzero result is expected before setup; its `ACTION` lines identify remaining
work.

Installation and diagnosis do not inspect or modify external browser automation
configuration. Do not replace an automation tool's temporary `--user-data-dir`
or debugging transport to make Tab Out work; instance selection belongs to Tab
Out's native bridge.

```zsh
"$TAB_OUT_CHECKOUT/scripts/doctor-macos-integration" \
  "$HAMMERSPOON_CONFIG_DIRECTORY"
```

### 1. Inspect the selected inputs

For each directory that is a Git worktree, record its selected revision and
state before changing the Mac. Skip the Hammerspoon pair when the selected
configuration directory is not a Git worktree:

```zsh
git -C "$TAB_OUT_CHECKOUT" status --short --branch
git -C "$TAB_OUT_CHECKOUT" rev-parse HEAD
git -C "$HAMMERSPOON_CONFIG_DIRECTORY" status --short --branch
git -C "$HAMMERSPOON_CONFIG_DIRECTORY" rev-parse HEAD
```

Stop if a revision is unexpected or either worktree contains changes that the
setup must not disturb. Updating repositories is outside this procedure.

### 2. Install missing prerequisites

The integration expects Google Chrome and Hammerspoon in `/Applications` and
uses `xcrun clang` plus `xcrun swiftc`. Install only prerequisites reported by
the diagnostic. For example, when Homebrew is the selected app installer:

```zsh
xcode-select --install
brew install --cask hammerspoon
```

`xcode-select --install` opens a user-facing installer. Do not treat it as
complete until `xcrun --find clang` and `xcrun --find swiftc` succeed.

### 3. Activate the Hammerspoon configuration

Inspect the active path before creating anything:

```zsh
ls -ld "$HOME/.hammerspoon" 2>/dev/null || true
readlink "$HOME/.hammerspoon" 2>/dev/null || true
```

- If it resolves to the selected configuration directory, leave it alone.
- If it does not exist, link the selected directory:

  ```zsh
  ln -s "$HAMMERSPOON_CONFIG_DIRECTORY" "$HOME/.hammerspoon"
  ```

- If another file, directory, or link exists, stop. Do not move, merge, delete,
  or replace it without a separate decision and rollback plan.

Do not open or reload Hammerspoon until the Spoon is installed in step 5 if the
configuration intentionally fails when a required Spoon is absent.

### 4. Configure the Chrome profile and load Tab Out

In the Chrome profile that should own Tab Out:

1. Open `chrome://version`.
2. Read **Profile Path** and take its final directory name, such as `Default` or
   `Profile 3`. Do not guess from Chrome's visible profile name.
3. Configure that directory and the desired global shortcuts through the
   settings table passed to `spoon.TabOut:start(config)`.

This selected profile is the **Configured Profile**. At runtime Tab Out accepts
only the **Configured Chrome Instance** whose Chrome-launched native host proves
that profile's current process. Keep the unpacked Tab Out extension loaded in
only this profile within the selected Chrome user-data directory; if it was
loaded in another profile, remove that copy there. The Spoon fails closed when
two profiles can host Tab Out because Chrome gives both profiles the same browser
process. Another Chrome process is not eligible merely because
`chrome://version` shows the same executable or application name.

The companion `hammerspoon-config` repository keeps those values in ignored
`tab-out.local.lua`. Create it only when absent, then replace the profile
placeholder and review the shortcuts:

```zsh
test -e "$HAMMERSPOON_CONFIG_DIRECTORY/tab-out.local.lua" || \
  cp "$HAMMERSPOON_CONFIG_DIRECTORY/tab-out.local.example.lua" \
    "$HAMMERSPOON_CONFIG_DIRECTORY/tab-out.local.lua"
```

Another Hammerspoon configuration can call the same Spoon interface directly:

```lua
assert(hs.loadSpoon("TabOut"), "Tab Out Spoon is not installed")

spoon.TabOut:start({
  chromeProfileDirectory = "REPLACE_WITH_CHROME_PROFILE_DIRECTORY",
  shortcuts = {
    filter = { key = "k", modifiers = { "cmd", "shift" } },
    newPage = { key = "space", modifiers = { "cmd", "shift" } },
  },
})
```

Set `privateFocusEnabled = false` in that table as a kill switch. Both shortcuts
then Safe Abort instead of falling back to ordinary Chrome activation.

The extension ID does not belong in Hammerspoon configuration. The installer
records it in the per-user native-messaging manifest, and the Spoon discovers
the installed extension from the selected Chrome profile.

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
select `$TAB_OUT_CHECKOUT/extension`, and copy the resulting 32-character Tab
Out extension ID.

### 5. Install the product integration

Run the canonical installer with the copied extension ID. The explicit config
directory also keeps installation correct when it is not the default path:

```zsh
EXTENSION_ID=<32-character-extension-id>
"$TAB_OUT_CHECKOUT/scripts/install-macos-integration" \
  "$EXTENSION_ID" \
  "$HAMMERSPOON_CONFIG_DIRECTORY"
```

The installer builds the private helper, links the checkout-owned
`TabOut.spoon` into the selected configuration, and installs the user-level
native-messaging host. It installs no LaunchAgent, login item, root file, or
network listener.

After it succeeds:

1. Reload Tab Out in `chrome://extensions` so its service worker reconnects.
2. Open Hammerspoon, or reload it from its menu if it was already running.
3. Click the Tab Out toolbar icon and confirm the final Tab Actions Menu
   option no longer shows an integration setup or update reason.

### 6. Complete macOS permissions

In **System Settings > Privacy & Security**:

- **Accessibility** is required for global shortcuts, Spaces, and exact-window
  operations.
- **Automation > Google Chrome** is required when macOS prompts after the first
  routed shortcut.
- **Screen Recording** is optional. It enables the target-display transition
  shield; without it, routing remains available but the ordinary
  inactive-to-front transition may be visible. Desktop Window Merge does not
  capture the screen and does not depend on this permission.

These permissions require the user. Relaunch or reload Hammerspoon when macOS
requests it, then reload Tab Out once more.

### 7. Exercise the live acceptance matrix

The diagnostic can verify Native Placement Bridge connectivity without routing
a window, but it does not replace live acceptance. With the user observing every
display, exercise both configured shortcuts over create and reuse routes:

- a target display with no Chrome window, which requires direct creation;
- a target display with an existing configured-profile Chrome window, which
  requires verified reuse;
- a remote display where Chrome is behind a focused non-Chrome window; and
- closing a bridge-created window while that remote focus and ordering must
  remain unchanged.

Also exercise the process-isolation cases for both shortcuts:

- leave a separately launched same-bundle automation/MCP Chrome instance open,
  ideally with one window matching the configured window's bounds;
- run reuse and create routes and confirm only the configured-profile window
  receives the destination;
- stop the Configured Chrome Instance while leaving the isolated instance open,
  invoke each shortcut, and confirm Tab Out cold-launches the configured
  user-data directory and profile instead of adopting the isolated process; and
- confirm the isolated process keeps the same windows, tabs, geometry, profile,
  command line, and lifecycle. An ordinary focus change away from it is expected
  when Tab Out focuses the configured destination.

Confirm destination focus and the absence of remote focus, ordering, or window
flash regressions. Repeat create and reuse acceptance after macOS updates or
changes to Private Exact-Window Activation.

Then exercise **Merge windows on this desktop…** from the Tab Out toolbar
menu:

- keep two or more normal configured-profile Chrome windows on the same active
  regular Desktop, including pinned tabs and a titled, colored tab group;
- keep another configured-profile window on a different Desktop or display,
  and, when available, a minimized, app, popup, fullscreen, sticky, Incognito,
  or other-profile window;
- confirm the in-menu preview counts only the eligible same-Desktop source
  windows and tabs and gives Cancel initial focus, and that confirming focuses
  a Tab Out page in the invoking window showing the same non-dismissible
  `Merging windows…` modal; and
- confirm the invoking window keeps focus and its active tab, destination tabs
  stay first, source windows follow native front-to-back order, pins and whole
  groups retain their state, eligible emptied windows close, and excluded
  windows remain unchanged.

Repeat with only the invoking window eligible and confirm no modal opens. The
page should report that all windows on the Desktop are already merged. Live
acceptance is required after macOS or Chrome updates because Space inspection
uses Hammerspoon's experimental macOS Spaces interface.

### 8. Run the final diagnostic

```zsh
"$TAB_OUT_CHECKOUT/scripts/doctor-macos-integration" \
  "$HAMMERSPOON_CONFIG_DIRECTORY"
```

It verifies product source and build prerequisites, the active Hammerspoon
configuration, the checkout-owned Spoon link, native host, the loaded Spoon's
public readiness interface, and an active versioned Native Placement Bridge
status round trip. It does not create or focus a window, require a prior routed
request, or inspect a particular local settings filename. Missing Screen
Recording produces a warning rather than a setup action because only transition
shielding depends on it.

For lower-level inspection:

```zsh
hs -c 'return hs.inspect(spoon.TabOut.status())'
"$TAB_OUT_CHECKOUT/scripts/native-host/status"
```

In the Spoon output, `nativeBridgeReady` records whether its most recent bridge
round trip succeeded. `desktopWindowControllerAvailable` confirms that the
controller loaded, while `desktopWindowControllerReady` is true only while the
extension-owned native host is running and connected. The product doctor
performs a fresh placement-bridge status round trip and separately requires the
desktop-window controller connection instead of treating a loaded controller as
ready.

## Runtime behavior

Each configured shortcut targets the active Space on the display under the
pointer. The Spoon first requests fresh configured-profile window IDs and the
Chrome-launched host's process ID. Its native helper targets ScriptingBridge and
Accessibility through that exact PID, correlates browser and native window IDs
internally, and revalidates all three identities before focus or navigation. The
host PID must also match the configured user-data directory's live Chrome
process lock, and no other profile in that directory may expose Tab Out's
shortcut commands. It reuses only a verified Configured Profile window in that
Configured Chrome Instance; otherwise the Native Placement Bridge creates the
destination there without activating Chrome on another display. A route that
needs an unavailable identity, Accessibility, bridge, or Private Exact-Window
Activation capability Safe Aborts instead of using an unsafe focus or activation
fallback. Screen Recording adds transition shielding but is not required for
routing.

Active URLs from the Configured Chrome Instance may be read ephemerally inside
the native helper solely to correlate browser and macOS windows. They never
cross the native protocol, persist, or enter logs. Tab Out does not read browser
content from a same-bundle Isolated Chrome Instance and never navigates, creates,
closes, moves, resizes, terminates, or reconfigures it. A pre-mutation identity
change receives one fresh-authority retry. After mutation starts, Tab Out never
replays the route; it cleans up a failed created window only while the full
process, browser-window, native-window, and creation-token identity is unchanged.
After exact navigation, it may wait through transient ScriptingBridge,
Accessibility-document, or destination-focus convergence. That bounded wait
retries only read-only correlation and control focus, revalidates the full
process/browser/native identity before every focus attempt, and never replays
navigation.

Desktop Window Merge starts from the Tab Out page that invoked the header
action. The extension sends only configured-profile browser window IDs to the
controller. Hammerspoon maps them to visible native Chrome windows, selects the
exact same active regular Space and display, returns their front-to-back browser
window IDs, and revalidates that topology at confirmation. Raw URLs may be used
ephemerally inside the local Chrome-to-Accessibility correlation, but they are
never returned across the native protocol, persisted, or logged. Ambiguous
identity, Space, display, profile, or z-order state aborts before mutation.

The canonical behavior is in the root
[Runtime and Interaction Contracts](../../CONTEXT.md#runtime-and-interaction-contracts).
The placement seam and repository ownership are recorded in
[ADR 0008](../../docs/adr/0008-use-native-messaging-for-macos-window-placement.md)
and
[ADR 0009](../../docs/adr/0009-co-locate-the-macos-integration.md). The
same-Desktop controller boundary is recorded in
[ADR 0020](../../docs/adr/0020-use-hammerspoon-to-select-same-desktop-chrome-windows.md).
[ADR 0022](../../docs/adr/0022-target-chrome-through-native-host-process-authority.md)
records the configured-instance process-authority boundary. Subsequent
macOS-placement decisions remain under [`docs/adr/`](../../docs/adr/).

## Source layout

The Spoon keeps its public interface and wiring in `init.lua` and delegates each
invocation through a small set of deep modules:

- `window_router.lua` owns pointer-display and Space selection, existing-window
  choice, request queueing, cold Chrome launch, and Native Placement Bridge
  creation.
- `chrome_catalog.lua` intersects configured-profile browser IDs with exact-PID
  native inventory and owns the resulting window cache.
- `desktop_window_controller.lua` owns the persistent versioned control socket,
  exact same-Desktop selection tokens, native z-order, and fail-closed
  revalidation used by Desktop Window Merge.
- `window_transition.lua` owns exact activation, the transition shield,
  destination focus, and the bridge-created window close lifecycle.
- `bridge.lua` owns the local Native Placement Bridge client protocol.
- `native/tab_out_private_focus.m` owns PID-targeted Chrome inventory,
  browser/native correlation, exact focus, navigation, and token-guarded cleanup.

Keep orchestration in `init.lua`; keep mutable lifecycle state inside the module
that owns it. Tests exercise the public Spoon interface through the reusable
scenario adapter under `tests/support/`.

## Develop and verify

From the Tab Out checkout, run the isolated router, bridge, installer, and
doctor regressions after changing the integration:

```zsh
pnpm hammerspoon:test
pnpm native-host:test
```

The Lua tests use a fake Hammerspoon interface and do not open or focus live
Chrome windows. They do not replace the live acceptance matrix.

## Uninstall

```zsh
"$TAB_OUT_CHECKOUT/scripts/uninstall-macos-integration" \
  "$HAMMERSPOON_CONFIG_DIRECTORY"
```

The Spoon is a link to this checkout, and the uninstall scripts remove only
artifacts they own. They do not remove either checkout, Hammerspoon, Chrome,
macOS permissions, or the top-level `~/.hammerspoon` configuration. Chrome
starts the native host on demand.
