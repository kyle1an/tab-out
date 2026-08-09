# Tab Out Hammerspoon Integration

This optional macOS integration routes the global Tab Out shortcuts to the
active Space on the display under the pointer while preserving every other
display. Tab Out owns the Spoon, its private exact-window helper, the Native
Placement Bridge protocol, installation and diagnosis, and their regression
tests.

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
TAB_OUT_HAMMERSPOON_CONFIG_DIR="$HAMMERSPOON_CONFIG_DIRECTORY" \
  "$TAB_OUT_CHECKOUT/scripts/install-macos-integration" "$EXTENSION_ID"
```

The installer builds the private helper, links the checkout-owned
`TabOut.spoon` into the selected configuration, and installs the user-level
native-messaging host. It installs no LaunchAgent, login item, root file, or
network listener.

After it succeeds:

1. Reload Tab Out in `chrome://extensions` so its service worker reconnects.
2. Open Hammerspoon, or reload it from its menu if it was already running.

For a manual installation, use the same lower-level owned commands:

```zsh
(
  cd "$TAB_OUT_CHECKOUT"
  pnpm hammerspoon:build
  TAB_OUT_HAMMERSPOON_CONFIG_DIR="$HAMMERSPOON_CONFIG_DIRECTORY" \
    scripts/hammerspoon/install
  scripts/native-host/install "$EXTENSION_ID"
)
```

### 6. Complete macOS permissions

In **System Settings > Privacy & Security**:

- **Accessibility** is required for global shortcuts, Spaces, and exact-window
  operations.
- **Automation > Google Chrome** is required when macOS prompts after the first
  routed shortcut.
- **Screen Recording** is optional. It enables the target-display transition
  shield; without it, routing remains available but the ordinary
  inactive-to-front transition may be visible.

These permissions require the user. Relaunch or reload Hammerspoon when macOS
requests it, then reload Tab Out once more.

### 7. Exercise the live acceptance matrix

The Native Placement Bridge reports ready only after a routed request. With the
user observing every display, exercise both Command-Shift-K and
Command-Shift-Space over create and reuse routes:

- a target display with no Chrome window, which requires direct creation;
- a target display with an existing configured-profile Chrome window, which
  requires verified reuse;
- a remote display where Chrome is behind a focused non-Chrome window; and
- closing a bridge-created window while that remote focus and ordering must
  remain unchanged.

Confirm destination focus and the absence of remote focus, ordering, or window
flash regressions. Repeat create and reuse acceptance after macOS updates or
changes to Private Exact-Window Activation.

### 8. Run the final diagnostic

```zsh
"$TAB_OUT_CHECKOUT/scripts/doctor-macos-integration" \
  "$HAMMERSPOON_CONFIG_DIRECTORY"
```

It verifies product source and build prerequisites, the active Hammerspoon
configuration, the checkout-owned Spoon link, native host, and the loaded
Spoon's public readiness interface. It does not inspect a particular local
settings filename. Missing Screen Recording produces a warning rather than a
setup action because only transition shielding depends on it.

For lower-level inspection:

```zsh
hs -c 'return hs.inspect(spoon.TabOut.status())'
"$TAB_OUT_CHECKOUT/scripts/native-host/status"
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

When Screen Recording permission is available, the Spoon snapshots only the
target display into a non-focusable transition shield before creation. It
validates the new native window ID, privately focuses that exact window,
focuses the destination control, and then removes the shield so Chrome's first
exposed frame is already frontmost. A missing permission skips only the shield.

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
  choice, request queueing, cold Chrome launch, and Native Placement Bridge
  creation.
- `chrome_catalog.lua` owns configured-profile discovery and its window cache.
- `window_transition.lua` owns exact activation, the transition shield,
  destination focus, and the bridge-created window close lifecycle.
- `bridge.lua` owns the local Native Placement Bridge client protocol.

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
TAB_OUT_HAMMERSPOON_CONFIG_DIR="$HAMMERSPOON_CONFIG_DIRECTORY" \
  "$TAB_OUT_CHECKOUT/scripts/uninstall-macos-integration"
```

The Spoon is a link to this checkout, and the uninstall scripts remove only
artifacts they own. They do not remove either checkout, Hammerspoon, Chrome,
macOS permissions, or the top-level `~/.hammerspoon` configuration. Chrome
starts the native host on demand.
