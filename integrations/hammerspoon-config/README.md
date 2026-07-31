# Hammerspoon Config

Personal macOS automation managed as a standalone Lua repository. Hammerspoon loads it through the `~/.hammerspoon` symlink.

## Layout

- `init.lua` owns Hammerspoon lifecycle settings, IPC, and debounced config reloads.
- `modules/tab_out.lua` owns the Tab Out shortcuts and Chrome window routing.

Write Hammerspoon behavior in native Lua. Keep `init.lua` as a small bootstrap and put feature behavior in a focused module under `modules/`.

## Tab Out shortcuts

| Shortcut | Result |
| --- | --- |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>K</kbd> | Open a fresh Tab Out page with the filter focused |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>Space</kbd> | Open a fresh Tab Out page with Chrome's address bar focused |

Both shortcuts capture the display containing the mouse pointer and the active Mission Control Space on that display. If the pointer display is unavailable, the frontmost window's display and then the main display are fallbacks.

The router:

1. Reuses the frontmost eligible Chrome window on that display and Space.
2. Restricts reuse to the configured Chrome profile by reading Chrome's local profile metadata and checked profile menu item.
3. Creates one normal target-profile Chrome window when no eligible window exists.
4. Preserves the frontmost non-Chrome window on every other display while creating the destination window.
5. Never moves or resizes an existing Chrome window.
6. Preserves a new window's size while clamping it into the target display.

Hammerspoon owns the two visible keyboard chords. Chrome's extension-shortcut assignments can remain unassigned; after selecting and verifying the destination window, the router opens Tab Out's internal extension page directly in that window.

The new-page shortcut invokes Chrome's native new-tab action in an existing window. When it must create a window, it launches Chrome in the background with an explicit `chrome://newtab/` destination, so Tab Out's override retains its new-tab identity and Chrome's normal empty omnibox. Chrome can briefly focus an existing window while handing that request to its running process; the router immediately restores the prior front window on that display so Chrome never becomes visibly topmost there. The filter shortcut uses Tab Out's extension URL because its `focusFilter=1` parameter is what focuses the in-page filter before the app mounts.

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
