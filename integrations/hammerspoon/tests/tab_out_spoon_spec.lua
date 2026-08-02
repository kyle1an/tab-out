local function assertEqual(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s (expected %s, got %s)", message, tostring(expected), tostring(actual)), 2)
  end
end

local function currentDirectory()
  local source = debug.getinfo(1, "S").source
  return source:sub(1, 1) == "@" and source:sub(2):match("^(.*)/[^/]+$") or "."
end

local modulePath = currentDirectory() .. "/../TabOut.spoon/init.lua"

local function runShortcut(kind, options)
  options = options or {}
  local targetHasChromeWindow = options.targetHasChromeWindow ~= false
  local otherHasChromeWindow = options.otherHasChromeWindow ~= false
  local chromeIsRunning = options.chromeIsRunning ~= false
  local cacheTargetProfile = options.cacheTargetProfile ~= false
  local targetProfileDirectory = options.targetProfileDirectory or "Profile 3"
  local targetHasInactiveSpaceChromeWindow = options.targetHasInactiveSpaceChromeWindow == true
  local targetDisplayPosition = options.targetDisplayPosition or 2
  local privateFocusAvailable = options.privateFocusAvailable ~= false
  local clock = 0
  local addressBarFocused = false
  local activationClickCount = 0
  local closeGestureCallback
  local closeGestureConsumed = false
  local closeMouseUpConsumed = false
  local createdWindowNativeTabCloseAllowed = false
  local createdWindowClosed = false
  local filterInputFocused = false
  local nativeBridgeRequest
  local extensionWindowFocusRequested = false
  local privateFocusCount = 0
  local createdChromeWindow
  local createdDestinationReadBeforePrivateFocus = false
  local destinationChildrenReadCount = 0
  local destinationWindowElementReadCount = 0
  local remoteDestinationFocusCount = 0
  local remoteTopHidden = false
  local createdWindowInitiallyMinimized = false
  local createdWindowRevealedByPrivateFocus = false
  local createdWindowSetFrameCount = 0
  local transitionShieldCreatedCount = 0
  local transitionShieldDeletedCount = 0
  local transitionShieldVisible = false
  local transitionShieldVisibleAtPrivateFocus = false
  local failureAlert
  local focusedWindow
  local frontmostApplication
  local focusCountByWindowId = {}
  local navigationObservedPrivateFocus = false
  local navigationUsesFrontWindow = false
  local otherChromeFocused = false
  local otherChromeReceivedFocus = false
  local otherChromeRaised = false
  local openedFilter = false
  local openedNewPage = false
  local orderedWindowsCallCount = 0
  local pendingTimers = {}
  local securePreferencesReadCount = 0
  local windowCreatedCallback
  local windowDestroyedCallback

  local function newWatcher()
    return {
      start = function(self)
        return self
      end,
    }
  end

  local targetScreen = {
    frame = function()
      return { h = 900, w = 1440, x = (targetDisplayPosition - 1) * 1440, y = 0 }
    end,
    fullFrame = function()
      return { h = 900, w = 1440, x = (targetDisplayPosition - 1) * 1440, y = 0 }
    end,
    getUUID = function()
      return "target-screen"
    end,
    snapshot = function()
      return { name = "target-screen-snapshot" }
    end,
  }
  local otherScreen = {
    frame = function()
      return { h = 900, w = 1440, x = targetDisplayPosition == 1 and 1440 or 0, y = 0 }
    end,
    getUUID = function()
      return "other-screen"
    end,
  }
  local thirdScreen = {
    frame = function()
      return { h = 900, w = 1440, x = targetDisplayPosition == 3 and 1440 or 2880, y = 0 }
    end,
    fullFrame = function()
      return { h = 900, w = 1440, x = targetDisplayPosition == 3 and 1440 or 2880, y = 0 }
    end,
    getUUID = function()
      return "third-screen"
    end,
  }

  local chromeApplication = {
    bundleID = function()
      return "com.google.Chrome"
    end,
    getMenuItems = function(_, callback)
      callback({
        {
          AXMenuItemMarkChar = "check",
          AXTitle = targetProfileDirectory == "Profile 8" and "Alternate Profile" or "Target Profile",
        },
      })
    end,
    isHidden = function()
      return false
    end,
    pid = function()
      return 43250
    end,
  }

  local function newChromeWindow(id, screen, isOtherWindow, initiallyMinimized)
    local currentFrame = screen:frame()
    local minimized = initiallyMinimized == true
    local window = {
      application = function()
        return chromeApplication
      end,
      focus = function(self)
        focusCountByWindowId[id] = (focusCountByWindowId[id] or 0) + 1
        if isOtherWindow then
          otherChromeFocused = true
          otherChromeReceivedFocus = true
          otherChromeRaised = true
        else
          otherChromeFocused = false
        end
        focusedWindow = self
        return true
      end,
      frame = function()
        return currentFrame
      end,
      id = function()
        return id
      end,
      isMinimized = function()
        return minimized
      end,
      isStandard = function()
        return true
      end,
      raise = function(self)
        if isOtherWindow then
          otherChromeFocused = true
          otherChromeRaised = true
        end
        focusedWindow = self
        return true
      end,
      screen = function()
        return screen
      end,
      setFrame = function(_, frame)
        if id == 404 then
          createdWindowSetFrameCount = createdWindowSetFrameCount + 1
        end
        currentFrame = frame
      end,
      setMinimized = function(_, value)
        minimized = value == true
      end,
    }
    return window
  end

  local targetChromeWindow = newChromeWindow(101, targetScreen)
  local inactiveSpaceChromeWindow = newChromeWindow(102, targetScreen)
  local otherChromeWindow = newChromeWindow(202, otherScreen, true)
  local remoteTopApplication = {
    bundleID = function()
      return "com.example.Editor"
    end,
    isHidden = function()
      return remoteTopHidden
    end,
  }
  local remoteTopWindow = {
    application = function()
      return remoteTopApplication
    end,
    focus = function(self)
      otherChromeFocused = false
      otherChromeRaised = false
      frontmostApplication = remoteTopApplication
      focusedWindow = self
      if options.invalidateCloseRecoveryAfterFocus then
        remoteTopHidden = true
      end
      return true
    end,
    id = function()
      return 303
    end,
    isMinimized = function()
      return false
    end,
    isStandard = function()
      return true
    end,
    raise = function()
      otherChromeRaised = false
      return true
    end,
    screen = function()
      return otherScreen
    end,
  }
  frontmostApplication = remoteTopApplication
  local originalWindow = {
    application = function()
      return remoteTopApplication
    end,
    id = function()
      return 304
    end,
    screen = function()
      return targetScreen
    end,
  }
  focusedWindow = targetHasChromeWindow and cacheTargetProfile and targetChromeWindow
    or (not targetHasChromeWindow and otherHasChromeWindow and chromeIsRunning and otherChromeWindow)
    or originalWindow

  local function currentChromeWindows()
    local windows = {}
    if not chromeIsRunning then
      return windows
    end
    if createdChromeWindow then
      table.insert(windows, createdChromeWindow)
    end
    if targetHasChromeWindow then
      table.insert(windows, targetChromeWindow)
    end
    if targetHasInactiveSpaceChromeWindow then
      table.insert(windows, inactiveSpaceChromeWindow)
    end
    if otherHasChromeWindow then
      table.insert(windows, otherChromeWindow)
    end
    return windows
  end

  local function currentOrderedWindows()
    local windows = {}
    if createdChromeWindow and not createdChromeWindow:isMinimized() then
      table.insert(windows, createdChromeWindow)
    end
    if targetHasChromeWindow then
      table.insert(windows, targetChromeWindow)
    end
    if not chromeIsRunning or not otherHasChromeWindow then
      table.insert(windows, remoteTopWindow)
    elseif otherChromeRaised then
      table.insert(windows, otherChromeWindow)
      table.insert(windows, remoteTopWindow)
    else
      table.insert(windows, remoteTopWindow)
      table.insert(windows, otherChromeWindow)
    end
    return windows
  end

  chromeApplication.allWindows = function()
    return currentChromeWindows()
  end

  local axRoot
  local addressBar = {
    attributeValue = function(_, attribute)
      if attribute == "AXRole" then
        return "AXTextField"
      end
      if attribute == "AXDescription" then
        return "Address and search bar"
      elseif attribute == "AXFocused" then
        return addressBarFocused
          or (createdChromeWindow ~= nil and privateFocusCount > 0 and kind == "newPage")
      elseif attribute == "AXWindow" then
        return axRoot
      end
      return nil
    end,
    setAttributeValue = function(_, attribute, value)
      if attribute == "AXFocused" and value == true then
        addressBarFocused = true
        return true
      end
      return false
    end,
  }
  local filterInput = {
    attributeValue = function(_, attribute)
      if attribute == "AXRole" then
        return "AXTextField"
      elseif attribute == "AXDescription" then
        return "Filter tabs, bookmarks, history…"
      elseif attribute == "AXFocused" then
        return filterInputFocused
          or (createdChromeWindow ~= nil and privateFocusCount > 0 and kind == "filter")
      elseif attribute == "AXWindow" then
        return axRoot
      elseif attribute == "AXChildren" then
        return {}
      end
      return nil
    end,
    setAttributeValue = function(_, attribute, value)
      if attribute == "AXFocused" and value == true then
        filterInputFocused = true
        return true
      end
      return false
    end,
  }
  local closeButton = {
    attributeValue = function(_, attribute)
      if attribute == "AXFrame" then
        return { h = 16, w = 16, x = targetScreen:frame().x + 12, y = 46 }
      elseif attribute == "AXRole" then
        return "AXButton"
      end
      return nil
    end,
  }
  local tabButton = {
    attributeValue = function(_, attribute)
      if attribute == "AXRole" then
        return "AXRadioButton"
      elseif attribute == "AXSubrole" then
        return "AXTabButton"
      elseif attribute == "AXChildren" then
        return {}
      end
      return nil
    end,
  }
  local secondTabButton = options.createdTabCount == 2 and {
    attributeValue = tabButton.attributeValue,
  } or nil
  axRoot = {
    attributeValue = function(_, attribute)
      if attribute == "AXRole" then
        return "AXWindow"
      end
      if attribute == "AXChildren" then
        destinationChildrenReadCount = destinationChildrenReadCount + 1
        if createdChromeWindow and privateFocusCount == 0 then
          createdDestinationReadBeforePrivateFocus = true
        end
        local children = { filterInput, addressBar, tabButton }
        if secondTabButton then
          table.insert(children, secondTabButton)
        end
        return children
      elseif attribute == "AXCloseButton" then
        return closeButton
      end
      return nil
    end,
  }
  local remoteAxRoot = {}
  local remoteDestinationControl = {
    attributeValue = function(_, attribute)
      if attribute == "AXRole" then
        return "AXTextField"
      elseif attribute == "AXDescription" then
        return kind == "filter" and "Filter tabs, bookmarks, history…" or "Address and search bar"
      elseif attribute == "AXFocused" then
        return true
      elseif attribute == "AXWindow" then
        return remoteAxRoot
      end
      return nil
    end,
    setAttributeValue = function(_, attribute, value)
      if attribute == "AXFocused" and value == true then
        remoteDestinationFocusCount = remoteDestinationFocusCount + 1
        return true
      end
      return false
    end,
  }
  local systemWideElement = {
    attributeValue = function(_, attribute)
      if attribute ~= "AXFocusedUIElement" or privateFocusCount == 0 or not createdChromeWindow then
        return nil
      end
      if options.focusedDestinationOwnerMismatch then
        return remoteDestinationControl
      end
      return kind == "filter" and filterInput or addressBar
    end,
  }
  local fakeAxElements = {
    [addressBar] = true,
    [axRoot] = true,
    [closeButton] = true,
    [filterInput] = true,
    [remoteAxRoot] = true,
    [remoteDestinationControl] = true,
    [systemWideElement] = true,
    [tabButton] = true,
  }
  if secondTabButton then
    fakeAxElements[secondTabButton] = true
  end

  local fakeHs = {
    accessibilityState = function()
      return true
    end,
    alert = {
      show = function(message)
        failureAlert = message
      end,
    },
    application = {
      frontmostApplication = function()
        return frontmostApplication
      end,
      get = function(bundleId)
        if bundleId == "com.google.Chrome" and chromeIsRunning then
          return chromeApplication
        end
        return nil
      end,
    },
    autoLaunch = function()
      return true
    end,
    canvas = {
      new = function(frame)
        assertEqual(frame.x, targetScreen:fullFrame().x, "transition shield target left")
        assertEqual(frame.y, targetScreen:fullFrame().y, "transition shield target top")
        transitionShieldCreatedCount = transitionShieldCreatedCount + 1
        local shield = {}
        function shield:bringToFront()
          return self
        end
        function shield:canvasMouseEvents()
          return self
        end
        function shield:delete()
          transitionShieldDeletedCount = transitionShieldDeletedCount + 1
          transitionShieldVisible = false
        end
        function shield:show()
          transitionShieldVisible = true
          return self
        end
        return shield
      end,
    },
    axuielement = {
      systemWideElement = function()
        return systemWideElement
      end,
      windowElement = function()
        destinationWindowElementReadCount = destinationWindowElementReadCount + 1
        return axRoot
      end,
    },
    eventtap = {
      event = {
        types = {
          keyDown = "keyDown",
          leftMouseDown = "leftMouseDown",
          leftMouseUp = "leftMouseUp",
        },
      },
      leftClick = function()
        activationClickCount = activationClickCount + 1
        frontmostApplication = chromeApplication
        local targetWindow = createdChromeWindow or targetChromeWindow
        targetWindow:focus()
      end,
      new = function(_, callback)
        closeGestureCallback = callback
        return {
          start = function(self)
            return self
          end,
          stop = function() end,
        }
      end,
    },
    hotkey = {
      bind = function()
        return {}
      end,
    },
    json = {
      read = function(path)
        if path:match("/Local State$") then
          return {
            profile = {
              info_cache = {
                ["Profile 3"] = { name = "Target Profile" },
                ["Profile 8"] = { name = "Alternate Profile" },
              },
            },
          }
        end

        if path:match("/Secure Preferences$") then
          securePreferencesReadCount = securePreferencesReadCount + 1
          return {
            extensions = {
              settings = {
                [string.rep("a", 32)] = {
                  commands = {
                    ["open-filter-tab"] = {},
                    ["open-new-tab"] = {},
                  },
                },
              },
            },
          }
        end

        return nil
      end,
    },
    keycodes = {
      map = { w = 13 },
    },
    logger = {
      new = function()
        local function ignore() end
        return {
          d = ignore,
          df = ignore,
          e = ignore,
          ef = ignore,
          i = ignore,
          w = ignore,
          wf = ignore,
        }
      end,
    },
    mouse = {
      getCurrentScreen = function()
        return targetScreen
      end,
    },
    osascript = {
      applescript = function(script)
        local focusesFilter = script:find("focusFilter=1", 1, true) ~= nil
        local focusesWindow = script:find("focusWindow=1", 1, true) ~= nil
        local opensNewPage = script:find("chrome://newtab/", 1, true) ~= nil
        navigationObservedPrivateFocus = privateFocusCount > 0 and focusedWindow == targetChromeWindow
        navigationUsesFrontWindow = script:find("set candidateWindow to front window", 1, true) ~= nil
        openedFilter = focusesFilter
        openedNewPage = opensNewPage
        if focusesWindow then
          extensionWindowFocusRequested = true
          if focusesFilter then
            openedFilter = true
          else
            openedNewPage = true
          end
          local requestedWindow = createdChromeWindow or targetChromeWindow
          requestedWindow:focus()
        end
        if script:match("%f[%a]activate%f[%A]") then
          otherChromeRaised = true
        end
        return true
      end,
    },
    screen = {
      allScreens = function()
        if options.screenCount == 1 then
          return { targetScreen }
        elseif options.screenCount == 3 then
          return { otherScreen, thirdScreen, targetScreen }
        end
        return { targetScreen, otherScreen }
      end,
      mainScreen = function()
        return targetScreen
      end,
      watcher = {
        new = newWatcher,
      },
    },
    screenRecordingState = function()
      return options.screenRecordingAvailable ~= false
    end,
    settings = {
      get = function()
        return nil
      end,
      set = function() end,
    },
    spaces = {
      activeSpaceOnScreen = function(screen)
        return screen == targetScreen and 11 or 22
      end,
      spaceType = function()
        return "user"
      end,
      spacesForScreen = function(screen)
        return screen == targetScreen and { 11 } or { 22 }
      end,
      watcher = {
        new = newWatcher,
      },
      windowSpaces = function(window)
        if window == inactiveSpaceChromeWindow then
          return { 33 }
        end
        return (window == targetChromeWindow or window == createdChromeWindow) and { 11 } or { 22 }
      end,
    },
    timer = {
      doEvery = function(delay, callback)
        local timer = {
          callback = callback,
          due = clock + delay,
          interval = delay,
          repeating = true,
          stopped = false,
        }
        function timer:stop()
          self.stopped = true
        end
        table.insert(pendingTimers, timer)
        return timer
      end,
      doAfter = function(delay, callback)
        local timer = {
          callback = callback,
          due = clock + delay,
          stopped = false,
        }
        function timer:stop()
          self.stopped = true
        end
        table.insert(pendingTimers, timer)
        return timer
      end,
      secondsSinceEpoch = function()
        return 1800000000 + clock
      end,
    },
    window = {
      filter = {
        new = function()
          return {
            getWindows = function()
              return currentChromeWindows()
            end,
            subscribe = function(_, event, callback, immediate)
              if event == "windowCreated" then
                windowCreatedCallback = callback
              elseif event == "windowDestroyed" then
                windowDestroyedCallback = callback
              elseif event == "windowFocused" then
                if immediate and (focusedWindow == otherChromeWindow or focusedWindow == targetChromeWindow) then
                  callback(focusedWindow)
                end
              end
            end,
          }
        end,
        windowCreated = "windowCreated",
        windowDestroyed = "windowDestroyed",
        windowFocused = "windowFocused",
      },
      focusedWindow = function()
        return focusedWindow
      end,
      get = function(windowId)
        for _, window in ipairs({
          createdChromeWindow,
          targetChromeWindow,
          inactiveSpaceChromeWindow,
          otherChromeWindow,
          remoteTopWindow,
          originalWindow,
        }) do
          if window and window:id() == windowId then
            return window
          end
        end
        return nil
      end,
      orderedWindows = function()
        orderedWindowsCallCount = orderedWindowsCallCount + 1
        return currentOrderedWindows()
      end,
    },
  }

  local function runPendingTimers()
    while true do
      local nextIndex
      local nextTimer
      for index, timer in ipairs(pendingTimers) do
        if not timer.stopped and (not nextTimer or timer.due < nextTimer.due) then
          nextIndex = index
          nextTimer = timer
        end
      end

      if not nextTimer then
        break
      end

      table.remove(pendingTimers, nextIndex)
      clock = nextTimer.due
      nextTimer.callback()
      if nextTimer.repeating and not nextTimer.stopped then
        nextTimer.due = clock + nextTimer.interval
        table.insert(pendingTimers, nextTimer)
      end
    end
  end

  local environment = setmetatable({
    hs = fakeHs,
    type = function(value)
      return fakeAxElements[value] and "userdata" or _G.type(value)
    end,
  }, { __index = _G })
  local chunk, loadError = loadfile(modulePath, "t", environment)
  assert(chunk, loadError)
  local tabOut = chunk()
  assertEqual(tabOut.name, "Tab Out", "Spoon should expose its public name")
  assertEqual(type(tabOut.start), "function", "Spoon should expose its start interface")
  local privateFocus = {
    capability = function()
      if not privateFocusAvailable then
        return nil, "unsupported macOS build"
      end
      return true
    end,
    focus = function(pid, windowId)
      assertEqual(pid, 43250, "private focus Chrome process ID")
      local targetWindow = createdChromeWindow or targetChromeWindow
      assertEqual(windowId, targetWindow:id(), "private focus exact target window ID")
      privateFocusCount = privateFocusCount + 1
      transitionShieldVisibleAtPrivateFocus = transitionShieldVisible
      if options.privateFocusSucceeds == false then
        return nil, "mock private focus failure"
      end
      if targetWindow == createdChromeWindow and targetWindow:isMinimized() then
        createdWindowRevealedByPrivateFocus = true
        targetWindow:setMinimized(false)
      end
      frontmostApplication = chromeApplication
      focusedWindow = targetWindow
      return true
    end,
  }
  local nativeBridge = {
    isReady = function()
      return options.nativeBridgeStarts ~= false
    end,
    createWindow = function(_, createOptions, callback)
      if options.nativeBridgeStarts == false then
        return false, "native bridge unavailable"
      end

      nativeBridgeRequest = createOptions
      assertEqual(createOptions.operation, kind, "Native Placement Bridge operation")
      assertEqual(createOptions.targetBounds.left, targetScreen:fullFrame().x, "Native Placement Bridge target left")
      assertEqual(createOptions.targetBounds.top, targetScreen:fullFrame().y, "Native Placement Bridge target top")
      assertEqual(createOptions.targetBounds.width, targetScreen:fullFrame().w, "Native Placement Bridge target width")
      assertEqual(createOptions.targetBounds.height, targetScreen:fullFrame().h, "Native Placement Bridge target height")
      assertEqual(createOptions.timeoutSeconds, 12, "Native Placement Bridge timeout budget")

      if kind == "filter" then
        openedFilter = true
      else
        openedNewPage = true
      end
      createdChromeWindow = newChromeWindow(404, targetScreen, false, false)
      function createdChromeWindow:close()
        local closingWindow = self
        if focusedWindow == closingWindow and otherHasChromeWindow then
          frontmostApplication = chromeApplication
          otherChromeWindow:focus()
        end
        createdChromeWindow = nil
        createdWindowClosed = true
        if windowDestroyedCallback then
          windowDestroyedCallback(closingWindow)
        end
        return true
      end
      createdWindowInitiallyMinimized = createdChromeWindow:isMinimized()
      if windowCreatedCallback then
        windowCreatedCallback(createdChromeWindow)
      end
      callback(true)
      return true
    end,
    status = function()
      return {
        connected = nativeBridgeRequest ~= nil and options.nativeBridgeStarts ~= false,
        hostInstalled = options.nativeBridgeStarts ~= false,
        version = 1,
      }
    end,
  }

  tabOut:start({
    chromeProfileDirectory = "Profile 3",
    nativeBridge = nativeBridge,
    privateFocus = privateFocus,
    shortcuts = {
      filter = { key = "k", modifiers = { "cmd", "shift" } },
      newPage = { key = "space", modifiers = { "cmd", "shift" } },
    },
  })

  runPendingTimers()
  focusedWindow = options.sourceWindowOnRemote and remoteTopWindow or originalWindow
  frontmostApplication = remoteTopApplication
  otherChromeFocused = false
  otherChromeReceivedFocus = false
  otherChromeRaised = false

  if kind == "filter" then
    tabOut.openFilter()
  else
    tabOut.openNewPage()
  end

  runPendingTimers()

  if options.closeCreatedWindowAfterShortcut and createdChromeWindow then
    local closeGesture = options.closeCreatedWindowAfterShortcut == true
        and "mouse"
      or options.closeCreatedWindowAfterShortcut
    local closeFrame = closeButton:attributeValue("AXFrame")
    local event = {
      getFlags = function()
        if closeGesture == "windowShortcut" then
          return { cmd = true, shift = true }
        elseif closeGesture == "tabShortcut" then
          return { cmd = true }
        end
        return {}
      end,
      getKeyCode = function()
        return closeGesture == "mouse" and -1 or 13
      end,
      getType = function()
        return closeGesture == "mouse" and "leftMouseDown" or "keyDown"
      end,
      location = function()
        return {
          x = closeFrame.x + closeFrame.w / 2,
          y = closeFrame.y + closeFrame.h / 2,
        }
      end,
    }
    closeGestureConsumed = closeGestureCallback and closeGestureCallback(event) == true or false
    if closeGesture == "mouse" and closeGestureConsumed then
      closeMouseUpConsumed = closeGestureCallback({
        getType = function()
          return "leftMouseUp"
        end,
      }) == true
    end
    if not closeGestureConsumed and createdChromeWindow then
      if closeGesture == "tabShortcut" and options.createdTabCount == 2 then
        createdWindowNativeTabCloseAllowed = true
      else
        createdChromeWindow:close()
      end
    end
    runPendingTimers()
  end

  local diagnostics = tabOut.status()

  return {
    activationClickCount = activationClickCount,
    addressBarFocused = addressBarFocused,
    closeGestureConsumed = closeGestureConsumed,
    closeMouseUpConsumed = closeMouseUpConsumed,
    createdWindow = createdChromeWindow ~= nil,
    createdWindowClosed = createdWindowClosed,
    createdWindowNativeTabCloseAllowed = createdWindowNativeTabCloseAllowed,
    createdDestinationReadBeforePrivateFocus = createdDestinationReadBeforePrivateFocus,
    createdWindowInitiallyMinimized = createdWindowInitiallyMinimized,
    createdWindowRevealedByPrivateFocus = createdWindowRevealedByPrivateFocus,
    createdWindowSetFrameCount = createdWindowSetFrameCount,
    destinationChildrenReadCount = destinationChildrenReadCount,
    destinationWindowElementReadCount = destinationWindowElementReadCount,
    extensionWindowFocusRequested = extensionWindowFocusRequested,
    failureAlert = failureAlert,
    filterInputFocused = filterInputFocused,
    existingTargetFocusCount = focusCountByWindowId[targetChromeWindow:id()] or 0,
    nativeBridgeRequest = nativeBridgeRequest,
    nativeBridgeInstalled = diagnostics.nativeBridgeInstalled,
    nativeBridgeReady = diagnostics.nativeBridgeReady,
    navigationObservedPrivateFocus = navigationObservedPrivateFocus,
    navigationUsesFrontWindow = navigationUsesFrontWindow,
    openedFilter = openedFilter,
    openedNewPage = openedNewPage,
    orderedWindowsCallCount = orderedWindowsCallCount,
    otherChromeFocused = otherChromeFocused,
    otherChromeReceivedFocus = otherChromeReceivedFocus,
    otherChromeRaised = otherChromeRaised,
    privateFocusCount = privateFocusCount,
    remoteDestinationFocusCount = remoteDestinationFocusCount,
    remoteTopFocused = focusedWindow == remoteTopWindow,
    securePreferencesReadCount = securePreferencesReadCount,
    targetFocused = focusedWindow == (createdChromeWindow or targetChromeWindow),
    targetAppActive = frontmostApplication == chromeApplication,
    transitionShieldCreatedCount = transitionShieldCreatedCount,
    transitionShieldDeletedCount = transitionShieldDeletedCount,
    transitionShieldVisibleAtPrivateFocus = transitionShieldVisibleAtPrivateFocus,
  }
end

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
  targetHasChromeWindow = false,
})
local unknownTargetFilterResult = runShortcut("filter", { cacheTargetProfile = false })
local unknownTargetNewPageResult = runShortcut("newPage", { cacheTargetProfile = false })
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
assertEqual(noTargetFilterResult.orderedWindowsCallCount, 0, "Chrome-empty filter routing should skip global window ordering")
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
assertEqual(noTargetNewPageResult.orderedWindowsCallCount, 0, "Chrome-empty new-page routing should skip global window ordering")
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
assertEqual(stoppedChromeNewPageResult.createdWindow, false, "a stopped Chrome should Safe Abort before creating a window")
assertEqual(stoppedChromeNewPageResult.nativeBridgeRequest, nil, "stopped Chrome should not receive a Native Placement Bridge request")
assertEqual(stoppedChromeNewPageResult.privateFocusCount, 0, "a stopped Chrome should not attempt private focus")
assertEqual(stoppedChromeNewPageResult.failureAlert ~= nil, true, "a stopped Chrome should explain its Safe Abort")
assertEqual(unknownTargetFilterResult.createdWindow, true, "filter routing should create a verified-profile window when the existing target Chrome profile is unknown")
assertEqual(unknownTargetFilterResult.openedFilter, true, "the uncached target-window fallback should still open the filtered Tab Out page")
assertEqual(unknownTargetFilterResult.targetFocused, true, "the uncached target-window fallback should focus its created destination")
assertEqual(unknownTargetFilterResult.nativeBridgeRequest ~= nil, true, "the uncached target-window fallback should use the Native Placement Bridge")
assertEqual(unknownTargetFilterResult.privateFocusCount, 1, "the uncached target-window fallback should privately focus only its created window")
assertEqual(unknownTargetFilterResult.existingTargetFocusCount, 0, "the fallback should not focus an unverified existing Chrome window")
assertEqual(unknownTargetFilterResult.otherChromeReceivedFocus, false, "the uncached target-window fallback should not focus remote Chrome")
assertEqual(unknownTargetFilterResult.otherChromeRaised, false, "the uncached target-window fallback should preserve remote Chrome order")
assertEqual(unknownTargetFilterResult.transitionShieldCreatedCount, 1, "the occupied-target fallback should retain the creation transition shield")
assertEqual(unknownTargetFilterResult.failureAlert, nil, "an uncached target Chrome profile should not block the filter shortcut")
assertEqual(unknownTargetNewPageResult.createdWindow, true, "new-page routing should create a verified-profile window when the existing target Chrome profile is unknown")
assertEqual(unknownTargetNewPageResult.openedNewPage, true, "the uncached target-window fallback should still open the native new-tab page")
assertEqual(unknownTargetNewPageResult.targetFocused, true, "the uncached new-page fallback should focus its created destination")
assertEqual(unknownTargetNewPageResult.existingTargetFocusCount, 0, "the new-page fallback should not focus an unverified existing Chrome window")
assertEqual(unknownTargetNewPageResult.otherChromeReceivedFocus, false, "the uncached new-page fallback should not focus remote Chrome")
assertEqual(unknownTargetNewPageResult.failureAlert, nil, "an uncached target Chrome profile should not block the new-page shortcut")
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

return "cross-display focus regression: ok"
