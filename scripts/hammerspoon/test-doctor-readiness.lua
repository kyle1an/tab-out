local source = debug.getinfo(1, "S").source
local scriptDirectory = source:match("^@(.+)/[^/]+$")
assert(scriptDirectory, "could not resolve doctor readiness test directory")

local readiness = dofile(scriptDirectory .. "/doctor-readiness.lua")

local function expect(actual, expected)
  assert(actual == expected, string.format("expected %q, got %q", expected, actual))
end

local function readyStatus()
  return {
    accessibility = true,
    desktopWindowControllerAvailable = true,
    desktopWindowControllerReady = true,
    extensionReady = true,
    nativeBridgeInstalled = true,
    nativeBridgeReady = false,
    privateFocusReady = true,
    profileMetadataReady = true,
    started = true,
  }
end

local function tabOutWithStatus(status)
  return {
    status = function()
      return status
    end,
  }
end

expect(readiness.evaluate(tabOutWithStatus(readyStatus())), "ready")

local requiredFields = {
  { "started", "Spoon start" },
  { "accessibility", "Accessibility permission" },
  { "privateFocusReady", "private exact-window focus" },
  { "nativeBridgeInstalled", "Native Placement Bridge host installation" },
  { "desktopWindowControllerReady", "desktop-window controller connection" },
  { "profileMetadataReady", "configured-profile metadata" },
  { "extensionReady", "configured-profile extension discovery" },
}

for _, requiredField in ipairs(requiredFields) do
  local status = readyStatus()
  status[requiredField[1]] = false
  expect(
    readiness.evaluate(tabOutWithStatus(status)),
    "missing:" .. requiredField[2]
  )
end

local truthyAccessibility = readyStatus()
truthyAccessibility.accessibility = "yes"
expect(
  readiness.evaluate(tabOutWithStatus(truthyAccessibility)),
  "missing:Accessibility permission"
)

expect(readiness.evaluate(nil), "missing:Tab Out Spoon")
expect(
  readiness.evaluate(tabOutWithStatus("not a status table")),
  "invalid:Tab Out status() did not return a table"
)

local statusWithoutBridgeHistory = readyStatus()
statusWithoutBridgeHistory.nativeBridgeReady = nil
expect(readiness.evaluate(tabOutWithStatus(statusWithoutBridgeHistory)), "ready")

local disconnectedController = readyStatus()
disconnectedController.desktopWindowControllerAvailable = true
disconnectedController.desktopWindowControllerReady = false
expect(
  readiness.evaluate(tabOutWithStatus(disconnectedController)),
  "missing:desktop-window controller connection"
)
expect(
  readiness.evaluate(
    tabOutWithStatus(disconnectedController),
    { expectUnpairedProfile = true }
  ),
  "ready"
)

return "doctor readiness policy regression: ok"
