local M = {}

local CHROME_LAUNCH_TIMEOUT_SECONDS = 20
local CHROME_LAUNCH_RETRY_INTERVAL_SECONDS = 0.2
local CHROME_OPEN_EXECUTABLE = "/usr/bin/open"
local LAST_USER_SPACES_KEY = "tabOut.lastUserSpaces.v1"
local NEW_WINDOW_POLL_INTERVAL_SECONDS = 0.005
local NEW_WINDOW_TIMEOUT_SECONDS = 12
local PROFILE_WINDOW_INVENTORY_TIMEOUT_SECONDS = 3

M.lastUserSpacesKey = LAST_USER_SPACES_KEY

local function noOp() end

local function loggerOrNoOp(logger)
  return {
    df = logger and logger.df or noOp,
    wf = logger and logger.wf or noOp,
  }
end

function M.new(options)
  assert(type(options) == "table", "Window router options must be a table")
  assert(type(options.catalog) == "table", "catalog is required")
  assert(type(options.chromeWindows) == "function", "chromeWindows is required")
  assert(type(options.config) == "table", "config is required")
  assert(type(options.fail) == "function", "fail is required")
  assert(type(options.hs) == "table", "hs is required")
  assert(type(options.isBusy) == "function", "isBusy is required")
  assert(type(options.isCurrent) == "function", "isCurrent is required")
  assert(type(options.later) == "function", "later is required")
  assert(type(options.stopTimer) == "function", "stopTimer is required")
  assert(type(options.trackTimer) == "function", "trackTimer is required")
  assert(type(options.transition) == "function", "transition is required")

  local catalog = options.catalog
  local chromeLaunchTask
  local chromeWindows = options.chromeWindows
  local config = options.config
  local fail = options.fail
  local hs = options.hs
  local isBusy = options.isBusy
  local isCurrent = options.isCurrent
  local lastUserSpaceByScreen = options.lastUserSpaces or {}
  local later = options.later
  local log = loggerOrNoOp(options.log)
  local nativeBridge = options.nativeBridge
  local nativeBridgeError = options.nativeBridgeError
  local pendingNativePlacement
  local privateFocus = options.privateFocus
  local privateFocusError = options.privateFocusError
  local stopTimer = options.stopTimer
  local trackTimer = options.trackTimer
  local transition = options.transition
  local router = {}

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
    local focusedApplication = focusedWindow and focusedWindow:application() or nil
    local focusedScreen = focusedWindow and focusedWindow:screen() or nil
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
      lastUserSpaceByScreen[uuid] = spaceId
      hs.settings.set(LAST_USER_SPACES_KEY, lastUserSpaceByScreen)
    end

    return {
      capturedSpaceId = spaceId,
      capturedSpaceType = spaceType,
      fallbackUserSpaceId = spaceType == "fullscreen" and lastUserSpaceByScreen[uuid] or nil,
      focusedWindowBundleId = focusedApplication and focusedApplication:bundleID() or nil,
      focusedWindowId = focusedWindow and focusedWindow:id() or nil,
      focusedWindowScreenUuid = screenUuid(focusedScreen),
      screenUuid = uuid,
    }
  end

  local function refreshLastUserSpaces()
    local changed = false

    for _, screen in ipairs(hs.screen.allScreens()) do
      local activeSpace = hs.spaces.activeSpaceOnScreen(screen)
      if activeSpace and hs.spaces.spaceType(activeSpace) == "user" then
        local uuid = screenUuid(screen)
        if uuid and lastUserSpaceByScreen[uuid] ~= activeSpace then
          lastUserSpaceByScreen[uuid] = activeSpace
          changed = true
        end
      end
    end

    if changed then
      hs.settings.set(LAST_USER_SPACES_KEY, lastUserSpaceByScreen)
    end
  end

  local function spaceBelongsToScreen(spaceId, screen)
    local spaces = hs.spaces.spacesForScreen(screen)
    return spaces and containsValue(spaces, spaceId) or false
  end

  local function regularSpaceForScreen(request, screen)
    local remembered = request.fallbackUserSpaceId
    if remembered
      and spaceBelongsToScreen(remembered, screen)
      and hs.spaces.spaceType(remembered) == "user"
    then
      return remembered
    end

    for _, spaceId in ipairs(hs.spaces.spacesForScreen(screen) or {}) do
      if hs.spaces.spaceType(spaceId) == "user" then
        return spaceId
      end
    end
    return nil
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
      fail("Could not switch to the target Desktop", "Timed out waiting for the Space change")
      return
    end

    later(0.1, function()
      waitForSpace(request, screen, targetSpace, attempt + 1)
    end, true)
  end

  local function ensureTargetUserSpace(request, callback)
    local screen = screenForUuid(request.screenUuid)
    if not screen then
      fail("The target display is no longer connected")
      return
    end

    local targetSpace
    if request.capturedSpaceType == "user" then
      targetSpace = request.capturedSpaceId
    elseif request.capturedSpaceType == "fullscreen" then
      targetSpace = regularSpaceForScreen(request, screen)
    end

    if not targetSpace then
      fail("No previously used regular Desktop is known for this display")
      return
    end

    if not spaceBelongsToScreen(targetSpace, screen) or hs.spaces.spaceType(targetSpace) ~= "user" then
      fail("The target regular Desktop is no longer available")
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
      fail("Could not switch from the full-screen Space", switchError)
      return
    end

    waitForSpace(request, screen, targetSpace, 0)
  end

  local function chromeApplication()
    return hs.application.get(config.chromeBundleId)
  end

  local function trackedChromeWindows()
    local tracked = chromeWindows()
    if tracked then
      return tracked
    end

    local application = chromeApplication()
    return application and application:allWindows() or {}
  end

  local function isChromeWindow(window)
    if not window or not window:id() or not window:isStandard() or window:isMinimized() then
      return false
    end

    local application = window:application()
    return application and application:bundleID() == config.chromeBundleId and not application:isHidden()
  end

  local function screenHasChromeWindowOnSpace(screen, spaceId)
    local targetScreenUuid = screenUuid(screen)
    for _, window in ipairs(trackedChromeWindows()) do
      if isChromeWindow(window) and screenUuid(window:screen()) == targetScreenUuid then
        local spaces = hs.spaces.windowSpaces(window)
        if spaces and containsValue(spaces, spaceId) then
          return true
        end
      end
    end
    return false
  end

  local function eligibleChromeWindows(screen, spaceId)
    local candidates = {}
    if not screenHasChromeWindowOnSpace(screen, spaceId) then
      return candidates
    end

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

  local function roundedCoordinate(value)
    return math.floor(value + 0.5)
  end

  local function acceptNativePlacementWindow(pending, window)
    if pending.windowFound then
      return
    end

    pending.windowFound = true
    stopTimer(pending.timeout)
    stopTimer(pending.poll)
    if pendingNativePlacement == pending then
      pendingNativePlacement = nil
    end

    local request = pending.request
    transition():registerCreatedWindow(request, window)
    log.df("Tab Out created the %s window directly on the target Desktop", request.kind)
    transition():activateCreated(request.kind, window)
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
      baselineWindowIds = {},
      bridgeAccepted = false,
      poll = nil,
      request = request,
      timeout = nil,
      windowFound = false,
    }
    local application = chromeApplication()
    for _, window in ipairs(application and application:allWindows() or {}) do
      local windowId = window:id()
      if windowId then
        pending.baselineWindowIds[windowId] = true
      end
    end
    pendingNativePlacement = pending
    pending.timeout = later(NEW_WINDOW_TIMEOUT_SECONDS, function()
      if pendingNativePlacement ~= pending or pending.windowFound then
        return
      end

      pendingNativePlacement = nil
      fail(
        "Timed out waiting for Tab Out's directly placed Chrome window",
        "Check the native bridge status and reload the Tab Out extension"
      )
    end, true)
    return pending
  end

  local function handlePendingChromeWindow(window)
    local pending = pendingNativePlacement
    local windowId = window and window:id() or nil
    if not pending
      or not pending.bridgeAccepted
      or pending.windowFound
      or not windowId
      or not window:isStandard()
    then
      return
    end

    acceptNativePlacementWindow(pending, window)
  end

  local function startNativePlacementPoll(pending)
    local poll
    poll = hs.timer.doEvery(NEW_WINDOW_POLL_INTERVAL_SECONDS, function()
      local ok, pollError = xpcall(function()
        if pendingNativePlacement ~= pending or pending.windowFound then
          stopTimer(poll)
          return
        end

        if not pending.bridgeAccepted then
          return
        end

        local application = chromeApplication()
        for _, window in ipairs(application and application:allWindows() or {}) do
          local windowId = window:id()
          if windowId and not pending.baselineWindowIds[windowId] then
            handlePendingChromeWindow(window)
            if pending.windowFound then
              return
            end
          end
        end
      end, debug.traceback)

      if not ok and isBusy() then
        fail("Automation failed", pollError)
      end
    end)
    pending.poll = poll
    trackTimer(poll)
  end

  local function requestInactiveTargetProfileWindow(request, targetScreen)
    local extensionId, extensionError = catalog:extensionId()
    if not extensionId then
      fail("Tab Out's Native Placement Bridge is unavailable", extensionError)
      return
    end

    if not nativeBridge then
      fail(
        "Tab Out's Native Placement Bridge is unavailable",
        nativeBridgeError or "The native bridge client is not configured"
      )
      return
    end

    local targetBounds, targetBoundsError = screenBoundsForBridge(targetScreen)
    if not targetBounds then
      fail("Tab Out cannot address the target display", targetBoundsError)
      return
    end

    local shieldCaptured, shieldError = transition():captureShield(targetScreen)
    if not shieldCaptured then
      log.wf("Could not shield the new-window transition: %s", shieldError or "unknown error")
    end

    local pending = expectNativePlacementWindow(request)
    startNativePlacementPoll(pending)
    local started, startError = nativeBridge:createWindow({
      operation = request.kind,
      targetBounds = targetBounds,
      timeoutSeconds = NEW_WINDOW_TIMEOUT_SECONDS,
    }, function(accepted, bridgeError)
      local ok, callbackError = xpcall(function()
        if pendingNativePlacement ~= pending or pending.windowFound then
          return
        end
        if bridgeError or accepted ~= true then
          pendingNativePlacement = nil
          stopTimer(pending.timeout)
          fail(
            "Tab Out's Native Placement Bridge rejected the request",
            bridgeError or "The extension returned no reason"
          )
          return
        end
        pending.bridgeAccepted = true
      end, debug.traceback)

      if not ok and isBusy() then
        fail("Automation failed", callbackError)
      end
    end)

    if not started then
      pendingNativePlacement = nil
      stopTimer(pending.timeout)
      fail("Tab Out's Native Placement Bridge could not start", startError)
      return
    end
  end

  local function waitForColdChromeBridge(request, targetScreen, startedAt)
    if not isCurrent(request) then
      return
    end

    if hs.timer.secondsSinceEpoch() - startedAt >= CHROME_LAUNCH_TIMEOUT_SECONDS then
      fail(
        "Google Chrome did not become ready for Tab Out",
        "The background launch did not establish the Native Placement Bridge"
      )
      return
    end

    local bridge = nativeBridge
    if not bridge or type(bridge.listProfileWindows) ~= "function" then
      fail(
        "Tab Out's Native Placement Bridge is unavailable",
        "The native bridge client cannot verify a cold Chrome launch"
      )
      return
    end

    local completed = false
    local function retry(inventoryError)
      if completed then
        return
      end
      completed = true
      if inventoryError then
        log.df("Waiting for cold Chrome bridge readiness: %s", inventoryError)
      end
      later(CHROME_LAUNCH_RETRY_INTERVAL_SECONDS, function()
        waitForColdChromeBridge(request, targetScreen, startedAt)
      end, true)
    end

    local started, startError = bridge:listProfileWindows({
      timeoutSeconds = PROFILE_WINDOW_INVENTORY_TIMEOUT_SECONDS,
    }, function(profileWindowIds, inventoryError)
      if not isCurrent(request) then
        return
      end
      if profileWindowIds then
        completed = true
        requestInactiveTargetProfileWindow(request, targetScreen)
        return
      end
      retry(inventoryError)
    end)

    if not started then
      retry(startError)
    end
  end

  local function launchChromeForNativePlacement(request, targetScreen)
    local extensionId, extensionError = catalog:extensionId()
    if not extensionId then
      fail("Tab Out's Chrome profile is unavailable", extensionError)
      return
    end
    if not nativeBridge or type(nativeBridge.listProfileWindows) ~= "function" then
      fail(
        "Tab Out's Native Placement Bridge is unavailable",
        nativeBridgeError or "The native bridge client cannot verify a cold Chrome launch"
      )
      return
    end

    local startedAt = hs.timer.secondsSinceEpoch()
    local arguments = {
      "-g",
      "-b",
      config.chromeBundleId,
      "--args",
      "--profile-directory=" .. config.chromeProfileDirectory,
      "--no-startup-window",
    }
    local task
    task = hs.task.new(CHROME_OPEN_EXECUTABLE, function(exitCode, _, standardError)
      if chromeLaunchTask == task then
        chromeLaunchTask = nil
      end
      if not isCurrent(request) then
        return
      end
      if exitCode ~= 0 then
        fail(
          "Google Chrome could not be launched in the background",
          standardError ~= "" and standardError or "The macOS application launcher failed"
        )
        return
      end
      waitForColdChromeBridge(request, targetScreen, startedAt)
    end, arguments)

    if not task then
      fail("Google Chrome could not be launched in the background")
      return
    end
    chromeLaunchTask = task
    if not task:start() then
      chromeLaunchTask = nil
      fail("Google Chrome could not be launched in the background")
    end
  end

  local function createTargetProfileWindow(request, targetScreen)
    if not chromeApplication() then
      launchChromeForNativePlacement(request, targetScreen)
      return
    end

    requestInactiveTargetProfileWindow(request, targetScreen)
  end

  local function tryCandidate(request, targetScreen, candidates, index)
    local window = candidates[index]
    if not window then
      if request.routeOnRegularSpace then
        local routeOnRegularSpace = request.routeOnRegularSpace
        request.routeOnRegularSpace = nil
        routeOnRegularSpace()
        return
      end
      createTargetProfileWindow(request, targetScreen)
      return
    end

    local windowId = window:id()
    local cachedProfile = catalog:profileFor(windowId)
    if cachedProfile == config.chromeProfileDirectory then
      transition():activateExisting(request.kind, window)
      return
    end

    if cachedProfile then
      tryCandidate(request, targetScreen, candidates, index + 1)
      return
    end

    local focusedWindow = hs.window.focusedWindow()
    if focusedWindow and focusedWindow:id() == windowId then
      catalog:probeFocused(window, function(profileDirectory, profileError)
        if profileDirectory == config.chromeProfileDirectory then
          transition():activateExisting(request.kind, window)
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
    catalog:discover(candidates, function()
      tryCandidate(request, targetScreen, candidates, 1)
    end)
  end

  local function processRequest(request)
    if request.capturedSpaceType == "fullscreen" then
      local screen = screenForUuid(request.screenUuid)
      if not screen then
        fail("The target display is no longer connected")
        return
      end

      request.targetSpaceId = request.capturedSpaceId
      request.routeOnRegularSpace = function()
        ensureTargetUserSpace(request, function(targetScreen)
          routeOnTargetSpace(request, targetScreen)
        end)
      end
      routeOnTargetSpace(request, screen)
      return
    end

    ensureTargetUserSpace(request, function(targetScreen)
      routeOnTargetSpace(request, targetScreen)
    end)
  end

  local function prepareRoutingRequest(kind)
    if not privateFocus then
      return nil, "The private Chrome focus helper is unavailable", privateFocusError
    end

    local context, contextError = captureTargetContext()
    if not context then
      return nil, "The target display or Desktop could not be determined", contextError
    end

    context.kind = kind
    return context
  end


  function router:cleanup()
    if pendingNativePlacement then
      stopTimer(pendingNativePlacement.timeout)
      stopTimer(pendingNativePlacement.poll)
    end
    transition():releaseShield()
    pendingNativePlacement = nil
  end

  function router:handleChromeWindowCreated(window)
    handlePendingChromeWindow(window)
  end

  function router:prepare(kind)
    return prepareRoutingRequest(kind)
  end

  function router:process(request)
    processRequest(request)
  end

  function router:refreshSpaces()
    refreshLastUserSpaces()
  end

  function router:screenFor(request)
    return request and screenForUuid(request.screenUuid) or nil
  end

  return router
end

return M
