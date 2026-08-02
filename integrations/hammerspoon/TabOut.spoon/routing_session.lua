local M = {}

function M.new(options)
  assert(type(options) == "table", "Routing session options must be a table")
  assert(type(options.cleanup) == "function", "cleanup is required")
  assert(type(options.later) == "function", "later is required")
  assert(type(options.prepare) == "function", "prepare is required")
  assert(type(options.process) == "function", "process is required")
  assert(type(options.releaseBeforeFailure) == "function", "releaseBeforeFailure is required")
  assert(type(options.reportFailure) == "function", "reportFailure is required")

  local busy = false
  local currentRequest
  local queue = {}
  local session = {}

  local function drain()
    if busy or #queue == 0 then
      return
    end

    currentRequest = table.remove(queue, 1)
    busy = true
    local ok, err = xpcall(function()
      options.process(currentRequest)
    end, debug.traceback)

    if not ok then
      session:fail("Automation failed", err)
    end
  end

  function session:current()
    return currentRequest
  end

  function session:enqueue(kind)
    local request, message, detail = options.prepare(kind)
    if not request then
      options.reportFailure(message, detail)
      return false
    end

    table.insert(queue, request)
    drain()
    return true
  end

  function session:fail(message, detail)
    if not busy then
      return false
    end

    options.releaseBeforeFailure()
    options.reportFailure(message, detail, currentRequest)
    self:finish()
    return true
  end

  function session:finish()
    if not busy then
      return false
    end

    options.cleanup(currentRequest)
    busy = false
    currentRequest = nil
    options.later(0.08, drain, false)
    return true
  end

  function session:isBusy()
    return busy
  end

  function session:isCurrent(request)
    return currentRequest == request
  end

  function session:queueDepth()
    return #queue
  end

  return session
end

return M
