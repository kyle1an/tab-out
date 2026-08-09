local M = {}

local requiredChecks = {
  { "Spoon start", "started" },
  { "Accessibility permission", "accessibility" },
  { "private exact-window focus", "privateFocusReady" },
  { "Native Placement Bridge host installation", "nativeBridgeInstalled" },
  { "configured-profile metadata", "profileMetadataReady" },
  { "configured-profile extension discovery", "extensionReady" },
}

function M.evaluate(tabOut)
  if not tabOut or type(tabOut.status) ~= "function" then
    return "missing:Tab Out Spoon"
  end

  local status = tabOut.status()
  if type(status) ~= "table" then
    return "invalid:Tab Out status() did not return a table"
  end

  local missing = {}
  for _, check in ipairs(requiredChecks) do
    if status[check[2]] ~= true then
      table.insert(missing, check[1])
    end
  end

  if #missing > 0 then
    return "missing:" .. table.concat(missing, ", ")
  end

  return "ready"
end

return M
