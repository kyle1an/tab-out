local M = {}

local BRIDGE_VERSION = 1
local MAXIMUM_COORDINATE = 100000
local MAXIMUM_REQUEST_TIMEOUT_SECONDS = 60

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

local function finiteNumber(value)
  return type(value) == "number"
    and value == value
    and value ~= math.huge
    and value ~= -math.huge
end

local function validTargetBounds(bounds)
  return type(bounds) == "table"
    and finiteNumber(bounds.left)
    and math.abs(bounds.left) <= MAXIMUM_COORDINATE
    and finiteNumber(bounds.top)
    and math.abs(bounds.top) <= MAXIMUM_COORDINATE
    and finiteNumber(bounds.width)
    and bounds.width > 0
    and bounds.width <= MAXIMUM_COORDINATE
    and finiteNumber(bounds.height)
    and bounds.height > 0
    and bounds.height <= MAXIMUM_COORDINATE
end

local function validateCreateOptions(options, callback)
  assert(type(options) == "table", "native bridge create options are required")
  assert(
    options.operation == "filter" or options.operation == "newPage",
    "native bridge operation must be filter or newPage"
  )
  assert(validTargetBounds(options.targetBounds), "native bridge targetBounds are invalid")
  assert(
    finiteNumber(options.timeoutSeconds)
      and options.timeoutSeconds > 0
      and options.timeoutSeconds <= MAXIMUM_REQUEST_TIMEOUT_SECONDS,
    "native bridge timeoutSeconds must be between 0 and 60"
  )
  assert(type(callback) == "function", "native bridge callback is required")
end

local function validateTimeoutOptions(options, callback)
  assert(type(options) == "table", "native bridge request options are required")
  assert(
    finiteNumber(options.timeoutSeconds)
      and options.timeoutSeconds > 0
      and options.timeoutSeconds <= MAXIMUM_REQUEST_TIMEOUT_SECONDS,
    "native bridge timeoutSeconds must be between 0 and 60"
  )
  assert(type(callback) == "function", "native bridge callback is required")
end

local function startRequest(client, payload, callback)
  if not client:isReady() then
    client.connected = false
    return false, "The native bridge host is not installed"
  end

  local encodedOk, encoded = pcall(hs.json.encode, payload)
  if not encodedOk or type(encoded) ~= "string" then
    return false, "The native bridge request could not be encoded: " .. tostring(encoded)
  end

  local task
  task = hs.task.new(client.hostPath, function(exitCode, standardOutput, standardError)
    client.activeTasks[task] = nil

    if exitCode ~= 0 then
      client.connected = false
      local detail = trim(standardError)
      callback(false, detail ~= "" and detail or "The native bridge request failed")
      return
    end

    local decoded, response = pcall(hs.json.decode, trim(standardOutput))
    if not decoded then
      client.connected = false
      callback(false, "The native bridge returned invalid JSON: " .. tostring(response))
      return
    end
    local validationError = responseError(response, payload.requestId)
    if validationError then
      client.connected = false
      callback(false, validationError)
      return
    end

    client.connected = true
    callback(response.status == "accepted", response.reason, response)
  end, { "--request", encoded })

  if not task then
    client.connected = false
    return false, "The native bridge client process could not be created"
  end

  client.activeTasks[task] = true
  if not task:start() then
    client.activeTasks[task] = nil
    client.connected = false
    return false, "The native bridge client process could not be started"
  end

  return true
end

function M.new(config)
  assert(type(config) == "table", "native bridge config is required")
  assert(type(config.hostPath) == "string", "native bridge hostPath is required")

  local client = {
    activeTasks = {},
    connected = false,
    hostPath = config.hostPath,
    nextRequestId = 0,
  }

  function client:isReady()
    return hs.fs.attributes(self.hostPath, "mode") == "file"
  end

  function client:createWindow(options, callback)
    validateCreateOptions(options, callback)

    self.nextRequestId = self.nextRequestId + 1
    local timestampMs = math.floor(hs.timer.secondsSinceEpoch() * 1000)
    local requestId = string.format("hs-%d-%d", timestampMs, self.nextRequestId)
    return startRequest(self, {
      version = BRIDGE_VERSION,
      type = "create-window",
      requestId = requestId,
      expiresAtMs = timestampMs + math.floor(options.timeoutSeconds * 1000),
      operation = options.operation,
      targetBounds = options.targetBounds,
    }, callback)
  end

  function client:listProfileWindows(options, callback)
    validateTimeoutOptions(options, callback)

    self.nextRequestId = self.nextRequestId + 1
    local timestampMs = math.floor(hs.timer.secondsSinceEpoch() * 1000)
    local requestId = string.format("hs-%d-%d", timestampMs, self.nextRequestId)
    return startRequest(self, {
      version = BRIDGE_VERSION,
      type = "list-profile-windows",
      requestId = requestId,
      expiresAtMs = timestampMs + math.floor(options.timeoutSeconds * 1000),
    }, function(accepted, requestError, response)
      if not accepted then
        callback(nil, requestError)
        return
      end

      local windowIds = response and response.windowIds or nil
      if type(windowIds) ~= "table" then
        self.connected = false
        callback(nil, "The native bridge returned an invalid profile-window inventory")
        return
      end

      local validated = {}
      local seen = {}
      for _, windowId in ipairs(windowIds) do
        if not finiteNumber(windowId)
          or windowId <= 0
          or windowId % 1 ~= 0
          or seen[windowId]
        then
          self.connected = false
          callback(nil, "The native bridge returned an invalid profile-window identity")
          return
        end
        seen[windowId] = true
        table.insert(validated, windowId)
      end
      callback(validated)
    end)
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
