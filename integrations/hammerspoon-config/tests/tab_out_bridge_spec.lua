local function assertEqual(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s (expected %s, got %s)", message, tostring(expected), tostring(actual)), 2)
  end
end

local function currentDirectory()
  local source = debug.getinfo(1, "S").source
  return source:sub(1, 1) == "@" and source:sub(2):match("^(.*)/[^/]+$") or "."
end

local modulePath = currentDirectory() .. "/../modules/tab_out_bridge.lua"
local filePresent = true
local nextExitCode = 0
local nextStandardError = ""
local nextStandardOutput = "accepted"
local taskArguments
local taskPath

local responses = {
  accepted = {
    version = 1,
    type = "response",
    requestId = "hs-test-1",
    status = "accepted",
  },
  rejected = {
    version = 1,
    type = "response",
    requestId = "hs-test-1",
    status = "rejected",
    reason = "extension rejected request",
  },
}

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
      return responses[value]
    end,
    encode = function()
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
}

local environment = setmetatable({ hs = fakeHs }, { __index = _G })
local chunk, loadError = loadfile(modulePath, "t", environment)
assert(chunk, loadError)
local bridgeModule = chunk()
local bridge = bridgeModule.new({ hostPath = "/tmp/tab-out-native-bridge" })
local payload = {
  version = 1,
  type = "status",
  requestId = "hs-test-1",
  expiresAtMs = 1800000012000,
}

local initialStatus = bridge:status()
assertEqual(initialStatus.hostInstalled, true, "native bridge status should report the installed host")
assertEqual(initialStatus.connected, false, "native bridge status should not claim connectivity before a response")

local callbackResponse
local callbackError
local started, startError = bridge:request(payload, function(response, requestError)
  callbackResponse = response
  callbackError = requestError
end)

assertEqual(started, true, "installed native bridge should start its client")
assertEqual(startError, nil, "successful native bridge start should not return an error")
assertEqual(taskPath, "/tmp/tab-out-native-bridge", "native bridge should launch the configured host")
assertEqual(taskArguments[1], "--request", "native bridge should use client request mode")
assertEqual(taskArguments[2], "encoded-request", "native bridge should pass the encoded request as one argument")
assertEqual(callbackResponse.status, "accepted", "native bridge should return an accepted response")
assertEqual(callbackError, nil, "accepted native bridge response should not return a transport error")
assertEqual(bridge:status().connected, true, "accepted native bridge response should prove connectivity")

nextStandardOutput = "rejected"
callbackResponse = nil
bridge:request(payload, function(response, requestError)
  callbackResponse = response
  callbackError = requestError
end)
assertEqual(callbackResponse.status, "rejected", "extension rejection should remain a structured response")
assertEqual(callbackResponse.reason, "extension rejected request", "extension rejection reason should be preserved")
assertEqual(callbackError, nil, "extension rejection is not a transport failure")
assertEqual(bridge:status().connected, true, "structured extension rejection should preserve connectivity")

nextExitCode = 1
nextStandardError = "bridge is disconnected"
callbackResponse = nil
callbackError = nil
bridge:request(payload, function(response, requestError)
  callbackResponse = response
  callbackError = requestError
end)
assertEqual(callbackResponse, nil, "failed native bridge process should not return a response")
assertEqual(callbackError, "bridge is disconnected", "failed native bridge process should return stderr")
assertEqual(bridge:status().connected, false, "failed native bridge process should clear connectivity")

filePresent = false
local missingStarted, missingError = bridge:request(payload, function() end)
assertEqual(missingStarted, false, "missing native bridge host should abort before launching a task")
assertEqual(missingError, "The native bridge host is not installed", "missing native bridge host should explain the Safe Abort")
assertEqual(bridge:status().connected, false, "missing native bridge host should not report connectivity")

return "native bridge client regression: ok"
