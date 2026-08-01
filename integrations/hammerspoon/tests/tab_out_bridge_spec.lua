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
    version = 1,
    type = "response",
    requestId = encodedPayload and encodedPayload.requestId or "missing-request",
    status = status,
  }
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
        return response("accepted", { version = 2 })
      end
      if value == "rejected" then
        return response("rejected", { reason = "extension rejected request" })
      end
      return response("accepted")
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
local started, startError = bridge:createWindow(createOptions(), function(accepted, requestError)
  callbackAccepted = accepted
  callbackError = requestError
end)

assertEqual(started, true, "installed native bridge should start its client")
assertEqual(startError, nil, "successful native bridge start should not return an error")
assertEqual(taskPath, "/tmp/tab-out-native-bridge", "native bridge should launch the configured host")
assertEqual(taskArguments[1], "--request", "native bridge should use client request mode")
assertEqual(taskArguments[2], "encoded-request", "native bridge should pass the encoded request as one argument")
assertEqual(encodedPayload.version, 1, "native bridge should own the protocol version")
assertEqual(encodedPayload.type, "create-window", "native bridge should own the wire request type")
assertEqual(encodedPayload.requestId, "hs-1800000000000-1", "native bridge should generate the request ID")
assertEqual(encodedPayload.expiresAtMs, 1800000012000, "native bridge should derive the wire deadline")
assertEqual(encodedPayload.operation, "filter", "native bridge should encode the placement operation")
assertEqual(encodedPayload.targetBounds.left, 1440, "native bridge should encode the target display bounds")
assertEqual(callbackAccepted, true, "accepted native bridge response should report semantic success")
assertEqual(callbackError, nil, "accepted native bridge response should not return an error")
assertEqual(bridge:status().connected, true, "accepted native bridge response should prove connectivity")

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
