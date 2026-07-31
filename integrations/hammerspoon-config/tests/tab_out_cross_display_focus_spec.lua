local function assertEqual(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s (expected %s, got %s)", message, tostring(expected), tostring(actual)), 2)
  end
end

local function currentDirectory()
  local source = debug.getinfo(1, "S").source
  return source:sub(1, 1) == "@" and source:sub(2):match("^(.*)/[^/]+$") or "."
end

local modulePath = currentDirectory() .. "/../modules/tab_out.lua"

local function runShortcut(
  kind,
  targetHasChromeWindow,
  targetProfileIsLastUsed,
  chromeIsRunning,
  cacheTargetProfile,
  targetHasInactiveSpaceChromeWindow,
  targetDisplayPosition,
  privateFocusAvailable
)
  targetHasChromeWindow = targetHasChromeWindow ~= false
  targetProfileIsLastUsed = targetProfileIsLastUsed ~= false
  cacheTargetProfile = cacheTargetProfile ~= false
  targetDisplayPosition = targetDisplayPosition or 2
  privateFocusAvailable = privateFocusAvailable ~= false
  local chromeWasRunning = chromeIsRunning ~= false
  local chromeRunning = chromeWasRunning
  local clock = 0
  local addressBarFocused = false
  local addressBarValue
  local activationClickCount = 0
  local filterInputFocused = false
  local inactiveWindowShortcutSent = false
  local inactiveWindowShortcutKey
  local extensionWindowFocusRequested = false
  local privateFocusCount = 0
  local createdChromeWindow
  local createdWindowSetFrameCount = 0
  local failureAlert
  local focusedWindow
  local frontmostApplication
  local focusCountByWindowId = {}
  local launcherArguments
  local launcherExecutable
  local navigationObservedPrivateFocus = false
  local navigationUsesFrontWindow = false
  local otherChromeFocused = false
  local otherChromeReceivedFocus = false
  local otherChromeRaised = false
  local openedFilter = false
  local openedNewPage = false
  local pendingTimers = {}
  local pointerPosition = { x = 700, y = 450 }
  local windowCreatedCallback
  local windowFocusedCallbacks = {}

  local function newWatcher()
    return {
      start = function(self)
        return self
      end,
    }
  end

  local targetScreen = {
    frame = function()
      return { h = 900, w = 1440, x = targetDisplayPosition == 1 and 0 or 1440, y = 0 }
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

  local chromeApplication = {
    allWindows = function()
      return {}
    end,
    bundleID = function()
      return "com.google.Chrome"
    end,
    focusedWindow = function()
      return focusedWindow
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
    or (not targetHasChromeWindow and chromeWasRunning and otherChromeWindow)
    or originalWindow

  local function currentChromeWindows()
    local windows = {}
    if not chromeRunning then
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
    if chromeWasRunning then
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
    if not chromeWasRunning then
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
      elseif attribute == "AXPosition" then
        local frame = (createdChromeWindow or targetChromeWindow):frame()
        return { x = frame.x + 200, y = frame.y + 40 }
      elseif attribute == "AXSize" then
        return { h = 24, w = 500 }
      elseif attribute == "AXFocused" then
        return addressBarFocused
      end
      return nil
    end,
    setAttributeValue = function(_, attribute, value)
      if attribute == "AXFocused" and value == true then
        addressBarFocused = true
        return true
      elseif attribute == "AXValue" and type(value) == "string" then
        addressBarValue = value
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
      elseif attribute == "AXPosition" then
        local frame = (createdChromeWindow or targetChromeWindow):frame()
        return { x = frame.x + 400, y = frame.y + 90 }
      elseif attribute == "AXSize" then
        return { h = 34, w = 280 }
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
  local selectedTab = {
    attributeValue = function(_, attribute)
      if attribute == "AXRole" then
        return "AXRadioButton"
      elseif attribute == "AXSubrole" then
        return "AXTabButton"
      elseif attribute == "AXValue" then
        return true
      elseif attribute == "AXPosition" then
        local frame = (createdChromeWindow or targetChromeWindow):frame()
        return { x = frame.x + 20, y = frame.y + 10 }
      elseif attribute == "AXSize" then
        return { h = 24, w = 60 }
      elseif attribute == "AXChildren" then
        return {}
      end
      return nil
    end,
  }
  local axRoot = {
    attributeValue = function(_, attribute)
      if attribute == "AXRole" then
        return "AXWindow"
      end
      if attribute == "AXChildren" then
        return { selectedTab, filterInput, addressBar }
      end
      return nil
    end,
  }
  local fakeAxElements = {
    [addressBar] = true,
    [axRoot] = true,
    [filterInput] = true,
    [selectedTab] = true,
  }

  local fakeHs = {
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
        if bundleId == "com.google.Chrome" and chromeRunning then
          return chromeApplication
        end
        return nil
      end,
    },
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
      keyStroke = function(modifiers, key, _, application)
        if application == nil then
          local expectedKey = targetDisplayPosition == 1
            and (kind == "filter" and "6" or "7")
            or (kind == "filter" and "8" or "9")
          assertEqual(key, expectedKey, "display-addressed direct-placement shortcut key")
          assertEqual(modifiers[1], "cmd", "inactive-window shortcut primary modifier")
          assertEqual(modifiers[2], "shift", "inactive-window shortcut secondary modifier")
          inactiveWindowShortcutSent = true
          inactiveWindowShortcutKey = key
          if kind == "filter" then
            openedFilter = true
          else
            openedNewPage = true
          end
          createdChromeWindow = newChromeWindow(404, targetScreen)
          if windowCreatedCallback then
            windowCreatedCallback(createdChromeWindow)
          end
          return
        end

        assertEqual(application, chromeApplication, "Chrome keystroke application")
        if key == "t" then
          assertEqual(modifiers[1], "cmd", "new-page shortcut modifier")
          openedNewPage = true
          return
        end

        assertEqual(key, "return", "address-bar navigation key")
        assertEqual(#modifiers, 0, "address-bar navigation modifiers")
        openedFilter = addressBarValue and addressBarValue:find("focusFilter=1", 1, true) ~= nil
      end,
    },
    hotkey = {
      bind = function()
        return {}
      end,
    },
    geometry = {
      point = function(x, y)
        return { x = x, y = y }
      end,
      rect = function(x, y, width, height)
        return { h = height, w = width, x = x, y = y }
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
              last_used = targetProfileIsLastUsed and "Profile 3" or "Default",
            },
          }
        end

        if path:match("/Secure Preferences$") then
          return {
            extensions = {
              settings = {
                [string.rep("a", 32)] = {
                  commands = {
                    ["create-inactive-filter-window-display-1"] = {},
                    ["create-inactive-new-page-window-display-1"] = {},
                    ["create-inactive-filter-window-display-2"] = {},
                    ["create-inactive-new-page-window-display-2"] = {},
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
      absolutePosition = function(position)
        if position then
          pointerPosition = { x = position.x, y = position.y }
        end
        return { x = pointerPosition.x, y = pointerPosition.y }
      end,
      getCurrentScreen = function()
        return targetScreen
      end,
    },
    osascript = {
      applescript = function(script)
        local focusesFilter = script:find("focusFilter=1", 1, true) ~= nil
        local focusesWindow = script:find("focusWindow=1", 1, true) ~= nil
        local opensNewPage = script:find("chrome://newtab/", 1, true) ~= nil
        local createsWindow = script:find("make new window", 1, true) ~= nil
        if createsWindow then
          otherChromeRaised = true
          createdChromeWindow = newChromeWindow(404, targetScreen)
          if focusesFilter then
            openedFilter = true
          else
            openedNewPage = true
          end
          if windowCreatedCallback then
            windowCreatedCallback(createdChromeWindow)
          end
        else
          navigationObservedPrivateFocus = privateFocusCount > 0 and focusedWindow == targetChromeWindow
          navigationUsesFrontWindow = script:find("set candidateWindow to front window", 1, true) ~= nil
          openedFilter = focusesFilter
          openedNewPage = opensNewPage
        end
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
      allSpaces = function()
        return {
          ["other-screen"] = { 22 },
          ["target-screen"] = { 11, 33 },
        }
      end,
      moveWindowToSpace = function()
        return true
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
      windowsForSpace = function(spaceId)
        local ids = {}
        for _, window in ipairs(currentChromeWindows()) do
          local windowSpaces
          if window == inactiveSpaceChromeWindow then
            windowSpaces = { 33 }
          else
            windowSpaces = (window == targetChromeWindow or window == createdChromeWindow) and { 11 } or { 22 }
          end
          if windowSpaces[1] == spaceId then
            table.insert(ids, window:id())
          end
        end
        return ids
      end,
    },
    task = {
      new = function(executable, exitCallback, arguments)
        launcherExecutable = executable
        launcherArguments = arguments
        return {
          start = function()
            local focusesFilter = false
            local hasBackgroundFlag = false
            local opensNewTab = false
            for _, argument in ipairs(arguments) do
              if argument:find("focusFilter=1", 1, true) then
                focusesFilter = true
              elseif argument == "chrome://newtab/" then
                opensNewTab = true
              elseif argument == "-g" then
                hasBackgroundFlag = true
              end
            end

            local launchesInBackground = executable == "/usr/bin/open" and hasBackgroundFlag
            if not launchesInBackground then
              otherChromeRaised = true
            end
            if chromeWasRunning then
              otherChromeWindow:focus()
              for _, callback in ipairs(windowFocusedCallbacks) do
                callback(otherChromeWindow)
              end
            end
            chromeRunning = true
            createdChromeWindow = newChromeWindow(404, targetScreen)
            if focusesFilter then
              openedFilter = true
            elseif opensNewTab then
              openedNewPage = true
            end
            if windowCreatedCallback then
              windowCreatedCallback(createdChromeWindow)
            end
            exitCallback(0, "", "")
            return true
          end,
        }
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
                table.insert(windowFocusedCallbacks, callback)
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
      allWindows = function()
        local windows = currentOrderedWindows()
        table.insert(windows, originalWindow)
        return windows
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

  tabOut.start({
    chromeBundleId = "com.google.Chrome",
    chromeProfileDirectory = "Profile 3",
    chromeUserDataDirectory = "/tmp/tab-out-test-profile",
    privateFocus = privateFocus,
    shortcuts = {
      filter = { key = "k", modifiers = { "cmd", "shift" } },
      inactiveWindow = {
        [1] = {
          filter = { key = "6", modifiers = { "cmd", "shift" } },
          newPage = { key = "7", modifiers = { "cmd", "shift" } },
        },
        [2] = {
          filter = { key = "8", modifiers = { "cmd", "shift" } },
          newPage = { key = "9", modifiers = { "cmd", "shift" } },
        },
      },
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

  return {
    activationClickCount = activationClickCount,
    addressBarFocused = addressBarFocused,
    createdWindow = createdChromeWindow ~= nil,
    createdWindowSetFrameCount = createdWindowSetFrameCount,
    extensionWindowFocusRequested = extensionWindowFocusRequested,
    failureAlert = failureAlert,
    existingTargetFocusCount = focusCountByWindowId[targetChromeWindow:id()] or 0,
    inactiveWindowShortcutSent = inactiveWindowShortcutSent,
    inactiveWindowShortcutKey = inactiveWindowShortcutKey,
    launcherArguments = launcherArguments,
    launcherExecutable = launcherExecutable,
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
local noTargetFilterResult = runShortcut("filter", false)
local noTargetNewPageResult = runShortcut("newPage", false)
local noTargetExplicitProfileFilterResult = runShortcut("filter", false, false)
local noTargetExplicitProfileNewPageResult = runShortcut("newPage", false, false)
local stoppedChromeNewPageResult = runShortcut("newPage", false, true, false)
local unknownTargetFilterResult = runShortcut("filter", true, true, true, false)
local inactiveSpaceTargetFilterResult = runShortcut("filter", false, true, true, true, true)
local firstDisplayPositionFilterResult = runShortcut("filter", false, true, true, true, false, 1)
local unavailablePrivateFocusResult = runShortcut("filter", true, true, true, true, false, 2, false)

assertEqual(filterResult.openedFilter, true, "filter shortcut should open the focused-filter page")
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
assertEqual(noTargetFilterResult.createdWindow, true, "filter shortcut should create a window on an empty target display")
assertEqual(noTargetFilterResult.extensionWindowFocusRequested, false, "filter bridge should leave the created Chrome window inactive")
assertEqual(noTargetFilterResult.inactiveWindowShortcutSent, true, "filter shortcut should ask Tab Out to create an inactive window")
assertEqual(noTargetFilterResult.launcherExecutable, nil, "filter shortcut should not hand a launch request to running Chrome")
assertEqual(noTargetFilterResult.createdWindowSetFrameCount, 0, "filter shortcut should not move the window after Chrome shows it")
assertEqual(noTargetFilterResult.targetFocused, true, "filter shortcut should focus the created target-display window")
assertEqual(noTargetFilterResult.otherChromeFocused, false, "filter shortcut should not focus Chrome on another display")
assertEqual(noTargetFilterResult.otherChromeReceivedFocus, false, "filter shortcut should avoid Chrome's remote launch handoff")
assertEqual(noTargetFilterResult.otherChromeRaised, false, "filter shortcut should not raise Chrome on another display")
assertEqual(noTargetFilterResult.activationClickCount, 0, "directly placed filter window should not receive a visible activation click")
assertEqual(noTargetFilterResult.privateFocusCount, 1, "directly placed filter window should receive one exact private focus call")
assertEqual(noTargetFilterResult.inactiveWindowShortcutKey, "8", "second desktop position should use its filter bridge command")
assertEqual(noTargetNewPageResult.createdWindow, true, "new-page shortcut should create a window on an empty target display")
assertEqual(noTargetNewPageResult.extensionWindowFocusRequested, false, "new-page bridge should leave the created Chrome window inactive")
assertEqual(noTargetNewPageResult.inactiveWindowShortcutSent, true, "new-page shortcut should ask Tab Out to create an inactive window")
assertEqual(noTargetNewPageResult.launcherExecutable, nil, "new-page shortcut should not hand a launch request to running Chrome")
assertEqual(noTargetNewPageResult.createdWindowSetFrameCount, 0, "new-page shortcut should not move the window after Chrome shows it")
assertEqual(noTargetNewPageResult.openedNewPage, true, "new-page shortcut should open the native Tab Out page")
assertEqual(noTargetNewPageResult.addressBarFocused, true, "new-page shortcut should focus the created window's address bar")
assertEqual(noTargetNewPageResult.targetFocused, true, "new-page shortcut should focus the created target-display window")
assertEqual(noTargetNewPageResult.otherChromeFocused, false, "new-page shortcut should not focus Chrome on another display")
assertEqual(noTargetNewPageResult.otherChromeReceivedFocus, false, "new-page shortcut should avoid Chrome's remote launch handoff")
assertEqual(noTargetNewPageResult.otherChromeRaised, false, "new-page shortcut should not raise Chrome on another display")
assertEqual(noTargetNewPageResult.privateFocusCount, 1, "directly placed new-page window should receive one exact private focus call")
assertEqual(noTargetExplicitProfileFilterResult.createdWindow, true, "filter shortcut should launch the configured profile on an empty target display")
assertEqual(noTargetExplicitProfileFilterResult.targetFocused, true, "filter shortcut should focus the explicitly launched target-display window")
assertEqual(noTargetExplicitProfileFilterResult.otherChromeFocused, false, "filter shortcut should not focus a remote profile anchor before launch")
assertEqual(noTargetExplicitProfileFilterResult.otherChromeRaised, false, "filter shortcut should not raise remote Chrome during explicit profile launch")
assertEqual(noTargetExplicitProfileNewPageResult.createdWindow, true, "new-page shortcut should launch the configured profile on an empty target display")
assertEqual(noTargetExplicitProfileNewPageResult.addressBarFocused, true, "new-page shortcut should focus the explicitly launched window's address bar")
assertEqual(noTargetExplicitProfileNewPageResult.targetFocused, true, "new-page shortcut should focus the explicitly launched target-display window")
assertEqual(noTargetExplicitProfileNewPageResult.otherChromeFocused, false, "new-page shortcut should not focus a remote profile anchor before launch")
assertEqual(noTargetExplicitProfileNewPageResult.otherChromeRaised, false, "new-page shortcut should not raise remote Chrome during explicit profile launch")
assertEqual(stoppedChromeNewPageResult.createdWindow, true, "new-page shortcut should start Chrome when it is not running")
assertEqual(stoppedChromeNewPageResult.inactiveWindowShortcutSent, false, "stopped Chrome cannot receive the extension bridge shortcut")
assertEqual(stoppedChromeNewPageResult.launcherExecutable, "/usr/bin/open", "stopped Chrome should use the background app launcher")
assertEqual(stoppedChromeNewPageResult.launcherArguments[1], "-g", "stopped Chrome should launch in the background")
assertEqual(stoppedChromeNewPageResult.launcherArguments[2], "-n", "stopped Chrome should request a new app launch event")
assertEqual(stoppedChromeNewPageResult.launcherArguments[4], "com.google.Chrome", "stopped Chrome should launch the configured browser")
assertEqual(stoppedChromeNewPageResult.launcherArguments[7], "--new-window", "stopped Chrome should request a new window")
assertEqual(stoppedChromeNewPageResult.launcherArguments[8], "chrome://newtab/", "stopped Chrome should open the native new-tab route")
assertEqual(unknownTargetFilterResult.createdWindow, false, "an occupied target with no verified profile should abort before creating a window")
assertEqual(unknownTargetFilterResult.existingTargetFocusCount, 0, "profile discovery should never focus an unverified Chrome window")
assertEqual(unknownTargetFilterResult.extensionWindowFocusRequested, false, "safe abort should not request Chrome focus")
assertEqual(unknownTargetFilterResult.privateFocusCount, 0, "safe abort should not invoke private focus")
assertEqual(unknownTargetFilterResult.otherChromeReceivedFocus, false, "the unverified-window fallback should not focus remote Chrome")
assertEqual(unknownTargetFilterResult.failureAlert ~= nil, true, "an ambiguous target should explain its safe abort")
assertEqual(inactiveSpaceTargetFilterResult.createdWindow, true, "a Chrome window on an inactive target Space must not make the active target Space occupied")
assertEqual(inactiveSpaceTargetFilterResult.failureAlert, nil, "inactive-Space Chrome windows must not block direct placement")
assertEqual(firstDisplayPositionFilterResult.inactiveWindowShortcutKey, "6", "first desktop position should use its filter bridge command")
assertEqual(unavailablePrivateFocusResult.openedFilter, false, "an unavailable private helper should abort before navigation")
assertEqual(unavailablePrivateFocusResult.privateFocusCount, 0, "an unavailable private helper should not attempt exact focus")
assertEqual(unavailablePrivateFocusResult.failureAlert ~= nil, true, "an unavailable private helper should explain its safe abort")

return "cross-display focus regression: ok"
