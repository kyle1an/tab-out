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
  local targetHasInactiveSpaceChromeWindow = options.targetHasInactiveSpaceChromeWindow == true
  local targetDisplayPosition = options.targetDisplayPosition or 2
  local privateFocusAvailable = options.privateFocusAvailable ~= false
  local clock = 0
  local addressBarFocused = false
  local activationClickCount = 0
  local filterInputFocused = false
  local nativeBridgeRequest
  local extensionWindowFocusRequested = false
  local privateFocusCount = 0
  local createdChromeWindow
  local createdWindowSetFrameCount = 0
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
  local pendingTimers = {}
  local windowCreatedCallback

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
          AXTitle = "Target Profile",
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

  local function newChromeWindow(id, screen, isOtherWindow)
    local currentFrame = screen:frame()
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
        return false
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
      return false
    end,
  }
  local remoteTopWindow = {
    application = function()
      return remoteTopApplication
    end,
    focus = function(self)
      otherChromeFocused = false
      otherChromeRaised = false
      focusedWindow = self
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
    if createdChromeWindow then
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

  local addressBar = {
    attributeValue = function(_, attribute)
      if attribute == "AXRole" then
        return "AXTextField"
      end
      if attribute == "AXDescription" then
        return "Address and search bar"
      elseif attribute == "AXFocused" then
        return addressBarFocused
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
  local axRoot = {
    attributeValue = function(_, attribute)
      if attribute == "AXRole" then
        return "AXWindow"
      end
      if attribute == "AXChildren" then
        return { filterInput, addressBar }
      end
      return nil
    end,
  }
  local fakeAxElements = {
    [addressBar] = true,
    [axRoot] = true,
    [filterInput] = true,
  }

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
    axuielement = {
      windowElement = function()
        return axRoot
      end,
    },
    eventtap = {
      leftClick = function()
        activationClickCount = activationClickCount + 1
        frontmostApplication = chromeApplication
        local targetWindow = createdChromeWindow or targetChromeWindow
        targetWindow:focus()
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
              },
            },
          }
        end

        if path:match("/Secure Preferences$") then
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
      orderedWindows = function()
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
      createdChromeWindow = newChromeWindow(404, targetScreen)
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
  focusedWindow = originalWindow
  otherChromeFocused = false
  otherChromeReceivedFocus = false
  otherChromeRaised = false

  if kind == "filter" then
    tabOut.openFilter()
  else
    tabOut.openNewPage()
  end

  runPendingTimers()

  local diagnostics = tabOut.status()

  return {
    activationClickCount = activationClickCount,
    addressBarFocused = addressBarFocused,
    createdWindow = createdChromeWindow ~= nil,
    createdWindowSetFrameCount = createdWindowSetFrameCount,
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
    otherChromeFocused = otherChromeFocused,
    otherChromeReceivedFocus = otherChromeReceivedFocus,
    otherChromeRaised = otherChromeRaised,
    privateFocusCount = privateFocusCount,
    targetFocused = focusedWindow == (createdChromeWindow or targetChromeWindow),
    targetAppActive = frontmostApplication == chromeApplication,
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
assertEqual(noTargetFilterResult.createdWindow, true, "filter shortcut should create a window on an empty target display")
assertEqual(noTargetFilterResult.extensionWindowFocusRequested, false, "Native Placement Bridge should leave the created Chrome window inactive")
assertEqual(noTargetFilterResult.nativeBridgeRequest ~= nil, true, "filter shortcut should ask the native bridge to create an inactive window")
assertEqual(noTargetFilterResult.createdWindowSetFrameCount, 0, "filter shortcut should not move the window after Chrome shows it")
assertEqual(noTargetFilterResult.filterInputFocused, true, "filter shortcut should focus the created window's in-page filter")
assertEqual(noTargetFilterResult.targetFocused, true, "filter shortcut should focus the created target-display window")
assertEqual(noTargetFilterResult.otherChromeFocused, false, "filter shortcut should not focus Chrome on another display")
assertEqual(noTargetFilterResult.otherChromeReceivedFocus, false, "filter shortcut should avoid Chrome's remote launch handoff")
assertEqual(noTargetFilterResult.otherChromeRaised, false, "filter shortcut should not raise Chrome on another display")
assertEqual(noTargetFilterResult.activationClickCount, 0, "directly placed filter window should not receive a visible activation click")
assertEqual(noTargetFilterResult.privateFocusCount, 1, "directly placed filter window should receive one exact private focus call")
assertEqual(noTargetFilterResult.nativeBridgeRequest.targetBounds.left, 1440, "native bridge should receive the pointer display bounds")
assertEqual(noTargetFilterResult.nativeBridgeInstalled, true, "successful native placement should keep host installation visible")
assertEqual(noTargetFilterResult.nativeBridgeReady, true, "successful native placement should prove bridge connectivity")
assertEqual(noTargetNewPageResult.createdWindow, true, "new-page shortcut should create a window on an empty target display")
assertEqual(noTargetNewPageResult.extensionWindowFocusRequested, false, "Native Placement Bridge should leave the created Chrome window inactive")
assertEqual(noTargetNewPageResult.nativeBridgeRequest ~= nil, true, "new-page shortcut should ask the native bridge to create an inactive window")
assertEqual(noTargetNewPageResult.createdWindowSetFrameCount, 0, "new-page shortcut should not move the window after Chrome shows it")
assertEqual(noTargetNewPageResult.openedNewPage, true, "new-page shortcut should open the native Tab Out page")
assertEqual(noTargetNewPageResult.addressBarFocused, true, "new-page shortcut should focus the created window's address bar")
assertEqual(noTargetNewPageResult.targetFocused, true, "new-page shortcut should focus the created target-display window")
assertEqual(noTargetNewPageResult.otherChromeFocused, false, "new-page shortcut should not focus Chrome on another display")
assertEqual(noTargetNewPageResult.otherChromeReceivedFocus, false, "new-page shortcut should avoid Chrome's remote launch handoff")
assertEqual(noTargetNewPageResult.otherChromeRaised, false, "new-page shortcut should not raise Chrome on another display")
assertEqual(noTargetNewPageResult.privateFocusCount, 1, "directly placed new-page window should receive one exact private focus call")
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
assertEqual(unknownTargetFilterResult.createdWindow, false, "an occupied target with no verified profile should abort before creating a window")
assertEqual(unknownTargetFilterResult.existingTargetFocusCount, 0, "profile discovery should never focus an unverified Chrome window")
assertEqual(unknownTargetFilterResult.extensionWindowFocusRequested, false, "safe abort should not request Chrome focus")
assertEqual(unknownTargetFilterResult.privateFocusCount, 0, "safe abort should not invoke private focus")
assertEqual(unknownTargetFilterResult.otherChromeReceivedFocus, false, "the unverified-window fallback should not focus remote Chrome")
assertEqual(unknownTargetFilterResult.failureAlert ~= nil, true, "an ambiguous target should explain its safe abort")
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

return "cross-display focus regression: ok"
