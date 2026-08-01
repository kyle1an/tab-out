# Hammerspoon Config

Personal macOS automation managed as a standalone Lua repository. Hammerspoon loads it through the `~/.hammerspoon` symlink.

## Layout

- `init.lua` owns Hammerspoon lifecycle settings, IPC, and debounced config reloads.
- `modules/tab_out.lua` owns the Tab Out shortcuts and Chrome window routing.
- `modules/tab_out_bridge.lua` adapts one versioned placement request to Tab Out's installed native host.

Write Hammerspoon orchestration in native Lua. Keep `init.lua` as a small bootstrap and put feature behavior in a focused module under `modules/`; the build-gated exact-window adapter under `native/` is the sole native-code exception.

## Tab Out shortcuts

| Shortcut | Result |
| --- | --- |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>K</kbd> | Open a fresh Tab Out page with the filter focused |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>Space</kbd> | Open a fresh Tab Out page with Chrome's address bar focused |

Both shortcuts capture the display containing the mouse pointer and the active Mission Control Space on that display. If the pointer display is unavailable, the frontmost window's display and then the main display are fallbacks.

The router:

1. Reuses the frontmost eligible Chrome window on that display and Space only after learning that it belongs to the configured profile.
2. Never focuses an inactive Chrome window merely to discover its profile. An unknown candidate is skipped.
3. Privately activates that exact native window before asking Chrome to create the tab in its now-unambiguous front window.
4. When Chrome is running and the pointer display's active Space has no normal Chrome window, sends that display's full bounds through Tab Out's Native Placement Bridge, then privately activates the observed native window ID.
5. Safe Aborts when Chrome is not already running because the extension cannot guarantee inactive direct creation in that state.
6. Never moves or resizes an existing Chrome window, and Safe Aborts before mutation when the private helper or an exact target identity is unavailable.

Hammerspoon owns only the two visible keyboard chords. The Native Placement Bridge carries the operation and pointer-display bounds through one local interface, so it works with any display count and requires no hidden Chrome shortcut assignments.

The Native Placement Bridge stops after `chrome.windows.create({ focused: false, ...finalBounds })`. Hammerspoon waits for the destination control, activates the exact target CGWindow ID through the native helper, verifies that same ID owns keyboard focus, and then focuses either Tab Out's search field or Chrome's address bar through Accessibility. It never falls back to `window:focus()`, application activation, or a synthetic click on Chrome.

Install the bridge from the Tab Out repository after copying the unpacked extension ID from `chrome://extensions`:

```bash
scripts/native-host/install <extension-id>
```

Reload Tab Out in `chrome://extensions`, then check the connection with `scripts/native-host/status`. `scripts/native-host/uninstall` removes the host. Chrome launches it on demand; there is no LaunchAgent, login item, root install, or network listener.

The native helper is intentionally narrow and private. It validates an on-screen, non-minimized standard window owned by the running Google Chrome process; dynamically resolves the exact-window WindowServer calls; performs the tested exact-window foreground/key sequence followed by `AXRaise`; and checks every result. It does not install a daemon, inject into Dock, require root, or require disabling SIP. Because those WindowServer calls are undocumented, the helper is allowlisted only for the qualified macOS build `25F84`. On another build—or when a required symbol or Accessibility capability is missing—both shortcuts Safe Abort before changing Chrome.

Build the ignored native artifact after cloning or changing its source, then reload Hammerspoon:

```bash
scripts/build_tab_out_private_focus
hs -c 'hs.reload()'
```

Set `privateFocusEnabled = false` in `init.lua` as a kill switch. Do not update the build allowlist until both create and reuse routes have passed the live cross-display oracle on the new macOS build.

For an existing verified window, private activation happens before AppleScript. Hammerspoon verifies that the exact target is now Chrome's front window and creates the new tab there; this avoids ambiguous bounds when another Space contains a same-sized Chrome window. A directly placed new window already contains either `focusFilter=1` or Chrome's native new-tab page before activation.

When the pointer display's active Space is full-screen, the router switches that display to its last observed regular Desktop. It fails with a short Hammerspoon HUD if no regular Desktop has been observed.

Success is silent. Detailed diagnostics are written to the Hammerspoon Console without logging profile names, account names, extension IDs, or page URLs.

## Editing

Edit the checked-out repository, not the symlink destination as a separate copy:

```bash
cd "$HOME/Developer/hammerspoon-config"
```

Saving a `.lua` file triggers one debounced `hs.reload()`. If a syntax error prevents the watcher from loading, fix the file and choose **Reload Config** from the Hammerspoon menu.

Inspect the safe runtime status from a terminal:

```bash
hs -c 'return hs.inspect(tabOutAutomation.status())'
```

Run the isolated cross-display focus regression after changing the Tab Out router:

```bash
hs -c 'return dofile(hs.configdir .. "/tests/tab_out_cross_display_focus_spec.lua")'
hs -c 'return dofile(hs.configdir .. "/tests/tab_out_bridge_spec.lua")'
```

The regression test loads the router with a fake Hammerspoon API and does not open or focus live Chrome windows.

Hammerspoon requires these macOS permissions:

- **System Settings → Privacy & Security → Accessibility** for global hotkeys, windows, and Spaces. Relaunch Hammerspoon after granting it.
- **System Settings → Privacy & Security → Automation → Hammerspoon → Google Chrome** so the verified destination window can receive a new tab. macOS asks on first use.

## Install and upgrade

Homebrew owns the application installation and upgrades; Hammerspoon's built-in updater is disabled by `init.lua`.

```bash
brew install --cask hammerspoon
brew upgrade --cask hammerspoon
```

`init.lua` also enables **Launch at Login**.
