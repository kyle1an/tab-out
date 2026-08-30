local function assertEqual(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s (expected %s, got %s)", message, tostring(expected), tostring(actual)), 2)
  end
end

local function assertMatch(actual, pattern, message)
  if type(actual) ~= "string" or not actual:match(pattern) then
    error(string.format("%s (expected %s to match %s)", message, tostring(actual), pattern), 2)
  end
end

local function currentDirectory()
  local source = debug.getinfo(1, "S").source
  return source:sub(1, 1) == "@" and source:sub(2):match("^(.*)/[^/]+$") or "."
end

local modulePath = currentDirectory() .. "/../TabOut.spoon/bridge.lua"
local filePresent = true
local nextExitCode = 0
local nextStandardError = ""
local nextStandardOutput = "accepted"
local encodedPayload
local taskArguments
local taskPath

local function response(status, overrides)
  local value = {
    version = 6,
    type = "response",
    requestId = encodedPayload and encodedPayload.requestId or "missing-request",
    status = status,
  }
  if status == "accepted" then
    value.browserProcessId = 43250
  end
  for key, field in pairs(overrides or {}) do
    value[key] = field
  end
  return value
end

local fakeHs = {
  fs = {
    attributes = function(_, attribute)
      if filePresent and attribute == "mode" then
        return "file"
      end
      return nil
    end,
  },
  json = {
    decode = function(value)
      if value == "invalid-json" then
        error("invalid JSON")
      end
      if value == "wrong-version" then
        return response("accepted", { version = 3 })
      end
      if value == "wrong-request-id" then
        return response("accepted", { requestId = "another-request" })
      end
      if value == "rejected" then
        return response("rejected", { reason = "extension rejected request" })
      end
      if value == "profile-windows" then
        return response("accepted", { windowIds = { 71, 72 } })
      end
      if value == "missing-created-window" then
        return response("accepted")
      end
      if value == "invalid-created-window" then
        return response("accepted", { browserWindowId = 91.5 })
      end
      if value == "missing-process" then
        local result = response("accepted", { browserWindowId = 91 })
        result.browserProcessId = nil
        return result
      end
      if value == "invalid-process" then
        return response("accepted", { browserProcessId = 1, browserWindowId = 91 })
      end
      return response("accepted", { browserWindowId = 91 })
    end,
    encode = function(value)
      encodedPayload = value
      return "encoded-request"
    end,
  },
  task = {
    new = function(path, callback, arguments)
      taskPath = path
      taskArguments = arguments
      return {
        start = function()
          callback(nextExitCode, nextStandardOutput, nextStandardError)
          return true
        end,
      }
    end,
  },
  timer = {
    secondsSinceEpoch = function()
      return 1800000000
    end,
  },
}

local environment = setmetatable({ hs = fakeHs }, { __index = _G })
local chunk, loadError = loadfile(modulePath, "t", environment)
assert(chunk, loadError)
local bridgeModule = chunk()
local bridge = bridgeModule.new({ hostPath = "/tmp/tab-out-native-bridge" })

local function createOptions(overrides)
  local options = {
    expectedBrowserProcessId = 43250,
    operation = "filter",
    targetBounds = {
      height = 900,
      left = 1440,
      top = 0,
      width = 1440,
    },
    timeoutSeconds = 12,
  }
  for key, value in pairs(overrides or {}) do
    options[key] = value
  end
  return options
end

local initialStatus = bridge:status()
assertEqual(initialStatus.hostInstalled, true, "native bridge status should report the installed host")
assertEqual(initialStatus.connected, false, "native bridge status should not claim connectivity before a response")

local callbackAccepted
local callbackError
local callbackIdentity
local started, startError = bridge:createWindow(createOptions(), function(
  accepted,
  requestError,
  identity
)
  callbackAccepted = accepted
  callbackError = requestError
  callbackIdentity = identity
end)

assertEqual(started, true, "installed native bridge should start its client")
assertEqual(startError, nil, "successful native bridge start should not return an error")
assertEqual(taskPath, "/tmp/tab-out-native-bridge", "native bridge should launch the configured host")
assertEqual(taskArguments[1], "--request", "native bridge should use client request mode")
assertEqual(taskArguments[2], "encoded-request", "native bridge should pass the encoded request as one argument")
assertEqual(encodedPayload.version, 6, "native bridge should own the protocol version")
assertEqual(encodedPayload.type, "create-window", "native bridge should own the wire request type")
assertEqual(encodedPayload.requestId, "hs-1800000000000-1", "native bridge should generate the request ID")
assertEqual(encodedPayload.expiresAtMs, 1800000012000, "native bridge should derive the wire deadline")
assertEqual(
  encodedPayload.expectedBrowserProcessId,
  43250,
  "native bridge should bind creation to the already-authorized Chrome process"
)
assertEqual(encodedPayload.operation, "filter", "native bridge should encode the placement operation")
assertEqual(encodedPayload.targetBounds.left, 1440, "native bridge should encode the target display bounds")
assertEqual(callbackAccepted, true, "accepted native bridge response should report semantic success")
assertEqual(callbackError, nil, "accepted native bridge response should not return an error")
assertEqual(callbackIdentity.browserProcessId, 43250, "accepted response should return configured Chrome authority")
assertEqual(callbackIdentity.browserWindowId, 91, "accepted native bridge response should return its browser window ID")
assertEqual(callbackIdentity.creationToken, "hs-1800000000000-1", "accepted response should return its exact request token")
assertEqual(bridge:status().connected, true, "accepted native bridge response should prove connectivity")

nextStandardOutput = "profile-windows"
local profileInventory
local profileWindowError
local inventoryStarted, inventoryStartError = bridge:listProfileWindows({ timeoutSeconds = 3 }, function(inventory, requestError)
  profileInventory = inventory
  profileWindowError = requestError
end)
assertEqual(inventoryStarted, true, "profile-window discovery should start its native bridge client")
assertEqual(inventoryStartError, nil, "profile-window discovery should not return a start error")
assertEqual(encodedPayload.type, "list-profile-windows", "profile-window discovery should own its wire request type")
assertEqual(encodedPayload.expiresAtMs, 1800000003000, "profile-window discovery should derive its wire deadline")
assertEqual(profileInventory.browserProcessId, 43250, "profile-window discovery should return configured Chrome authority")
assertEqual(profileInventory.windowIds[1], 71, "profile-window discovery should preserve the first browser window ID")
assertEqual(profileInventory.windowIds[2], 72, "profile-window discovery should preserve the second browser window ID")
assertEqual(profileWindowError, nil, "accepted profile-window discovery should not return an error")

nextStandardOutput = "rejected"
callbackAccepted = nil
callbackError = nil
bridge:createWindow(createOptions({ operation = "newPage" }), function(accepted, requestError)
  callbackAccepted = accepted
  callbackError = requestError
end)
assertEqual(callbackAccepted, false, "extension rejection should report semantic rejection")
assertEqual(callbackError, "extension rejected request", "extension rejection reason should be preserved")
assertEqual(bridge:status().connected, true, "structured extension rejection should preserve connectivity")

nextStandardOutput = "missing-created-window"
callbackAccepted = nil
callbackError = nil
callbackIdentity = nil
bridge:createWindow(createOptions(), function(accepted, requestError, identity)
  callbackAccepted = accepted
  callbackError = requestError
  callbackIdentity = identity
end)
assertEqual(callbackAccepted, false, "missing created-window identity should reject the bridge response")
assertMatch(callbackError, "created browser window identity", "missing identity should explain the protocol failure")
assertEqual(callbackIdentity, nil, "missing created-window identity should not leak a candidate")
assertEqual(bridge:status().connected, false, "missing created-window identity should clear connectivity")

nextStandardOutput = "invalid-created-window"
callbackAccepted = nil
callbackError = nil
bridge:createWindow(createOptions(), function(accepted, requestError)
  callbackAccepted = accepted
  callbackError = requestError
end)
assertEqual(callbackAccepted, false, "nonintegral created-window identity should reject the bridge response")
assertMatch(callbackError, "created browser window identity", "invalid identity should explain the protocol failure")
assertEqual(bridge:status().connected, false, "invalid created-window identity should clear connectivity")

nextExitCode = 1
nextStandardError = "bridge is disconnected"
callbackAccepted = nil
callbackError = nil
bridge:createWindow(createOptions(), function(accepted, requestError)
  callbackAccepted = accepted
  callbackError = requestError
end)
assertEqual(callbackAccepted, false, "failed bridge process should report semantic rejection")
assertEqual(callbackError, "bridge is disconnected", "failed bridge process should return stderr")
assertEqual(bridge:status().connected, false, "failed bridge process should clear connectivity")

nextExitCode = 0
nextStandardError = ""
nextStandardOutput = "wrong-version"
callbackAccepted = nil
callbackError = nil
bridge:createWindow(createOptions(), function(accepted, requestError)
  callbackAccepted = accepted
  callbackError = requestError
end)
assertEqual(callbackAccepted, false, "invalid bridge response should report semantic rejection")
assertMatch(callbackError, "version does not match", "invalid bridge response should explain the protocol failure")
assertEqual(bridge:status().connected, false, "invalid bridge response should clear connectivity")

nextStandardOutput = "wrong-request-id"
callbackAccepted = nil
callbackError = nil
bridge:createWindow(createOptions(), function(accepted, requestError)
  callbackAccepted = accepted
  callbackError = requestError
end)
assertEqual(callbackAccepted, false, "another request's response should report semantic rejection")
assertMatch(callbackError, "another request", "another request's response should explain the protocol failure")
assertEqual(bridge:status().connected, false, "another request's response should clear connectivity")

nextStandardOutput = "missing-process"
callbackAccepted = nil
callbackError = nil
bridge:createWindow(createOptions(), function(accepted, requestError)
  callbackAccepted = accepted
  callbackError = requestError
end)
assertEqual(callbackAccepted, false, "missing configured Chrome authority should reject the response")
assertMatch(callbackError, "configured Chrome process identity", "missing process authority should explain the mismatch")
assertEqual(bridge:status().connected, false, "missing process authority should clear connectivity")

nextStandardOutput = "invalid-process"
callbackAccepted = nil
callbackError = nil
bridge:createWindow(createOptions(), function(accepted, requestError)
  callbackAccepted = accepted
  callbackError = requestError
end)
assertEqual(callbackAccepted, false, "invalid configured Chrome authority should reject the response")
assertMatch(callbackError, "configured Chrome process identity", "invalid process authority should explain the mismatch")

filePresent = false
local missingStarted, missingError = bridge:createWindow(createOptions(), function() end)
assertEqual(missingStarted, false, "missing native bridge host should abort before launching a task")
assertEqual(missingError, "The native bridge host is not installed", "missing native bridge host should explain the Safe Abort")
assertEqual(bridge:status().connected, false, "missing native bridge host should not report connectivity")

local validCall, validationError = pcall(function()
  bridge:createWindow(createOptions({ operation = "unknown" }), function() end)
end)
assertEqual(validCall, false, "native bridge should reject an invalid semantic operation")
assertMatch(validationError, "operation", "invalid operation should explain the interface violation")

validCall, validationError = pcall(function()
  bridge:createWindow(createOptions({ targetBounds = { height = 900, left = 0, top = 0, width = 0 } }), function() end)
end)
assertEqual(validCall, false, "native bridge should reject invalid semantic bounds")
assertMatch(validationError, "targetBounds", "invalid bounds should explain the interface violation")

validCall, validationError = pcall(function()
  bridge:createWindow(createOptions({ timeoutSeconds = 61 }), function() end)
end)
assertEqual(validCall, false, "native bridge should reject an unsupported timeout budget")
assertMatch(validationError, "timeoutSeconds", "invalid timeout should explain the interface violation")

validCall, validationError = pcall(function()
  bridge:createWindow(createOptions(), nil)
end)
assertEqual(validCall, false, "native bridge should require a completion callback")
assertMatch(validationError, "callback", "missing callback should explain the interface violation")

return "native bridge client regression: ok"
