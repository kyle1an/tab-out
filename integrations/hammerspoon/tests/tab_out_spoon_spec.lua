local function assertEqual(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s (expected %s, got %s)", message, tostring(expected), tostring(actual)), 2)
  end
end

local function currentDirectory()
  local source = debug.getinfo(1, "S").source
  return source:sub(1, 1) == "@" and source:sub(2):match("^(.*)/[^/]+$") or "."
end

local fakeRuntimePath = currentDirectory() .. "/support/fake_hammerspoon.lua"
local fakeRuntimeChunk, loadError = loadfile(fakeRuntimePath)
assert(fakeRuntimeChunk, loadError)
local runShortcut = fakeRuntimeChunk().runShortcut

local filterResult = runShortcut("filter")
local newPageResult = runShortcut("newPage")
local noTargetFilterResult = runShortcut("filter", { targetHasChromeWindow = false })
local noTargetNewPageResult = runShortcut("newPage", { targetHasChromeWindow = false })
local allDisplaysEmptyFilterResult = runShortcut("filter", {
  otherHasChromeWindow = false,
  targetHasChromeWindow = false,
})
local allDisplaysEmptyNewPageResult = runShortcut("newPage", {
  otherHasChromeWindow = false,
  targetHasChromeWindow = false,
})
local singleDisplayEmptyFilterResult = runShortcut("filter", {
  otherHasChromeWindow = false,
  screenCount = 1,
  targetDisplayPosition = 1,
  targetHasChromeWindow = false,
})
local singleDisplayEmptyNewPageResult = runShortcut("newPage", {
  otherHasChromeWindow = false,
  screenCount = 1,
  targetDisplayPosition = 1,
  targetHasChromeWindow = false,
})
local stoppedChromeNewPageResult = runShortcut("newPage", {
  chromeIsRunning = false,
  otherHasChromeWindow = false,
  targetHasChromeWindow = false,
})
local unknownTargetFilterResult = runShortcut("filter", { cacheTargetProfile = false })
local unknownTargetNewPageResult = runShortcut("newPage", { cacheTargetProfile = false })
local ambiguousTargetFilterResult = runShortcut("filter", {
  ambiguousProfileWindowIdentity = true,
  cacheTargetProfile = false,
})
local otherProfileTargetFilterResult = runShortcut("filter", {
  targetProfileDirectory = "Profile 8",
})
local inactiveSpaceTargetFilterResult = runShortcut("filter", {
  targetHasChromeWindow = false,
  targetHasInactiveSpaceChromeWindow = true,
})
local threeDisplayFilterResult = runShortcut("filter", {
  screenCount = 3,
  targetDisplayPosition = 3,
  targetHasChromeWindow = false,
})
local unavailablePrivateFocusResult = runShortcut("filter", { privateFocusAvailable = false })
local unavailableNativeBridgeResult = runShortcut("filter", {
  nativeBridgeStarts = false,
  targetHasChromeWindow = false,
})
local unavailableScreenRecordingResult = runShortcut("filter", {
  screenRecordingAvailable = false,
  targetHasChromeWindow = false,
})
local failedCreatedWindowFocusResult = runShortcut("filter", {
  privateFocusSucceeds = false,
  targetHasChromeWindow = false,
})
local mismatchedFocusedControlFilterResult = runShortcut("filter", {
  focusedDestinationOwnerMismatch = true,
  targetHasChromeWindow = false,
})
local closeCreatedFilterResult = runShortcut("filter", {
  closeCreatedWindowAfterShortcut = true,
  sourceWindowOnRemote = true,
  targetHasChromeWindow = false,
})
local closeCreatedNewPageResult = runShortcut("newPage", {
  closeCreatedWindowAfterShortcut = "windowShortcut",
  sourceWindowOnRemote = true,
  targetHasChromeWindow = false,
})
local closeCreatedLastTabResult = runShortcut("filter", {
  closeCreatedWindowAfterShortcut = "tabShortcut",
  sourceWindowOnRemote = true,
  targetHasChromeWindow = false,
})
local closeCreatedMultiTabResult = runShortcut("filter", {
  closeCreatedWindowAfterShortcut = "tabShortcut",
  createdTabCount = 2,
  sourceWindowOnRemote = true,
  targetHasChromeWindow = false,
})
local closeAfterRecoveryInvalidationResult = runShortcut("filter", {
  closeCreatedWindowAfterShortcut = "windowShortcut",
  invalidateCloseRecoveryAfterFocus = true,
  sourceWindowOnRemote = true,
  targetHasChromeWindow = false,
})
local closeCreatedSameDisplayResult = runShortcut("filter", {
  cacheTargetProfile = false,
  closeCreatedWindowAfterShortcut = "windowShortcut",
  profileWindowInventoryUnavailable = true,
})
local closeCreatedSameDisplayUnhandledResult = runShortcut("filter", {
  closeCreatedWindowAfterShortcut = "unhandled",
  targetHasChromeWindow = false,
})
local closeCreatedWithoutDestroyEventResult = runShortcut("filter", {
  closeCreatedWindowAfterShortcut = "unhandled",
  suppressWindowDestroyedCallback = true,
  targetHasChromeWindow = false,
})
local fullscreenChromeReuseResult = runShortcut("filter", {
  targetSpaceType = "fullscreen",
})
local fullscreenFallbackCreationResult = runShortcut("newPage", {
  otherHasChromeWindow = false,
  targetHasChromeWindow = false,
  targetSpaceType = "fullscreen",
})

assertEqual(filterResult.openedFilter, true, "filter shortcut should open the focused-filter page")
assertEqual(filterResult.filterInputFocused, true, "filter shortcut should focus the in-page filter")
assertEqual(filterResult.extensionWindowFocusRequested, false, "filter shortcut should not activate Chrome from its extension page")
assertEqual(filterResult.targetFocused, true, "filter shortcut should focus the routed Chrome window")
assertEqual(filterResult.activationClickCount, 0, "filter shortcut should not use a visible activation click")
assertEqual(filterResult.privateFocusCount, 1, "filter shortcut should privately focus the exact Chrome window once")
assertEqual(filterResult.navigationObservedPrivateFocus, true, "filter shortcut should privately focus before scripting the target window")
assertEqual(filterResult.navigationUsesFrontWindow, true, "filter shortcut should script the privately selected front Chrome window")
assertEqual(filterResult.targetAppActive, true, "filter shortcut should make Chrome active through exact-window focus")
assertEqual(newPageResult.openedNewPage, true, "new-page shortcut should use Chrome's native new-tab action")
assertEqual(newPageResult.extensionWindowFocusRequested, false, "new-page shortcut should not activate Chrome from its extension page")
assertEqual(newPageResult.targetFocused, true, "new-page shortcut should focus the routed Chrome window")
assertEqual(newPageResult.activationClickCount, 0, "new-page shortcut should not use a visible activation click")
assertEqual(newPageResult.privateFocusCount, 1, "new-page shortcut should privately focus the exact Chrome window once")
assertEqual(newPageResult.navigationObservedPrivateFocus, true, "new-page shortcut should privately focus before scripting the target window")
assertEqual(newPageResult.navigationUsesFrontWindow, true, "new-page shortcut should script the privately selected front Chrome window")
assertEqual(newPageResult.otherChromeRaised, false, "new-page shortcut should not raise Chrome on another display")
assertEqual(filterResult.otherChromeRaised, false, "filter shortcut should not raise Chrome on another display")
assertEqual(filterResult.nativeBridgeInstalled, true, "installed bridge status should be independent of route use")
assertEqual(filterResult.nativeBridgeReady, false, "unused bridge should not claim a proven connection")
assertEqual(filterResult.transitionShieldCreatedCount, 0, "existing-window activation should not create a transition shield")
assertEqual(filterResult.orderedWindowsCallCount > 0, true, "existing-window activation should preserve front-to-back Chrome ordering")
assertEqual(filterResult.securePreferencesReadCount, 1, "filter routing and diagnostics should reuse one discovered extension ID")
assertEqual(noTargetFilterResult.createdWindow, true, "filter shortcut should create a window on an empty target display")
assertEqual(noTargetFilterResult.orderedWindowsCallCountBeforeCreation, 0, "Chrome-empty filter routing should skip global window ordering before creation")
assertEqual(noTargetFilterResult.securePreferencesReadCount, 1, "filter creation and diagnostics should reuse one discovered extension ID")
assertEqual(noTargetFilterResult.createdWindowInitiallyMinimized, false, "filter shortcut should create directly at target bounds without a deferred minimized placement")
assertEqual(noTargetFilterResult.createdWindowRevealedByPrivateFocus, false, "private focus should not need to unminimize the created filter window")
assertEqual(noTargetFilterResult.createdDestinationReadBeforePrivateFocus, false, "created filter window should be privately focused before waiting for its destination")
assertEqual(noTargetFilterResult.extensionWindowFocusRequested, false, "Native Placement Bridge should leave the created Chrome window inactive")
assertEqual(noTargetFilterResult.nativeBridgeRequest ~= nil, true, "filter shortcut should ask the native bridge to create an inactive window")
assertEqual(noTargetFilterResult.createdWindowSetFrameCount, 0, "filter shortcut should not move the window after Chrome shows it")
assertEqual(noTargetFilterResult.filterInputFocused, true, "filter shortcut should focus the created window's in-page filter")
assertEqual(noTargetFilterResult.destinationChildrenReadCount, 0, "filter creation should reuse the already-focused destination without scanning its accessibility tree")
assertEqual(noTargetFilterResult.destinationWindowElementReadCount, 1, "filter creation should reuse the destination control found by its readiness check")
assertEqual(noTargetFilterResult.targetFocused, true, "filter shortcut should focus the created target-display window")
assertEqual(noTargetFilterResult.otherChromeFocused, false, "filter shortcut should not focus Chrome on another display")
assertEqual(noTargetFilterResult.otherChromeReceivedFocus, false, "filter shortcut should avoid Chrome's remote launch handoff")
assertEqual(noTargetFilterResult.otherChromeRaised, false, "filter shortcut should not raise Chrome on another display")
assertEqual(noTargetFilterResult.activationClickCount, 0, "directly placed filter window should not receive a visible activation click")
assertEqual(noTargetFilterResult.privateFocusCount, 1, "directly placed filter window should receive one exact private focus call")
assertEqual(noTargetFilterResult.transitionShieldCreatedCount, 1, "filter creation should shield the target-display transition")
assertEqual(noTargetFilterResult.transitionShieldVisibleAtPrivateFocus, true, "filter transition shield should remain visible through private focus")
assertEqual(noTargetFilterResult.transitionShieldDeletedCount, 1, "filter transition shield should be removed after destination focus")
assertEqual(noTargetFilterResult.nativeBridgeRequest.targetBounds.left, 1440, "native bridge should receive the pointer display bounds")
assertEqual(noTargetFilterResult.nativeBridgeInstalled, true, "successful native placement should keep host installation visible")
assertEqual(noTargetFilterResult.nativeBridgeReady, true, "successful native placement should prove bridge connectivity")
assertEqual(noTargetNewPageResult.createdWindow, true, "new-page shortcut should create a window on an empty target display")
assertEqual(noTargetNewPageResult.orderedWindowsCallCountBeforeCreation, 0, "Chrome-empty new-page routing should skip global window ordering before creation")
assertEqual(noTargetNewPageResult.securePreferencesReadCount, 1, "new-page creation and diagnostics should reuse one discovered extension ID")
assertEqual(noTargetNewPageResult.createdWindowInitiallyMinimized, false, "new-page shortcut should create directly at target bounds without a deferred minimized placement")
assertEqual(noTargetNewPageResult.createdWindowRevealedByPrivateFocus, false, "private focus should not need to unminimize the created new-page window")
assertEqual(noTargetNewPageResult.createdDestinationReadBeforePrivateFocus, false, "created new-page window should be privately focused before waiting for its destination")
assertEqual(noTargetNewPageResult.extensionWindowFocusRequested, false, "Native Placement Bridge should leave the created Chrome window inactive")
assertEqual(noTargetNewPageResult.nativeBridgeRequest ~= nil, true, "new-page shortcut should ask the native bridge to create an inactive window")
assertEqual(noTargetNewPageResult.createdWindowSetFrameCount, 0, "new-page shortcut should not move the window after Chrome shows it")
assertEqual(noTargetNewPageResult.openedNewPage, true, "new-page shortcut should open the native Tab Out page")
assertEqual(noTargetNewPageResult.addressBarFocused, true, "new-page shortcut should focus the created window's address bar")
assertEqual(noTargetNewPageResult.destinationChildrenReadCount, 0, "new-page creation should reuse the already-focused destination without scanning its accessibility tree")
assertEqual(noTargetNewPageResult.destinationWindowElementReadCount, 1, "new-page creation should reuse the destination control found by its readiness check")
assertEqual(noTargetNewPageResult.targetFocused, true, "new-page shortcut should focus the created target-display window")
assertEqual(noTargetNewPageResult.otherChromeFocused, false, "new-page shortcut should not focus Chrome on another display")
assertEqual(noTargetNewPageResult.otherChromeReceivedFocus, false, "new-page shortcut should avoid Chrome's remote launch handoff")
assertEqual(noTargetNewPageResult.otherChromeRaised, false, "new-page shortcut should not raise Chrome on another display")
assertEqual(noTargetNewPageResult.privateFocusCount, 1, "directly placed new-page window should receive one exact private focus call")
assertEqual(noTargetNewPageResult.transitionShieldCreatedCount, 1, "new-page creation should shield the target-display transition")
assertEqual(noTargetNewPageResult.transitionShieldVisibleAtPrivateFocus, true, "new-page transition shield should remain visible through private focus")
assertEqual(noTargetNewPageResult.transitionShieldDeletedCount, 1, "new-page transition shield should be removed after destination focus")
assertEqual(allDisplaysEmptyFilterResult.createdWindow, true, "filter shortcut should create a window when both displays are Chrome-empty")
assertEqual(allDisplaysEmptyFilterResult.failureAlert, nil, "two Chrome-empty displays should not block the filter shortcut")
assertEqual(allDisplaysEmptyFilterResult.filterInputFocused, true, "all-empty filter creation should focus the in-page filter")
assertEqual(allDisplaysEmptyNewPageResult.createdWindow, true, "new-page shortcut should create a window when both displays are Chrome-empty")
assertEqual(allDisplaysEmptyNewPageResult.failureAlert, nil, "two Chrome-empty displays should not block the new-page shortcut")
assertEqual(allDisplaysEmptyNewPageResult.addressBarFocused, true, "all-empty new-page creation should focus the address bar")
assertEqual(singleDisplayEmptyFilterResult.createdWindow, true, "filter shortcut should create a window on one Chrome-empty display")
assertEqual(singleDisplayEmptyFilterResult.failureAlert, nil, "one Chrome-empty display should not block the filter shortcut")
assertEqual(singleDisplayEmptyFilterResult.nativeBridgeRequest.targetBounds.left, 0, "one display should be addressed by its bounds")
assertEqual(singleDisplayEmptyNewPageResult.createdWindow, true, "new-page shortcut should create a window on one Chrome-empty display")
assertEqual(singleDisplayEmptyNewPageResult.failureAlert, nil, "one Chrome-empty display should not block the new-page shortcut")
assertEqual(singleDisplayEmptyNewPageResult.nativeBridgeRequest.targetBounds.left, 0, "one display should use the same native bridge interface")
assertEqual(stoppedChromeNewPageResult.chromeLaunchCount, 1, "a stopped Chrome should launch once in the background")
assertEqual(stoppedChromeNewPageResult.chromeLaunchArguments ~= nil, true, "a stopped Chrome should use the background launcher")
assertEqual(stoppedChromeNewPageResult.createdWindow, true, "a stopped Chrome should continue into Native Placement Bridge creation")
assertEqual(stoppedChromeNewPageResult.nativeBridgeRequest ~= nil, true, "a cold launch should create through the Native Placement Bridge")
assertEqual(stoppedChromeNewPageResult.privateFocusCount, 1, "a cold launch should privately focus only the placed window")
assertEqual(stoppedChromeNewPageResult.failureAlert, nil, "a supported cold launch should not Safe Abort")
assertEqual(unknownTargetFilterResult.createdWindow, false, "filter routing should reuse a focus-independently identified target-profile window")
assertEqual(unknownTargetFilterResult.openedFilter, true, "the uncached target-window fallback should still open the filtered Tab Out page")
assertEqual(unknownTargetFilterResult.targetFocused, true, "focus-independent discovery should focus its existing destination")
assertEqual(unknownTargetFilterResult.nativeBridgeRequest, nil, "focus-independent discovery should avoid creating a duplicate window")
assertEqual(unknownTargetFilterResult.privateFocusCount, 1, "focus-independent discovery should privately focus the identified window once")
assertEqual(unknownTargetFilterResult.existingTargetFocusCount, 0, "profile discovery itself should not publicly focus the existing Chrome window")
assertEqual(unknownTargetFilterResult.profileWindowInventoryRequestCount, 1, "an uncached target should request one profile-window inventory")
assertEqual(unknownTargetFilterResult.otherChromeReceivedFocus, false, "the uncached target-window fallback should not focus remote Chrome")
assertEqual(unknownTargetFilterResult.otherChromeRaised, false, "the uncached target-window fallback should preserve remote Chrome order")
assertEqual(unknownTargetFilterResult.transitionShieldCreatedCount, 0, "existing-window discovery should not create a transition shield")
assertEqual(unknownTargetFilterResult.failureAlert, nil, "an uncached target Chrome profile should not block the filter shortcut")
assertEqual(unknownTargetNewPageResult.createdWindow, false, "new-page routing should reuse a focus-independently identified target-profile window")
assertEqual(unknownTargetNewPageResult.openedNewPage, true, "the uncached target-window fallback should still open the native new-tab page")
assertEqual(unknownTargetNewPageResult.targetFocused, true, "the uncached new-page fallback should focus its created destination")
assertEqual(unknownTargetNewPageResult.existingTargetFocusCount, 0, "new-page profile discovery should not publicly focus the existing Chrome window")
assertEqual(unknownTargetNewPageResult.otherChromeReceivedFocus, false, "the uncached new-page fallback should not focus remote Chrome")
assertEqual(unknownTargetNewPageResult.failureAlert, nil, "an uncached target Chrome profile should not block the new-page shortcut")
assertEqual(ambiguousTargetFilterResult.createdWindow, true, "ambiguous focus-independent identity should retain the safe create fallback")
assertEqual(ambiguousTargetFilterResult.existingTargetFocusCount, 0, "ambiguous identity should never focus the existing candidate")
assertEqual(otherProfileTargetFilterResult.createdWindow, true, "a target Space occupied only by another Chrome profile should receive a configured-profile window")
assertEqual(otherProfileTargetFilterResult.openedFilter, true, "another Chrome profile should not block the filter shortcut")
assertEqual(otherProfileTargetFilterResult.privateFocusCount, 1, "the other-profile fallback should privately focus only its created window")
assertEqual(otherProfileTargetFilterResult.existingTargetFocusCount, 0, "routing should not focus a known other-profile Chrome window")
assertEqual(otherProfileTargetFilterResult.otherChromeReceivedFocus, false, "the other-profile fallback should not focus remote Chrome")
assertEqual(otherProfileTargetFilterResult.failureAlert, nil, "another Chrome profile on the target Space should not cause a Safe Abort")
assertEqual(inactiveSpaceTargetFilterResult.createdWindow, true, "a Chrome window on an inactive target Space must not make the active target Space occupied")
assertEqual(inactiveSpaceTargetFilterResult.failureAlert, nil, "inactive-Space Chrome windows must not block the Native Placement Bridge")
assertEqual(threeDisplayFilterResult.createdWindow, true, "three displays should use the same native bridge without extra shortcuts")
assertEqual(threeDisplayFilterResult.nativeBridgeRequest.targetBounds.left, 2880, "the third display should be addressed by bounds")
assertEqual(threeDisplayFilterResult.failureAlert, nil, "three displays should not block native placement")
assertEqual(unavailablePrivateFocusResult.openedFilter, false, "an unavailable private helper should abort before navigation")
assertEqual(unavailablePrivateFocusResult.privateFocusCount, 0, "an unavailable private helper should not attempt exact focus")
assertEqual(unavailablePrivateFocusResult.failureAlert ~= nil, true, "an unavailable private helper should explain its safe abort")
assertEqual(unavailableNativeBridgeResult.createdWindow, false, "an unavailable native bridge should abort before creation")
assertEqual(unavailableNativeBridgeResult.privateFocusCount, 0, "an unavailable native bridge should not attempt exact focus")
assertEqual(unavailableNativeBridgeResult.failureAlert ~= nil, true, "an unavailable native bridge should explain its safe abort")
assertEqual(unavailableNativeBridgeResult.nativeBridgeInstalled, false, "missing bridge host should report not installed")
assertEqual(unavailableNativeBridgeResult.nativeBridgeReady, false, "missing bridge host should report not ready")
assertEqual(unavailableScreenRecordingResult.createdWindow, true, "missing Screen Recording permission should preserve window creation")
assertEqual(unavailableScreenRecordingResult.filterInputFocused, true, "missing Screen Recording permission should preserve destination focus")
assertEqual(unavailableScreenRecordingResult.transitionShieldCreatedCount, 0, "missing Screen Recording permission should skip the optional transition shield")
assertEqual(failedCreatedWindowFocusResult.failureAlert ~= nil, true, "failed private focus should surface a safe error")
assertEqual(failedCreatedWindowFocusResult.transitionShieldVisibleAtPrivateFocus, true, "failed private focus should remain covered during the attempt")
assertEqual(failedCreatedWindowFocusResult.transitionShieldDeletedCount, 1, "failed private focus should clean up the transition shield")
assertEqual(mismatchedFocusedControlFilterResult.remoteDestinationFocusCount, 0, "a focused control owned by another window must not be reused")
assertEqual(mismatchedFocusedControlFilterResult.destinationChildrenReadCount > 0, true, "a mismatched focused control should fall back to the target window accessibility tree")
assertEqual(mismatchedFocusedControlFilterResult.filterInputFocused, true, "a mismatched focused control should still focus the target window destination")
assertEqual(closeCreatedFilterResult.createdWindowClosed, true, "the filter window close gesture should still close the created window")
assertEqual(closeCreatedFilterResult.closeGestureConsumed, true, "the filter window close gesture should be handled before Chrome's remote fallback")
assertEqual(closeCreatedFilterResult.closeMouseUpConsumed, true, "the intercepted close button mouse-up should not land in the restored application")
assertEqual(closeCreatedFilterResult.otherChromeReceivedFocus, false, "closing the created filter window should never focus remote Chrome")
assertEqual(closeCreatedFilterResult.remoteTopFocused, true, "closing the created filter window should restore the prior remote window")
assertEqual(closeCreatedNewPageResult.createdWindowClosed, true, "the new-page window close gesture should still close the created window")
assertEqual(closeCreatedNewPageResult.closeGestureConsumed, true, "the new-page window close gesture should be handled before Chrome's remote fallback")
assertEqual(closeCreatedNewPageResult.otherChromeReceivedFocus, false, "closing the created new-page window should never focus remote Chrome")
assertEqual(closeCreatedNewPageResult.remoteTopFocused, true, "closing the created new-page window should restore the prior remote window")
assertEqual(closeCreatedLastTabResult.createdWindowClosed, true, "closing the created window's last tab should still close the window")
assertEqual(closeCreatedLastTabResult.closeGestureConsumed, true, "the last-tab close gesture should be handled before Chrome's remote fallback")
assertEqual(closeCreatedLastTabResult.otherChromeReceivedFocus, false, "closing the created window's last tab should never focus remote Chrome")
assertEqual(closeCreatedLastTabResult.remoteTopFocused, true, "closing the created window's last tab should restore the prior remote window")
assertEqual(closeCreatedMultiTabResult.closeGestureConsumed, false, "multi-tab Command-W should remain Chrome-owned")
assertEqual(closeCreatedMultiTabResult.createdWindowClosed, false, "multi-tab Command-W should not close the created window")
assertEqual(closeCreatedMultiTabResult.createdWindow, true, "multi-tab Command-W should leave the created window open")
assertEqual(closeCreatedMultiTabResult.createdWindowNativeTabCloseAllowed, true, "multi-tab Command-W should pass through to Chrome's tab close")
assertEqual(closeCreatedMultiTabResult.otherChromeReceivedFocus, false, "multi-tab Command-W should not involve remote Chrome")
assertEqual(closeAfterRecoveryInvalidationResult.closeGestureConsumed, true, "eligible close recovery should consume the whole-window shortcut")
assertEqual(closeAfterRecoveryInvalidationResult.createdWindowClosed, true, "a consumed close must still close the target if recovery later becomes unavailable")
assertEqual(closeCreatedSameDisplayResult.createdWindowClosed, true, "same-display recovery should still close the created window")
assertEqual(closeCreatedSameDisplayResult.closeGestureConsumed, true, "same-display recovery should intercept whole-window close before Chrome fallback")
assertEqual(closeCreatedSameDisplayResult.originalWindowFocused, true, "same-display recovery should restore the invocation-time non-Chrome window")
assertEqual(closeCreatedSameDisplayResult.otherChromeReceivedFocus, false, "same-display recovery should not fall through to another Chrome window")
assertEqual(closeCreatedSameDisplayUnhandledResult.closeGestureConsumed, false, "an unhandled close path should remain Chrome-owned")
assertEqual(closeCreatedSameDisplayUnhandledResult.otherChromeReceivedFocus, true, "an unhandled close may briefly trigger Chrome's remote fallback")
assertEqual(closeCreatedSameDisplayUnhandledResult.originalWindowFocused, true, "close recovery should restore the same-display source after remote Chrome fallback")
assertEqual(closeCreatedWithoutDestroyEventResult.otherChromeReceivedFocus, true, "a close without a destruction event may briefly trigger Chrome's remote fallback")
assertEqual(closeCreatedWithoutDestroyEventResult.originalWindowFocused, true, "close monitoring should restore the same-display source when Chrome omits its destruction event")
assertEqual(fullscreenChromeReuseResult.createdWindow, false, "a fullscreen target-profile Chrome window should be reused in place")
assertEqual(fullscreenChromeReuseResult.openedFilter, true, "fullscreen Chrome reuse should open the filtered destination")
assertEqual(fullscreenChromeReuseResult.spaceSwitchCount, 0, "fullscreen Chrome reuse should not leave the current fullscreen Space")
assertEqual(fullscreenChromeReuseResult.failureAlert, nil, "fullscreen Chrome reuse should not require remembered Desktop history")
assertEqual(fullscreenFallbackCreationResult.createdWindow, true, "a fullscreen Space without reusable Chrome should fall back to an existing regular Desktop")
assertEqual(fullscreenFallbackCreationResult.spaceSwitchCount, 1, "fullscreen fallback should switch to one regular Desktop")
assertEqual(fullscreenFallbackCreationResult.openedNewPage, true, "fullscreen fallback should still open the new-page destination")
assertEqual(fullscreenFallbackCreationResult.failureAlert, nil, "fullscreen fallback should not require remembered Desktop history")

return "cross-display focus regression: ok"
