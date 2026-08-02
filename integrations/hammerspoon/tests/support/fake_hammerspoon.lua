local function assertEqual(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s (expected %s, got %s)", message, tostring(expected), tostring(actual)), 2)
  end
end

local function currentDirectory()
  local source = debug.getinfo(1, "S").source
  return source:sub(1, 1) == "@" and source:sub(2):match("^(.*)/[^/]+$") or "."
end

local modulePath = currentDirectory() .. "/../../TabOut.spoon/init.lua"

local function runShortcut(kind, options)
  options = options or {}
  local targetHasChromeWindow = options.targetHasChromeWindow ~= false
  local otherHasChromeWindow = options.otherHasChromeWindow ~= false
  local chromeIsRunning = options.chromeIsRunning ~= false
  local cacheTargetProfile = options.cacheTargetProfile ~= false
  local targetProfileDirectory = options.targetProfileDirectory or "Profile 3"
  local targetSpaceType = options.targetSpaceType or "user"
  local targetHasInactiveSpaceChromeWindow = options.targetHasInactiveSpaceChromeWindow == true
  local targetDisplayPosition = options.targetDisplayPosition or 2
  local privateFocusAvailable = options.privateFocusAvailable ~= false
  local clock = 0
  local addressBarFocused = false
  local activationClickCount = 0
  local closeGestureCallback
  local closeGestureConsumed = false
  local closeMouseUpConsumed = false
  local chromeLaunchArguments
  local chromeLaunchCount = 0
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
  local orderedWindowsCallCountBeforeCreation
  local pendingTimers = {}
  local pendingWaits = {}
  local profileWindowInventoryRequestCount = 0
  local securePreferencesReadCount = 0
  local spaceSwitchCount = 0
  local targetActiveSpace = 11
  local windowCreatedCallback
  local windowDestroyedCallback
  local targetBrowserWindowId = 1001
  local otherBrowserWindowId = 2002
  local targetDocumentUrl = "https://example.test/target"
  local otherDocumentUrl = "https://example.test/remote"

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
    focus = function(self)
      frontmostApplication = remoteTopApplication
      focusedWindow = self
      return true
    end,
    id = function()
      return 304
    end,
    isMinimized = function()
      return false
    end,
    isStandard = function()
      return true
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
    local seen = {}
    local function append(window)
      local windowId = window and window:id() or nil
      if windowId and not seen[windowId] then
        seen[windowId] = true
        table.insert(windows, window)
      end
    end

    append(focusedWindow)
    if createdChromeWindow and not createdChromeWindow:isMinimized() then
      append(createdChromeWindow)
    end
    append(originalWindow)
    if targetHasChromeWindow then
      append(targetChromeWindow)
    end
    if not chromeIsRunning or not otherHasChromeWindow then
      append(remoteTopWindow)
    elseif otherChromeRaised then
      append(otherChromeWindow)
      append(remoteTopWindow)
    else
      append(remoteTopWindow)
      append(otherChromeWindow)
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
      if attribute == "AXDocument" then
        return targetDocumentUrl
      elseif attribute == "AXChildren" then
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
  local remoteAxRoot = {
    attributeValue = function(_, attribute)
      if attribute == "AXDocument" then
        return otherDocumentUrl
      elseif attribute == "AXRole" then
        return "AXWindow"
      elseif attribute == "AXChildren" then
        return {}
      end
      return nil
    end,
  }
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
      pathForBundleID = function(bundleId)
        if bundleId == "com.google.Chrome" then
          return "/Applications/Google Chrome.app"
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
      windowElement = function(window)
        destinationWindowElementReadCount = destinationWindowElementReadCount + 1
        if window == otherChromeWindow then
          return remoteAxRoot
        end
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
        if script:find("TAB_OUT_PROFILE_WINDOW_INVENTORY", 1, true) then
          local descriptors = {}
          if targetHasChromeWindow then
            local frame = targetChromeWindow:frame()
            table.insert(descriptors, {
              targetBrowserWindowId,
              { frame.x, frame.y, frame.x + frame.w, frame.y + frame.h },
              targetDocumentUrl,
            })
          end
          if otherHasChromeWindow and chromeIsRunning then
            local frame = otherChromeWindow:frame()
            table.insert(descriptors, {
              otherBrowserWindowId,
              { frame.x, frame.y, frame.x + frame.w, frame.y + frame.h },
              otherDocumentUrl,
            })
          end
          if options.ambiguousProfileWindowIdentity then
            local frame = targetChromeWindow:frame()
            table.insert(descriptors, {
              3003,
              { frame.x, frame.y, frame.x + frame.w, frame.y + frame.h },
              targetDocumentUrl,
            })
          end
          return true, descriptors
        end

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
        if options.rememberedTargetSpace then
          return { ["target-screen"] = 12 }
        end
        return nil
      end,
      set = function() end,
    },
    spaces = {
      activeSpaceOnScreen = function(screen)
        return screen == targetScreen and targetActiveSpace or 22
      end,
      gotoSpace = function(spaceId)
        targetActiveSpace = spaceId
        spaceSwitchCount = spaceSwitchCount + 1
        return true
      end,
      spaceType = function(spaceId)
        if spaceId == 11 and targetSpaceType == "fullscreen" then
          return "fullscreen"
        end
        return "user"
      end,
      spacesForScreen = function(screen)
        if screen ~= targetScreen then
          return { 22 }
        end
        return targetSpaceType == "fullscreen" and { 12, 11 } or { 11 }
      end,
      watcher = {
        new = newWatcher,
      },
      windowSpaces = function(window)
        if window == inactiveSpaceChromeWindow then
          return { 33 }
        end
        if window == targetChromeWindow then
          return { 11 }
        end
        if window == createdChromeWindow then
          return { targetActiveSpace }
        end
        if window == originalWindow and targetSpaceType == "fullscreen" then
          return { 11 }
        end
        return window == originalWindow and { targetActiveSpace } or { 22 }
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
      waitUntil = function(predicate, action)
        local timer = {
          action = action,
          predicate = predicate,
          stopped = false,
        }
        function timer:stop()
          self.stopped = true
        end
        table.insert(pendingWaits, timer)
        return timer
      end,
    },
    task = {
      new = function(path, callback, arguments)
        return {
          start = function()
            chromeLaunchCount = chromeLaunchCount + 1
            chromeLaunchArguments = { path = path, values = arguments }
            chromeIsRunning = true
            callback(0, "", "")
            return true
          end,
          terminate = function() end,
        }
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
        if createdChromeWindow and createdChromeWindow:id() == windowId then
          return createdChromeWindow
        end
        for _, window in ipairs({
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
      local waitFired = false
      for index = #pendingWaits, 1, -1 do
        local wait = pendingWaits[index]
        if wait.stopped then
          table.remove(pendingWaits, index)
        elseif wait.predicate() then
          wait.stopped = true
          table.remove(pendingWaits, index)
          wait.action(wait)
          waitFired = true
        end
      end

      local nextIndex
      local nextTimer
      for index, timer in ipairs(pendingTimers) do
        if not timer.stopped and (not nextTimer or timer.due < nextTimer.due) then
          nextIndex = index
          nextTimer = timer
        end
      end

      if not nextTimer and not waitFired then
        break
      end
      if nextTimer then
        table.remove(pendingTimers, nextIndex)
        clock = nextTimer.due
        nextTimer.callback()
        if nextTimer.repeating and not nextTimer.stopped then
          nextTimer.due = clock + nextTimer.interval
          table.insert(pendingTimers, nextTimer)
        end
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
    listProfileWindows = function(_, inventoryOptions, callback)
      profileWindowInventoryRequestCount = profileWindowInventoryRequestCount + 1
      assertEqual(inventoryOptions.timeoutSeconds > 0, true, "profile-window inventory timeout budget")
      if options.nativeBridgeStarts == false then
        return false, "native bridge unavailable"
      end
      if options.profileWindowInventoryUnavailable then
        callback(nil, "profile-window inventory unavailable")
        return true
      end

      local windowIds = {}
      if targetHasChromeWindow and targetProfileDirectory == "Profile 3" then
        table.insert(windowIds, targetBrowserWindowId)
      end
      if otherHasChromeWindow and chromeIsRunning then
        table.insert(windowIds, otherBrowserWindowId)
      end
      callback(windowIds)
      return true
    end,
    createWindow = function(_, createOptions, callback)
      if options.nativeBridgeStarts == false then
        return false, "native bridge unavailable"
      end

      nativeBridgeRequest = createOptions
      orderedWindowsCallCountBeforeCreation = orderedWindowsCallCount
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
        if focusedWindow == closingWindow and targetHasChromeWindow then
          frontmostApplication = chromeApplication
          targetChromeWindow:focus()
        elseif focusedWindow == closingWindow and otherHasChromeWindow then
          frontmostApplication = chromeApplication
          otherChromeWindow:focus()
        end
        createdChromeWindow = nil
        createdWindowClosed = true
        if windowDestroyedCallback and not options.suppressWindowDestroyedCallback then
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
    chromeLaunchArguments = chromeLaunchArguments,
    chromeLaunchCount = chromeLaunchCount,
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
    orderedWindowsCallCountBeforeCreation = orderedWindowsCallCountBeforeCreation,
    otherChromeFocused = otherChromeFocused,
    otherChromeReceivedFocus = otherChromeReceivedFocus,
    otherChromeRaised = otherChromeRaised,
    privateFocusCount = privateFocusCount,
    profileWindowInventoryRequestCount = profileWindowInventoryRequestCount,
    remoteDestinationFocusCount = remoteDestinationFocusCount,
    remoteTopFocused = focusedWindow == remoteTopWindow,
    originalWindowFocused = focusedWindow == originalWindow,
    securePreferencesReadCount = securePreferencesReadCount,
    spaceSwitchCount = spaceSwitchCount,
    targetFocused = focusedWindow == (createdChromeWindow or targetChromeWindow),
    targetAppActive = frontmostApplication == chromeApplication,
    transitionShieldCreatedCount = transitionShieldCreatedCount,
    transitionShieldDeletedCount = transitionShieldDeletedCount,
    transitionShieldVisibleAtPrivateFocus = transitionShieldVisibleAtPrivateFocus,
  }
end

return { runShortcut = runShortcut }
