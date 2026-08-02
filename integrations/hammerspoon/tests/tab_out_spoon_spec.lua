local function assertEqual(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s (expected %s, got %s)", message, tostring(expected), tostring(actual)), 2)
  end
end

local source = debug.getinfo(1, "S").source
local directory = source:sub(1, 1) == "@" and source:sub(2):match("^(.*)/[^/]+$") or "."
local fakeRuntimeChunk, loadError = loadfile(directory .. "/support/fake_hammerspoon.lua")
assert(fakeRuntimeChunk, loadError)
local runShortcut = fakeRuntimeChunk().runShortcut

local scenarios = {
  {
    "reuse target profile for filter", "filter", nil,
    { createdWindow = false, extensionFocusRequested = false, failed = false,
      filterInputFocused = true, navigationAfterPrivateFocus = true, openedFilter = true,
      otherChromeRaised = false, privateFocusUsed = true, targetAppActive = true, targetFocused = true },
  },
  {
    "reuse target profile for new page", "newPage", nil,
    { addressBarFocused = true, createdWindow = false, extensionFocusRequested = false,
      failed = false, navigationAfterPrivateFocus = true, openedNewPage = true,
      otherChromeRaised = false, privateFocusUsed = true, targetFocused = true },
  },
  {
    "create filter window on empty target", "filter", { targetHasChromeWindow = false },
    { bridgeUsed = true, createdWindow = true, createdWindowMoved = false,
      extensionFocusRequested = false, failed = false, filterInputFocused = true,
      nativeBridgeReady = true, openedFilter = true, otherChromeReceivedFocus = false,
      otherChromeRaised = false, privateFocusUsed = true, shieldUsed = true,
      shieldVisibleAtPrivateFocus = true, targetBoundsLeft = 1440, targetFocused = true },
  },
  {
    "create new-page window on empty target", "newPage", { targetHasChromeWindow = false },
    { addressBarFocused = true, bridgeUsed = true, createdWindow = true,
      createdWindowMoved = false, extensionFocusRequested = false, failed = false,
      openedNewPage = true, otherChromeReceivedFocus = false, otherChromeRaised = false,
      privateFocusUsed = true, shieldUsed = true, shieldVisibleAtPrivateFocus = true,
      targetBoundsLeft = 1440, targetFocused = true },
  },
  {
    "create filter window when every display is Chrome-empty", "filter",
    { otherHasChromeWindow = false, targetHasChromeWindow = false },
    { createdWindow = true, failed = false, filterInputFocused = true, openedFilter = true },
  },
  {
    "create new-page window when every display is Chrome-empty", "newPage",
    { otherHasChromeWindow = false, targetHasChromeWindow = false },
    { addressBarFocused = true, createdWindow = true, failed = false, openedNewPage = true },
  },
  {
    "create filter window on one display", "filter",
    { otherHasChromeWindow = false, screenCount = 1, targetDisplayPosition = 1, targetHasChromeWindow = false },
    { createdWindow = true, failed = false, targetBoundsLeft = 0 },
  },
  {
    "create new-page window on one display", "newPage",
    { otherHasChromeWindow = false, screenCount = 1, targetDisplayPosition = 1, targetHasChromeWindow = false },
    { createdWindow = true, failed = false, targetBoundsLeft = 0 },
  },
  {
    "cold-launch Chrome", "newPage",
    { chromeIsRunning = false, otherHasChromeWindow = false, targetHasChromeWindow = false },
    { bridgeUsed = true, chromeLaunched = true, createdWindow = true, failed = false,
      openedNewPage = true, targetFocused = true },
  },
  {
    "discover uncached target profile for filter", "filter", { cacheTargetProfile = false },
    { bridgeUsed = false, createdWindow = false, failed = false, filterInputFocused = true,
      openedFilter = true, otherChromeReceivedFocus = false, otherChromeRaised = false, targetFocused = true },
  },
  {
    "discover uncached target profile for new page", "newPage", { cacheTargetProfile = false },
    { bridgeUsed = false, createdWindow = false, failed = false, openedNewPage = true,
      otherChromeReceivedFocus = false, targetFocused = true },
  },
  {
    "create when profile identity is ambiguous", "filter",
    { ambiguousProfileWindowIdentity = true, cacheTargetProfile = false },
    { bridgeUsed = true, createdWindow = true, failed = false, openedFilter = true, targetFocused = true },
  },
  {
    "create beside another profile", "filter", { targetProfileDirectory = "Profile 8" },
    { createdWindow = true, failed = false, openedFilter = true,
      otherChromeReceivedFocus = false, targetFocused = true },
  },
  {
    "ignore Chrome on an inactive target Space", "filter",
    { targetHasChromeWindow = false, targetHasInactiveSpaceChromeWindow = true },
    { createdWindow = true, failed = false, openedFilter = true },
  },
  {
    "route to a third display", "filter",
    { screenCount = 3, targetDisplayPosition = 3, targetHasChromeWindow = false },
    { createdWindow = true, failed = false, targetBoundsLeft = 2880 },
  },
  {
    "safe-abort without private focus", "filter", { privateFocusAvailable = false },
    { createdWindow = false, failed = true, openedFilter = false, privateFocusUsed = false },
  },
  {
    "safe-abort without native bridge", "filter",
    { nativeBridgeStarts = false, targetHasChromeWindow = false },
    { bridgeUsed = false, createdWindow = false, failed = true,
      nativeBridgeInstalled = false, nativeBridgeReady = false },
  },
  {
    "continue without transition shield", "filter",
    { screenRecordingAvailable = false, targetHasChromeWindow = false },
    { createdWindow = true, failed = false, filterInputFocused = true, shieldUsed = false },
  },
  {
    "report failed exact focus", "filter",
    { privateFocusSucceeds = false, targetHasChromeWindow = false },
    { failed = true, targetFocused = false },
  },
  {
    "reject a destination owned by another window", "filter",
    { focusedDestinationOwnerMismatch = true, targetHasChromeWindow = false },
    { failed = false, filterInputFocused = true, remoteDestinationFocusCount = 0, targetFocused = true },
  },
  {
    "close created filter window by mouse", "filter",
    { closeCreatedWindowAfterShortcut = true, sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = true, closeMouseUpConsumed = true, createdWindowClosed = true,
      otherChromeReceivedFocus = false, remoteTopFocused = true },
  },
  {
    "close created new-page window", "newPage",
    { closeCreatedWindowAfterShortcut = "windowShortcut", sourceWindowOnRemote = true,
      targetHasChromeWindow = false },
    { closeGestureConsumed = true, createdWindowClosed = true,
      otherChromeReceivedFocus = false, remoteTopFocused = true },
  },
  {
    "close created window's last tab", "filter",
    { closeCreatedWindowAfterShortcut = "tabShortcut", sourceWindowOnRemote = true,
      targetHasChromeWindow = false },
    { closeGestureConsumed = true, createdWindowClosed = true,
      otherChromeReceivedFocus = false, remoteTopFocused = true },
  },
  {
    "leave multi-tab close to Chrome", "filter",
    { closeCreatedWindowAfterShortcut = "tabShortcut", createdTabCount = 2,
      sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = false, createdWindow = true, createdWindowClosed = false,
      createdWindowNativeTabCloseAllowed = true, otherChromeReceivedFocus = false },
  },
  {
    "finish an intercepted close after recovery invalidates", "filter",
    { closeCreatedWindowAfterShortcut = "windowShortcut", invalidateCloseRecoveryAfterFocus = true,
      sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = true, createdWindowClosed = true },
  },
  {
    "restore same-display source after close", "filter",
    { cacheTargetProfile = false, closeCreatedWindowAfterShortcut = "windowShortcut",
      profileWindowInventoryUnavailable = true },
    { closeGestureConsumed = true, createdWindowClosed = true,
      originalWindowFocused = true, otherChromeReceivedFocus = false },
  },
  {
    "repair an unhandled close", "filter",
    { closeCreatedWindowAfterShortcut = "unhandled", targetHasChromeWindow = false },
    { closeGestureConsumed = false, originalWindowFocused = true, otherChromeReceivedFocus = true },
  },
  {
    "repair close without destruction event", "filter",
    { closeCreatedWindowAfterShortcut = "unhandled", suppressWindowDestroyedCallback = true,
      targetHasChromeWindow = false },
    { originalWindowFocused = true, otherChromeReceivedFocus = true },
  },
  {
    "reuse Chrome in fullscreen", "filter", { targetSpaceType = "fullscreen" },
    { createdWindow = false, failed = false, openedFilter = true, spaceSwitchCount = 0 },
  },
  {
    "fall back from fullscreen for creation", "newPage",
    { otherHasChromeWindow = false, targetHasChromeWindow = false, targetSpaceType = "fullscreen" },
    { createdWindow = true, failed = false, openedNewPage = true, spaceSwitchCount = 1 },
  },
}

for _, scenario in ipairs(scenarios) do
  local name, kind, options, expected = table.unpack(scenario)
  local result = runShortcut(kind, options)
  for field, value in pairs(expected) do
    assertEqual(result[field], value, name .. ": " .. field)
  end
end

return "cross-display focus regression: ok"
