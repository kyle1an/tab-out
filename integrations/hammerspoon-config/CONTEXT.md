# Domain Context

## Glossary

- **Target Focus**: Keyboard input is directed to the Tab Out Chrome window on the pointer display.
- **Target Profile Continuity**: The target window belongs to the configured profile in the existing Chrome application. A separate browser application or isolated browser profile does not satisfy the shortcut.
- **Remote Raise**: An existing Chrome window becomes visually frontmost on a non-target display.
- **Remote Focus**: Keyboard input is directed to a Chrome window on a non-target display.
- **Remote Display Preservation**: Every non-target display keeps its active Space and frontmost window unchanged throughout and after every Tab Out shortcut, whether the target Chrome window is reused or newly created. A Remote Raise or Remote Focus violates this guarantee.
- **Safe Abort**: When Target Focus and Remote Display Preservation cannot both be guaranteed for the current desktop state, the shortcut makes no window or Space changes and presents a short explanation.
- **Native Placement Bridge**: The user-local, versioned native-messaging channel through which Hammerspoon sends a destination kind and pointer-display bounds to Tab Out for inactive window creation.
- **Private Exact-Window Activation**: The gated one-shot native operation that names the validated target Chrome CGWindow ID in the WindowServer foreground/key sequence and then raises that same Accessibility window.
- **Qualified Build**: The exact macOS build on which every create and reuse route has passed the live Remote Display Preservation oracle. Private Exact-Window Activation is unavailable on every other build until it is requalified.

## Routing invariants

- The Native Placement Bridge owns transport only. Hammerspoon owns target display and Space policy, while Tab Out owns inactive creation; neither bridge layer may activate Chrome or focus a Chrome window.
- Chrome must already be running and the Native Placement Bridge must be connected so Tab Out can own inactive creation; otherwise the shortcut Safe Aborts before mutation.
- The Native Placement Bridge addresses the pointer display by full bounds and must not impose a display-count or shortcut-position limit.
- Hammerspoon must establish the exact target display, Space, profile, PID, and native window ID before Private Exact-Window Activation.
- Existing-window navigation occurs only after the exact target is privately activated and verified as Chrome's front window; bounds alone are not an identity because another Space may contain a same-sized window.
- Private Exact-Window Activation has no fallback to ordinary Chrome activation, a click, or remote z-order restoration. A missing capability or failed postcondition becomes a Safe Abort.
