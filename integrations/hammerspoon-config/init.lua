require("hs.ipc")

hs.autoLaunch(true)
hs.automaticallyCheckForUpdates(false)

local log = hs.logger.new("config", "info")
local configRoot = hs.fs.pathToAbsolute(hs.configdir)
local reloadTimer

local function containsLuaChange(paths)
  for _, path in ipairs(paths) do
    if path:match("%.lua$") then
      return true
    end
  end

  return false
end

_G.hammerspoonConfigWatcher = hs.pathwatcher.new(configRoot, function(paths)
  if not containsLuaChange(paths) then
    return
  end

  if reloadTimer then
    reloadTimer:stop()
  end

  reloadTimer = hs.timer.doAfter(0.35, hs.reload)
end):start()

if not hs.accessibilityState(true) then
  log.w("Accessibility permission is required; relaunch Hammerspoon after granting it")
  hs.alert.show("Hammerspoon needs Accessibility permission", nil, hs.screen.mainScreen(), 3)
  return
end

local homeDirectory = os.getenv("HOME")

_G.tabOutAutomation = require("modules.tab_out")
_G.tabOutAutomation.start({
  chromeBundleId = "com.google.Chrome",
  chromeProfileDirectory = "Profile 3",
  chromeUserDataDirectory = homeDirectory .. "/Library/Application Support/Google/Chrome",
  shortcuts = {
    filter = {
      key = "k",
      modifiers = { "cmd", "shift" },
    },
    newPage = {
      key = "space",
      modifiers = { "cmd", "shift" },
    },
  },
})

log.i("Hammerspoon configuration loaded")
