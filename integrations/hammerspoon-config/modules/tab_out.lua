local M = {}

local log = hs.logger.new("tab-out", "info")
local LAST_USER_SPACES_KEY = "tabOut.lastUserSpaces.v1"
local NEW_WINDOW_TIMEOUT_SECONDS = 12
local NEW_TAB_URL = "chrome://newtab/"
local OPEN_EXECUTABLE = "/usr/bin/open"
local PROFILE_PROBE_TIMEOUT_SECONDS = 6
local WINDOW_FOCUS_DELAY_SECONDS = 0.15
local WINDOW_FOCUS_RETRY_INTERVAL_SECONDS = 0.05
local WINDOW_FOCUS_RETRY_LIMIT = 10

local state = {
  busy = false,
  chromeWindowFilter = nil,
  config = nil,
  currentRequest = nil,
  extensionId = nil,
  hotkeys = {},
  lastUserSpaceByScreen = {},
  pendingWindowLaunch = nil,
  profileByWindow = {},
  profileProbes = {},
  queue = {},
  screenWatcher = nil,
  spaceWatcher = nil,
  started = false,
  tasks = {},
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
  state.pendingWindowLaunch = nil
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

local function focusWindowThen(window, onFocused, onFailure, attempt, expectedWindowId)
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

  local focusedWindow = hs.window.focusedWindow()
  if focusedWindow and focusedWindow:id() == expectedWindowId then
    onFocused()
    return
  end

  if attempt >= WINDOW_FOCUS_RETRY_LIMIT then
    onFailure("Timed out waiting for Chrome to focus the requested window")
    return
  end

  local succeeded, focusError = pcall(function()
    window:raise()
    window:focus()
  end)
  if not succeeded then
    onFailure(focusError)
    return
  end

  later(WINDOW_FOCUS_RETRY_INTERVAL_SECONDS, function()
    focusWindowThen(window, onFocused, onFailure, attempt + 1, expectedWindowId)
  end, true)
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

local function focusChromeAddressBar(window)
  local callSucceeded, focused, focusError = pcall(function()
    local addressBar = chromeAddressBar(window)
    if not addressBar then
      return false, "Chrome's address bar is unavailable"
    end

    return addressBar:setAttributeValue("AXFocused", true)
  end)

  if not callSucceeded then
    return false, focused
  end

  return focused, focusError
end

local function navigateChromeAddressBar(window, url)
  local callSucceeded, navigated, navigationError = pcall(function()
    local addressBar = chromeAddressBar(window)
    if not addressBar then
      return false, "Chrome's address bar is unavailable"
    end

    if not addressBar:setAttributeValue("AXFocused", true) then
      return false, "Chrome's address bar could not be focused"
    end

    if not addressBar:setAttributeValue("AXValue", url) then
      return false, "Chrome's address bar value could not be changed"
    end

    local application = window:application()
    if not application then
      return false, "Google Chrome is no longer running"
    end

    hs.eventtap.keyStroke({}, "return", 0, application)
    return true
  end)

  if not callSucceeded then
    return false, navigated
  end

  return navigated, navigationError
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

  window:focus()
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

local function openTabOutInFrontChrome(kind)
  if kind == "newPage" then
    local application = chromeApplication()
    if not application then
      return false, "Google Chrome is no longer running"
    end

    local succeeded, openError = pcall(hs.eventtap.keyStroke, { "cmd" }, "t", 0, application)
    if succeeded then
      return true
    end

    return false, openError
  end

  local url, urlError = filterFocusUrl()
  if not url then
    return false, urlError
  end

  local script = string.format([[
tell application "Google Chrome"
  if (count of windows) is 0 then error "No Chrome window is available"
  tell front window
    make new tab at end of tabs with properties {URL:"%s"}
    set active tab index to (count of tabs)
  end tell
end tell
]], url)

  local succeeded, _, descriptor = hs.osascript.applescript(script)
  if succeeded then
    return true
  end

  local errorNumber = type(descriptor) == "table" and descriptor.NSAppleScriptErrorNumber or nil
  if errorNumber then
    return false, "Chrome AppleScript error " .. tostring(errorNumber)
  end

  return false, "Chrome did not accept the new tab request"
end

local function finishWindowActivation(kind, window, focusAddressBarExplicitly)
  later(0.2, function()
    focusWindowThen(window, function()
      if kind == "newPage" and focusAddressBarExplicitly then
        local focused, focusError = focusChromeAddressBar(window)
        if not focused then
          failCurrent("Chrome's address bar could not be focused", focusError)
          return
        end

        log.d("Focused Chrome's address bar through Accessibility")
      elseif kind == "newPage" then
        log.d("Kept Chrome's native new-tab address-bar focus")
      end

      finishCurrent()
    end, function(focusError)
      failCurrent("The Tab Out window did not retain focus", focusError)
    end)
  end, true)
end

local function activateExistingWindow(kind, window)
  focusWindowThen(window, function()
    local opened, openError = openTabOutInFrontChrome(kind)
    if not opened then
      failCurrent("Chrome could not open the Tab Out page", openError)
      return
    end

    log.df("Opened the %s page in an existing target-profile window", kind)
    finishWindowActivation(kind, window, false)
  end, function(focusError)
    failCurrent("The selected Chrome window did not retain focus", focusError)
  end)
end

local function translatedRect(currentFrame, sourceFrame, targetFrame)
  local width = math.min(currentFrame.w, targetFrame.w)
  local height = math.min(currentFrame.h, targetFrame.h)
  local offsetX = currentFrame.x - sourceFrame.x
  local offsetY = currentFrame.y - sourceFrame.y
  local maxX = math.max(0, targetFrame.w - width)
  local maxY = math.max(0, targetFrame.h - height)
  local x = targetFrame.x + math.max(0, math.min(offsetX, maxX))
  local y = targetFrame.y + math.max(0, math.min(offsetY, maxY))

  return hs.geometry.rect(x, y, width, height)
end

local function translatedFrame(window, targetScreen)
  local targetFrame = targetScreen:frame()
  local sourceScreen = window:screen()
  local sourceFrame = sourceScreen and sourceScreen:frame() or targetFrame
  return translatedRect(window:frame(), sourceFrame, targetFrame)
end

local function finishNewWindow(request, window, targetScreen, originalFrame)
  if originalFrame then
    window:setFrame(originalFrame, 0)
  else
    window:setFrame(translatedFrame(window, targetScreen), 0)
  end

  state.profileByWindow[window:id()] = state.config.chromeProfileDirectory
  if request.kind == "filter" then
    focusWindowThen(window, function()
      later(WINDOW_FOCUS_DELAY_SECONDS, function()
        focusWindowThen(window, function()
          local url, urlError = filterFocusUrl()
          if not url then
            failCurrent("Tab Out's Chrome shortcut mapping is unavailable", urlError)
            return
          end

          local navigated, navigationError = navigateChromeAddressBar(window, url)
          if not navigated then
            failCurrent("Chrome could not open the Tab Out page", navigationError)
            return
          end

          log.d("Opened the filter page after placing the new target-profile Chrome window")
          finishWindowActivation(request.kind, window, false)
        end, function(focusError)
          failCurrent("The new Chrome window did not retain focus", focusError)
        end)
      end, true)
    end, function(focusError)
      failCurrent("The new Chrome window did not retain focus", focusError)
    end)
    return
  end

  window:focus()
  log.df("Created a target-profile Chrome window for the %s shortcut", request.kind)
  finishWindowActivation(request.kind, window, true)
end

local function placeNewWindow(request, window, targetScreen, attempt, targetFrame)
  local spaces = hs.spaces.windowSpaces(window)
  if spaces and containsValue(spaces, request.targetSpaceId) then
    finishNewWindow(request, window, targetScreen, targetFrame)
    return
  end

  if attempt >= 5 then
    local detail = "The display move did not settle"
    if screenUuid(window:screen()) == request.screenUuid then
      detail = "The Space move did not settle"
    end

    failCurrent("Could not place the new Chrome window on the target Desktop", detail)
    return
  end

  if screenUuid(window:screen()) ~= request.screenUuid then
    window:setFrame(targetFrame, 0)
    later(0.2, function()
      placeNewWindow(request, window, targetScreen, attempt + 1, targetFrame)
    end, true)
    return
  end

  local moved, moveError = hs.spaces.moveWindowToSpace(window, request.targetSpaceId)
  if moved then
    later(0.2, function()
      placeNewWindow(request, window, targetScreen, attempt + 1, targetFrame)
    end, true)
    return
  end

  later(0.2, function()
    placeNewWindow(request, window, targetScreen, attempt + 1, targetFrame)
  end, true)
  log.wf("Chrome window Space move attempt %d failed: %s", attempt + 1, moveError or "unknown error")
end

local function trackedChromeWindows(sortOrder)
  if state.chromeWindowFilter then
    return state.chromeWindowFilter:getWindows(sortOrder)
  end

  local application = chromeApplication()
  return application and application:allWindows() or {}
end

local function managedWindowIds()
  local ids = {}

  local spacesByScreen = hs.spaces.allSpaces() or {}
  for _, spaces in pairs(spacesByScreen) do
    for _, spaceId in ipairs(spaces) do
      for _, windowId in ipairs(hs.spaces.windowsForSpace(spaceId) or {}) do
        ids[windowId] = true
      end
    end
  end

  for _, window in ipairs(trackedChromeWindows()) do
    if window:id() then
      ids[window:id()] = true
    end
  end

  return ids
end

local function findNewChromeWindow(previousIds)
  local application = chromeApplication()
  if not application then
    return nil
  end

  local focusedWindow = application:focusedWindow()
  if focusedWindow and focusedWindow:id() and focusedWindow:isStandard() and not previousIds[focusedWindow:id()] then
    return focusedWindow
  end

  local newestWindow
  local windows = trackedChromeWindows(hs.window.filter.sortByCreatedLast)
  for _, window in ipairs(windows) do
    local windowId = window:id()
    if windowId and window:isStandard() and not previousIds[windowId] then
      if not newestWindow or windowId > newestWindow:id() then
        newestWindow = window
      end
    end
  end

  return newestWindow
end

local function beginNewWindowPlacement(request, targetScreen, launchState, window)
  if launchState.windowFound then
    return
  end

  launchState.windowFound = true
  if state.pendingWindowLaunch and state.pendingWindowLaunch.launchState == launchState then
    state.pendingWindowLaunch = nil
  end

  local targetFrame = translatedFrame(window, targetScreen)
  if screenUuid(window:screen()) ~= request.screenUuid then
    window:setFrame(targetFrame, 0)
  end

  placeNewWindow(request, window, targetScreen, 0, targetFrame)
end

local function expectNewChromeWindow(request, targetScreen, previousIds, launchState)
  state.pendingWindowLaunch = {
    launchState = launchState,
    previousIds = previousIds,
    request = request,
    targetScreen = targetScreen,
  }
end

local function handlePendingChromeWindow(window)
  local pending = state.pendingWindowLaunch
  local windowId = window and window:id() or nil
  if not pending
    or pending.launchState.windowFound
    or not windowId
    or pending.previousIds[windowId]
    or not window:isStandard()
  then
    return
  end

  beginNewWindowPlacement(pending.request, pending.targetScreen, pending.launchState, window)
end

local function pollForNewWindow(request, targetScreen, previousIds, launchState, attempt)
  if launchState.windowFound then
    return
  end

  local window = findNewChromeWindow(previousIds)
  if window then
    beginNewWindowPlacement(request, targetScreen, launchState, window)
    return
  end

  if launchState.exitCode and launchState.exitCode ~= 0 then
    failCurrent("Chrome could not create the target-profile window", launchState.errorOutput)
    return
  end

  if attempt * 0.1 >= NEW_WINDOW_TIMEOUT_SECONDS then
    failCurrent("Timed out waiting for the new Chrome window")
    return
  end

  later(0.1, function()
    pollForNewWindow(request, targetScreen, previousIds, launchState, attempt + 1)
  end, true)
end

local function launchTargetProfileWindow(request, targetScreen)
  local previousIds = managedWindowIds()
  local launchState = {
    errorOutput = nil,
    exitCode = nil,
    windowFound = false,
  }
  local arguments = {
    "-g",
    "-n",
    "-b",
    state.config.chromeBundleId,
    "--args",
    "--profile-directory=" .. state.config.chromeProfileDirectory,
    "--new-window",
  }

  if request.kind == "filter" then
    local url, urlError = filterFocusUrl()
    if not url then
      failCurrent("Tab Out's Chrome shortcut mapping is unavailable", urlError)
      return
    end
  end
  table.insert(arguments, NEW_TAB_URL)

  local task
  task = hs.task.new(OPEN_EXECUTABLE, function(exitCode, _, standardError)
    state.tasks[task] = nil
    launchState.exitCode = exitCode
    if exitCode ~= 0 then
      launchState.errorOutput = standardError
      log.ef("Chrome launcher exited with code %d", exitCode)
    end
  end, arguments)

  expectNewChromeWindow(request, targetScreen, previousIds, launchState)
  if not task or not task:start() then
    failCurrent("Chrome could not be launched for the target profile")
    return
  end

  state.tasks[task] = true
  pollForNewWindow(request, targetScreen, previousIds, launchState, 0)
end

local function createTargetProfileWindow(request, targetScreen)
  launchTargetProfileWindow(request, targetScreen)
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

  state.chromeWindowFilter:subscribe(hs.window.filter.windowFocused, function(window)
    learnFocusedChromeProfile(window)
  end, true)

  state.chromeWindowFilter:subscribe(hs.window.filter.windowCreated, handlePendingChromeWindow)

  state.chromeWindowFilter:subscribe(hs.window.filter.windowDestroyed, function(window)
    local windowId = window and window:id() or nil
    if windowId then
      state.profileByWindow[windowId] = nil
      state.profileProbes[windowId] = nil
    end
  end)
end

local function validateConfig(config)
  assert(type(config) == "table", "Tab Out config must be a table")
  assert(type(config.chromeBundleId) == "string", "chromeBundleId is required")
  assert(type(config.chromeProfileDirectory) == "string", "chromeProfileDirectory is required")
  assert(type(config.chromeUserDataDirectory) == "string", "chromeUserDataDirectory is required")
  assert(type(config.shortcuts) == "table", "shortcuts are required")
  assert(type(config.shortcuts.filter) == "table", "filter shortcut is required")
  assert(type(config.shortcuts.newPage) == "table", "newPage shortcut is required")
end

function M.start(config)
  if state.started then
    return M
  end

  validateConfig(config)
  state.config = config

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
    queueDepth = #state.queue,
    started = state.started,
  }

  if state.config then
    diagnostics.extensionReady = tabOutExtensionId() ~= nil
    diagnostics.profileMetadataReady = chromeLocalState() ~= nil
  end

  return diagnostics
end

return M
