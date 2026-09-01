# ADR 0023: Pair the Native Bridge to One Chrome Profile

- Status: Accepted; profile replacement superseded by ADR 0024
- Date: 2026-08-27

## Context

Chrome may load the same unpacked Tab Out extension ID in several profiles of
one macOS browser process. Native messaging supplies the host with that shared
extension origin and the browser parent PID, but not a trustworthy profile
directory. The previous rule therefore required Tab Out to be absent from every
other profile. Loading it later in a second profile made both shortcuts and
Desktop Window Merge Safe Abort even though the original profile had not
changed.

Letting the first host process that happens to bind the shared socket win is not
an acceptable replacement. Chrome can wake profiles in either order, so startup
timing would silently choose authority and a later profile could take it after a
restart.

## Decision

- Each profile creates one opaque random profile ID in its own
  `chrome.storage.local`. The value contains no profile name, account, path,
  browsing data, or extension content and is used only by the local native
  integration.
- Every native-messaging connection begins with a versioned profile handshake.
  The host does not create or replace the shared local socket before that
  handshake matches the persisted selected profile.
- When no profile is selected, the Tab Actions Menu offers an explicit **Use
  this profile for macOS integration** action. The host serializes that
  first selection under a per-user file lock and writes it to a mode-restricted
  local file. A competing selection cannot overwrite it.
- A later connection with another profile ID receives only the fact that
  another profile is selected, exits without binding the local socket, and does
  not enter the normal reconnect loop. It cannot automatically disable or
  replace the selected profile. ADR 0024 defines the explicit, revision-checked
  transfer that may replace it after user confirmation.
- The explicitly paired extension instance is the Configured Profile authority
  for profile-scoped browser window inventories. Hammerspoon continues to
  require the configured user-data process lock, the configured profile's local
  extension metadata, exact browser/native window correlation, and all existing
  pre-mutation revalidation. It no longer scans other profiles merely to require
  extension-install exclusivity.
- Machine-local `chromeProfileDirectory` remains the cold-launch and bootstrap
  setting and must name the same profile in which the user performs the pairing.
  Chrome exposes no native-messaging profile-directory claim on macOS, so this
  correspondence is an explicit setup invariant rather than an inferred one.
- `pnpm setup:local --reset-profile` is the explicit fallback recovery path when
  the user cannot use ADR 0024's popup transfer. The installed native
  helper clears the selection under the same lock used by host startup and
  stops any live owner before reset returns, so that owner cannot retain the
  shared socket. Reset does not choose a replacement; after extension reload,
  the user must pair from the intended profile again.
- Placement protocol v6 and desktop-control protocol v7 require the selected
  profile handshake. Mixed installations Safe Abort instead of falling back to
  startup-order ownership.

## Consequences

Tab Out may remain loaded in additional regular Chrome profiles without making
the selected profile's shortcuts or Desktop Window Merge unavailable. Those
profiles do not gain access to the Hammerspoon controller or local placement
socket and do not sustain native-host reconnect attempts after they learn that
another profile is selected.

Fresh setup now includes one deliberate profile-selection click after loading
or reloading the extension. Selecting the wrong profile is recoverable but
never silently corrected, because automatic takeover would recreate the
authority race this decision removes. ADR 0024 supersedes this record only
where reset was the sole way to choose a different owner.

This supersedes ADR 0022 only where it required the Configured Profile to be the
sole Tab Out installation in one Chrome user-data directory. ADR 0022's exact
process authority, isolated-process exclusion, correlation, deadline,
revalidation, privacy, and Safe Abort rules remain in force.
