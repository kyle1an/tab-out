local M = {}

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

function M.new(options)
  assert(type(options) == "table", "Hammerspoon platform options must be a table")
  assert(type(options.chromeBundleId) == "string", "chromeBundleId is required")
  assert(type(options.chromeProfileDirectory) == "string", "chromeProfileDirectory is required")
  assert(type(options.chromeUserDataDirectory) == "string", "chromeUserDataDirectory is required")
  assert(type(options.hs) == "table", "hs is required")

  local hs = options.hs
  local chromeBundleId = options.chromeBundleId
  local profilePath = options.chromeUserDataDirectory .. "/" .. options.chromeProfileDirectory
  local platform = {}

  function platform.describeWindow(window)
    local frame = window and window:frame() or nil
    local root = window and hs.axuielement.windowElement(window) or nil
    local documentUrl = root and root:attributeValue("AXDocument") or nil
    if not frame then
      return nil
    end

    return {
      bounds = { frame.x, frame.y, frame.x + frame.w, frame.y + frame.h },
      documentUrl = documentUrl,
    }
  end

  function platform.focusedWindowId()
    local focusedWindow = hs.window.focusedWindow()
    return focusedWindow and focusedWindow:id() or nil
  end

  function platform.readBrowserWindows()
    local succeeded, records, descriptor = hs.osascript.applescript(PROFILE_WINDOW_INVENTORY_SCRIPT)
    if not succeeded or type(records) ~= "table" then
      return nil, "Chrome's focus-independent window inventory is unavailable: " .. tostring(descriptor)
    end

    local browserWindows = {}
    for _, record in ipairs(records) do
      table.insert(browserWindows, {
        bounds = type(record) == "table" and record[2] or nil,
        browserWindowId = type(record) == "table" and record[1] or nil,
        documentUrl = type(record) == "table" and record[3] or nil,
      })
    end
    return browserWindows
  end

  function platform.readLocalState()
    return hs.json.read(options.chromeUserDataDirectory .. "/Local State")
  end

  function platform.readProfileMenu(callback)
    local application = hs.application.get(chromeBundleId)
    if not application then
      return false, "Google Chrome is no longer running"
    end
    application:getMenuItems(callback)
    return true
  end

  function platform.readSecurePreferences()
    return hs.json.read(profilePath .. "/Secure Preferences")
  end

  return platform
end

return M
