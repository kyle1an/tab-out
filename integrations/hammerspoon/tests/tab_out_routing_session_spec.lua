local function assertEqual(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s (expected %s, got %s)", message, tostring(expected), tostring(actual)), 2)
  end
end

local function currentDirectory()
  local source = debug.getinfo(1, "S").source
  return source:sub(1, 1) == "@" and source:sub(2):match("^(.*)/[^/]+$") or "."
end

local modulePath = currentDirectory() .. "/../TabOut.spoon/routing_session.lua"
local moduleChunk, loadError = loadfile(modulePath)
assert(moduleChunk, loadError)
local RoutingSession = moduleChunk()

local cleanupCount = 0
local failureMessage
local processed = {}
local scheduled = {}
local session = RoutingSession.new({
  cleanup = function()
    cleanupCount = cleanupCount + 1
  end,
  later = function(delay, callback)
    assertEqual(delay, 0.08, "queue drain delay")
    table.insert(scheduled, callback)
  end,
  prepare = function(kind)
    if kind == "blocked" then
      return nil, "Routing unavailable", "test reason"
    end
    return { kind = kind }
  end,
  process = function(request)
    table.insert(processed, request.kind)
  end,
  releaseBeforeFailure = function() end,
  reportFailure = function(message, detail)
    failureMessage = message .. ": " .. detail
  end,
})

assertEqual(session:enqueue("filter"), true, "first request should be accepted")
assertEqual(session:isBusy(), true, "processing should mark the session busy")
assertEqual(session:current().kind, "filter", "current request should be visible through the session seam")
assertEqual(processed[1], "filter", "first request should begin immediately")

assertEqual(session:enqueue("newPage"), true, "second request should be queued")
assertEqual(session:queueDepth(), 1, "queued request count")
session:finish()
assertEqual(cleanupCount, 1, "finishing should clean up the active request")
assertEqual(session:isBusy(), false, "finishing should release the session before draining")
assertEqual(#scheduled, 1, "finishing should schedule one queue drain")
scheduled[1]()
assertEqual(processed[2], "newPage", "scheduled drain should start the next request")

session:fail("Automation failed", "example failure")
assertEqual(failureMessage, "Automation failed: example failure", "active failures should be reported")
assertEqual(cleanupCount, 2, "failure should finish and clean up the active request")

assertEqual(session:enqueue("blocked"), false, "preflight rejection should not enter the queue")
assertEqual(failureMessage, "Routing unavailable: test reason", "preflight rejection should be reported")
assertEqual(session:queueDepth(), 0, "preflight rejection should not change the queue")

return "routing session regression: ok"
