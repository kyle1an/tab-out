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

local function runShortcut(kind, targetHasChromeWindow, targetProfileIsLastUsed)
  targetHasChromeWindow = targetHasChromeWindow ~= false
  targetProfileIsLastUsed = targetProfileIsLastUsed ~= false
  local clock = 0
  local addressBarFocused = false
  local addressBarValue
  local createdChromeWindow
  local focusedWindow
  local launcherArguments
  local launcherExecutable
  local otherChromeFocused = false
  local otherChromeReceivedFocus = false
  local otherChromeRaised = false
  local openedFilter = false
  local openedNewPage = false
  local pendingTimers = {}
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
      return { h = 900, w = 1440, x = 0, y = 0 }
    end,
    getUUID = function()
      return "target-screen"
    end,
  }
  local otherScreen = {
    frame = function()
      return { h = 900, w = 1440, x = 1440, y = 0 }
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
  }

  local function newChromeWindow(id, screen, isOtherWindow)
    local currentFrame = screen:frame()
    local window = {
      application = function()
        return chromeApplication
      end,
      focus = function(self)
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
        currentFrame = frame
      end,
    }
    return window
  end

  local targetChromeWindow = newChromeWindow(101, targetScreen)
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
  local originalWindow = {
    id = function()
      return 304
    end,
    screen = function()
      return targetScreen
    end,
  }
  focusedWindow = targetHasChromeWindow and originalWindow or otherChromeWindow

  local function currentChromeWindows()
    local windows = {}
    if createdChromeWindow then
      table.insert(windows, createdChromeWindow)
    end
    if targetHasChromeWindow then
      table.insert(windows, targetChromeWindow)
    end
    table.insert(windows, otherChromeWindow)
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
    if otherChromeRaised then
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
  local axRoot = {
    attributeValue = function(_, attribute)
      if attribute == "AXRole" then
        return "AXWindow"
      end
      if attribute == "AXChildren" then
        return { addressBar }
      end
      return nil
    end,
  }
  local fakeAxElements = {
    [addressBar] = true,
    [axRoot] = true,
  }

  local fakeHs = {
    alert = {
      show = function()
        error("The shortcut unexpectedly displayed a failure alert")
      end,
    },
    application = {
      get = function(bundleId)
        if bundleId == "com.google.Chrome" then
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
      keyStroke = function(modifiers, key, _, application)
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
          openedFilter = focusesFilter
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
          ["target-screen"] = { 11 },
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
        return (window == targetChromeWindow or window == createdChromeWindow) and { 11 } or { 22 }
      end,
      windowsForSpace = function(spaceId)
        local ids = {}
        for _, window in ipairs(currentChromeWindows()) do
          local windowSpaces = (window == targetChromeWindow or window == createdChromeWindow) and { 11 } or { 22 }
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
            otherChromeWindow:focus()
            for _, callback in ipairs(windowFocusedCallbacks) do
              callback(otherChromeWindow)
            end
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
                if immediate and focusedWindow == otherChromeWindow then
                  callback(otherChromeWindow)
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

  tabOut.start({
    chromeBundleId = "com.google.Chrome",
    chromeProfileDirectory = "Profile 3",
    chromeUserDataDirectory = "/tmp/tab-out-test-profile",
    shortcuts = {
      filter = { key = "k", modifiers = { "cmd", "shift" } },
      newPage = { key = "space", modifiers = { "cmd", "shift" } },
    },
  })

  if not targetHasChromeWindow then
    runPendingTimers()
    focusedWindow = originalWindow
    otherChromeFocused = false
    otherChromeRaised = false
  end

  if kind == "filter" then
    tabOut.openFilter()
  else
    tabOut.openNewPage()
  end

  runPendingTimers()

  return {
    addressBarFocused = addressBarFocused,
    createdWindow = createdChromeWindow ~= nil,
    launcherArguments = launcherArguments,
    launcherExecutable = launcherExecutable,
    openedFilter = openedFilter,
    openedNewPage = openedNewPage,
    otherChromeFocused = otherChromeFocused,
    otherChromeReceivedFocus = otherChromeReceivedFocus,
    otherChromeRaised = otherChromeRaised,
    targetFocused = focusedWindow == (createdChromeWindow or targetChromeWindow),
  }
end

local filterResult = runShortcut("filter")
local newPageResult = runShortcut("newPage")
local noTargetFilterResult = runShortcut("filter", false)
local noTargetNewPageResult = runShortcut("newPage", false)
local noTargetExplicitProfileFilterResult = runShortcut("filter", false, false)
local noTargetExplicitProfileNewPageResult = runShortcut("newPage", false, false)

assertEqual(filterResult.openedFilter, true, "filter shortcut should open the focused-filter page")
assertEqual(filterResult.targetFocused, true, "filter shortcut should focus the routed Chrome window")
assertEqual(newPageResult.openedNewPage, true, "new-page shortcut should use Chrome's native new-tab action")
assertEqual(newPageResult.targetFocused, true, "new-page shortcut should focus the routed Chrome window")
assertEqual(newPageResult.otherChromeRaised, false, "new-page shortcut should not raise Chrome on another display")
assertEqual(filterResult.otherChromeRaised, false, "filter shortcut should not raise Chrome on another display")
assertEqual(noTargetFilterResult.createdWindow, true, "filter shortcut should create a window on an empty target display")
assertEqual(noTargetFilterResult.launcherExecutable, "/usr/bin/open", "filter shortcut should use the background app launcher")
assertEqual(noTargetFilterResult.launcherArguments[1], "-g", "filter shortcut should launch Chrome in the background")
assertEqual(noTargetFilterResult.launcherArguments[2], "-n", "filter shortcut should request a new app launch event")
assertEqual(noTargetFilterResult.launcherArguments[4], "com.google.Chrome", "filter shortcut should route the launch to Chrome")
assertEqual(noTargetFilterResult.launcherArguments[5], "--args", "filter shortcut should pass the remaining arguments to Chrome")
assertEqual(noTargetFilterResult.launcherArguments[7], "--new-window", "filter shortcut should request a new Chrome window")
assertEqual(
  noTargetFilterResult.launcherArguments[8],
  "chrome://newtab/",
  "filter shortcut should create its window with the background-safe new-tab route"
)
assertEqual(noTargetFilterResult.targetFocused, true, "filter shortcut should focus the created target-display window")
assertEqual(noTargetFilterResult.otherChromeFocused, false, "filter shortcut should not focus Chrome on another display")
assertEqual(noTargetFilterResult.otherChromeReceivedFocus, true, "filter regression should exercise Chrome's remote launch handoff")
assertEqual(noTargetFilterResult.otherChromeRaised, false, "filter shortcut should not raise Chrome on another display")
assertEqual(noTargetNewPageResult.createdWindow, true, "new-page shortcut should create a window on an empty target display")
assertEqual(noTargetNewPageResult.launcherExecutable, "/usr/bin/open", "new-page shortcut should use the background app launcher")
assertEqual(noTargetNewPageResult.launcherArguments[1], "-g", "new-page shortcut should launch Chrome in the background")
assertEqual(noTargetNewPageResult.launcherArguments[2], "-n", "new-page shortcut should request a new app launch event")
assertEqual(noTargetNewPageResult.launcherArguments[4], "com.google.Chrome", "new-page shortcut should route the launch to Chrome")
assertEqual(noTargetNewPageResult.launcherArguments[5], "--args", "new-page shortcut should pass the remaining arguments to Chrome")
assertEqual(noTargetNewPageResult.launcherArguments[7], "--new-window", "new-page shortcut should request a new Chrome window")
assertEqual(noTargetNewPageResult.launcherArguments[8], "chrome://newtab/", "new-page shortcut should explicitly request Chrome's new-tab page")
assertEqual(noTargetNewPageResult.openedNewPage, true, "new-page shortcut should open the native Tab Out page")
assertEqual(noTargetNewPageResult.addressBarFocused, true, "new-page shortcut should focus the created window's address bar")
assertEqual(noTargetNewPageResult.targetFocused, true, "new-page shortcut should focus the created target-display window")
assertEqual(noTargetNewPageResult.otherChromeFocused, false, "new-page shortcut should not focus Chrome on another display")
assertEqual(noTargetNewPageResult.otherChromeReceivedFocus, true, "new-page regression should exercise Chrome's remote launch handoff")
assertEqual(noTargetNewPageResult.otherChromeRaised, false, "new-page shortcut should not raise Chrome on another display")
assertEqual(noTargetExplicitProfileFilterResult.createdWindow, true, "filter shortcut should launch the configured profile on an empty target display")
assertEqual(noTargetExplicitProfileFilterResult.targetFocused, true, "filter shortcut should focus the explicitly launched target-display window")
assertEqual(noTargetExplicitProfileFilterResult.otherChromeFocused, false, "filter shortcut should not focus a remote profile anchor before launch")
assertEqual(noTargetExplicitProfileFilterResult.otherChromeRaised, false, "filter shortcut should not raise remote Chrome during explicit profile launch")
assertEqual(noTargetExplicitProfileNewPageResult.createdWindow, true, "new-page shortcut should launch the configured profile on an empty target display")
assertEqual(noTargetExplicitProfileNewPageResult.addressBarFocused, true, "new-page shortcut should focus the explicitly launched window's address bar")
assertEqual(noTargetExplicitProfileNewPageResult.targetFocused, true, "new-page shortcut should focus the explicitly launched target-display window")
assertEqual(noTargetExplicitProfileNewPageResult.otherChromeFocused, false, "new-page shortcut should not focus a remote profile anchor before launch")
assertEqual(noTargetExplicitProfileNewPageResult.otherChromeRaised, false, "new-page shortcut should not raise remote Chrome during explicit profile launch")

return "cross-display focus regression: ok"
