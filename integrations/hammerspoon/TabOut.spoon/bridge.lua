local M = {}

local BRIDGE_VERSION = 1

local function trim(value)
  if type(value) ~= "string" then
    return ""
  end
  return value:match("^%s*(.-)%s*$")
end

local function responseError(response, requestId)
  if type(response) ~= "table" then
    return "The native bridge returned invalid JSON"
  end
  if response.version ~= BRIDGE_VERSION then
    return "The native bridge protocol version does not match"
  end
  if response.type ~= "response" or response.requestId ~= requestId then
    return "The native bridge returned a response for another request"
  end
  if response.status ~= "accepted" and response.status ~= "rejected" then
    return "The native bridge returned an invalid status"
  end
  return nil
end

function M.new(config)
  assert(type(config) == "table", "native bridge config is required")
  assert(type(config.hostPath) == "string", "native bridge hostPath is required")

  local client = {
    activeTasks = {},
    connected = false,
    hostPath = config.hostPath,
  }

  function client:isReady()
    return hs.fs.attributes(self.hostPath, "mode") == "file"
  end

  function client:request(payload, callback)
    assert(type(payload) == "table", "native bridge payload is required")
    assert(type(callback) == "function", "native bridge callback is required")

    if not self:isReady() then
      self.connected = false
      return false, "The native bridge host is not installed"
    end

    local encodedOk, encoded = pcall(hs.json.encode, payload)
    if not encodedOk or type(encoded) ~= "string" then
      return false, "The native bridge request could not be encoded: " .. tostring(encoded)
    end

    local task
    task = hs.task.new(self.hostPath, function(exitCode, standardOutput, standardError)
      self.activeTasks[task] = nil

      if exitCode ~= 0 then
        self.connected = false
        local detail = trim(standardError)
        callback(nil, detail ~= "" and detail or "The native bridge request failed")
        return
      end

      local decoded, response = pcall(hs.json.decode, trim(standardOutput))
      if not decoded then
        self.connected = false
        callback(nil, "The native bridge returned invalid JSON: " .. tostring(response))
        return
      end
      local validationError = responseError(response, payload.requestId)
      if validationError then
        self.connected = false
        callback(nil, validationError)
        return
      end

      self.connected = true
      callback(response, nil)
    end, { "--request", encoded })

    if not task then
      self.connected = false
      return false, "The native bridge client process could not be created"
    end

    self.activeTasks[task] = true
    if not task:start() then
      self.activeTasks[task] = nil
      self.connected = false
      return false, "The native bridge client process could not be started"
    end

    return true
  end

  function client:status()
    local activeTaskCount = 0
    for _ in pairs(self.activeTasks) do
      activeTaskCount = activeTaskCount + 1
    end
    return {
      activeRequests = activeTaskCount,
      connected = self.connected,
      hostInstalled = self:isReady(),
      hostPath = self.hostPath,
      version = BRIDGE_VERSION,
    }
  end

  return client
end

return M
