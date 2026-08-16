local function assertEqual(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s (expected %s, got %s)", message, tostring(expected), tostring(actual)), 2)
  end
end

local source = debug.getinfo(1, "S").source
local directory = source:sub(1, 1) == "@" and source:sub(2):match("^(.*)/[^/]+$") or "."
local catalogChunk, loadError = loadfile(directory .. "/../TabOut.spoon/chrome_catalog.lua")
assert(catalogChunk, loadError)
local ChromeCatalog = catalogChunk()

local browserInventory = {}
local fakeHs = {
  application = {
    get = function() return {} end,
  },
  axuielement = {
    windowElement = function(window)
      return {
        attributeValue = function(_, attribute)
          return attribute == "AXDocument" and window.documentUrl or nil
        end,
      }
    end,
  },
  json = hs.json,
  osascript = {
    applescript = function()
      return true, browserInventory, nil
    end,
  },
}

local catalog = ChromeCatalog.new({
  chromeBundleId = "com.google.Chrome",
  chromeUserDataDirectory = "/tmp/tab-out-chrome-catalog-test",
  configuredProfileDirectory = "Profile 1",
  hs = fakeHs,
  later = function() return {} end,
  stopTimer = function() end,
})

local function nativeWindow(id, bounds, documentUrl)
  return {
    documentUrl = documentUrl,
    frame = function()
      return {
        x = bounds[1],
        y = bounds[2],
        w = bounds[3] - bounds[1],
        h = bounds[4] - bounds[2],
      }
    end,
    id = function() return id end,
  }
end

local sharedBounds = { 0, 0, 1200, 800 }
local sharedUrl = "chrome://newtab/"
local frontWindow = nativeWindow(201, sharedBounds, sharedUrl)
local middleWindow = nativeWindow(202, sharedBounds, sharedUrl)
local backWindow = nativeWindow(203, sharedBounds, sharedUrl)

browserInventory = {
  { 101, sharedBounds, sharedUrl },
  { 102, sharedBounds, sharedUrl },
  { 103, sharedBounds, sharedUrl },
}

local duplicateMapping, duplicateError = catalog:browserWindowIdsFor(
  { backWindow, frontWindow, middleWindow },
  { frontWindow, middleWindow, backWindow }
)
assert(duplicateMapping, duplicateError)
assertEqual(duplicateMapping[201], 101, "front duplicate uses front browser identity")
assertEqual(duplicateMapping[202], 102, "middle duplicate uses middle browser identity")
assertEqual(duplicateMapping[203], 103, "back duplicate uses back browser identity")

local uniqueBounds = { 20, 20, 900, 700 }
local uniqueUrl = "https://example.test/unique"
local uniqueWindow = nativeWindow(204, uniqueBounds, uniqueUrl)
browserInventory = {
  { 101, sharedBounds, sharedUrl },
  { 102, sharedBounds, sharedUrl },
  { 103, sharedBounds, sharedUrl },
  { 104, uniqueBounds, uniqueUrl },
}

local uniqueMapping, uniqueError = catalog:browserWindowIdsFor(
  { uniqueWindow },
  { uniqueWindow }
)
assert(uniqueMapping, uniqueError)
assertEqual(
  uniqueMapping[204],
  104,
  "an unrelated duplicate fingerprint does not block a unique candidate"
)

browserInventory = {
  { 101, sharedBounds, sharedUrl },
  { 102, sharedBounds, sharedUrl },
  { 103, sharedBounds, sharedUrl },
}
local partialMapping, partialError = catalog:browserWindowIdsFor(
  { frontWindow, middleWindow },
  { frontWindow, middleWindow }
)
assertEqual(partialMapping, nil, "a partially visible duplicate group remains unavailable")
assert(
  partialError and partialError:find("ambiguous", 1, true),
  "a partially visible duplicate group identifies the ambiguity"
)

return true
