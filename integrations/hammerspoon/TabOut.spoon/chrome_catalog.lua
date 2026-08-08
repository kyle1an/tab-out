local M = {}

local PROFILE_PROBE_TIMEOUT_SECONDS = 6
local PROFILE_WINDOW_INVENTORY_TIMEOUT_SECONDS = 3
local WINDOW_FOCUS_DELAY_SECONDS = 0.15
local PROFILE_WINDOW_INVENTORY_SCRIPT = [[
tell application "Google Chrome"
  -- TAB_OUT_PROFILE_WINDOW_INVENTORY
  set windowRecords to {}
  repeat with browserWindow in windows
    set documentUrl to ""
    try
      set documentUrl to URL of active tab of browserWindow
    end try
    set end of windowRecords to {id of browserWindow, bounds of browserWindow, documentUrl}
  end repeat
  return windowRecords
end tell
]]

local function noOp() end

local function loggerOrNoOp(logger)
  return logger or {
    df = noOp,
    ef = noOp,
    wf = noOp,
  }
end

local function windowId(windowOrId)
  if type(windowOrId) == "number" then
    return windowOrId
  end
  return windowOrId and windowOrId:id() or nil
end

local function roundedCoordinate(value)
  return math.floor(value + 0.5)
end

local function fingerprint(bounds, documentUrl)
  if type(bounds) ~= "table"
    or type(bounds[1]) ~= "number"
    or type(bounds[2]) ~= "number"
    or type(bounds[3]) ~= "number"
    or type(bounds[4]) ~= "number"
    or type(documentUrl) ~= "string"
    or documentUrl == ""
  then
    return nil
  end

  local boundsKey = table.concat({
    roundedCoordinate(bounds[1]),
    roundedCoordinate(bounds[2]),
    roundedCoordinate(bounds[3]),
    roundedCoordinate(bounds[4]),
  }, "\0")
  return boundsKey .. "\0" .. documentUrl
end

local function creationTokenIsValid(value)
  return type(value) == "string"
    and #value > 0
    and #value <= 128
    and value:match("^[A-Za-z0-9._:%-]+$") ~= nil
end

local function documentCarriesCreationToken(documentUrl, extensionId, creationToken)
  if type(documentUrl) ~= "string" then
    return false
  end

  local parts = hs.http.urlParts(documentUrl)
  if not parts
    or parts.scheme ~= "chrome-extension"
    or parts.host ~= extensionId
    or parts.path ~= "/index.html"
  then
    return false
  end

  local matchedValues = 0
  for _, queryItem in ipairs(parts.queryItems or {}) do
    local value = queryItem.tabOutPlacement
    if value ~= nil then
      matchedValues = matchedValues + 1
      if value ~= creationToken then
        return false
      end
    elseif queryItem[1] == "tabOutPlacement" then
      return false
    end
  end
  return matchedValues == 1
end

local function profileTokens(profile)
  local tokens = {}
  local seen = {}

  for _, field in ipairs({ "user_name", "gaia_name", "shortcut_name", "name" }) do
    local value = profile and profile[field] or nil
    if type(value) == "string" then
      value = value:lower():match("^%s*(.-)%s*$")
      if #value >= 3 and not seen[value] then
        seen[value] = true
        table.insert(tokens, value)
      end
    end
  end

  table.sort(tokens, function(left, right)
    return #left > #right
  end)
  return tokens
end

local function markedMenuTitles(value, results, seen)
  if type(value) ~= "table" or seen[value] then
    return
  end

  seen[value] = true
  local mark = value.AXMenuItemMarkChar
  local title = value.AXTitle
  if type(mark) == "string" and mark ~= "" and type(title) == "string" and title ~= "" then
    table.insert(results, title:lower())
  end

  for _, child in pairs(value) do
    if type(child) == "table" then
      markedMenuTitles(child, results, seen)
    end
  end
end

local function hammerspoonPlatform(options)
  local hs = assert(options.hs, "hs or platform is required")
  local bundleId = assert(options.chromeBundleId, "chromeBundleId is required")
  local userDataDirectory = assert(options.chromeUserDataDirectory, "chromeUserDataDirectory is required")
  local profilePath = userDataDirectory .. "/" .. options.configuredProfileDirectory

  return {
    describeWindow = function(window)
      local frame = window and window:frame() or nil
      local root = window and hs.axuielement.windowElement(window) or nil
      if not frame then
        return nil
      end
      return {
        bounds = { frame.x, frame.y, frame.x + frame.w, frame.y + frame.h },
        documentUrl = root and root:attributeValue("AXDocument") or nil,
      }
    end,
    focusedWindowId = function()
      local window = hs.window.focusedWindow()
      return window and window:id() or nil
    end,
    readBrowserWindows = function()
      if not hs.application.get(bundleId) then
        return nil, "Google Chrome is no longer running"
      end
      local succeeded, records, descriptor = hs.osascript.applescript(PROFILE_WINDOW_INVENTORY_SCRIPT)
      if not succeeded or type(records) ~= "table" then
        return nil, "Chrome's focus-independent window inventory is unavailable: " .. tostring(descriptor)
      end
      local windows = {}
      for _, record in ipairs(records) do
        windows[#windows + 1] = {
          bounds = type(record) == "table" and record[2] or nil,
          browserWindowId = type(record) == "table" and record[1] or nil,
          documentUrl = type(record) == "table" and record[3] or nil,
        }
      end
      return windows
    end,
    readLocalState = function()
      return hs.json.read(userDataDirectory .. "/Local State")
    end,
    readProfileMenu = function(callback)
      local application = hs.application.get(bundleId)
      if not application then
        return false, "Google Chrome is no longer running"
      end
      application:getMenuItems(callback)
      return true
    end,
    readSecurePreferences = function()
      return hs.json.read(profilePath .. "/Secure Preferences")
    end,
  }
end

function M.new(options)
  assert(type(options) == "table", "Chrome catalog options must be a table")
  assert(type(options.configuredProfileDirectory) == "string", "configuredProfileDirectory is required")
  assert(type(options.later) == "function", "later is required")
  assert(type(options.stopTimer) == "function", "stopTimer is required")

  local bridge = options.bridge
  local configuredProfileDirectory = options.configuredProfileDirectory
  local later = options.later
  local log = loggerOrNoOp(options.log)
  local onAsyncError = options.onAsyncError or noOp
  local platform = options.platform or hammerspoonPlatform(options)
  local stopTimer = options.stopTimer
  local extensionId
  local profileByWindow = {}
  local profileProbes = {}
  local catalog = {}

  local function profileDirectoryFromMenu(menuItems)
    local localState = platform.readLocalState()
    local profiles = localState and localState.profile and localState.profile.info_cache or nil
    if type(profiles) ~= "table" then
      return nil, "Chrome profile metadata is unavailable"
    end

    local titles = {}
    markedMenuTitles(menuItems, titles, {})

    local bestDirectory
    local bestLength = 0
    local ambiguous = false

    for directory, profile in pairs(profiles) do
      for _, token in ipairs(profileTokens(profile)) do
        for _, title in ipairs(titles) do
          if title:find(token, 1, true) then
            if #token > bestLength then
              bestDirectory = directory
              bestLength = #token
              ambiguous = false
            elseif #token == bestLength and bestDirectory ~= directory then
              ambiguous = true
            end
          end
        end
      end
    end

    if bestDirectory and not ambiguous then
      return bestDirectory
    end

    return nil,
      ambiguous and "Chrome profile identity is ambiguous"
        or "Chrome's active profile could not be identified"
  end

  local function completeProfileProbe(probe, profileDirectory, probeError)
    if profileProbes[probe.windowId] ~= probe then
      return
    end

    profileProbes[probe.windowId] = nil
    stopTimer(probe.timeout)

    if profileDirectory then
      profileByWindow[probe.windowId] = profileDirectory
    end

    for _, callback in ipairs(probe.callbacks) do
      local ok, err = xpcall(function()
        callback(profileDirectory, probeError)
      end, debug.traceback)

      if not ok then
        log.ef("Profile probe callback failed: %s", err)
        onAsyncError(err)
      end
    end
  end

  function catalog:profileFor(windowOrId)
    local id = windowId(windowOrId)
    return id and profileByWindow[id] or nil
  end

  function catalog:forget(windowOrId)
    local id = windowId(windowOrId)
    if id then
      profileByWindow[id] = nil
      profileProbes[id] = nil
    end
  end

  function catalog:probeFocused(window, callback)
    local id = windowId(window)
    if not id then
      callback(nil, "The Chrome window is no longer available")
      return
    end

    local existingProbe = profileProbes[id]
    if existingProbe then
      table.insert(existingProbe.callbacks, callback)
      return
    end

    local probe = {
      callbacks = { callback },
      timeout = nil,
      windowId = id,
    }
    profileProbes[id] = probe

    probe.timeout = later(PROFILE_PROBE_TIMEOUT_SECONDS, function()
      completeProfileProbe(probe, nil, "Timed out reading Chrome's Profiles menu")
    end, false)

    if platform.focusedWindowId() ~= id then
      completeProfileProbe(probe, nil, "Chrome profile checks require an already-focused window")
      return
    end

    later(WINDOW_FOCUS_DELAY_SECONDS, function()
      if profileProbes[id] ~= probe then
        return
      end

      if platform.focusedWindowId() ~= id then
        completeProfileProbe(probe, nil, "The candidate window did not retain focus")
        return
      end

      local started, profileMenuError = platform.readProfileMenu(function(menuItems)
        local ok, err = xpcall(function()
          if profileProbes[id] ~= probe then
            return
          end

          if platform.focusedWindowId() ~= id then
            completeProfileProbe(probe, nil, "Chrome focus changed while reading its profile")
            return
          end

          if not menuItems then
            completeProfileProbe(probe, nil, "Chrome's menu structure is unavailable")
            return
          end

          local profileDirectory, profileError = profileDirectoryFromMenu(menuItems)
          completeProfileProbe(probe, profileDirectory, profileError)
        end, debug.traceback)

        if not ok then
          log.ef("Profile menu processing failed: %s", err)
          completeProfileProbe(probe, nil, err)
        end
      end)

      if started == false then
        completeProfileProbe(probe, nil, profileMenuError or "Google Chrome is no longer running")
      end
    end, false)
  end

  function catalog:learnFocused(window, routingIsBusy)
    local id = windowId(window)
    if not id or self:profileFor(id) or routingIsBusy() then
      return
    end

    later(0.2, function()
      if routingIsBusy() or platform.focusedWindowId() ~= id then
        return
      end

      self:probeFocused(window, function(profileDirectory, profileError)
        if profileDirectory then
          log.df("Cached the profile for Chrome window %d", id)
        elseif profileError then
          log.df("Could not cache Chrome window %d: %s", id, profileError)
        end
      end)
    end, false)
  end

  function catalog:extensionId()
    if extensionId then
      return extensionId
    end

    local preferences = platform.readSecurePreferences()
    local settings = preferences and preferences.extensions and preferences.extensions.settings or nil
    if type(settings) ~= "table" then
      return nil, "Chrome's extension settings could not be read"
    end

    for candidateId, extension in pairs(settings) do
      local commands = type(extension) == "table" and extension.commands or nil
      if type(commands) == "table"
        and type(commands["open-filter-tab"]) == "table"
        and type(commands["open-new-tab"]) == "table"
        and type(candidateId) == "string"
        and #candidateId == 32
        and candidateId:match("^[a-p]+$")
      then
        extensionId = candidateId
        return candidateId
      end
    end

    return nil, "The Tab Out extension could not be identified"
  end

  function catalog:filterFocusUrl()
    local id, extensionError = self:extensionId()
    if not id then
      return nil, extensionError
    end

    return "chrome-extension://" .. id .. "/index.html?focusFilter=1"
  end

  function catalog:matchCreatedBrowserWindow(
    browserWindowId,
    creationToken,
    candidates
  )
    if type(browserWindowId) ~= "number"
      or browserWindowId <= 0
      or browserWindowId % 1 ~= 0
    then
      return nil, "The created browser window identity is invalid", true
    end
    if not creationTokenIsValid(creationToken) then
      return nil, "The created window token is invalid", true
    end

    local expectedExtensionId, extensionError = self:extensionId()
    if not expectedExtensionId then
      return nil, extensionError, true
    end

    local browserWindows, inventoryError = platform.readBrowserWindows()
    if not browserWindows then
      return nil, inventoryError
    end

    local targetFound = false
    local targetCarriesToken = false
    local tokenDocumentCount = 0
    for _, browserWindow in ipairs(browserWindows) do
      local documentUrl = type(browserWindow) == "table"
        and browserWindow.documentUrl
        or nil
      local carriesToken = documentCarriesCreationToken(
        documentUrl,
        expectedExtensionId,
        creationToken
      )
      if carriesToken then
        tokenDocumentCount = tokenDocumentCount + 1
      end
      if type(browserWindow) == "table"
        and tonumber(browserWindow.browserWindowId) == browserWindowId
      then
        if targetFound then
          return nil, "Chrome returned duplicate records for the created browser window", true
        end
        targetFound = true
        targetCarriesToken = carriesToken
      end
    end

    if not targetFound then
      return nil, "The created browser window is not yet available in Chrome's window inventory"
    end
    if tokenDocumentCount == 0 then
      return nil, "The created browser window token is not yet available in Chrome's window inventory"
    end
    if tokenDocumentCount > 1 then
      return nil, "Chrome returned an ambiguous created window token", true
    end
    if not targetCarriesToken then
      return nil, "Chrome attached the created window token to another browser window", true
    end

    local matchedWindow
    for _, window in ipairs(candidates or {}) do
      local descriptor = platform.describeWindow(window)
      local matches = descriptor
        and documentCarriesCreationToken(
          descriptor.documentUrl,
          expectedExtensionId,
          creationToken
        )
      if matches then
        if matchedWindow then
          return nil, "Multiple native Chrome windows match the created browser window", true
        end
        matchedWindow = window
      end
    end

    if not matchedWindow then
      return nil, "The created window token is not yet available to macOS accessibility"
    end

    local id = windowId(matchedWindow)
    if not id then
      return nil, "The matched native Chrome window identity is unavailable", true
    end
    profileByWindow[id] = configuredProfileDirectory
    return matchedWindow
  end

  local function cacheFocusIndependentProfiles(candidates, profileWindowIds)
    local browserWindows, inventoryError = platform.readBrowserWindows()
    if not browserWindows then
      return false, inventoryError
    end

    local descriptorsById = {}
    local fingerprintCounts = {}
    for _, browserWindow in ipairs(browserWindows) do
      local browserWindowId = type(browserWindow) == "table"
        and tonumber(browserWindow.browserWindowId)
        or nil
      local browserFingerprint = type(browserWindow) == "table"
        and fingerprint(browserWindow.bounds, browserWindow.documentUrl)
        or nil
      if browserWindowId
        and browserWindowId > 0
        and browserWindowId % 1 == 0
        and browserFingerprint
        and not descriptorsById[browserWindowId]
      then
        descriptorsById[browserWindowId] = browserFingerprint
        fingerprintCounts[browserFingerprint] = (fingerprintCounts[browserFingerprint] or 0) + 1
      end
    end

    local targetFingerprints = {}
    for _, browserWindowId in ipairs(profileWindowIds or {}) do
      local browserFingerprint = descriptorsById[browserWindowId]
      if browserFingerprint and fingerprintCounts[browserFingerprint] == 1 then
        targetFingerprints[browserFingerprint] = true
      end
    end

    local learned = false
    for _, window in ipairs(candidates) do
      local id = windowId(window)
      local descriptor = id and platform.describeWindow(window) or nil
      local nativeFingerprint = descriptor
        and fingerprint(descriptor.bounds, descriptor.documentUrl)
        or nil
      if id and nativeFingerprint and targetFingerprints[nativeFingerprint] then
        profileByWindow[id] = configuredProfileDirectory
        learned = true
      end
    end
    return learned
  end

  function catalog:discover(candidates, callback)
    local needsInventory = false
    for _, window in ipairs(candidates) do
      local id = windowId(window)
      local cachedProfile = id and profileByWindow[id] or nil
      if cachedProfile == configuredProfileDirectory then
        callback()
        return
      end
      if id and not cachedProfile then
        needsInventory = true
      end
    end
    if not needsInventory or not bridge or type(bridge.listProfileWindows) ~= "function" then
      callback()
      return
    end

    local completed = false
    local function complete()
      if completed then
        return
      end
      completed = true
      callback()
    end

    local started, startError = bridge:listProfileWindows({
      timeoutSeconds = PROFILE_WINDOW_INVENTORY_TIMEOUT_SECONDS,
    }, function(profileWindowIds, inventoryError)
      if profileWindowIds then
        local learned, discoveryError = cacheFocusIndependentProfiles(candidates, profileWindowIds)
        if not learned and discoveryError then
          log.wf("Could not identify Chrome profiles without focus: %s", discoveryError)
        end
      elseif inventoryError then
        log.wf("Could not read configured-profile Chrome windows: %s", inventoryError)
      end
      complete()
    end)

    if not started then
      log.wf("Could not start configured-profile window discovery: %s", startError or "unknown error")
      complete()
    end
  end

  function catalog:status()
    local targetWindows = 0
    local otherWindows = 0
    for _, profileDirectory in pairs(profileByWindow) do
      if profileDirectory == configuredProfileDirectory then
        targetWindows = targetWindows + 1
      else
        otherWindows = otherWindows + 1
      end
    end

    return {
      cachedOtherProfileWindows = otherWindows,
      cachedTargetProfileWindows = targetWindows,
      extensionReady = self:extensionId() ~= nil,
      profileMetadataReady = platform.readLocalState() ~= nil,
    }
  end

  return catalog
end

return M
