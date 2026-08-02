local M = {}

M.name = "Tab Out"
M.version = "1.0.0"
M.author = "Tab Out contributors"
M.license = "MIT"

local moduleSource = debug.getinfo(1, "S").source
local modulePath = moduleSource:sub(1, 1) == "@" and moduleSource:sub(2) or moduleSource
local moduleDirectory = modulePath:match("^(.*)/[^/]+$") or "."

local function loadSiblingModule(fileName)
  local chunk, loadError = loadfile(moduleDirectory .. "/" .. fileName, "t", _ENV)
  if not chunk then
    error(loadError)
  end
  return chunk()
end

local ChromeCatalog = loadSiblingModule("chrome_catalog.lua")
local HammerspoonPlatform = loadSiblingModule("platform/hammerspoon.lua")
local RoutingSession = loadSiblingModule("routing_session.lua")
local WindowTransition = loadSiblingModule("window_transition.lua")
local WindowRouter = loadSiblingModule("window_router.lua")

local log = hs.logger.new("tab-out", "info")
local state = {
  chromeCatalog = nil,
  chromeWindowFilter = nil,
  config = nil,
  hotkeys = {},
  nativeBridge = nil,
  nativeBridgeError = nil,
  privateFocus = nil,
  privateFocusError = nil,
  routingSession = nil,
  screenWatcher = nil,
  spaceWatcher = nil,
  started = false,
  timers = {},
  windowRouter = nil,
  windowTransition = nil,
}

local failCurrent
local finishCurrent

local function routingIsBusy()
  return state.routingSession and state.routingSession:isBusy() or false
end

local function currentRoutingRequest()
  return state.routingSession and state.routingSession:current() or nil
end

local function later(delay, callback, fatal)
  local timer
  timer = hs.timer.doAfter(delay, function()
    state.timers[timer] = nil
    local ok, err = xpcall(callback, debug.traceback)

    if not ok then
      log.ef("Asynchronous callback failed: %s", err)
      if fatal and routingIsBusy() and failCurrent then
        failCurrent("Automation failed", err)
      end
    end
  end)
  state.timers[timer] = true
  return timer
end

local function stopTimer(timer)
  if not timer then
    return
  end

  timer:stop()
  state.timers[timer] = nil
end

local function releaseTransitionShield()
  if state.windowTransition then
    state.windowTransition:releaseShield()
  end
end

local function showFailure(message, detail, screen)
  if detail and detail ~= "" then
    log.ef("%s: %s", message, detail)
  else
    log.e(message)
  end

  hs.alert.show("Tab Out: " .. message, nil, screen or hs.screen.mainScreen(), 2.5)
end

finishCurrent = function()
  state.routingSession:finish()
end

failCurrent = function(message, detail)
  state.routingSession:fail(message, detail)
end

local function enqueue(kind)
  if not state.started or not state.routingSession then
    showFailure("The Hammerspoon module is not running")
    return
  end
  state.routingSession:enqueue(kind)
end

local function learnFocusedChromeProfile(window)
  state.chromeCatalog:learnFocused(window, function()
    return routingIsBusy()
  end)
end

local function configureChromeWindowCache()
  state.chromeWindowFilter = hs.window.filter.new(function(window)
    local application = window and window:application() or nil
    return application and application:bundleID() == state.config.chromeBundleId
  end, "tab-out-profile-cache", "warning")

  state.chromeWindowFilter:subscribe(hs.window.filter.windowFocused, learnFocusedChromeProfile, true)

  state.chromeWindowFilter:subscribe(hs.window.filter.windowCreated, function(window)
    state.windowRouter:handleChromeWindowCreated(window)
  end)

  state.chromeWindowFilter:subscribe(hs.window.filter.windowDestroyed, function(window)
    local windowId = window and window:id() or nil
    if windowId then
      state.windowTransition:handleWindowDestroyed(window)
      state.chromeCatalog:forget(windowId)
    end
  end)
end

local function configureCreatedWindowCloseGestures()
  state.windowTransition:start()
end

local function configurePrivateFocus(config)
  state.privateFocus = nil
  state.privateFocusError = nil

  if config.privateFocusEnabled == false then
    state.privateFocusError = "Private focus is disabled by configuration"
    return
  end

  local privateFocus = config.privateFocus
  if not privateFocus then
    local loader, loadError = package.loadlib(
      config.privateFocusModulePath,
      "luaopen_tab_out_private_focus"
    )
    if not loader then
      state.privateFocusError = "The native module could not be loaded: " .. tostring(loadError)
      return
    end

    local loaded, moduleOrError = pcall(loader)
    if not loaded then
      state.privateFocusError = "The native module failed to initialize: " .. tostring(moduleOrError)
      return
    end
    privateFocus = moduleOrError
  end

  if type(privateFocus) ~= "table" or type(privateFocus.focus) ~= "function" then
    state.privateFocusError = "The native module does not expose exact-window focus"
    return
  end

  if type(privateFocus.capability) == "function" then
    local called, available, capabilityError = pcall(privateFocus.capability)
    if not called then
      state.privateFocusError = "Private focus capability check failed: " .. tostring(available)
      return
    end
    if not available then
      state.privateFocusError = capabilityError or "Private focus is unavailable on this Mac"
      return
    end
  end

  state.privateFocus = privateFocus
end

local function configureNativeBridge(config)
  state.nativeBridge = nil
  state.nativeBridgeError = nil

  local nativeBridge = config.nativeBridge
  if not nativeBridge then
    local loaded, bridgeModule = pcall(loadSiblingModule, "bridge.lua")
    if not loaded then
      state.nativeBridgeError = "The native bridge module could not be loaded: " .. tostring(bridgeModule)
      return
    end

    local created, bridgeOrError = pcall(bridgeModule.new, {
      hostPath = config.nativeBridgeHostPath,
    })
    if not created then
      state.nativeBridgeError = "The native bridge client could not initialize: " .. tostring(bridgeOrError)
      return
    end
    nativeBridge = bridgeOrError
  end

  if type(nativeBridge) ~= "table" or type(nativeBridge.createWindow) ~= "function" then
    state.nativeBridgeError = "The native bridge client does not expose window creation"
    return
  end

  state.nativeBridge = nativeBridge
  if type(nativeBridge.isReady) == "function" then
    local called, ready = pcall(nativeBridge.isReady, nativeBridge)
    if not called then
      state.nativeBridgeError = "The native bridge readiness check failed: " .. tostring(ready)
    elseif not ready then
      log.w("The native bridge host is not installed")
    end
  end
end

local function configureChromeCatalog(config)
  local platform = HammerspoonPlatform.new({
    chromeBundleId = config.chromeBundleId,
    chromeProfileDirectory = config.chromeProfileDirectory,
    chromeUserDataDirectory = config.chromeUserDataDirectory,
    hs = hs,
  })

  state.chromeCatalog = ChromeCatalog.new({
    bridge = state.nativeBridge,
    configuredProfileDirectory = config.chromeProfileDirectory,
    later = later,
    log = log,
    onAsyncError = function(err)
      if routingIsBusy() then
        failCurrent("Automation failed", err)
      end
    end,
    platform = platform,
    stopTimer = stopTimer,
  })
end

local function configureWindowRouter(config, storedSpaces)
  state.windowRouter = WindowRouter.new({
    catalog = state.chromeCatalog,
    chromeWindows = function()
      return state.chromeWindowFilter and state.chromeWindowFilter:getWindows() or nil
    end,
    config = config,
    fail = failCurrent,
    hs = hs,
    isBusy = routingIsBusy,
    isCurrent = function(request)
      return state.routingSession and state.routingSession:isCurrent(request) or false
    end,
    lastUserSpaces = storedSpaces,
    later = later,
    log = log,
    nativeBridge = state.nativeBridge,
    nativeBridgeError = state.nativeBridgeError,
    privateFocus = state.privateFocus,
    privateFocusError = state.privateFocusError,
    stopTimer = stopTimer,
    trackTimer = function(timer)
      state.timers[timer] = true
    end,
    transition = function()
      return state.windowTransition
    end,
  })
end

local function configureRoutingSession()
  state.routingSession = RoutingSession.new({
    cleanup = function()
      state.windowRouter:cleanup()
    end,
    later = later,
    prepare = function(kind)
      return state.windowRouter:prepare(kind)
    end,
    process = function(request)
      state.windowRouter:process(request)
    end,
    releaseBeforeFailure = releaseTransitionShield,
    reportFailure = function(message, detail, request)
      local screen = state.windowRouter:screenFor(request) or hs.screen.mainScreen()
      showFailure(message, detail, screen)
    end,
  })
end

local function configureWindowTransition(config)
  state.windowTransition = WindowTransition.new({
    catalog = state.chromeCatalog,
    chromeBundleId = config.chromeBundleId,
    configuredProfileDirectory = config.chromeProfileDirectory,
    currentRequest = currentRoutingRequest,
    fail = failCurrent,
    finish = finishCurrent,
    hs = hs,
    later = later,
    log = log,
    privateFocus = state.privateFocus,
    privateFocusError = state.privateFocusError,
  })
end

local function validateConfig(config)
  assert(type(config) == "table", "Tab Out config must be a table")
  assert(type(config.chromeBundleId) == "string", "chromeBundleId is required")
  assert(type(config.chromeProfileDirectory) == "string", "chromeProfileDirectory is required")
  assert(type(config.chromeUserDataDirectory) == "string", "chromeUserDataDirectory is required")
  assert(
    config.privateFocusEnabled == nil or type(config.privateFocusEnabled) == "boolean",
    "privateFocusEnabled must be a boolean"
  )
  if config.privateFocusEnabled ~= false then
    assert(
      type(config.privateFocus) == "table" or type(config.privateFocusModulePath) == "string",
      "privateFocus or privateFocusModulePath is required"
    )
  end
  assert(
    type(config.nativeBridge) == "table" or type(config.nativeBridgeHostPath) == "string",
    "nativeBridge or nativeBridgeHostPath is required"
  )
  assert(type(config.shortcuts) == "table", "shortcuts are required")
  assert(type(config.shortcuts.filter) == "table", "filter shortcut is required")
  assert(type(config.shortcuts.newPage) == "table", "newPage shortcut is required")
end

local function configWithDefaults(config)
  assert(type(config) == "table", "Tab Out config must be a table")

  local resolved = {}
  for key, value in pairs(config) do
    resolved[key] = value
  end

  local homeDirectory = os.getenv("HOME")
  resolved.chromeBundleId = resolved.chromeBundleId or "com.google.Chrome"
  resolved.chromeUserDataDirectory = resolved.chromeUserDataDirectory
    or (homeDirectory .. "/Library/Application Support/Google/Chrome")
  resolved.nativeBridgeHostPath = resolved.nativeBridgeHostPath
    or (homeDirectory .. "/Library/Application Support/Tab Out/bin/tab-out-native-bridge")
  resolved.privateFocusModulePath = resolved.privateFocusModulePath
    or (moduleDirectory .. "/native/build/tab_out_private_focus.dylib")
  return resolved
end

function M:start(config)
  if state.started then
    return M
  end

  config = configWithDefaults(config)
  validateConfig(config)
  state.config = config
  configurePrivateFocus(config)
  if not state.privateFocus then
    log.ef("Private Chrome focus is unavailable: %s", state.privateFocusError or "unknown error")
  end
  configureNativeBridge(config)
  if state.nativeBridgeError then
    log.ef("Native placement bridge is unavailable: %s", state.nativeBridgeError)
  end
  configureChromeCatalog(config)
  local storedSpaces = hs.settings.get(WindowRouter.lastUserSpacesKey)
  if type(storedSpaces) ~= "table" then
    storedSpaces = {}
  end
  configureWindowRouter(config, storedSpaces)
  configureRoutingSession()
  configureWindowTransition(config)

  state.windowRouter:refreshSpaces()
  state.spaceWatcher = hs.spaces.watcher.new(function()
    state.windowRouter:refreshSpaces()
  end):start()
  state.screenWatcher = hs.screen.watcher.new(function()
    state.windowRouter:refreshSpaces()
  end):start()
  configureChromeWindowCache()
  configureCreatedWindowCloseGestures()

  state.chromeCatalog:extensionId()

  state.hotkeys.filter = hs.hotkey.bind(
    config.shortcuts.filter.modifiers,
    config.shortcuts.filter.key,
    function()
      enqueue("filter")
    end
  )
  state.hotkeys.newPage = hs.hotkey.bind(
    config.shortcuts.newPage.modifiers,
    config.shortcuts.newPage.key,
    function()
      enqueue("newPage")
    end
  )

  state.started = true
  log.i("Tab Out routing shortcuts are active")
  return M
end

function M.openFilter()
  enqueue("filter")
end

function M.openNewPage()
  enqueue("newPage")
end

function M.status()
  local catalogStatus = state.chromeCatalog and state.chromeCatalog:status() or {}
  local diagnostics = {
    accessibility = hs.accessibilityState(false),
    busy = routingIsBusy(),
    cachedOtherProfileWindows = catalogStatus.cachedOtherProfileWindows or 0,
    cachedTargetProfileWindows = catalogStatus.cachedTargetProfileWindows or 0,
    extensionReady = catalogStatus.extensionReady == true,
    launchAtLogin = hs.autoLaunch(),
    nativeBridgeError = state.nativeBridgeError,
    nativeBridgeInstalled = false,
    nativeBridgeReady = false,
    privateFocusError = state.privateFocusError,
    privateFocusReady = state.privateFocus ~= nil,
    queueDepth = state.routingSession and state.routingSession:queueDepth() or 0,
    started = state.started,
  }

  if state.chromeCatalog then
    diagnostics.profileMetadataReady = catalogStatus.profileMetadataReady == true
  end

  if state.nativeBridge and type(state.nativeBridge.status) == "function" then
    local called, bridgeStatus = pcall(state.nativeBridge.status, state.nativeBridge)
    if called then
      diagnostics.nativeBridge = bridgeStatus
      diagnostics.nativeBridgeInstalled = bridgeStatus.hostInstalled == true
      diagnostics.nativeBridgeReady = bridgeStatus.connected == true
    end
  end

  return diagnostics
end

return M
