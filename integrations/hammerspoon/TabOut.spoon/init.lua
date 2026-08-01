local M = {}

M.name = "Tab Out"
M.version = "1.0.0"
M.author = "Tab Out contributors"
M.license = "MIT"

local moduleSource = debug.getinfo(1, "S").source
local modulePath = moduleSource:sub(1, 1) == "@" and moduleSource:sub(2) or moduleSource
local moduleDirectory = modulePath:match("^(.*)/[^/]+$") or "."

local function loadSiblingModule(fileName)
  local chunk, loadError = loadfile(moduleDirectory .. "/" .. fileName, "t", _ENV)
  if not chunk then
    error(loadError)
  end
  return chunk()
end

local log = hs.logger.new("tab-out", "info")
local LAST_USER_SPACES_KEY = "tabOut.lastUserSpaces.v1"
local NEW_WINDOW_TIMEOUT_SECONDS = 12
local NEW_TAB_URL = "chrome://newtab/"
local PROFILE_PROBE_TIMEOUT_SECONDS = 6
local DESTINATION_CONTROL_TIMEOUT_SECONDS = 6
local TARGET_FOCUS_TIMEOUT_SECONDS = 2
local WINDOW_FOCUS_DELAY_SECONDS = 0.15
local WINDOW_FOCUS_RETRY_INTERVAL_SECONDS = 0.05

local state = {
  busy = false,
  chromeWindowFilter = nil,
  config = nil,
  currentRequest = nil,
  extensionId = nil,
  hotkeys = {},
  lastUserSpaceByScreen = {},
  nativeBridge = nil,
  nativeBridgeError = nil,
  pendingNativePlacement = nil,
  privateFocus = nil,
  privateFocusError = nil,
  profileByWindow = {},
  profileProbes = {},
  queue = {},
  screenWatcher = nil,
  spaceWatcher = nil,
  started = false,
  timers = {},
}

local drainQueue
local failCurrent
local finishCurrent

local function later(delay, callback, fatal)
  local timer
  timer = hs.timer.doAfter(delay, function()
    state.timers[timer] = nil
    local ok, err = xpcall(callback, debug.traceback)

    if not ok then
      log.ef("Asynchronous callback failed: %s", err)
      if fatal and state.busy and failCurrent then
        failCurrent("Automation failed", err)
      end
    end
  end)
  state.timers[timer] = true
  return timer
end

local function stopTimer(timer)
  if not timer then
    return
  end

  timer:stop()
  state.timers[timer] = nil
end

local function screenUuid(screen)
  return screen and screen:getUUID() or nil
end

local function screenForUuid(uuid)
  if not uuid then
    return nil
  end

  for _, screen in ipairs(hs.screen.allScreens()) do
    if screen:getUUID() == uuid then
      return screen
    end
  end

  return nil
end

local function currentRequestScreen()
  local request = state.currentRequest
  local screen = request and screenForUuid(request.screenUuid) or nil
  return screen or hs.screen.mainScreen()
end

local function showFailure(message, detail, screen)
  if detail and detail ~= "" then
    log.ef("%s: %s", message, detail)
  else
    log.e(message)
  end

  hs.alert.show("Tab Out: " .. message, nil, screen or hs.screen.mainScreen(), 2.5)
end

finishCurrent = function()
  local pendingNativePlacement = state.pendingNativePlacement
  if pendingNativePlacement then
    stopTimer(pendingNativePlacement.timeout)
  end
  state.pendingNativePlacement = nil
  state.busy = false
  state.currentRequest = nil
  later(0.08, function()
    drainQueue()
  end, false)
end

failCurrent = function(message, detail)
  if not state.busy then
    return
  end

  showFailure(message, detail, currentRequestScreen())
  finishCurrent()
end

local function containsValue(values, expected)
  for _, value in ipairs(values or {}) do
    if value == expected then
      return true
    end
  end

  return false
end

local function captureTargetContext()
  local screen = hs.mouse.getCurrentScreen()
  local focusedWindow = hs.window.focusedWindow()
  screen = screen or (focusedWindow and focusedWindow:screen()) or hs.screen.mainScreen()

  if not screen then
    return nil, "No target display is available"
  end

  local spaceId, spaceError = hs.spaces.activeSpaceOnScreen(screen)
  if not spaceId then
    return nil, spaceError or "The active Space could not be determined"
  end

  local spaceType, typeError = hs.spaces.spaceType(spaceId)
  if not spaceType then
    return nil, typeError or "The active Space type could not be determined"
  end

  local uuid = screenUuid(screen)
  if not uuid then
    return nil, "The target display has no stable identifier"
  end

  if spaceType == "user" then
    state.lastUserSpaceByScreen[uuid] = spaceId
    hs.settings.set(LAST_USER_SPACES_KEY, state.lastUserSpaceByScreen)
  end

  return {
    capturedSpaceId = spaceId,
    capturedSpaceType = spaceType,
    fallbackUserSpaceId = spaceType == "fullscreen" and state.lastUserSpaceByScreen[uuid] or nil,
    screenUuid = uuid,
  }
end

local function refreshLastUserSpaces()
  local changed = false

  for _, screen in ipairs(hs.screen.allScreens()) do
    local activeSpace = hs.spaces.activeSpaceOnScreen(screen)
    if activeSpace and hs.spaces.spaceType(activeSpace) == "user" then
      local uuid = screenUuid(screen)
      if uuid and state.lastUserSpaceByScreen[uuid] ~= activeSpace then
        state.lastUserSpaceByScreen[uuid] = activeSpace
        changed = true
      end
    end
  end

  if changed then
    hs.settings.set(LAST_USER_SPACES_KEY, state.lastUserSpaceByScreen)
  end
end

local function spaceBelongsToScreen(spaceId, screen)
  local spaces = hs.spaces.spacesForScreen(screen)
  return spaces and containsValue(spaces, spaceId) or false
end

local function waitForSpace(request, screen, targetSpace, attempt)
  local activeSpace = hs.spaces.activeSpaceOnScreen(screen)
  if activeSpace == targetSpace then
    request.targetSpaceId = targetSpace
    refreshLastUserSpaces()
    request.continueOnTargetSpace(screen)
    return
  end

  if attempt >= 50 then
    failCurrent("Could not switch to the target Desktop", "Timed out waiting for the Space change")
    return
  end

  later(0.1, function()
    waitForSpace(request, screen, targetSpace, attempt + 1)
  end, true)
end

local function ensureTargetUserSpace(request, callback)
  local screen = screenForUuid(request.screenUuid)
  if not screen then
    failCurrent("The target display is no longer connected")
    return
  end

  local targetSpace
  if request.capturedSpaceType == "user" then
    targetSpace = request.capturedSpaceId
  elseif request.capturedSpaceType == "fullscreen" then
    targetSpace = request.fallbackUserSpaceId
  end

  if not targetSpace then
    failCurrent("No previously used regular Desktop is known for this display")
    return
  end

  if not spaceBelongsToScreen(targetSpace, screen) or hs.spaces.spaceType(targetSpace) ~= "user" then
    failCurrent("The target regular Desktop is no longer available")
    return
  end

  request.continueOnTargetSpace = callback
  local activeSpace = hs.spaces.activeSpaceOnScreen(screen)
  if activeSpace == targetSpace then
    request.targetSpaceId = targetSpace
    callback(screen)
    return
  end

  local switched, switchError = hs.spaces.gotoSpace(targetSpace)
  if not switched then
    failCurrent("Could not switch from the full-screen Space", switchError)
    return
  end

  waitForSpace(request, screen, targetSpace, 0)
end

local function chromeApplication()
  return hs.application.get(state.config.chromeBundleId)
end

local function isChromeWindow(window)
  if not window or not window:id() or not window:isStandard() or window:isMinimized() then
    return false
  end

  local application = window:application()
  return application and application:bundleID() == state.config.chromeBundleId and not application:isHidden()
end

local function chromeAddressBar(window)
  local root = window and hs.axuielement.windowElement(window) or nil
  local visited = {}

  local function findAddressBar(element, depth)
    if type(element) ~= "userdata" or visited[element] or depth > 20 then
      return nil
    end

    visited[element] = true
    local role = element:attributeValue("AXRole")
    if role == "AXWebArea" then
      return nil
    end

    if role == "AXTextField"
      and element:attributeValue("AXDescription") == "Address and search bar"
    then
      return element
    end

    for _, child in ipairs(element:attributeValue("AXChildren") or {}) do
      local found = findAddressBar(child, depth + 1)
      if found then
        return found
      end
    end

    return nil
  end

  return root and findAddressBar(root, 0) or nil
end

local function chromeFilterInput(window)
  local root = window and hs.axuielement.windowElement(window) or nil
  local visited = {}

  local function findFilterInput(element, depth)
    if type(element) ~= "userdata" or visited[element] or depth > 30 then
      return nil
    end

    visited[element] = true
    local description = element:attributeValue("AXDescription")
    if element:attributeValue("AXRole") == "AXTextField"
      and type(description) == "string"
      and description:match("^Filter ")
    then
      return element
    end

    for _, child in ipairs(element:attributeValue("AXChildren") or {}) do
      local found = findFilterInput(child, depth + 1)
      if found then
        return found
      end
    end

    return nil
  end

  return root and findFilterInput(root, 0) or nil
end

local function destinationControl(kind, window)
  if kind == "filter" then
    return chromeFilterInput(window)
  end
  return chromeAddressBar(window)
end

local function eligibleChromeWindows(screen, spaceId)
  local candidates = {}
  local targetScreenUuid = screenUuid(screen)

  for _, window in ipairs(hs.window.orderedWindows()) do
    if isChromeWindow(window) and screenUuid(window:screen()) == targetScreenUuid then
      local spaces = hs.spaces.windowSpaces(window)
      if spaces and containsValue(spaces, spaceId) then
        table.insert(candidates, window)
      end
    end
  end

  return candidates
end

local function chromeLocalState()
  return hs.json.read(state.config.chromeUserDataDirectory .. "/Local State")
end

local function profileTokens(profile)
  local tokens = {}
  local seen = {}

  for _, field in ipairs({ "user_name", "gaia_name", "shortcut_name", "name" }) do
    local value = profile and profile[field] or nil
    if type(value) == "string" then
      value = value:lower():match("^%s*(.-)%s*$")
      if #value >= 3 and not seen[value] then
        seen[value] = true
        table.insert(tokens, value)
      end
    end
  end

  table.sort(tokens, function(left, right)
    return #left > #right
  end)
  return tokens
end

local function markedMenuTitles(value, results, seen)
  if type(value) ~= "table" or seen[value] then
    return
  end

  seen[value] = true
  local mark = value.AXMenuItemMarkChar
  local title = value.AXTitle
  if type(mark) == "string" and mark ~= "" and type(title) == "string" and title ~= "" then
    table.insert(results, title:lower())
  end

  for _, child in pairs(value) do
    if type(child) == "table" then
      markedMenuTitles(child, results, seen)
    end
  end
end

local function profileDirectoryFromMenu(menuItems)
  local localState = chromeLocalState()
  local profiles = localState and localState.profile and localState.profile.info_cache or nil
  if type(profiles) ~= "table" then
    return nil, "Chrome profile metadata is unavailable"
  end

  local titles = {}
  markedMenuTitles(menuItems, titles, {})

  local bestDirectory
  local bestLength = 0
  local ambiguous = false

  for directory, profile in pairs(profiles) do
    for _, token in ipairs(profileTokens(profile)) do
      for _, title in ipairs(titles) do
        if title:find(token, 1, true) then
          if #token > bestLength then
            bestDirectory = directory
            bestLength = #token
            ambiguous = false
          elseif #token == bestLength and bestDirectory ~= directory then
            ambiguous = true
          end
        end
      end
    end
  end

  if bestDirectory and not ambiguous then
    return bestDirectory
  end

  return nil, ambiguous and "Chrome profile identity is ambiguous" or "Chrome's active profile could not be identified"
end

local function completeProfileProbe(probe, profileDirectory, probeError)
  if state.profileProbes[probe.windowId] ~= probe then
    return
  end

  state.profileProbes[probe.windowId] = nil
  stopTimer(probe.timeout)

  if profileDirectory then
    state.profileByWindow[probe.windowId] = profileDirectory
  end

  for _, callback in ipairs(probe.callbacks) do
    local ok, err = xpcall(function()
      callback(profileDirectory, probeError)
    end, debug.traceback)

    if not ok then
      log.ef("Profile probe callback failed: %s", err)
      if state.busy then
        failCurrent("Automation failed", err)
      end
    end
  end
end

local function probeWindowProfile(window, callback)
  local windowId = window and window:id() or nil
  if not windowId then
    callback(nil, "The Chrome window is no longer available")
    return
  end

  local existingProbe = state.profileProbes[windowId]
  if existingProbe then
    table.insert(existingProbe.callbacks, callback)
    return
  end

  local probe = {
    callbacks = { callback },
    timeout = nil,
    windowId = windowId,
  }
  state.profileProbes[windowId] = probe

  probe.timeout = later(PROFILE_PROBE_TIMEOUT_SECONDS, function()
    completeProfileProbe(probe, nil, "Timed out reading Chrome's Profiles menu")
  end, false)

  local focusedWindow = hs.window.focusedWindow()
  if not focusedWindow or focusedWindow:id() ~= windowId then
    completeProfileProbe(probe, nil, "Chrome profile checks require an already-focused window")
    return
  end

  later(WINDOW_FOCUS_DELAY_SECONDS, function()
    if state.profileProbes[windowId] ~= probe then
      return
    end

    local focusedWindow = hs.window.focusedWindow()
    if not focusedWindow or focusedWindow:id() ~= windowId then
      completeProfileProbe(probe, nil, "The candidate window did not retain focus")
      return
    end

    local application = chromeApplication()
    if not application then
      completeProfileProbe(probe, nil, "Google Chrome is no longer running")
      return
    end

    application:getMenuItems(function(menuItems)
      local ok, err = xpcall(function()
        if state.profileProbes[windowId] ~= probe then
          return
        end

        local currentWindow = hs.window.focusedWindow()
        if not currentWindow or currentWindow:id() ~= windowId then
          completeProfileProbe(probe, nil, "Chrome focus changed while reading its profile")
          return
        end

        if not menuItems then
          completeProfileProbe(probe, nil, "Chrome's menu structure is unavailable")
          return
        end

        local profileDirectory, profileError = profileDirectoryFromMenu(menuItems)
        completeProfileProbe(probe, profileDirectory, profileError)
      end, debug.traceback)

      if not ok then
        log.ef("Profile menu processing failed: %s", err)
        completeProfileProbe(probe, nil, err)
      end
    end)
  end, false)
end

local function secureProfilePreferences()
  local profilePath = state.config.chromeUserDataDirectory .. "/" .. state.config.chromeProfileDirectory
  return hs.json.read(profilePath .. "/Secure Preferences")
end

local function tabOutExtensionId()
  local preferences = secureProfilePreferences()
  local settings = preferences and preferences.extensions and preferences.extensions.settings or nil

  if type(settings) ~= "table" then
    return state.extensionId, state.extensionId and nil or "Chrome's extension settings could not be read"
  end

  for extensionId, extension in pairs(settings) do
    local commands = type(extension) == "table" and extension.commands or nil
    if type(commands) == "table"
      and type(commands["open-filter-tab"]) == "table"
      and type(commands["open-new-tab"]) == "table"
      and type(extensionId) == "string"
      and #extensionId == 32
      and extensionId:match("^[a-p]+$")
    then
      state.extensionId = extensionId
      return extensionId
    end
  end

  return state.extensionId, state.extensionId and nil or "The Tab Out extension could not be identified"
end

local function filterFocusUrl()
  local extensionId, extensionError = tabOutExtensionId()
  if not extensionId then
    return nil, extensionError
  end

  return "chrome-extension://" .. extensionId .. "/index.html?focusFilter=1"
end

local function roundedCoordinate(value)
  return math.floor(value + 0.5)
end

local function openTabOutTabInFrontWindow(kind, window)
  local url = NEW_TAB_URL
  local urlError
  if kind == "filter" then
    url, urlError = filterFocusUrl()
  end
  if not url then
    return false, urlError
  end

  local frame = window and window:frame() or nil
  if not frame then
    return false, "The Chrome window frame is unavailable"
  end

  local left = roundedCoordinate(frame.x)
  local top = roundedCoordinate(frame.y)
  local right = roundedCoordinate(frame.x + frame.w)
  local bottom = roundedCoordinate(frame.y + frame.h)
  local tabAction = string.format([[
    make new tab at end of tabs with properties {URL:"%s"}
    set active tab index to count of tabs
]], url)

  local windowSelection = [[
  set candidateWindow to front window
  if (bounds of candidateWindow) is not targetBounds then error "The privately focused Chrome window changed before navigation"
]]

  local script = string.format([[
tell application "Google Chrome"
  set targetBounds to {%d, %d, %d, %d}
%s  tell candidateWindow
%s  end tell
end tell
]], left, top, right, bottom, windowSelection, tabAction)

  local succeeded, _, descriptor = hs.osascript.applescript(script)
  if succeeded then
    return true
  end

  local errorNumber = type(descriptor) == "table" and descriptor.NSAppleScriptErrorNumber or nil
  if errorNumber then
    return false, "Chrome AppleScript error " .. tostring(errorNumber)
  end

  return false, "Chrome did not accept the target-window request"
end

local function waitForDestinationControl(kind, window, onReady, onFailure, attempt, expectedWindowId)
  attempt = attempt or 0
  expectedWindowId = expectedWindowId or (window and window:id() or nil)

  local windowId = window and window:id() or nil
  local application = window and window:application() or nil
  if not windowId
    or windowId ~= expectedWindowId
    or not application
    or application:bundleID() ~= state.config.chromeBundleId
  then
    onFailure("The Chrome window is no longer available")
    return
  end

  if destinationControl(kind, window) then
    onReady()
    return
  end

  if attempt * WINDOW_FOCUS_RETRY_INTERVAL_SECONDS >= DESTINATION_CONTROL_TIMEOUT_SECONDS then
    onFailure("Timed out waiting for the Tab Out destination control")
    return
  end

  later(WINDOW_FOCUS_RETRY_INTERVAL_SECONDS, function()
    waitForDestinationControl(kind, window, onReady, onFailure, attempt + 1, expectedWindowId)
  end, true)
end

local function waitForTargetWindowFocus(window, onFocused, onFailure, attempt, expectedWindowId)
  attempt = attempt or 0
  expectedWindowId = expectedWindowId or (window and window:id() or nil)

  local frontmostApplication = hs.application.frontmostApplication()
  local focusedWindow = hs.window.focusedWindow()
  if frontmostApplication
    and frontmostApplication:bundleID() == state.config.chromeBundleId
    and focusedWindow
    and focusedWindow:id() == expectedWindowId
  then
    onFocused()
    return
  end

  if attempt * WINDOW_FOCUS_RETRY_INTERVAL_SECONDS >= TARGET_FOCUS_TIMEOUT_SECONDS then
    onFailure("Timed out waiting for Chrome to activate the requested window")
    return
  end

  later(WINDOW_FOCUS_RETRY_INTERVAL_SECONDS, function()
    waitForTargetWindowFocus(window, onFocused, onFailure, attempt + 1, expectedWindowId)
  end, true)
end

local function focusDestinationControl(kind, window)
  local control = destinationControl(kind, window)
  if not control then
    return false, "Chrome's destination control is unavailable"
  end

  local focused = control:setAttributeValue("AXFocused", true)
  if not focused or control:attributeValue("AXFocused") ~= true then
    return false, "Chrome's destination control could not be focused"
  end

  return true
end

local function focusWindowPrivately(window)
  local windowId = window and window:id() or nil
  local application = window and window:application() or nil
  local processId = application and application:pid() or nil
  local request = state.currentRequest
  if not windowId
    or not application
    or application:bundleID() ~= state.config.chromeBundleId
    or type(processId) ~= "number"
  then
    return false, "The exact Chrome window identity is unavailable"
  end

  local windowSpaces = hs.spaces.windowSpaces(window)
  if not request
    or screenUuid(window:screen()) ~= request.screenUuid
    or not windowSpaces
    or not containsValue(windowSpaces, request.targetSpaceId)
    or state.profileByWindow[windowId] ~= state.config.chromeProfileDirectory
  then
    return false, "The Chrome window no longer matches the target display, Desktop, and profile"
  end

  if not state.privateFocus then
    return false, state.privateFocusError or "The private focus helper is unavailable"
  end

  local called, focused, focusError = pcall(state.privateFocus.focus, processId, windowId)
  if not called then
    return false, focused
  end
  if not focused then
    return false, focusError or "The private focus helper rejected the target window"
  end

  return true
end

local function finishDestinationControlFocus(kind, window)
  local controlFocused, controlError = focusDestinationControl(kind, window)
  if not controlFocused then
    failCurrent("The Tab Out destination could not receive keyboard focus", controlError)
    return
  end

  log.df("Privately focused exact Chrome window %d", window:id())
  finishCurrent()
end

local function privatelyActivateWindow(window, onActivated)
  local focused, focusError = focusWindowPrivately(window)
  if not focused then
    failCurrent("The Tab Out window could not be focused privately", focusError)
    return
  end

  waitForTargetWindowFocus(window, onActivated, function(activationError)
    failCurrent("The Tab Out window did not become keyboard-active", activationError)
  end)
end

-- Native Placement Bridge windows already contain their destination before Chrome is
-- made active. Existing windows invert that order: exact private focus first,
-- then script Chrome's now-unambiguous front window.
local function finishExtensionWindowActivation(kind, window)
  waitForDestinationControl(kind, window, function()
    privatelyActivateWindow(window, function()
      finishDestinationControlFocus(kind, window)
    end)
  end, function(controlError)
    failCurrent("The Tab Out destination did not become ready", controlError)
  end)
end

local function activateExistingWindow(kind, window)
  privatelyActivateWindow(window, function()
    local opened, openError = openTabOutTabInFrontWindow(kind, window)
    if not opened then
      failCurrent("Chrome could not open the Tab Out page", openError)
      return
    end

    log.df("Opened the %s destination in the privately selected Chrome window", kind)
    waitForDestinationControl(kind, window, function()
      finishDestinationControlFocus(kind, window)
    end, function(controlError)
      failCurrent("The Tab Out destination did not become ready", controlError)
    end)
  end)
end

local function trackedChromeWindows()
  if state.chromeWindowFilter then
    return state.chromeWindowFilter:getWindows()
  end

  local application = chromeApplication()
  return application and application:allWindows() or {}
end

local function acceptNativePlacementWindow(pending, window)
  if pending.windowFound then
    return
  end

  pending.windowFound = true
  stopTimer(pending.timeout)
  if state.pendingNativePlacement == pending then
    state.pendingNativePlacement = nil
  end

  local request = pending.request
  local windowScreen = window:screen()
  local spaces = hs.spaces.windowSpaces(window)
  if screenUuid(windowScreen) ~= request.screenUuid
    or not spaces
    or not containsValue(spaces, request.targetSpaceId)
  then
    failCurrent(
      "Tab Out did not create its window on the target Desktop",
      "The Native Placement Bridge returned a window on a different display or Space"
    )
    return
  end

  state.profileByWindow[window:id()] = state.config.chromeProfileDirectory
  log.df("Tab Out created the %s window directly on the target Desktop", request.kind)
  finishExtensionWindowActivation(request.kind, window)
end

local function windowOccupiesActiveSpace(window)
  local screen = window and window:screen() or nil
  local activeSpace = screen and hs.spaces.activeSpaceOnScreen(screen) or nil
  local windowSpaces = window and hs.spaces.windowSpaces(window) or nil
  return activeSpace and windowSpaces and containsValue(windowSpaces, activeSpace) or false
end

local function screenHasChromeWindowOnActiveSpace(targetScreen)
  local targetUuid = screenUuid(targetScreen)
  for _, window in ipairs(trackedChromeWindows()) do
    if isChromeWindow(window)
      and windowOccupiesActiveSpace(window)
      and screenUuid(window:screen()) == targetUuid
    then
      return true
    end
  end
  return false
end

local function screenBoundsForBridge(targetScreen)
  local frame = targetScreen and targetScreen:fullFrame() or nil
  if not frame
    or type(frame.x) ~= "number"
    or type(frame.y) ~= "number"
    or type(frame.w) ~= "number"
    or type(frame.h) ~= "number"
    or frame.w <= 0
    or frame.h <= 0
  then
    return nil, "The pointer display bounds are unavailable"
  end

  return {
    height = roundedCoordinate(frame.h),
    left = roundedCoordinate(frame.x),
    top = roundedCoordinate(frame.y),
    width = roundedCoordinate(frame.w),
  }
end

local function expectNativePlacementWindow(request)
  local pending = {
    request = request,
    timeout = nil,
    windowFound = false,
  }
  state.pendingNativePlacement = pending
  pending.timeout = later(NEW_WINDOW_TIMEOUT_SECONDS, function()
    if state.pendingNativePlacement ~= pending or pending.windowFound then
      return
    end

    state.pendingNativePlacement = nil
    failCurrent(
      "Timed out waiting for Tab Out's directly placed Chrome window",
      "Check the native bridge status and reload the Tab Out extension"
    )
  end, true)
  return pending
end

local function handlePendingChromeWindow(window)
  local pending = state.pendingNativePlacement
  local windowId = window and window:id() or nil
  if not pending
    or pending.windowFound
    or not windowId
    or not window:isStandard()
  then
    return
  end

  acceptNativePlacementWindow(pending, window)
end

local function requestInactiveTargetProfileWindow(request, targetScreen)
  local extensionId, extensionError = tabOutExtensionId()
  if not extensionId then
    failCurrent("Tab Out's Native Placement Bridge is unavailable", extensionError)
    return
  end

  if screenHasChromeWindowOnActiveSpace(targetScreen) then
    failCurrent(
      "The target Desktop already has a normal Chrome window",
      "Direct placement is reserved for a Chrome-empty active Space on the pointer display"
    )
    return
  end

  if not state.nativeBridge then
    failCurrent(
      "Tab Out's Native Placement Bridge is unavailable",
      state.nativeBridgeError or "The native bridge client is not configured"
    )
    return
  end

  local targetBounds, targetBoundsError = screenBoundsForBridge(targetScreen)
  if not targetBounds then
    failCurrent("Tab Out cannot address the target display", targetBoundsError)
    return
  end

  local pending = expectNativePlacementWindow(request)
  local started, startError = state.nativeBridge:createWindow({
    operation = request.kind,
    targetBounds = targetBounds,
    timeoutSeconds = NEW_WINDOW_TIMEOUT_SECONDS,
  }, function(accepted, bridgeError)
    local ok, callbackError = xpcall(function()
      if state.pendingNativePlacement ~= pending or pending.windowFound then
        return
      end
      if bridgeError or accepted ~= true then
        state.pendingNativePlacement = nil
        stopTimer(pending.timeout)
        failCurrent(
          "Tab Out's Native Placement Bridge rejected the request",
          bridgeError or "The extension returned no reason"
        )
        return
      end
    end, debug.traceback)

    if not ok and state.busy then
      failCurrent("Automation failed", callbackError)
    end
  end)

  if not started then
    state.pendingNativePlacement = nil
    stopTimer(pending.timeout)
    failCurrent("Tab Out's Native Placement Bridge could not start", startError)
    return
  end
end

local function createTargetProfileWindow(request, targetScreen)
  if not chromeApplication() then
    failCurrent(
      "Google Chrome is not running",
      "The Native Placement Bridge cannot create a guaranteed inactive window until Chrome is running"
    )
    return
  end

  requestInactiveTargetProfileWindow(request, targetScreen)
end

local function tryCandidate(request, targetScreen, candidates, index)
  local window = candidates[index]
  if not window then
    createTargetProfileWindow(request, targetScreen)
    return
  end

  local windowId = window:id()
  local cachedProfile = state.profileByWindow[windowId]
  if cachedProfile == state.config.chromeProfileDirectory then
    activateExistingWindow(request.kind, window)
    return
  end

  if cachedProfile then
    tryCandidate(request, targetScreen, candidates, index + 1)
    return
  end

  local focusedWindow = hs.window.focusedWindow()
  if focusedWindow and focusedWindow:id() == windowId then
    probeWindowProfile(window, function(profileDirectory, profileError)
      if profileDirectory == state.config.chromeProfileDirectory then
        activateExistingWindow(request.kind, window)
        return
      end

      if not profileDirectory then
        log.wf("Skipped an unverified Chrome window: %s", profileError or "unknown profile")
      end

      tryCandidate(request, targetScreen, candidates, index + 1)
    end)
    return
  end

  log.df("Skipped Chrome window %d because its profile has not been learned", windowId)
  tryCandidate(request, targetScreen, candidates, index + 1)
end

local function routeOnTargetSpace(request, targetScreen)
  local candidates = eligibleChromeWindows(targetScreen, request.targetSpaceId)
  tryCandidate(request, targetScreen, candidates, 1)
end

local function processRequest(request)
  ensureTargetUserSpace(request, function(targetScreen)
    routeOnTargetSpace(request, targetScreen)
  end)
end

drainQueue = function()
  if state.busy or #state.queue == 0 then
    return
  end

  state.currentRequest = table.remove(state.queue, 1)
  state.busy = true
  local ok, err = xpcall(function()
    processRequest(state.currentRequest)
  end, debug.traceback)

  if not ok then
    failCurrent("Automation failed", err)
  end
end

local function enqueue(kind)
  if not state.started then
    showFailure("The Hammerspoon module is not running")
    return
  end

  if not state.privateFocus then
    showFailure("The private Chrome focus helper is unavailable", state.privateFocusError)
    return
  end

  local context, contextError = captureTargetContext()
  if not context then
    showFailure("The target display or Desktop could not be determined", contextError)
    return
  end

  context.kind = kind
  table.insert(state.queue, context)
  drainQueue()
end

local function learnFocusedChromeProfile(window)
  if state.busy or not window or not window:id() or state.profileByWindow[window:id()] then
    return
  end

  later(0.2, function()
    if state.busy then
      return
    end

    local focusedWindow = hs.window.focusedWindow()
    if not focusedWindow or focusedWindow:id() ~= window:id() then
      return
    end

    probeWindowProfile(window, function(profileDirectory, profileError)
      if profileDirectory then
        log.df("Cached the profile for Chrome window %d", window:id())
      elseif profileError then
        log.df("Could not cache Chrome window %d: %s", window:id(), profileError)
      end
    end)
  end, false)
end

local function configureChromeWindowCache()
  state.chromeWindowFilter = hs.window.filter.new(function(window)
    local application = window and window:application() or nil
    return application and application:bundleID() == state.config.chromeBundleId
  end, "tab-out-profile-cache", "warning")

  state.chromeWindowFilter:subscribe(hs.window.filter.windowFocused, learnFocusedChromeProfile, true)

  state.chromeWindowFilter:subscribe(hs.window.filter.windowCreated, handlePendingChromeWindow)

  state.chromeWindowFilter:subscribe(hs.window.filter.windowDestroyed, function(window)
    local windowId = window and window:id() or nil
    if windowId then
      state.profileByWindow[windowId] = nil
      state.profileProbes[windowId] = nil
    end
  end)
end

local function configurePrivateFocus(config)
  state.privateFocus = nil
  state.privateFocusError = nil

  if config.privateFocusEnabled == false then
    state.privateFocusError = "Private focus is disabled by configuration"
    return
  end

  local privateFocus = config.privateFocus
  if not privateFocus then
    local loader, loadError = package.loadlib(
      config.privateFocusModulePath,
      "luaopen_tab_out_private_focus"
    )
    if not loader then
      state.privateFocusError = "The native module could not be loaded: " .. tostring(loadError)
      return
    end

    local loaded, moduleOrError = pcall(loader)
    if not loaded then
      state.privateFocusError = "The native module failed to initialize: " .. tostring(moduleOrError)
      return
    end
    privateFocus = moduleOrError
  end

  if type(privateFocus) ~= "table" or type(privateFocus.focus) ~= "function" then
    state.privateFocusError = "The native module does not expose exact-window focus"
    return
  end

  if type(privateFocus.capability) == "function" then
    local called, available, capabilityError = pcall(privateFocus.capability)
    if not called then
      state.privateFocusError = "Private focus capability check failed: " .. tostring(available)
      return
    end
    if not available then
      state.privateFocusError = capabilityError or "Private focus is unavailable on this Mac"
      return
    end
  end

  state.privateFocus = privateFocus
end

local function configureNativeBridge(config)
  state.nativeBridge = nil
  state.nativeBridgeError = nil

  local nativeBridge = config.nativeBridge
  if not nativeBridge then
    local loaded, bridgeModule = pcall(loadSiblingModule, "bridge.lua")
    if not loaded then
      state.nativeBridgeError = "The native bridge module could not be loaded: " .. tostring(bridgeModule)
      return
    end

    local created, bridgeOrError = pcall(bridgeModule.new, {
      hostPath = config.nativeBridgeHostPath,
    })
    if not created then
      state.nativeBridgeError = "The native bridge client could not initialize: " .. tostring(bridgeOrError)
      return
    end
    nativeBridge = bridgeOrError
  end

  if type(nativeBridge) ~= "table" or type(nativeBridge.createWindow) ~= "function" then
    state.nativeBridgeError = "The native bridge client does not expose window creation"
    return
  end

  state.nativeBridge = nativeBridge
  if type(nativeBridge.isReady) == "function" then
    local called, ready = pcall(nativeBridge.isReady, nativeBridge)
    if not called then
      state.nativeBridgeError = "The native bridge readiness check failed: " .. tostring(ready)
    elseif not ready then
      log.w("The native bridge host is not installed")
    end
  end
end

local function validateConfig(config)
  assert(type(config) == "table", "Tab Out config must be a table")
  assert(type(config.chromeBundleId) == "string", "chromeBundleId is required")
  assert(type(config.chromeProfileDirectory) == "string", "chromeProfileDirectory is required")
  assert(type(config.chromeUserDataDirectory) == "string", "chromeUserDataDirectory is required")
  assert(
    config.privateFocusEnabled == nil or type(config.privateFocusEnabled) == "boolean",
    "privateFocusEnabled must be a boolean"
  )
  if config.privateFocusEnabled ~= false then
    assert(
      type(config.privateFocus) == "table" or type(config.privateFocusModulePath) == "string",
      "privateFocus or privateFocusModulePath is required"
    )
  end
  assert(
    type(config.nativeBridge) == "table" or type(config.nativeBridgeHostPath) == "string",
    "nativeBridge or nativeBridgeHostPath is required"
  )
  assert(type(config.shortcuts) == "table", "shortcuts are required")
  assert(type(config.shortcuts.filter) == "table", "filter shortcut is required")
  assert(type(config.shortcuts.newPage) == "table", "newPage shortcut is required")
end

local function configWithDefaults(config)
  assert(type(config) == "table", "Tab Out config must be a table")

  local resolved = {}
  for key, value in pairs(config) do
    resolved[key] = value
  end

  local homeDirectory = os.getenv("HOME")
  resolved.chromeBundleId = resolved.chromeBundleId or "com.google.Chrome"
  resolved.chromeUserDataDirectory = resolved.chromeUserDataDirectory
    or (homeDirectory .. "/Library/Application Support/Google/Chrome")
  resolved.nativeBridgeHostPath = resolved.nativeBridgeHostPath
    or (homeDirectory .. "/Library/Application Support/Tab Out/bin/tab-out-native-bridge")
  resolved.privateFocusModulePath = resolved.privateFocusModulePath
    or (moduleDirectory .. "/native/build/tab_out_private_focus.dylib")
  return resolved
end

function M:start(config)
  if state.started then
    return M
  end

  config = configWithDefaults(config)
  validateConfig(config)
  state.config = config
  configurePrivateFocus(config)
  if not state.privateFocus then
    log.ef("Private Chrome focus is unavailable: %s", state.privateFocusError or "unknown error")
  end
  configureNativeBridge(config)
  if state.nativeBridgeError then
    log.ef("Native placement bridge is unavailable: %s", state.nativeBridgeError)
  end

  local storedSpaces = hs.settings.get(LAST_USER_SPACES_KEY)
  if type(storedSpaces) == "table" then
    state.lastUserSpaceByScreen = storedSpaces
  end

  refreshLastUserSpaces()
  state.spaceWatcher = hs.spaces.watcher.new(refreshLastUserSpaces):start()
  state.screenWatcher = hs.screen.watcher.new(refreshLastUserSpaces):start()
  configureChromeWindowCache()

  tabOutExtensionId()

  state.hotkeys.filter = hs.hotkey.bind(
    config.shortcuts.filter.modifiers,
    config.shortcuts.filter.key,
    function()
      enqueue("filter")
    end
  )
  state.hotkeys.newPage = hs.hotkey.bind(
    config.shortcuts.newPage.modifiers,
    config.shortcuts.newPage.key,
    function()
      enqueue("newPage")
    end
  )

  state.started = true
  log.i("Tab Out routing shortcuts are active")
  return M
end

function M.openFilter()
  enqueue("filter")
end

function M.openNewPage()
  enqueue("newPage")
end

function M.status()
  local targetWindows = 0
  local otherWindows = 0
  for _, profileDirectory in pairs(state.profileByWindow) do
    if profileDirectory == (state.config and state.config.chromeProfileDirectory) then
      targetWindows = targetWindows + 1
    else
      otherWindows = otherWindows + 1
    end
  end

  local diagnostics = {
    accessibility = hs.accessibilityState(false),
    busy = state.busy,
    cachedOtherProfileWindows = otherWindows,
    cachedTargetProfileWindows = targetWindows,
    extensionReady = false,
    launchAtLogin = hs.autoLaunch(),
    nativeBridgeError = state.nativeBridgeError,
    nativeBridgeInstalled = false,
    nativeBridgeReady = false,
    privateFocusError = state.privateFocusError,
    privateFocusReady = state.privateFocus ~= nil,
    queueDepth = #state.queue,
    started = state.started,
  }

  if state.config then
    diagnostics.extensionReady = tabOutExtensionId() ~= nil
    diagnostics.profileMetadataReady = chromeLocalState() ~= nil
  end

  if state.nativeBridge and type(state.nativeBridge.status) == "function" then
    local called, bridgeStatus = pcall(state.nativeBridge.status, state.nativeBridge)
    if called then
      diagnostics.nativeBridge = bridgeStatus
      diagnostics.nativeBridgeInstalled = bridgeStatus.hostInstalled == true
      diagnostics.nativeBridgeReady = bridgeStatus.connected == true
    end
  end

  return diagnostics
end

return M
