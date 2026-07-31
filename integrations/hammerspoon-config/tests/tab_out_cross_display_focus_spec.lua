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

local function runShortcut(kind)
  local clock = 0
  local focusedWindow
  local otherChromeRaised = false
  local openedFilter = false
  local openedNewPage = false
  local pendingTimers = {}

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

  local function newChromeWindow(id, screen)
    local window = {
      application = function()
        return chromeApplication
      end,
      focus = function(self)
        focusedWindow = self
        return true
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
        focusedWindow = self
        return true
      end,
      screen = function()
        return screen
      end,
    }
    return window
  end

  local targetChromeWindow = newChromeWindow(101, targetScreen)
  local otherChromeWindow = newChromeWindow(202, otherScreen)
  local originalWindow = {
    id = function()
      return 303
    end,
    screen = function()
      return targetScreen
    end,
  }
  focusedWindow = originalWindow

  chromeApplication.allWindows = function()
    return { targetChromeWindow, otherChromeWindow }
  end

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
    eventtap = {
      keyStroke = function(modifiers, key, _, application)
        assertEqual(modifiers[1], "cmd", "new-page shortcut modifier")
        assertEqual(key, "t", "new-page shortcut key")
        assertEqual(application, chromeApplication, "new-page shortcut application")
        openedNewPage = true
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
              last_used = "Profile 3",
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
        openedFilter = script:find("focusFilter=1", 1, true) ~= nil
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
        return window == targetChromeWindow and { 11 } or { 22 }
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
              return { targetChromeWindow, otherChromeWindow }
            end,
            subscribe = function() end,
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
        return { targetChromeWindow, otherChromeWindow }
      end,
    },
  }

  local environment = setmetatable({ hs = fakeHs }, { __index = _G })
  local chunk, loadError = loadfile(modulePath, "t", environment)
  assert(chunk, loadError)
  local tabOut = chunk()

  tabOut.start({
    chromeBundleId = "com.google.Chrome",
    chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    chromeProfileDirectory = "Profile 3",
    chromeUserDataDirectory = "/tmp/tab-out-test-profile",
    shortcuts = {
      filter = { key = "k", modifiers = { "cmd", "shift" } },
      newPage = { key = "space", modifiers = { "cmd", "shift" } },
    },
  })

  if kind == "filter" then
    tabOut.openFilter()
  else
    tabOut.openNewPage()
  end

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

  return {
    openedFilter = openedFilter,
    openedNewPage = openedNewPage,
    otherChromeRaised = otherChromeRaised,
    targetFocused = focusedWindow == targetChromeWindow,
  }
end

local filterResult = runShortcut("filter")
local newPageResult = runShortcut("newPage")

assertEqual(filterResult.openedFilter, true, "filter shortcut should open the focused-filter page")
assertEqual(filterResult.targetFocused, true, "filter shortcut should focus the routed Chrome window")
assertEqual(newPageResult.openedNewPage, true, "new-page shortcut should use Chrome's native new-tab action")
assertEqual(newPageResult.targetFocused, true, "new-page shortcut should focus the routed Chrome window")
assertEqual(newPageResult.otherChromeRaised, false, "new-page shortcut should not raise Chrome on another display")
assertEqual(filterResult.otherChromeRaised, false, "filter shortcut should not raise Chrome on another display")

return "cross-display focus regression: ok"
