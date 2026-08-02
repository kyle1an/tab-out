local M = {}

local CREATED_WINDOW_CLOSE_FOCUS_TIMEOUT_SECONDS = 0.5
local CREATED_WINDOW_CLOSE_MONITOR_INTERVAL_SECONDS = 0.1
local CREATED_WINDOW_CLOSE_RETRY_INTERVAL_SECONDS = 0.005
local DESTINATION_CONTROL_TIMEOUT_SECONDS = 6
local NEW_TAB_URL = "chrome://newtab/"
local TARGET_FOCUS_TIMEOUT_SECONDS = 2
local WINDOW_FOCUS_RETRY_INTERVAL_SECONDS = 0.05

local function noOp() end

local function loggerOrNoOp(logger)
  return {
    df = logger and logger.df or noOp,
    ef = logger and logger.ef or noOp,
    wf = logger and logger.wf or noOp,
  }
end

local function containsValue(values, expected)
  for _, value in ipairs(values or {}) do
    if value == expected then
      return true
    end
  end
  return false
end

local function roundedCoordinate(value)
  return math.floor(value + 0.5)
end

function M.new(options)
  assert(type(options) == "table", "Window transition options must be a table")
  assert(type(options.catalog) == "table", "catalog is required")
  assert(type(options.chromeBundleId) == "string", "chromeBundleId is required")
  assert(type(options.configuredProfileDirectory) == "string", "configuredProfileDirectory is required")
  assert(type(options.currentRequest) == "function", "currentRequest is required")
  assert(type(options.fail) == "function", "fail is required")
  assert(type(options.finish) == "function", "finish is required")
  assert(type(options.hs) == "table", "hs is required")
  assert(type(options.later) == "function", "later is required")

  local catalog = options.catalog
  local chromeBundleId = options.chromeBundleId
  local configuredProfileDirectory = options.configuredProfileDirectory
  local currentRequest = options.currentRequest
  local fail = options.fail
  local finish = options.finish
  local hs = options.hs
  local later = options.later
  local log = loggerOrNoOp(options.log)
  local privateFocus = options.privateFocus
  local privateFocusError = options.privateFocusError
  local closeGestureTap
  local createdWindowCloseRecovery = {}
  local suppressCloseMouseUp = false
  local transitionShield
  local transition = {}

  local function screenUuid(screen)
    return screen and screen:getUUID() or nil
  end

  local function releaseTransitionShield()
    local shield = transitionShield
    transitionShield = nil
    if shield then
      pcall(function()
        shield:delete()
      end)
    end
  end

  local function captureTransitionShield(screen)
    releaseTransitionShield()
    if type(hs.screenRecordingState) == "function" and not hs.screenRecordingState() then
      return false, "Hammerspoon does not have Screen Recording permission"
    end

    local shield
    local captured, captureError = xpcall(function()
      local frame = screen and screen:fullFrame() or nil
      local image = screen and screen:snapshot() or nil
      if not frame or not image then
        error("the target display snapshot is unavailable")
      end

      shield = hs.canvas.new(frame)
      if not shield then
        error("the transition shield could not be created")
      end
      shield[1] = {
        frame = { x = 0, y = 0, w = frame.w, h = frame.h },
        image = image,
        imageScaling = "scaleProportionally",
        type = "image",
      }
      shield:canvasMouseEvents(false, false, false, false)
      shield:bringToFront(false):show()
    end, debug.traceback)

    if not captured then
      if shield then
        pcall(function()
          shield:delete()
        end)
      end
      return false, captureError
    end

    transitionShield = shield
    return true
  end


  local function isDestinationControl(kind, element, role)
    if type(element) ~= "userdata" then
      return false
    end
    role = role or element:attributeValue("AXRole")
    if role ~= "AXTextField" then
      return false
    end

    local description = element:attributeValue("AXDescription")
    if kind == "filter" then
      return type(description) == "string" and description:match("^Filter ") ~= nil
    end
    return description == "Address and search bar"
  end

  local function focusedDestinationControl(kind, root)
    local systemWideElement = hs.axuielement.systemWideElement
      and hs.axuielement.systemWideElement()
      or nil
    local control = systemWideElement
      and systemWideElement:attributeValue("AXFocusedUIElement")
      or nil
    if not isDestinationControl(kind, control)
      or control:attributeValue("AXFocused") ~= true
      or control:attributeValue("AXWindow") ~= root
    then
      return nil
    end

    return control
  end

  local function chromeAddressBar(root)
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

      if isDestinationControl("newPage", element, role) then
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

  local function chromeFilterInput(root)
    local visited = {}

    local function findFilterInput(element, depth)
      if type(element) ~= "userdata" or visited[element] or depth > 30 then
        return nil
      end

      visited[element] = true
      if isDestinationControl("filter", element) then
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
    local root = window and hs.axuielement.windowElement(window) or nil
    if not root then
      return nil
    end

    local focusedControl = focusedDestinationControl(kind, root)
    if focusedControl then
      return focusedControl
    end

    if kind == "filter" then
      return chromeFilterInput(root)
    end
    return chromeAddressBar(root)
  end

  local function topStandardWindowOnScreen(screen, excludedWindowId)
    local expectedScreenUuid = screenUuid(screen)
    local activeSpace = screen and hs.spaces.activeSpaceOnScreen(screen) or nil
    if not expectedScreenUuid or not activeSpace then
      return nil
    end

    for _, window in ipairs(hs.window.orderedWindows()) do
      if window
        and window:id()
        and window:id() ~= excludedWindowId
        and window:isStandard()
        and not window:isMinimized()
        and screenUuid(window:screen()) == expectedScreenUuid
      then
        local spaces = hs.spaces.windowSpaces(window)
        if spaces and containsValue(spaces, activeSpace) then
          return window
        end
      end
    end
    return nil
  end

  local function recoveryWindow(recovery, requireTop, excludedWindowId)
    local window = recovery and hs.window.get(recovery.windowId) or nil
    local application = window and window:application() or nil
    local screen = window and window:screen() or nil
    if not window
      or not window:id()
      or not window:isStandard()
      or window:isMinimized()
      or not application
      or application:isHidden()
      or application:bundleID() ~= recovery.bundleId
      or application:bundleID() == chromeBundleId
      or screenUuid(screen) ~= recovery.screenUuid
    then
      return nil
    end

    local activeSpace = hs.spaces.activeSpaceOnScreen(screen)
    local spaces = hs.spaces.windowSpaces(window)
    if not activeSpace or not spaces or not containsValue(spaces, activeSpace) then
      return nil
    end

    if requireTop then
      local topWindow = topStandardWindowOnScreen(screen, excludedWindowId)
      if not topWindow or topWindow:id() ~= window:id() then
        return nil
      end
    end
    return window
  end

  local function createdWindowCloseButtonFrame(window)
    local root = window and hs.axuielement.windowElement(window) or nil
    local closeButton = root and root:attributeValue("AXCloseButton") or nil
    local frame = closeButton and closeButton:attributeValue("AXFrame") or nil
    if not frame
      or type(frame.x) ~= "number"
      or type(frame.y) ~= "number"
      or type(frame.w) ~= "number"
      or type(frame.h) ~= "number"
      or frame.w <= 0
      or frame.h <= 0
    then
      return nil
    end
    return frame
  end

  local function chromeTabCount(window)
    local root = window and hs.axuielement.windowElement(window) or nil
    local visited = {}
    local count = 0

    local function countTabs(element, depth)
      if type(element) ~= "userdata" or visited[element] or depth > 20 then
        return
      end
      visited[element] = true

      local role = element:attributeValue("AXRole")
      if role == "AXWebArea" then
        return
      end
      if role == "AXRadioButton" and element:attributeValue("AXSubrole") == "AXTabButton" then
        count = count + 1
        return
      end
      for _, child in ipairs(element:attributeValue("AXChildren") or {}) do
        countTabs(child, depth + 1)
      end
    end

    if not root then
      return nil
    end
    countTabs(root, 0)
    return count > 0 and count or nil
  end

  local function pointIsInsideFrame(point, frame)
    return point
      and point.x >= frame.x
      and point.x <= frame.x + frame.w
      and point.y >= frame.y
      and point.y <= frame.y + frame.h
  end

  local function finishCreatedWindowClose(windowId, attempt)
    attempt = attempt or 0
    local recovery = createdWindowCloseRecovery[windowId]
    local targetWindow = hs.window.get(windowId)
    local restoreWindow = recoveryWindow(recovery, false)
    if not recovery or not targetWindow then
      return
    end
    if not restoreWindow then
      recovery.closing = false
      log.wf("Prior non-Chrome window became unavailable before closing created Chrome window %d", windowId)
      targetWindow:close()
      return
    end

    local focusedWindow = hs.window.focusedWindow()
    if focusedWindow and focusedWindow:id() == restoreWindow:id() then
      if targetWindow:close() == false then
        recovery.closing = false
        log.wf("Could not close created Chrome window %d after restoring prior focus", windowId)
      end
      return
    end

    if attempt * CREATED_WINDOW_CLOSE_RETRY_INTERVAL_SECONDS
      >= CREATED_WINDOW_CLOSE_FOCUS_TIMEOUT_SECONDS
    then
      recovery.closing = false
      log.wf("Timed out restoring prior focus before closing created Chrome window %d", windowId)
      targetWindow:close()
      return
    end

    later(CREATED_WINDOW_CLOSE_RETRY_INTERVAL_SECONDS, function()
      finishCreatedWindowClose(windowId, attempt + 1)
    end, false)
  end

  local function beginCreatedWindowClose(window, recovery)
    if recovery.closing then
      return true
    end

    local excludedWindowId = recovery.screenUuid == recovery.targetScreenUuid and window:id() or nil
    local restoreWindow = recoveryWindow(recovery, true, excludedWindowId)
    if not restoreWindow then
      return false
    end

    recovery.closing = true
    if restoreWindow:focus() == false then
      recovery.closing = false
      return false
    end
    later(CREATED_WINDOW_CLOSE_RETRY_INTERVAL_SECONDS, function()
      finishCreatedWindowClose(window:id(), 0)
    end, false)
    return true
  end

  local function focusedCreatedWindowCloseRecovery()
    local window = hs.window.focusedWindow()
    local windowId = window and window:id() or nil
    local application = window and window:application() or nil
    local recovery = windowId and createdWindowCloseRecovery[windowId] or nil
    if not recovery
      or not application
      or application:bundleID() ~= chromeBundleId
      or screenUuid(window:screen()) ~= recovery.targetScreenUuid
    then
      return nil, nil
    end
    return window, recovery
  end

  local function shouldInterceptKeyboardClose(event, window)
    if event:getKeyCode() ~= hs.keycodes.map.w then
      return false
    end
    local flags = event:getFlags()
    if not flags.cmd or flags.alt or flags.ctrl then
      return false
    end
    if flags.shift then
      return true
    end
    return chromeTabCount(window) == 1
  end

  local function handleCreatedWindowCloseGesture(event)
    local eventType = event:getType()
    if eventType == hs.eventtap.event.types.leftMouseUp and suppressCloseMouseUp then
      suppressCloseMouseUp = false
      return true
    end
    if next(createdWindowCloseRecovery) == nil then
      return false
    end

    local window, recovery = focusedCreatedWindowCloseRecovery()
    if not window then
      return false
    end

    if eventType == hs.eventtap.event.types.keyDown then
      if shouldInterceptKeyboardClose(event, window) then
        return beginCreatedWindowClose(window, recovery)
      end
      return false
    end

    if eventType ~= hs.eventtap.event.types.leftMouseDown then
      return false
    end
    local closeButtonFrame = createdWindowCloseButtonFrame(window)
    if not closeButtonFrame or not pointIsInsideFrame(event:location(), closeButtonFrame) then
      return false
    end

    local intercepted = beginCreatedWindowClose(window, recovery)
    if intercepted then
      suppressCloseMouseUp = true
    end
    return intercepted
  end


  local function openTabOutTabInFrontWindow(kind, window)
    local url = NEW_TAB_URL
    local urlError
    if kind == "filter" then
      url, urlError = catalog:filterFocusUrl()
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
      or application:bundleID() ~= chromeBundleId
    then
      onFailure("The Chrome window is no longer available")
      return
    end

    local control = destinationControl(kind, window)
    if control then
      onReady(control)
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
      and frontmostApplication:bundleID() == chromeBundleId
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

  local function focusDestinationControl(kind, window, control)
    control = control or destinationControl(kind, window)
    if not control then
      return false, "Chrome's destination control is unavailable"
    end

    local focused = control:setAttributeValue("AXFocused", true)
    if not focused or control:attributeValue("AXFocused") ~= true then
      return false, "Chrome's destination control could not be focused"
    end

    return true
  end

  local function focusWindowPrivately(window, expectedProfileDirectory)
    local windowId = window and window:id() or nil
    local application = window and window:application() or nil
    local processId = application and application:pid() or nil
    local request = currentRequest()
    if not windowId
      or not application
      or application:bundleID() ~= chromeBundleId
      or type(processId) ~= "number"
    then
      return false, "The exact Chrome window identity is unavailable"
    end

    local windowSpaces = hs.spaces.windowSpaces(window)
    if not request
      or screenUuid(window:screen()) ~= request.screenUuid
      or not windowSpaces
      or not containsValue(windowSpaces, request.targetSpaceId)
      or (expectedProfileDirectory or catalog:profileFor(windowId))
        ~= configuredProfileDirectory
    then
      return false, "The Chrome window no longer matches the target display, Desktop, and profile"
    end

    if not privateFocus then
      return false, privateFocusError or "The private focus helper is unavailable"
    end

    local called, focused, focusError = pcall(privateFocus.focus, processId, windowId)
    if not called then
      return false, focused
    end
    if not focused then
      return false, focusError or "The private focus helper rejected the target window"
    end

    if expectedProfileDirectory then
      catalog:confirm(windowId, expectedProfileDirectory)
    end

    return true
  end

  local function finishDestinationControlFocus(kind, window, control)
    local controlFocused, controlError = focusDestinationControl(kind, window, control)
    if not controlFocused then
      fail("The Tab Out destination could not receive keyboard focus", controlError)
      return
    end

    log.df("Privately focused exact Chrome window %d", window:id())
    finish()
  end

  local function privatelyActivateWindow(window, onActivated, expectedProfileDirectory)
    local focused, focusError = focusWindowPrivately(window, expectedProfileDirectory)
    if not focused then
      fail("The Tab Out window could not be focused privately", focusError)
      return
    end

    waitForTargetWindowFocus(window, onActivated, function(activationError)
      fail("The Tab Out window did not become keyboard-active", activationError)
    end)
  end

  -- Native Placement Bridge windows already contain their destination and are
  -- created inactive at final target bounds. The target-display snapshot stays
  -- above the inactive window until private activation and destination focus
  -- complete, so the created window is first exposed in its final frontmost state.
  local function finishExtensionWindowActivation(kind, window)
    privatelyActivateWindow(window, function()
      waitForDestinationControl(kind, window, function(control)
        finishDestinationControlFocus(kind, window, control)
      end, function(controlError)
        fail("The Tab Out destination did not become ready", controlError)
      end)
    end, configuredProfileDirectory)
  end

  local function activateExistingWindow(kind, window)
    privatelyActivateWindow(window, function()
      local opened, openError = openTabOutTabInFrontWindow(kind, window)
      if not opened then
        fail("Chrome could not open the Tab Out page", openError)
        return
      end

      log.df("Opened the %s destination in the privately selected Chrome window", kind)
      waitForDestinationControl(kind, window, function(control)
        finishDestinationControlFocus(kind, window, control)
      end, function(controlError)
        fail("The Tab Out destination did not become ready", controlError)
      end)
    end)
  end

  local function clearCreatedWindowCloseRecovery(windowId, expectedRecovery)
    local recovery = createdWindowCloseRecovery[windowId]
    if not recovery or (expectedRecovery and recovery ~= expectedRecovery) then
      return nil
    end

    createdWindowCloseRecovery[windowId] = nil
    if recovery.monitor then
      recovery.monitor:stop()
      recovery.monitor = nil
    end
    return recovery
  end

  local function repairCreatedWindowCloseFallback(recovery, closedWindowId, deadline)
    local restoreWindow = recoveryWindow(recovery, false)
    if not restoreWindow then
      return
    end

    local focusedWindow = hs.window.focusedWindow()
    local frontmostApplication = hs.application.frontmostApplication()
    local focusedApplication = focusedWindow and focusedWindow:application() or nil
    if focusedWindow and focusedWindow:id() == restoreWindow:id() then
      return
    end

    if frontmostApplication
      and frontmostApplication:bundleID() == chromeBundleId
      and focusedApplication
      and focusedApplication:bundleID() == chromeBundleId
      and focusedWindow:id() ~= closedWindowId
    then
      restoreWindow:focus()
      return
    end

    if frontmostApplication
      and frontmostApplication:bundleID() ~= chromeBundleId
    then
      return
    end

    deadline = deadline
      or (hs.timer.secondsSinceEpoch() + CREATED_WINDOW_CLOSE_FOCUS_TIMEOUT_SECONDS)
    if hs.timer.secondsSinceEpoch() >= deadline then
      return
    end
    later(CREATED_WINDOW_CLOSE_RETRY_INTERVAL_SECONDS, function()
      repairCreatedWindowCloseFallback(recovery, closedWindowId, deadline)
    end, false)
  end

  local function monitorCreatedWindowClose(windowId, recovery)
    recovery.monitor = hs.timer.waitUntil(function()
      return createdWindowCloseRecovery[windowId] ~= recovery
        or hs.window.get(windowId) == nil
    end, function()
      if createdWindowCloseRecovery[windowId] ~= recovery then
        return
      end
      recovery.monitor = nil
      createdWindowCloseRecovery[windowId] = nil
      repairCreatedWindowCloseFallback(recovery, windowId)
    end, CREATED_WINDOW_CLOSE_MONITOR_INTERVAL_SECONDS)
  end

  local function registerCreatedWindowCloseRecovery(request, window)
    local windowId = window and window:id() or nil
    if not windowId
      or not request.focusedWindowId
      or not request.focusedWindowBundleId
      or not request.focusedWindowScreenUuid
      or request.focusedWindowBundleId == chromeBundleId
    then
      return
    end

    local recovery = {
      bundleId = request.focusedWindowBundleId,
      closing = false,
      screenUuid = request.focusedWindowScreenUuid,
      targetScreenUuid = request.screenUuid,
      windowId = request.focusedWindowId,
    }
    local excludedWindowId = recovery.screenUuid == recovery.targetScreenUuid and windowId or nil
    if recoveryWindow(recovery, true, excludedWindowId) then
      createdWindowCloseRecovery[windowId] = recovery
      monitorCreatedWindowClose(windowId, recovery)
    end
  end


  function transition:captureShield(screen)
    return captureTransitionShield(screen)
  end

  function transition:releaseShield()
    releaseTransitionShield()
  end

  function transition:activateCreated(kind, window)
    finishExtensionWindowActivation(kind, window)
  end

  function transition:activateExisting(kind, window)
    activateExistingWindow(kind, window)
  end

  function transition:registerCreatedWindow(request, window)
    registerCreatedWindowCloseRecovery(request, window)
  end

  function transition:handleWindowDestroyed(window)
    local id = window and window:id() or nil
    if not id then
      return
    end

    local recovery = clearCreatedWindowCloseRecovery(id)
    if recovery then
      repairCreatedWindowCloseFallback(recovery, id)
    end
  end

  function transition:handleCloseGesture(event)
    return handleCreatedWindowCloseGesture(event)
  end

  function transition:start()
    closeGestureTap = hs.eventtap.new({
      hs.eventtap.event.types.keyDown,
      hs.eventtap.event.types.leftMouseDown,
      hs.eventtap.event.types.leftMouseUp,
    }, function(event)
      local ok, intercepted = xpcall(function()
        return handleCreatedWindowCloseGesture(event)
      end, debug.traceback)
      if not ok then
        log.ef("Created-window close handling failed: %s", intercepted)
        return false
      end
      return intercepted == true
    end):start()
    return transition
  end

  function transition:stop()
    if closeGestureTap then
      closeGestureTap:stop()
      closeGestureTap = nil
    end
    releaseTransitionShield()
  end

  return transition
end

return M
