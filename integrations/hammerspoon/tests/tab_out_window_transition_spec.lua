local function assertEqual(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s (expected %s, got %s)", message, tostring(expected), tostring(actual)), 2)
  end
end

local function currentDirectory()
  local source = debug.getinfo(1, "S").source
  return source:sub(1, 1) == "@" and source:sub(2):match("^(.*)/[^/]+$") or "."
end

local modulePath = currentDirectory() .. "/../TabOut.spoon/window_transition.lua"
local moduleChunk, loadError = loadfile(modulePath)
assert(moduleChunk, loadError)
local WindowTransition = moduleChunk()

local deletedCount = 0
local visible = false
local shield = {}
function shield:bringToFront()
  return self
end
function shield:canvasMouseEvents()
  return self
end
function shield:delete()
  deletedCount = deletedCount + 1
  visible = false
end
function shield:show()
  visible = true
  return self
end

local transition = WindowTransition.new({
  catalog = {},
  chromeBundleId = "com.google.Chrome",
  configuredProfileDirectory = "Profile 3",
  currentRequest = function()
    return nil
  end,
  fail = function(message)
    error(message, 2)
  end,
  finish = function() end,
  hs = {
    canvas = {
      new = function(frame)
        assertEqual(frame.w, 1440, "shield width")
        return shield
      end,
    },
    screenRecordingState = function()
      return true
    end,
  },
  later = function() end,
  log = {},
  privateFocus = {},
})

local captured, captureError = transition:captureShield({
  fullFrame = function()
    return { h = 900, w = 1440, x = 0, y = 0 }
  end,
  snapshot = function()
    return { name = "snapshot" }
  end,
})
assertEqual(captured, true, captureError or "shield should be captured")
assertEqual(visible, true, "captured shield should be visible")
transition:releaseShield()
assertEqual(visible, false, "release should hide the shield")
assertEqual(deletedCount, 1, "release should delete the shield exactly once")
transition:releaseShield()
assertEqual(deletedCount, 1, "release should be idempotent")

assertEqual(type(transition.activateCreated), "function", "created-window activation seam")
assertEqual(type(transition.activateExisting), "function", "existing-window activation seam")
assertEqual(type(transition.registerCreatedWindow), "function", "created-window recovery seam")
assertEqual(type(transition.handleWindowDestroyed), "function", "window-destruction seam")

return "window transition regression: ok"
