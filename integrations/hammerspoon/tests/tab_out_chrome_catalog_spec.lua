local function assertEqual(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s (expected %s, got %s)", message, tostring(expected), tostring(actual)), 2)
  end
end

local function currentDirectory()
  local source = debug.getinfo(1, "S").source
  return source:sub(1, 1) == "@" and source:sub(2):match("^(.*)/[^/]+$") or "."
end

local modulePath = currentDirectory() .. "/../TabOut.spoon/chrome_catalog.lua"
local moduleChunk, loadError = loadfile(modulePath)
assert(moduleChunk, loadError)
local ChromeCatalog = moduleChunk()

local preferencesReadCount = 0
local bridgeRequestCount = 0
local callbackCount = 0
local candidate = {
  id = function()
    return 101
  end,
}

local catalog = ChromeCatalog.new({
  bridge = {
    listProfileWindows = function(_, options, callback)
      bridgeRequestCount = bridgeRequestCount + 1
      assertEqual(options.timeoutSeconds, 3, "profile inventory timeout")
      callback({ 1001 })
      return true
    end,
  },
  configuredProfileDirectory = "Profile 3",
  later = function(_, callback)
    callback()
    return { stop = function() end }
  end,
  onAsyncError = function(message)
    error(message, 2)
  end,
  platform = {
    describeWindow = function(window)
      assertEqual(window, candidate, "native descriptor candidate")
      return {
        bounds = { 1440, 0, 2880, 900 },
        documentUrl = "https://example.test/target",
      }
    end,
    focusedWindowId = function()
      return nil
    end,
    readBrowserWindows = function()
      return {
        {
          bounds = { 1440, 0, 2880, 900 },
          browserWindowId = 1001,
          documentUrl = "https://example.test/target",
        },
      }
    end,
    readLocalState = function()
      return {
        profile = {
          info_cache = {
            ["Profile 3"] = { name = "Target Profile" },
          },
        },
      }
    end,
    readProfileMenu = function()
      return false, "not needed"
    end,
    readSecurePreferences = function()
      preferencesReadCount = preferencesReadCount + 1
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
    end,
  },
  stopTimer = function(timer)
    if timer then
      timer:stop()
    end
  end,
})

catalog:discover({ candidate }, function()
  callbackCount = callbackCount + 1
end)

assertEqual(callbackCount, 1, "discovery should complete exactly once")
assertEqual(bridgeRequestCount, 1, "discovery should request configured-profile windows once")
assertEqual(catalog:profileFor(candidate), "Profile 3", "unique fingerprint should identify the configured profile")

local filterUrl = catalog:filterFocusUrl()
assertEqual(
  filterUrl,
  "chrome-extension://" .. string.rep("a", 32) .. "/index.html?focusFilter=1",
  "filter URL should use the discovered extension"
)
assertEqual(catalog:filterFocusUrl(), filterUrl, "filter URL should be stable")
assertEqual(preferencesReadCount, 1, "extension identity should be cached")

catalog:forget(candidate)
assertEqual(catalog:profileFor(candidate), nil, "destroyed windows should leave the catalog")

return "Chrome catalog regression: ok"
