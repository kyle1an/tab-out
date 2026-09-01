import Darwin
import CoreFoundation
import Foundation

private let profileSelectionVersion = 2
private let placementBridgeVersion = 6
private let controlBridgeVersion = 7
private let bridgeVersionString = "9.0.0"
private let maximumMessageBytes = 64 * 1024
private let maximumRequestLifetimeMs: Int64 = 60_000
private let mergeDesktopCapability = "merge-desktop"
private let profileTransferCapability = "profile-transfer"
private let profileTransferDrainCapability = "profile-transfer-drain"

private enum BridgeError: Error, CustomStringConvertible {
  case endpointUnavailable(String)
  case message(String)

  var description: String {
    switch self {
    case .endpointUnavailable(let message): message
    case .message(let message): message
    }
  }
}

private func currentTimeMs() -> Int64 {
  Int64(Date().timeIntervalSince1970 * 1_000)
}

private func validatedBrowserProcessId() throws -> Int {
  let processId = getppid()
  guard processId > 1 else {
    throw BridgeError.message("The native bridge could not identify its browser process")
  }
  guard kill(processId, 0) == 0 || errno == EPERM else {
    throw BridgeError.message("The native bridge browser process is no longer running")
  }
  return Int(processId)
}

private func bridgeSocketURL() -> URL {
  if let override = ProcessInfo.processInfo.environment["TAB_OUT_NATIVE_BRIDGE_SOCKET_PATH"],
     !override.isEmpty {
    return URL(fileURLWithPath: override)
  }
  return FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Tab Out/run/native-bridge-v1.sock")
}

private func bridgeDirectoryURL() -> URL {
  bridgeSocketURL().deletingLastPathComponent()
}

private func profileSelectionURL() -> URL {
  if let override = ProcessInfo.processInfo.environment["TAB_OUT_NATIVE_BRIDGE_PROFILE_SELECTION_PATH"],
     !override.isEmpty {
    return URL(fileURLWithPath: override)
  }
  return FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Tab Out/configured-profile-v1.json")
}

private func profileSelectionDirectoryURL() -> URL {
  profileSelectionURL().deletingLastPathComponent()
}

private func writeAll(_ fileDescriptor: Int32, data: Data) -> Bool {
  data.withUnsafeBytes { rawBuffer in
    guard let baseAddress = rawBuffer.baseAddress else { return true }
    var offset = 0
    while offset < rawBuffer.count {
      let written = Darwin.write(fileDescriptor, baseAddress.advanced(by: offset), rawBuffer.count - offset)
      if written < 0 {
        if errno == EINTR { continue }
        return false
      }
      if written == 0 { return false }
      offset += written
    }
    return true
  }
}

private func readExactly(_ fileDescriptor: Int32, count: Int) -> Data? {
  var data = Data(count: count)
  let succeeded = data.withUnsafeMutableBytes { rawBuffer -> Bool in
    guard let baseAddress = rawBuffer.baseAddress else { return count == 0 }
    var offset = 0
    while offset < count {
      let bytesRead = Darwin.read(fileDescriptor, baseAddress.advanced(by: offset), count - offset)
      if bytesRead < 0 {
        if errno == EINTR { continue }
        return false
      }
      if bytesRead == 0 { return false }
      offset += bytesRead
    }
    return true
  }
  return succeeded ? data : nil
}

private func readLine(_ fileDescriptor: Int32) throws -> Data {
  var data = Data()
  var byte: UInt8 = 0

  while data.count <= maximumMessageBytes {
    let bytesRead = Darwin.read(fileDescriptor, &byte, 1)
    if bytesRead < 0 {
      if errno == EINTR { continue }
      throw BridgeError.message("Could not read the local bridge request: \(String(cString: strerror(errno)))")
    }
    if bytesRead == 0 {
      throw BridgeError.message("The local bridge request ended before a complete message arrived")
    }
    if byte == 0x0A { return data }
    data.append(byte)
  }

  throw BridgeError.message("The local bridge request exceeded \(maximumMessageBytes) bytes")
}

private func jsonObject(from data: Data) throws -> [String: Any] {
  let value = try JSONSerialization.jsonObject(with: data)
  guard let object = value as? [String: Any] else {
    throw BridgeError.message("The bridge message must be a JSON object")
  }
  return object
}

private func jsonData(_ object: [String: Any]) throws -> Data {
  guard JSONSerialization.isValidJSONObject(object) else {
    throw BridgeError.message("The bridge response is not valid JSON")
  }
  return try JSONSerialization.data(withJSONObject: object)
}

private func response(
  version: Int,
  requestId: String,
  status: String,
  reason: String? = nil,
  fields: [String: Any] = [:]
) -> [String: Any] {
  var value: [String: Any] = [
    "version": version,
    "type": "response",
    "requestId": requestId,
    "status": status,
  ]
  if let reason, !reason.isEmpty {
    value["reason"] = reason
  }
  for (key, field) in fields {
    value[key] = field
  }
  return value
}

private func rejection(
  version: Int = placementBridgeVersion,
  requestId: String,
  reason: String
) -> [String: Any] {
  response(version: version, requestId: requestId, status: "rejected", reason: reason)
}

@discardableResult
private func writeLocalMessage(_ object: [String: Any], to fileDescriptor: Int32) -> Bool {
  guard var data = try? jsonData(object), data.count <= maximumMessageBytes else { return false }
  data.append(0x0A)
  return writeAll(fileDescriptor, data: data)
}

private func validRequestId(_ value: Any?) -> String? {
  guard let requestId = value as? String,
        !requestId.isEmpty,
        requestId.utf8.count <= 128,
        requestId.range(of: "^[A-Za-z0-9._:-]+$", options: .regularExpression) != nil
  else { return nil }
  return requestId
}

private func hasOnlyKeys(_ object: [String: Any], _ allowedKeys: Set<String>) -> Bool {
  object.keys.allSatisfy(allowedKeys.contains)
}

private func validReason(_ value: Any?) -> String? {
  guard let reason = value as? String,
        !reason.isEmpty,
        reason.utf8.count <= 1_024
  else { return nil }
  return reason
}

private func validExtensionOrigin(_ value: String) -> Bool {
  value.range(
    of: "^chrome-extension://[a-p]{32}/$",
    options: .regularExpression
  ) != nil
}

private func validProfileId(_ value: Any?) -> String? {
  guard let profileId = value as? String,
        profileId.range(
          of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
          options: .regularExpression
        ) != nil
  else { return nil }
  return profileId
}

private enum ProfileSelectionStatus: String {
  case anotherProfile = "another-profile"
  case required
  case selected
}

private struct SelectedProfile {
  let profileId: String
  let ownerRevision: String
}

private struct ProfileSelectionSnapshot {
  let selectedProfile: SelectedProfile?
  let status: ProfileSelectionStatus
}

private func profileSelectionStatusMessage(
  _ snapshot: ProfileSelectionSnapshot,
  profileTransferAvailable: Bool
) -> [String: Any] {
  var message: [String: Any] = [
    "version": profileSelectionVersion,
    "type": "profile-selection-status",
    "selection": snapshot.status.rawValue,
    "capabilities": profileTransferAvailable ? [profileTransferCapability] : [],
  ]
  if let selectedProfile = snapshot.selectedProfile {
    message["ownerRevision"] = selectedProfile.ownerRevision
  }
  return message
}

private func secureProfileSelectionDirectory() throws {
  let directory = profileSelectionDirectoryURL()
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  guard chmod(directory.path, S_IRWXU) == 0 else {
    throw BridgeError.message("Could not secure the native bridge profile-selection directory")
  }
}

private func withProfileSelectionLock<Result>(
  _ operation: () throws -> Result
) throws -> Result {
  try secureProfileSelectionDirectory()
  let lockPath = "\(profileSelectionURL().path).lock"
  let lockDescriptor = Darwin.open(
    lockPath,
    O_CREAT | O_RDWR | O_NOFOLLOW,
    S_IRUSR | S_IWUSR
  )
  guard lockDescriptor >= 0 else {
    throw BridgeError.message("Could not open the native bridge profile-selection lock")
  }
  defer {
    _ = flock(lockDescriptor, LOCK_UN)
    Darwin.close(lockDescriptor)
  }
  guard flock(lockDescriptor, LOCK_EX) == 0 else {
    throw BridgeError.message("Could not lock the native bridge profile selection")
  }
  return try operation()
}

private func readSelectedProfile() throws -> SelectedProfile? {
  let url = profileSelectionURL()
  guard FileManager.default.fileExists(atPath: url.path) else { return nil }
  let data = try Data(contentsOf: url)
  guard data.count <= 4_096 else {
    throw BridgeError.message("The native bridge profile selection is invalid")
  }
  let object = try jsonObject(from: data)
  if hasOnlyKeys(object, ["version", "profileId", "ownerRevision"]),
     finiteNumber(object["version"]) == Double(profileSelectionVersion),
     let profileId = validProfileId(object["profileId"]),
     let ownerRevision = validProfileId(object["ownerRevision"]) {
    return SelectedProfile(profileId: profileId, ownerRevision: ownerRevision)
  }
  if hasOnlyKeys(object, ["version", "profileId"]),
     finiteNumber(object["version"]) == 1,
     let profileId = validProfileId(object["profileId"]) {
    let migrated = SelectedProfile(
      profileId: profileId,
      ownerRevision: UUID().uuidString.lowercased()
    )
    try writeSelectedProfile(migrated)
    return migrated
  }
  throw BridgeError.message("The native bridge profile selection is invalid")
}

private func writeSelectedProfile(_ selectedProfile: SelectedProfile) throws {
  let url = profileSelectionURL()
  let data = try jsonData([
    "version": profileSelectionVersion,
    "profileId": selectedProfile.profileId,
    "ownerRevision": selectedProfile.ownerRevision,
  ])
  let temporaryURL = url.deletingLastPathComponent()
    .appendingPathComponent(".configured-profile-\(UUID().uuidString.lowercased())")
  let temporaryDescriptor = Darwin.open(
    temporaryURL.path,
    O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW,
    S_IRUSR | S_IWUSR
  )
  guard temporaryDescriptor >= 0 else {
    throw BridgeError.message("Could not create the native bridge profile selection")
  }
  var installed = false
  defer {
    Darwin.close(temporaryDescriptor)
    if !installed { _ = unlink(temporaryURL.path) }
  }
  guard writeAll(temporaryDescriptor, data: data), fsync(temporaryDescriptor) == 0 else {
    throw BridgeError.message("Could not write the native bridge profile selection")
  }
  guard rename(temporaryURL.path, url.path) == 0 else {
    throw BridgeError.message("Could not install the native bridge profile selection")
  }
  installed = true
}

private func profileSelectionSnapshotLocked(
  for profileId: String
) throws -> ProfileSelectionSnapshot {
  guard let selectedProfile = try readSelectedProfile() else {
    return ProfileSelectionSnapshot(selectedProfile: nil, status: .required)
  }
  return ProfileSelectionSnapshot(
    selectedProfile: selectedProfile,
    status: selectedProfile.profileId == profileId ? .selected : .anotherProfile
  )
}

private func profileSelectionSnapshot(for profileId: String) throws -> ProfileSelectionSnapshot {
  try withProfileSelectionLock {
    try profileSelectionSnapshotLocked(for: profileId)
  }
}

private func selectProfile(_ profileId: String) throws -> ProfileSelectionSnapshot {
  try withProfileSelectionLock {
    if let selectedProfile = try readSelectedProfile() {
      return ProfileSelectionSnapshot(
        selectedProfile: selectedProfile,
        status: selectedProfile.profileId == profileId ? .selected : .anotherProfile
      )
    }
    let selectedProfile = SelectedProfile(
      profileId: profileId,
      ownerRevision: UUID().uuidString.lowercased()
    )
    try writeSelectedProfile(selectedProfile)
    return ProfileSelectionSnapshot(selectedProfile: selectedProfile, status: .selected)
  }
}

@discardableResult
private func clearSelectedProfileLocked() throws -> Bool {
  let path = profileSelectionURL().path
  if unlink(path) == 0 { return true }
  if errno == ENOENT { return false }
  throw BridgeError.message(
    "Could not clear the native bridge profile selection: \(String(cString: strerror(errno)))"
  )
}

private func finiteNumber(_ value: Any?) -> Double? {
  guard let number = value as? NSNumber,
        CFGetTypeID(number) != CFBooleanGetTypeID()
  else { return nil }
  let result = number.doubleValue
  return result.isFinite ? result : nil
}

private func positiveInteger(_ value: Any?) -> Int? {
  guard let number = finiteNumber(value),
        number.rounded() == number,
        number > 0,
        number <= Double(Int.max)
  else { return nil }
  return Int(number)
}

private func validProcessId(_ value: Any?) -> Int? {
  guard let processId = positiveInteger(value), processId > 1, processId <= Int(Int32.max) else {
    return nil
  }
  return processId
}

private func validCapabilities(_ value: Any?) -> [String]? {
  guard let values = value as? [Any], values.count <= 16 else { return nil }
  var capabilities: [String] = []
  var seen = Set<String>()
  for value in values {
    guard let capability = value as? String,
          capability == mergeDesktopCapability || capability == profileTransferDrainCapability,
          seen.insert(capability).inserted
    else { return nil }
    capabilities.append(capability)
  }
  return capabilities
}

private func validWindowIds(_ value: Any?) -> [Int]? {
  guard let values = value as? [Any], values.count <= 512 else { return nil }
  var windowIds: [Int] = []
  var seen = Set<Int>()
  for value in values {
    guard let windowId = positiveInteger(value), seen.insert(windowId).inserted else { return nil }
    windowIds.append(windowId)
  }
  return windowIds
}

private func validateBounds(_ value: Any?) -> Bool {
  guard let bounds = value as? [String: Any],
        let left = finiteNumber(bounds["left"]),
        let top = finiteNumber(bounds["top"]),
        let width = finiteNumber(bounds["width"]),
        let height = finiteNumber(bounds["height"])
  else { return false }

  return abs(left) <= 100_000
    && abs(top) <= 100_000
    && width > 0 && width <= 100_000
    && height > 0 && height <= 100_000
}

private struct ValidatedRequest {
  let expiresAtMs: Int64
  let requestId: String
}

private func validateDeadline(_ object: [String: Any], requestKind: String) throws -> ValidatedRequest {
  guard let requestId = validRequestId(object["requestId"]) else {
    throw BridgeError.message("The \(requestKind) request ID is invalid")
  }
  guard let expiresNumber = finiteNumber(object["expiresAtMs"]),
        expiresNumber.rounded() == expiresNumber
  else {
    throw BridgeError.message("The \(requestKind) request deadline is invalid")
  }

  let nowMs = currentTimeMs()
  guard expiresNumber >= Double(nowMs) else {
    throw BridgeError.message("The \(requestKind) request expired")
  }
  guard expiresNumber <= Double(nowMs + maximumRequestLifetimeMs) else {
    throw BridgeError.message("The \(requestKind) request deadline is too far in the future")
  }
  return ValidatedRequest(expiresAtMs: Int64(expiresNumber), requestId: requestId)
}

private struct ValidatedPlacementRequest {
  let expectedBrowserProcessId: Int?
  let expiresAtMs: Int64
  let requestId: String
}

private func validatePlacementRequest(_ object: [String: Any]) throws -> ValidatedPlacementRequest {
  guard finiteNumber(object["version"]) == Double(placementBridgeVersion) else {
    throw BridgeError.message("The native placement protocol version is unsupported")
  }
  let request = try validateDeadline(object, requestKind: "native placement")

  guard let type = object["type"] as? String else {
    throw BridgeError.message("The native placement request type is invalid")
  }
  if type == "status" || type == "list-profile-windows" {
    let requestKind = type == "status" ? "status" : "inventory"
    guard hasOnlyKeys(object, ["version", "type", "requestId", "expiresAtMs"]) else {
      throw BridgeError.message("The native placement \(requestKind) request contains unsupported fields")
    }
    return ValidatedPlacementRequest(
      expectedBrowserProcessId: nil,
      expiresAtMs: request.expiresAtMs,
      requestId: request.requestId
    )
  }
  guard type == "create-window" else {
    throw BridgeError.message("The native placement request type is unsupported")
  }
  guard let operation = object["operation"] as? String,
        operation == "filter" || operation == "newPage"
  else {
    throw BridgeError.message("The native placement operation is invalid")
  }
  guard validateBounds(object["targetBounds"]) else {
    throw BridgeError.message("The native placement target bounds are invalid")
  }
  guard hasOnlyKeys(object, [
    "version", "type", "requestId", "expiresAtMs", "expectedBrowserProcessId",
    "operation", "targetBounds",
  ]) else {
    throw BridgeError.message("The native placement create request contains unsupported fields")
  }
  guard let expectedBrowserProcessId = validProcessId(object["expectedBrowserProcessId"]) else {
    throw BridgeError.message("The expected browser process is invalid")
  }

  return ValidatedPlacementRequest(
    expectedBrowserProcessId: expectedBrowserProcessId,
    expiresAtMs: request.expiresAtMs,
    requestId: request.requestId
  )
}

private struct ValidatedControllerRegistration {
  let capabilities: [String]
  let request: ValidatedRequest
}

private func validateControllerRegistration(
  _ object: [String: Any]
) throws -> ValidatedControllerRegistration {
  guard hasOnlyKeys(object, [
    "version", "type", "requestId", "expiresAtMs", "capabilities",
  ]) else {
    throw BridgeError.message("The native controller registration contains unsupported fields")
  }
  guard finiteNumber(object["version"]) == Double(controlBridgeVersion),
        object["type"] as? String == "controller-register"
  else {
    throw BridgeError.message("The native controller registration is unsupported")
  }
  guard let capabilities = validCapabilities(object["capabilities"]),
        capabilities.contains(mergeDesktopCapability)
  else {
    throw BridgeError.message("The native controller capabilities are invalid")
  }
  return ValidatedControllerRegistration(
    capabilities: capabilities,
    request: try validateDeadline(object, requestKind: "native controller")
  )
}

private func validateControlRequest(_ object: [String: Any]) throws -> ValidatedRequest {
  guard finiteNumber(object["version"]) == Double(controlBridgeVersion) else {
    throw BridgeError.message("The native control protocol version is unsupported")
  }
  let request = try validateDeadline(object, requestKind: "native control")
  guard let type = object["type"] as? String else {
    throw BridgeError.message("The native control request type is invalid")
  }
  guard type == "resolve-desktop-windows" || type == "revalidate-desktop-windows" else {
    throw BridgeError.message("The native control request type is unsupported")
  }
  var allowedKeys: Set<String> = [
    "version", "type", "requestId", "expiresAtMs", "destinationWindowId",
    "profileWindowIds",
  ]
  if type == "revalidate-desktop-windows" {
    allowedKeys.insert("selectionToken")
  }
  guard hasOnlyKeys(object, allowedKeys) else {
    throw BridgeError.message("The native control request contains unsupported fields")
  }
  guard let destinationWindowId = positiveInteger(object["destinationWindowId"]),
        let profileWindowIds = validWindowIds(object["profileWindowIds"]),
        profileWindowIds.contains(destinationWindowId)
  else {
    throw BridgeError.message("The native control window inventory is invalid")
  }
  if type == "revalidate-desktop-windows",
     validRequestId(object["selectionToken"]) == nil {
    throw BridgeError.message("The native control selection token is invalid")
  }
  return request
}

private func validateControllerResponse(_ object: [String: Any]) -> String? {
  guard hasOnlyKeys(object, [
    "version", "type", "requestId", "status", "reason", "windowIds",
  ]) else { return nil }
  guard finiteNumber(object["version"]) == Double(controlBridgeVersion),
        object["type"] as? String == "response",
        let requestId = validRequestId(object["requestId"]),
        let status = object["status"] as? String,
        status == "accepted" || status == "rejected"
  else { return nil }
  if status == "accepted" {
    guard object["reason"] == nil,
          let windowIds = validWindowIds(object["windowIds"]),
          !windowIds.isEmpty
    else { return nil }
  } else {
    guard validReason(object["reason"]) != nil,
          object["windowIds"] == nil
    else { return nil }
  }
  return requestId
}

private func validateProfileTransferControllerResponse(
  _ object: [String: Any]
) -> (requestId: String, result: ProfileTransferPreparationResult)? {
  guard hasOnlyKeys(object, ["version", "type", "requestId", "status", "reason"]),
        finiteNumber(object["version"]) == Double(controlBridgeVersion),
        object["type"] as? String == "profile-transfer-response",
        let requestId = validRequestId(object["requestId"]),
        let status = object["status"] as? String
  else { return nil }
  if status == "accepted", object["reason"] == nil {
    return (requestId, .idle)
  }
  if status == "rejected", validReason(object["reason"]) != nil {
    return (requestId, .busy)
  }
  return nil
}

private func validateProfileTransferExtensionResponse(
  _ object: [String: Any]
) -> (requestId: String, result: ProfileTransferPreparationResult)? {
  guard hasOnlyKeys(object, ["version", "type", "requestId", "status"]),
        finiteNumber(object["version"]) == Double(profileSelectionVersion),
        object["type"] as? String == "profile-transfer-response",
        let requestId = validRequestId(object["requestId"]),
        let status = object["status"] as? String
  else { return nil }
  if status == "idle" { return (requestId, .idle) }
  if status == "busy" { return (requestId, .busy) }
  return nil
}

private func makeUnixAddress(path: String) throws -> sockaddr_un {
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  let pathBytes = Array(path.utf8CString)
  let capacity = MemoryLayout.size(ofValue: address.sun_path)
  guard pathBytes.count <= capacity else {
    throw BridgeError.message("The native bridge socket path is too long")
  }

  withUnsafeMutableBytes(of: &address.sun_path) { destination in
    destination.initializeMemory(as: UInt8.self, repeating: 0)
    pathBytes.withUnsafeBytes { source in
      destination.copyBytes(from: source)
    }
  }
  return address
}

private func connectSocket(path: String, timeoutSeconds: Int = 15) throws -> Int32 {
  let fileDescriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
  guard fileDescriptor >= 0 else {
    throw BridgeError.message("Could not create the native bridge client socket")
  }

  var timeout = timeval(tv_sec: timeoutSeconds, tv_usec: 0)
  _ = setsockopt(fileDescriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
  _ = setsockopt(fileDescriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))

  do {
    var address = try makeUnixAddress(path: path)
    let result = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(fileDescriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard result == 0 else {
      let connectionError = errno
      let message = "The native bridge is not connected: \(String(cString: strerror(connectionError)))"
      if connectionError == ENOENT || connectionError == ECONNREFUSED {
        throw BridgeError.endpointUnavailable(message)
      }
      throw BridgeError.message(message)
    }
    return fileDescriptor
  } catch {
    Darwin.close(fileDescriptor)
    throw error
  }
}

private func socketIsLive(path: String) -> Bool {
  guard let fileDescriptor = try? connectSocket(path: path, timeoutSeconds: 1) else { return false }
  Darwin.close(fileDescriptor)
  return true
}

private enum ProfileTransferPreparationResult: Equatable {
  case busy
  case idle
  case updateRequired
}

private final class ProfileTransferPreparation: @unchecked Sendable {
  private let lock = NSLock()
  private let semaphore = DispatchSemaphore(value: 0)
  private var controllerResult: ProfileTransferPreparationResult?
  private var extensionResult: ProfileTransferPreparationResult?

  func completeController(_ result: ProfileTransferPreparationResult) {
    lock.lock()
    guard controllerResult == nil else {
      lock.unlock()
      return
    }
    controllerResult = result
    lock.unlock()
    semaphore.signal()
  }

  func completeExtension(_ result: ProfileTransferPreparationResult) {
    lock.lock()
    guard extensionResult == nil else {
      lock.unlock()
      return
    }
    extensionResult = result
    lock.unlock()
    semaphore.signal()
  }

  func wait(timeoutSeconds: Double) -> ProfileTransferPreparationResult {
    let deadline = DispatchTime.now() + timeoutSeconds
    for _ in 0..<2 {
      if semaphore.wait(timeout: deadline) == .timedOut { break }
    }
    lock.lock()
    defer { lock.unlock() }
    if extensionResult == .busy || controllerResult == .busy { return .busy }
    if extensionResult == .idle && controllerResult == .idle { return .idle }
    return .updateRequired
  }
}

private enum ProfileTransferPreparationStart {
  case busy
  case started(ProfileTransferPreparation, Int32)
  case updateRequired
}

private final class BridgeState: @unchecked Sendable {
  private let lock = NSLock()
  private var controllerCapabilities = Set<String>()
  private var controllerDescriptor: Int32?
  private var controllerPending = Set<String>()
  private var placementPending: [String: Int32] = [:]
  private var profileTransferDraining = false
  private var profileTransferPreparation: (requestId: String, value: ProfileTransferPreparation)?
  private var shuttingDown = false

  func registerPlacement(requestId: String, fileDescriptor: Int32) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !shuttingDown,
          !profileTransferDraining,
          placementPending[requestId] == nil
    else { return false }
    placementPending[requestId] = fileDescriptor
    return true
  }

  func takePlacement(requestId: String) -> Int32? {
    lock.lock()
    defer { lock.unlock() }
    return placementPending.removeValue(forKey: requestId)
  }

  func registerController(fileDescriptor: Int32, capabilities: [String]) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !shuttingDown, controllerDescriptor == nil else { return false }
    controllerDescriptor = fileDescriptor
    controllerCapabilities = Set(capabilities)
    return true
  }

  func forwardToController(requestId: String, object: [String: Any]) -> String? {
    lock.lock()
    defer { lock.unlock() }
    guard !shuttingDown, !profileTransferDraining else {
      return "The native bridge is shutting down or transferring profiles"
    }
    guard let fileDescriptor = controllerDescriptor else {
      return "The Hammerspoon controller is not connected"
    }
    guard controllerPending.insert(requestId).inserted else {
      return "The native control request ID is already pending"
    }
    guard writeLocalMessage(object, to: fileDescriptor) else {
      controllerPending.remove(requestId)
      return "The native control request could not reach Hammerspoon"
    }
    return nil
  }

  func completeControllerRequest(requestId: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return controllerPending.remove(requestId) != nil
  }

  func removeController(fileDescriptor: Int32) -> (removed: Bool, requestIds: [String]) {
    lock.lock()
    defer { lock.unlock() }
    guard controllerDescriptor == fileDescriptor else { return (false, []) }
    controllerDescriptor = nil
    controllerCapabilities.removeAll()
    profileTransferPreparation?.value.completeController(.updateRequired)
    let pending = Array(controllerPending)
    controllerPending.removeAll()
    return (true, pending)
  }

  func beginProfileTransferPreparation(requestId: String) -> ProfileTransferPreparationStart {
    lock.lock()
    defer { lock.unlock() }
    guard !shuttingDown, !profileTransferDraining, placementPending.isEmpty else {
      return .busy
    }
    guard let controllerDescriptor,
          controllerCapabilities.contains(profileTransferDrainCapability)
    else { return .updateRequired }
    let preparation = ProfileTransferPreparation()
    profileTransferDraining = true
    profileTransferPreparation = (requestId, preparation)
    return .started(preparation, controllerDescriptor)
  }

  func profileTransferIsAvailable() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return !shuttingDown
      && controllerDescriptor != nil
      && controllerCapabilities.contains(profileTransferDrainCapability)
  }

  func completeProfileTransferController(
    requestId: String,
    result: ProfileTransferPreparationResult
  ) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard let pending = profileTransferPreparation, pending.requestId == requestId else {
      return false
    }
    pending.value.completeController(result)
    return true
  }

  func completeProfileTransferExtension(
    requestId: String,
    result: ProfileTransferPreparationResult
  ) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard let pending = profileTransferPreparation, pending.requestId == requestId else {
      return false
    }
    pending.value.completeExtension(result)
    return true
  }

  func cancelProfileTransferPreparation(requestId: String) {
    lock.lock()
    defer { lock.unlock() }
    guard profileTransferPreparation?.requestId == requestId else { return }
    profileTransferPreparation = nil
    profileTransferDraining = false
  }

  struct ShutdownState {
    let controllerDescriptor: Int32?
    let placementDescriptors: [Int32]
  }

  func beginShutdown() -> ShutdownState {
    lock.lock()
    defer { lock.unlock() }
    shuttingDown = true
    profileTransferDraining = true
    profileTransferPreparation = nil
    let state = ShutdownState(
      controllerDescriptor: controllerDescriptor,
      placementDescriptors: Array(placementPending.values)
    )
    controllerDescriptor = nil
    controllerCapabilities.removeAll()
    controllerPending.removeAll()
    placementPending.removeAll()
    return state
  }

  func isShuttingDown() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return shuttingDown
  }
}

private func controllerStatusMessage(
  connected: Bool,
  capabilities: [String]
) -> [String: Any] {
  [
    "version": controlBridgeVersion,
    "type": "controller-status",
    "connected": connected,
    "capabilities": capabilities,
  ]
}

private final class NativeOutput: @unchecked Sendable {
  private let lock = NSLock()

  func send(_ object: [String: Any]) -> Bool {
    guard let data = try? jsonData(object), data.count <= maximumMessageBytes else { return false }
    var length = UInt32(data.count).littleEndian
    let prefix = withUnsafeBytes(of: &length) { Data($0) }

    lock.lock()
    defer { lock.unlock() }
    return writeAll(STDOUT_FILENO, data: prefix) && writeAll(STDOUT_FILENO, data: data)
  }
}

private func readNativeMessage() -> [String: Any]? {
  guard let prefix = readExactly(STDIN_FILENO, count: 4) else { return nil }
  let length = prefix.withUnsafeBytes { rawBuffer in
    UInt32(littleEndian: rawBuffer.loadUnaligned(as: UInt32.self))
  }
  guard length > 0, length <= maximumMessageBytes,
        let data = readExactly(STDIN_FILENO, count: Int(length))
  else { return nil }
  return try? jsonObject(from: data)
}

private struct NegotiatedProfileSelection {
  let selectedProfile: SelectedProfile
  let serverSocket: ServerSocket?
}

private func negotiateProfileSelection(
  nativeOutput: NativeOutput
) throws -> NegotiatedProfileSelection? {
  guard let hello = readNativeMessage() else { return nil }
  guard hasOnlyKeys(hello, ["version", "type", "profileId"]),
        finiteNumber(hello["version"]) == Double(profileSelectionVersion),
        hello["type"] as? String == "profile-hello",
        let profileId = validProfileId(hello["profileId"])
  else {
    throw BridgeError.message("The native bridge profile handshake is invalid")
  }

  var snapshot = try withProfileSelectionLock { () throws -> ProfileSelectionSnapshot in
    let snapshot = try profileSelectionSnapshotLocked(for: profileId)
    guard nativeOutput.send(profileSelectionStatusMessage(
      snapshot,
      profileTransferAvailable: profileTransferIsAvailable(snapshot)
    )) else {
      throw BridgeError.message("Chrome disconnected during native bridge profile selection")
    }
    return snapshot
  }
  if snapshot.status == .selected, let selectedProfile = snapshot.selectedProfile {
    return NegotiatedProfileSelection(selectedProfile: selectedProfile, serverSocket: nil)
  }
  if snapshot.status == .anotherProfile {
    guard let transfer = readNativeMessage() else { return nil }
    guard hasOnlyKeys(transfer, [
      "version", "type", "profileId", "expectedOwnerRevision",
    ]),
    finiteNumber(transfer["version"]) == Double(profileSelectionVersion),
    transfer["type"] as? String == "transfer-profile",
    validProfileId(transfer["profileId"]) == profileId,
    let expectedOwnerRevision = validProfileId(transfer["expectedOwnerRevision"])
    else {
      throw BridgeError.message("The native bridge profile-transfer request is invalid")
    }

    do {
      let commit = try transferProfile(
        to: profileId,
        expectedOwnerRevision: expectedOwnerRevision
      )
      snapshot = ProfileSelectionSnapshot(
        selectedProfile: commit.selectedProfile,
        status: .selected
      )
      guard nativeOutput.send(profileSelectionStatusMessage(
        snapshot,
        profileTransferAvailable: false
      )) else {
        throw BridgeError.message("Chrome disconnected during native bridge profile transfer")
      }
      return NegotiatedProfileSelection(
        selectedProfile: commit.selectedProfile,
        serverSocket: commit.serverSocket
      )
    } catch let reason as ProfileTransferFailureReason {
      snapshot = try profileSelectionSnapshot(for: profileId)
      if snapshot.status == .selected, let selectedProfile = snapshot.selectedProfile {
        guard nativeOutput.send(profileSelectionStatusMessage(
          snapshot,
          profileTransferAvailable: false
        )) else {
          throw BridgeError.message("Chrome disconnected after native bridge profile transfer")
        }
        return NegotiatedProfileSelection(selectedProfile: selectedProfile, serverSocket: nil)
      }
      var result: [String: Any] = [
        "version": profileSelectionVersion,
        "type": "profile-transfer-result",
        "status": "rejected",
        "reason": reason.rawValue,
      ]
      if let selectedProfile = snapshot.selectedProfile {
        result["ownerRevision"] = selectedProfile.ownerRevision
      }
      _ = nativeOutput.send(result)
      return nil
    } catch {
      var result: [String: Any] = [
        "version": profileSelectionVersion,
        "type": "profile-transfer-result",
        "status": "rejected",
        "reason": ProfileTransferFailureReason.failed.rawValue,
      ]
      if let selectedProfile = snapshot.selectedProfile {
        result["ownerRevision"] = selectedProfile.ownerRevision
      }
      _ = nativeOutput.send(result)
      return nil
    }
  }

  guard let selection = readNativeMessage() else { return nil }
  guard hasOnlyKeys(selection, ["version", "type", "profileId"]),
        finiteNumber(selection["version"]) == Double(profileSelectionVersion),
        selection["type"] as? String == "select-profile",
        validProfileId(selection["profileId"]) == profileId
  else {
    throw BridgeError.message("The native bridge profile-selection request is invalid")
  }

  snapshot = try selectProfile(profileId)
  guard nativeOutput.send(profileSelectionStatusMessage(
    snapshot,
    profileTransferAvailable: false
  )) else {
    throw BridgeError.message("Chrome disconnected during native bridge profile selection")
  }
  if snapshot.status != .selected { _ = readNativeMessage() }
  guard snapshot.status == .selected, let selectedProfile = snapshot.selectedProfile else {
    return nil
  }
  return NegotiatedProfileSelection(selectedProfile: selectedProfile, serverSocket: nil)
}

private struct SocketIdentity {
  let device: dev_t
  let inode: ino_t
}

private struct ServerSocket {
  let fileDescriptor: Int32
  let lockFileDescriptor: Int32
  let identity: SocketIdentity
}

private func socketIdentity(path: String) -> SocketIdentity? {
  var metadata = stat()
  guard lstat(path, &metadata) == 0 else { return nil }
  return SocketIdentity(device: metadata.st_dev, inode: metadata.st_ino)
}

private func unlinkSocket(path: String, ifOwnedBy identity: SocketIdentity) {
  guard let currentIdentity = socketIdentity(path: path),
        currentIdentity.device == identity.device,
        currentIdentity.inode == identity.inode
  else { return }
  _ = unlink(path)
}

private func makeServerSocket(path: String) throws -> ServerSocket {
  let directory = bridgeDirectoryURL()
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  guard chmod(directory.path, S_IRWXU) == 0 else {
    throw BridgeError.message("Could not secure the native bridge runtime directory")
  }

  let lockPath = "\(path).lock"
  let lockFileDescriptor = Darwin.open(lockPath, O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
  guard lockFileDescriptor >= 0 else {
    throw BridgeError.message("Could not open the native bridge ownership lock")
  }
  guard flock(lockFileDescriptor, LOCK_EX | LOCK_NB) == 0 else {
    Darwin.close(lockFileDescriptor)
    throw BridgeError.message("Another native bridge host already owns the local endpoint")
  }

  if FileManager.default.fileExists(atPath: path) {
    if socketIsLive(path: path) {
      _ = flock(lockFileDescriptor, LOCK_UN)
      Darwin.close(lockFileDescriptor)
      throw BridgeError.message("Another native bridge host already owns the local endpoint")
    }
    guard unlink(path) == 0 || errno == ENOENT else {
      _ = flock(lockFileDescriptor, LOCK_UN)
      Darwin.close(lockFileDescriptor)
      throw BridgeError.message("Could not remove a stale native bridge endpoint")
    }
  }

  let fileDescriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
  guard fileDescriptor >= 0 else {
    _ = flock(lockFileDescriptor, LOCK_UN)
    Darwin.close(lockFileDescriptor)
    throw BridgeError.message("Could not create the native bridge server socket")
  }

  var boundIdentity: SocketIdentity?
  do {
    var address = try makeUnixAddress(path: path)
    let bindResult = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(fileDescriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard bindResult == 0 else {
      throw BridgeError.message("Could not bind the native bridge endpoint: \(String(cString: strerror(errno)))")
    }
    guard let identity = socketIdentity(path: path) else {
      throw BridgeError.message("Could not identify the native bridge endpoint")
    }
    boundIdentity = identity
    guard chmod(path, S_IRUSR | S_IWUSR) == 0 else {
      throw BridgeError.message("Could not secure the native bridge endpoint")
    }
    guard Darwin.listen(fileDescriptor, 8) == 0 else {
      throw BridgeError.message("Could not listen on the native bridge endpoint")
    }
    return ServerSocket(
      fileDescriptor: fileDescriptor,
      lockFileDescriptor: lockFileDescriptor,
      identity: identity
    )
  } catch {
    if let boundIdentity {
      unlinkSocket(path: path, ifOwnedBy: boundIdentity)
    }
    Darwin.close(fileDescriptor)
    _ = flock(lockFileDescriptor, LOCK_UN)
    Darwin.close(lockFileDescriptor)
    throw error
  }
}

private func makeSelectedProfileServerSocket(
  path: String,
  selectedProfile: SelectedProfile
) throws -> ServerSocket? {
  try withProfileSelectionLock { () -> ServerSocket? in
    guard let current = try readSelectedProfile(),
          current.profileId == selectedProfile.profileId,
          current.ownerRevision == selectedProfile.ownerRevision
    else { return nil }
    return try makeServerSocket(path: path)
  }
}

private func closeServerSocket(_ serverSocket: ServerSocket, path: String) {
  unlinkSocket(path: path, ifOwnedBy: serverSocket.identity)
  Darwin.shutdown(serverSocket.fileDescriptor, SHUT_RDWR)
  Darwin.close(serverSocket.fileDescriptor)
  _ = flock(serverSocket.lockFileDescriptor, LOCK_UN)
  Darwin.close(serverSocket.lockFileDescriptor)
}

private func bridgeOwnershipIsHeld(path: String) throws -> Bool {
  let lockPath = "\(path).lock"
  let lockFileDescriptor = Darwin.open(lockPath, O_RDWR | O_NOFOLLOW)
  if lockFileDescriptor < 0 {
    if errno == ENOENT { return false }
    throw BridgeError.message("Could not inspect the native bridge ownership lock")
  }
  defer { Darwin.close(lockFileDescriptor) }

  if flock(lockFileDescriptor, LOCK_EX | LOCK_NB) == 0 {
    _ = flock(lockFileDescriptor, LOCK_UN)
    return false
  }
  if errno == EWOULDBLOCK || errno == EAGAIN { return true }
  throw BridgeError.message("Could not inspect the native bridge ownership lock")
}

private func waitForBridgeOwnershipRelease(path: String) throws {
  let deadline = Date().addingTimeInterval(3)
  while try bridgeOwnershipIsHeld(path: path) {
    guard Date() < deadline else {
      throw BridgeError.message("The active native bridge did not release its endpoint")
    }
    usleep(20_000)
  }
}

private func peerProcessId(_ fileDescriptor: Int32) throws -> pid_t {
  var peerUserId = uid_t.max
  var peerGroupId = gid_t.max
  guard getpeereid(fileDescriptor, &peerUserId, &peerGroupId) == 0,
        peerUserId == getuid()
  else {
    throw BridgeError.message("The active native bridge is not owned by the current user")
  }

  var processId = pid_t()
  var processIdSize = socklen_t(MemoryLayout<pid_t>.size)
  guard getsockopt(
    fileDescriptor,
    SOL_LOCAL,
    LOCAL_PEERPID,
    &processId,
    &processIdSize
  ) == 0,
  processId > 1 else {
    throw BridgeError.message("Could not identify the active native bridge process")
  }
  return processId
}

private func processExecutablePath(_ processId: pid_t) -> String? {
  var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN * 4))
  guard proc_pidpath(processId, &buffer, UInt32(buffer.count)) > 0 else { return nil }
  return String(cString: buffer)
}

private func canonicalPath(_ path: String) -> String {
  URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
}

private func terminateLegacyProfileOwner(_ processId: pid_t) throws {
  guard let runningPath = processExecutablePath(processId) else {
    if kill(processId, 0) != 0, errno == ESRCH { return }
    throw BridgeError.message("Could not verify the active native bridge executable")
  }
  let currentPath = canonicalPath(CommandLine.arguments[0])
  guard canonicalPath(runningPath) == currentPath else {
    throw BridgeError.message(
      "Refusing to stop an unexpected process that owns the native bridge endpoint"
    )
  }
  guard kill(processId, SIGTERM) == 0 || errno == ESRCH else {
    throw BridgeError.message("Could not stop the active native bridge process")
  }
}

private enum ProfileTransferFailureReason: String, Error {
  case busy
  case failed
  case selectionChanged = "selection-changed"
  case updateRequired = "update-required"
}

private func profileTransferIsAvailable(
  _ snapshot: ProfileSelectionSnapshot
) -> Bool {
  guard snapshot.status == .anotherProfile,
        let selectedProfile = snapshot.selectedProfile
  else { return false }

  let path = bridgeSocketURL().path
  let fileDescriptor: Int32
  do {
    fileDescriptor = try connectSocket(path: path, timeoutSeconds: 3)
  } catch BridgeError.endpointUnavailable {
    return (try? bridgeOwnershipIsHeld(path: path)) == false
  } catch {
    return false
  }
  defer { Darwin.close(fileDescriptor) }

  do {
    _ = try validateRunningOwnerExecutable(fileDescriptor)
    let requestId = "profile-transfer-capability-\(getpid())-\(currentTimeMs())"
    var requestData = try jsonData([
      "version": profileSelectionVersion,
      "type": "profile-transfer-capability",
      "requestId": requestId,
      "expectedOwnerRevision": selectedProfile.ownerRevision,
    ])
    requestData.append(0x0A)
    guard writeAll(fileDescriptor, data: requestData),
          let responseData = try? readLine(fileDescriptor),
          let capabilityResponse = try? jsonObject(from: responseData),
          hasOnlyKeys(capabilityResponse, [
            "version", "type", "requestId", "status",
          ]),
          finiteNumber(capabilityResponse["version"]) == Double(profileSelectionVersion),
          capabilityResponse["type"] as? String == "response",
          capabilityResponse["requestId"] as? String == requestId,
          capabilityResponse["status"] as? String == "accepted"
    else { return false }
    return true
  } catch {
    return false
  }
}

private func validateRunningOwnerExecutable(_ fileDescriptor: Int32) throws -> pid_t {
  let processId = try peerProcessId(fileDescriptor)
  guard let runningPath = processExecutablePath(processId),
        canonicalPath(runningPath) == canonicalPath(CommandLine.arguments[0])
  else {
    throw BridgeError.message(
      "Refusing to coordinate with an unexpected process that owns the native bridge endpoint"
    )
  }
  return processId
}

private func prepareRunningHostForProfileTransfer(
  expectedOwnerRevision: String
) throws -> Bool {
  let path = bridgeSocketURL().path
  let socketIdentityBeforeTransfer = socketIdentity(path: path)
  let fileDescriptor: Int32
  do {
    fileDescriptor = try connectSocket(path: path, timeoutSeconds: 3)
  } catch BridgeError.endpointUnavailable {
    if try bridgeOwnershipIsHeld(path: path) {
      throw ProfileTransferFailureReason.failed
    }
    if let socketIdentityBeforeTransfer {
      unlinkSocket(path: path, ifOwnedBy: socketIdentityBeforeTransfer)
    }
    return false
  } catch {
    throw ProfileTransferFailureReason.failed
  }
  defer { Darwin.close(fileDescriptor) }

  _ = try validateRunningOwnerExecutable(fileDescriptor)
  let requestId = "profile-transfer-\(getpid())-\(currentTimeMs())"
  var requestData = try jsonData([
    "version": profileSelectionVersion,
    "type": "prepare-profile-transfer",
    "requestId": requestId,
    "expectedOwnerRevision": expectedOwnerRevision,
  ])
  requestData.append(0x0A)

  guard writeAll(fileDescriptor, data: requestData),
        let responseData = try? readLine(fileDescriptor),
        let transferResponse = try? jsonObject(from: responseData),
        finiteNumber(transferResponse["version"]) == Double(profileSelectionVersion),
        transferResponse["type"] as? String == "response",
        transferResponse["requestId"] as? String == requestId,
        let status = transferResponse["status"] as? String
  else { throw ProfileTransferFailureReason.updateRequired }

  if status == "rejected" {
    guard let code = transferResponse["code"] as? String,
          let reason = ProfileTransferFailureReason(rawValue: code)
    else { throw ProfileTransferFailureReason.failed }
    throw reason
  }
  guard status == "accepted", transferResponse["code"] == nil else {
    throw ProfileTransferFailureReason.failed
  }

  try waitForBridgeOwnershipRelease(path: path)
  if let socketIdentityBeforeTransfer {
    unlinkSocket(path: path, ifOwnedBy: socketIdentityBeforeTransfer)
  }
  return true
}

private struct ProfileTransferCommit {
  let selectedProfile: SelectedProfile
  let serverSocket: ServerSocket
}

private func transferProfile(
  to profileId: String,
  expectedOwnerRevision: String
) throws -> ProfileTransferCommit {
  try withProfileSelectionLock {
    guard let current = try readSelectedProfile() else {
      throw ProfileTransferFailureReason.selectionChanged
    }
    if current.profileId == profileId {
      throw ProfileTransferFailureReason.selectionChanged
    }
    guard current.ownerRevision == expectedOwnerRevision else {
      throw ProfileTransferFailureReason.selectionChanged
    }

    _ = try prepareRunningHostForProfileTransfer(
      expectedOwnerRevision: expectedOwnerRevision
    )
    let path = bridgeSocketURL().path
    let serverSocket = try makeServerSocket(path: path)
    do {
      let replacement = SelectedProfile(
        profileId: profileId,
        ownerRevision: UUID().uuidString.lowercased()
      )
      try writeSelectedProfile(replacement)
      return ProfileTransferCommit(
        selectedProfile: replacement,
        serverSocket: serverSocket
      )
    } catch {
      closeServerSocket(serverSocket, path: path)
      throw error
    }
  }
}

private func releaseRunningHostForProfileReset(
  expectedOwnerRevision: String?
) throws -> Bool {
  let path = bridgeSocketURL().path
  let socketIdentityBeforeReset = socketIdentity(path: path)
  let fileDescriptor: Int32
  do {
    fileDescriptor = try connectSocket(path: path, timeoutSeconds: 3)
  } catch {
    if try bridgeOwnershipIsHeld(path: path) {
      throw BridgeError.message(
        "The active native bridge owns its endpoint but could not receive the profile reset"
      )
    }
    if let socketIdentityBeforeReset {
      unlinkSocket(path: path, ifOwnedBy: socketIdentityBeforeReset)
    }
    return false
  }
  defer { Darwin.close(fileDescriptor) }

  let processId = try peerProcessId(fileDescriptor)
  let requestId = "profile-reset-\(getpid())-\(currentTimeMs())"
  var request: [String: Any] = [
    "version": profileSelectionVersion,
    "type": "release-profile-owner",
    "requestId": requestId,
  ]
  if let expectedOwnerRevision {
    request["expectedOwnerRevision"] = expectedOwnerRevision
  }
  var requestData = try jsonData(request)
  requestData.append(0x0A)

  var releaseAccepted = false
  if writeAll(fileDescriptor, data: requestData),
     let responseData = try? readLine(fileDescriptor),
     let releaseResponse = try? jsonObject(from: responseData) {
    releaseAccepted = finiteNumber(releaseResponse["version"]) == Double(profileSelectionVersion)
      && releaseResponse["type"] as? String == "response"
      && releaseResponse["requestId"] as? String == requestId
      && releaseResponse["status"] as? String == "accepted"
  }

  if !releaseAccepted {
    try terminateLegacyProfileOwner(processId)
  }
  try waitForBridgeOwnershipRelease(path: path)
  if let socketIdentityBeforeReset {
    unlinkSocket(path: path, ifOwnedBy: socketIdentityBeforeReset)
  }
  return true
}

private struct ProfileResetResult {
  let selectionCleared: Bool
  let runningHostStopped: Bool
}

private func resetProfileSelection() throws -> ProfileResetResult {
  try withProfileSelectionLock {
    let selectedProfile = try? readSelectedProfile()
    let runningHostStopped = try releaseRunningHostForProfileReset(
      expectedOwnerRevision: selectedProfile?.ownerRevision
    )
    let selectionCleared = try clearSelectedProfileLocked()
    return ProfileResetResult(
      selectionCleared: selectionCleared,
      runningHostStopped: runningHostStopped
    )
  }
}

private func cancelProfileTransferPreparation(
  requestId: String,
  controllerDescriptor: Int32,
  state: BridgeState,
  nativeOutput: NativeOutput
) {
  _ = nativeOutput.send([
    "version": profileSelectionVersion,
    "type": "profile-transfer-cancel",
    "requestId": requestId,
  ])
  _ = writeLocalMessage([
    "version": controlBridgeVersion,
    "type": "profile-transfer-cancel",
    "requestId": requestId,
  ], to: controllerDescriptor)
  state.cancelProfileTransferPreparation(requestId: requestId)
}

private func handleLocalClient(
  _ fileDescriptor: Int32,
  browserProcessId: Int,
  selectedProfile: SelectedProfile,
  state: BridgeState,
  nativeOutput: NativeOutput,
  socketIdentity: SocketIdentity,
  socketPath: String
) {
  var requestId = "invalid"
  var responseVersion = placementBridgeVersion
  var peerUserId = uid_t.max
  var peerGroupId = gid_t.max
  guard getpeereid(fileDescriptor, &peerUserId, &peerGroupId) == 0,
        peerUserId == getuid()
  else {
    writeLocalMessage(rejection(requestId: "invalid", reason: "The local bridge client is not the current user"), to: fileDescriptor)
    Darwin.close(fileDescriptor)
    return
  }

  do {
    let object = try jsonObject(from: readLine(fileDescriptor))
    if object["type"] as? String == "profile-transfer-capability" {
      responseVersion = positiveInteger(object["version"]) ?? profileSelectionVersion
      requestId = validRequestId(object["requestId"]) ?? "invalid"
      guard hasOnlyKeys(object, [
        "version", "type", "requestId", "expectedOwnerRevision",
      ]),
            finiteNumber(object["version"]) == Double(profileSelectionVersion),
            requestId != "invalid",
            validProfileId(object["expectedOwnerRevision"]) == selectedProfile.ownerRevision
      else {
        throw BridgeError.message("The native bridge profile-transfer capability request is invalid")
      }
      let available = state.profileTransferIsAvailable()
      writeLocalMessage(response(
        version: profileSelectionVersion,
        requestId: requestId,
        status: available ? "accepted" : "rejected",
        reason: available ? nil : "The active integration does not support profile transfer",
        fields: available ? [:] : ["code": ProfileTransferFailureReason.updateRequired.rawValue]
      ), to: fileDescriptor)
      Darwin.close(fileDescriptor)
      return
    }
    if object["type"] as? String == "release-profile-owner" {
      responseVersion = positiveInteger(object["version"]) ?? profileSelectionVersion
      requestId = validRequestId(object["requestId"]) ?? "invalid"
      guard hasOnlyKeys(object, [
        "version", "type", "requestId", "expectedOwnerRevision",
      ]),
            finiteNumber(object["version"]) == Double(profileSelectionVersion),
            requestId != "invalid",
            validProfileId(object["expectedOwnerRevision"]) == selectedProfile.ownerRevision
      else {
        throw BridgeError.message("The native bridge profile-owner release request is invalid")
      }
      guard writeLocalMessage(response(
        version: profileSelectionVersion,
        requestId: requestId,
        status: "accepted"
      ), to: fileDescriptor) else {
        throw BridgeError.message("Could not acknowledge the native bridge profile-owner release")
      }
      Darwin.close(fileDescriptor)
      unlinkSocket(path: socketPath, ifOwnedBy: socketIdentity)
      Darwin.exit(0)
    }
    if object["type"] as? String == "prepare-profile-transfer" {
      responseVersion = positiveInteger(object["version"]) ?? profileSelectionVersion
      requestId = validRequestId(object["requestId"]) ?? "invalid"
      guard hasOnlyKeys(object, [
        "version", "type", "requestId", "expectedOwnerRevision",
      ]),
      finiteNumber(object["version"]) == Double(profileSelectionVersion),
      requestId != "invalid",
      validProfileId(object["expectedOwnerRevision"]) == selectedProfile.ownerRevision
      else {
        throw BridgeError.message("The native bridge profile-transfer preparation is invalid")
      }

      switch state.beginProfileTransferPreparation(requestId: requestId) {
      case .busy:
        writeLocalMessage(response(
          version: profileSelectionVersion,
          requestId: requestId,
          status: "rejected",
          reason: "A Tab Out macOS action is already in progress",
          fields: ["code": ProfileTransferFailureReason.busy.rawValue]
        ), to: fileDescriptor)
        Darwin.close(fileDescriptor)
        return
      case .updateRequired:
        writeLocalMessage(response(
          version: profileSelectionVersion,
          requestId: requestId,
          status: "rejected",
          reason: "The active integration cannot attest that it is idle",
          fields: ["code": ProfileTransferFailureReason.updateRequired.rawValue]
        ), to: fileDescriptor)
        Darwin.close(fileDescriptor)
        return
      case .started(let preparation, let controllerDescriptor):
        let extensionPrepared = nativeOutput.send([
          "version": profileSelectionVersion,
          "type": "profile-transfer-prepare",
          "requestId": requestId,
        ])
        let controllerPrepared = writeLocalMessage([
          "version": controlBridgeVersion,
          "type": "profile-transfer-prepare",
          "requestId": requestId,
        ], to: controllerDescriptor)
        if !extensionPrepared {
          preparation.completeExtension(.updateRequired)
        }
        if !controllerPrepared {
          preparation.completeController(.updateRequired)
        }
        let preparationResult = preparation.wait(timeoutSeconds: 3)
        if preparationResult == .idle {
          guard writeLocalMessage(response(
            version: profileSelectionVersion,
            requestId: requestId,
            status: "accepted"
          ), to: fileDescriptor) else {
            cancelProfileTransferPreparation(
              requestId: requestId,
              controllerDescriptor: controllerDescriptor,
              state: state,
              nativeOutput: nativeOutput
            )
            throw BridgeError.message("Could not acknowledge the native bridge profile transfer")
          }
          Darwin.close(fileDescriptor)
          unlinkSocket(path: socketPath, ifOwnedBy: socketIdentity)
          Darwin.exit(0)
        }

        cancelProfileTransferPreparation(
          requestId: requestId,
          controllerDescriptor: controllerDescriptor,
          state: state,
          nativeOutput: nativeOutput
        )
        let failure = preparationResult == .busy
          ? ProfileTransferFailureReason.busy
          : ProfileTransferFailureReason.updateRequired
        writeLocalMessage(response(
          version: profileSelectionVersion,
          requestId: requestId,
          status: "rejected",
          reason: failure == .busy
            ? "A Tab Out macOS action is already in progress"
            : "The active integration could not attest that it is idle",
          fields: ["code": failure.rawValue]
        ), to: fileDescriptor)
        Darwin.close(fileDescriptor)
        return
      }
    }
    if finiteNumber(object["version"]) == Double(controlBridgeVersion) {
      responseVersion = controlBridgeVersion
    }
    requestId = validRequestId(object["requestId"]) ?? "invalid"
    if object["type"] as? String == "controller-register" {
      responseVersion = positiveInteger(object["version"]) ?? controlBridgeVersion
      guard finiteNumber(object["version"]) == Double(controlBridgeVersion) else {
        throw BridgeError.message("The native controller protocol version is unsupported")
      }
      let registration = try validateControllerRegistration(object)
      guard state.registerController(
        fileDescriptor: fileDescriptor,
        capabilities: registration.capabilities
      ) else {
        throw BridgeError.message("Another Hammerspoon controller is already connected")
      }
      guard writeLocalMessage(response(
        version: controlBridgeVersion,
        requestId: registration.request.requestId,
        status: "accepted",
        fields: ["capabilities": registration.capabilities]
      ), to: fileDescriptor) else {
        _ = state.removeController(fileDescriptor: fileDescriptor)
        throw BridgeError.message("The native controller acknowledgement could not be sent")
      }
      _ = nativeOutput.send(controllerStatusMessage(
        connected: true,
        capabilities: registration.capabilities
      ))

      while !state.isShuttingDown() {
        let controllerObject = try jsonObject(from: readLine(fileDescriptor))
        if let transferResponse = validateProfileTransferControllerResponse(controllerObject) {
          _ = state.completeProfileTransferController(
            requestId: transferResponse.requestId,
            result: transferResponse.result
          )
          continue
        }
        guard let controllerRequestId = validateControllerResponse(controllerObject) else {
          throw BridgeError.message("The Hammerspoon controller returned an invalid response")
        }
        guard state.completeControllerRequest(requestId: controllerRequestId) else {
          continue
        }
        guard nativeOutput.send(controllerObject) else {
          throw BridgeError.message("Chrome is no longer connected to the native bridge")
        }
      }
      return
    }

    let request = try validatePlacementRequest(object)
    if let expectedBrowserProcessId = request.expectedBrowserProcessId,
       expectedBrowserProcessId != browserProcessId {
      throw BridgeError.message("The expected browser process does not match the connected Chrome instance")
    }
    guard state.registerPlacement(requestId: request.requestId, fileDescriptor: fileDescriptor) else {
      throw BridgeError.message("The native placement request ID is already pending")
    }

    var extensionObject = object
    extensionObject.removeValue(forKey: "expectedBrowserProcessId")
    guard nativeOutput.send(extensionObject) else {
      _ = state.takePlacement(requestId: request.requestId)
      throw BridgeError.message("Chrome is no longer connected to the native bridge")
    }

    let delay = max(0, Double(request.expiresAtMs - currentTimeMs()) / 1_000)
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay) {
      guard let pendingDescriptor = state.takePlacement(requestId: request.requestId) else { return }
      writeLocalMessage(
        rejection(requestId: request.requestId, reason: "The native placement request timed out"),
        to: pendingDescriptor
      )
      Darwin.close(pendingDescriptor)
    }
  } catch {
    let controllerRemoval = state.removeController(fileDescriptor: fileDescriptor)
    if controllerRemoval.removed {
      _ = nativeOutput.send(controllerStatusMessage(connected: false, capabilities: []))
      for pendingRequestId in controllerRemoval.requestIds {
        _ = nativeOutput.send(rejection(
          version: controlBridgeVersion,
          requestId: pendingRequestId,
          reason: "The Hammerspoon controller disconnected"
        ))
      }
    }
    writeLocalMessage(rejection(
      version: responseVersion,
      requestId: requestId,
      reason: String(describing: error)
    ), to: fileDescriptor)
    Darwin.close(fileDescriptor)
  }
}

private func handleNativeControlRequest(
  _ object: [String: Any],
  browserProcessId: Int,
  state: BridgeState,
  nativeOutput: NativeOutput
) {
  let requestId = validRequestId(object["requestId"]) ?? "invalid"
  do {
    let request = try validateControlRequest(object)
    var controllerObject = object
    controllerObject["browserProcessId"] = browserProcessId
    if let reason = state.forwardToController(
      requestId: request.requestId,
      object: controllerObject
    ) {
      _ = nativeOutput.send(rejection(
        version: controlBridgeVersion,
        requestId: request.requestId,
        reason: reason
      ))
      return
    }

    let delay = max(0, Double(request.expiresAtMs - currentTimeMs()) / 1_000)
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay) {
      guard state.completeControllerRequest(requestId: request.requestId) else { return }
      _ = nativeOutput.send(rejection(
        version: controlBridgeVersion,
        requestId: request.requestId,
        reason: "The native control request timed out"
      ))
    }
  } catch {
    _ = nativeOutput.send(rejection(
      version: controlBridgeVersion,
      requestId: requestId,
      reason: String(describing: error)
    ))
  }
}

private func runNativeHost() throws {
  signal(SIGPIPE, SIG_IGN)
  let browserProcessId = try validatedBrowserProcessId()
  let nativeOutput = NativeOutput()
  guard let negotiation = try negotiateProfileSelection(nativeOutput: nativeOutput) else { return }
  let path = bridgeSocketURL().path
  let serverSocket: ServerSocket
  if let transferredSocket = negotiation.serverSocket {
    serverSocket = transferredSocket
  } else {
    guard let selectedSocket = try makeSelectedProfileServerSocket(
      path: path,
      selectedProfile: negotiation.selectedProfile
    ) else { return }
    serverSocket = selectedSocket
  }
  let serverDescriptor = serverSocket.fileDescriptor
  let state = BridgeState()

  DispatchQueue.global(qos: .userInitiated).async {
    while !state.isShuttingDown() {
      let clientDescriptor = Darwin.accept(serverDescriptor, nil, nil)
      if clientDescriptor < 0 {
        if errno == EINTR { continue }
        break
      }
      DispatchQueue.global(qos: .utility).async {
        handleLocalClient(
          clientDescriptor,
          browserProcessId: browserProcessId,
          selectedProfile: negotiation.selectedProfile,
          state: state,
          nativeOutput: nativeOutput,
          socketIdentity: serverSocket.identity,
          socketPath: path
        )
      }
    }
  }

  while let object = readNativeMessage() {
    let messageType = object["type"] as? String
    if let transferResponse = validateProfileTransferExtensionResponse(object),
       state.completeProfileTransferExtension(
         requestId: transferResponse.requestId,
         result: transferResponse.result
       ) {
      continue
    }
    if (messageType == "resolve-desktop-windows"
      || messageType == "revalidate-desktop-windows"),
       finiteNumber(object["version"]) != Double(controlBridgeVersion) {
      _ = nativeOutput.send(rejection(
        version: positiveInteger(object["version"]) ?? controlBridgeVersion,
        requestId: validRequestId(object["requestId"]) ?? "invalid",
        reason: "The native control protocol version is unsupported"
      ))
      continue
    }
    if finiteNumber(object["version"]) == Double(controlBridgeVersion),
       messageType != "response" {
      handleNativeControlRequest(
        object,
        browserProcessId: browserProcessId,
        state: state,
        nativeOutput: nativeOutput
      )
      continue
    }
    guard object["type"] as? String == "response",
          let requestId = validRequestId(object["requestId"]),
          let clientDescriptor = state.takePlacement(requestId: requestId)
    else { continue }

    guard finiteNumber(object["version"]) == Double(placementBridgeVersion),
          let status = object["status"] as? String,
          status == "accepted" || status == "rejected"
    else {
      writeLocalMessage(rejection(
        requestId: requestId,
        reason: "The extension native placement protocol version does not match"
      ), to: clientDescriptor)
      Darwin.close(clientDescriptor)
      continue
    }

    var localResponse = object
    localResponse["browserProcessId"] = browserProcessId
    writeLocalMessage(localResponse, to: clientDescriptor)
    Darwin.close(clientDescriptor)
  }

  let shutdown = state.beginShutdown()
  if let controllerDescriptor = shutdown.controllerDescriptor {
    Darwin.shutdown(controllerDescriptor, SHUT_RDWR)
  }
  for clientDescriptor in shutdown.placementDescriptors {
    writeLocalMessage(rejection(requestId: "invalid", reason: "Chrome disconnected from the native bridge"), to: clientDescriptor)
    Darwin.close(clientDescriptor)
  }
  closeServerSocket(serverSocket, path: path)
}

private func runClient(requestData: Data) throws -> [String: Any] {
  let object = try jsonObject(from: requestData)
  _ = try validatePlacementRequest(object)
  let fileDescriptor = try connectSocket(path: bridgeSocketURL().path)
  defer { Darwin.close(fileDescriptor) }

  var outgoing = try jsonData(object)
  outgoing.append(0x0A)
  guard writeAll(fileDescriptor, data: outgoing) else {
    throw BridgeError.message("Could not send the local native bridge request")
  }
  return try jsonObject(from: readLine(fileDescriptor))
}

private func printJson(_ object: [String: Any]) throws {
  var data = try jsonData(object)
  data.append(0x0A)
  guard writeAll(STDOUT_FILENO, data: data) else {
    throw BridgeError.message("Could not write the native bridge response")
  }
}

private func main() -> Int32 {
  do {
    let arguments = CommandLine.arguments
    if arguments.count == 2 && arguments[1] == "--version" {
      print(bridgeVersionString)
      return 0
    }
    if arguments.count == 2 && arguments[1] == "--status" {
      let nowMs = currentTimeMs()
      let result = try runClient(requestData: try jsonData([
        "version": placementBridgeVersion,
        "type": "status",
        "requestId": "status-\(getpid())-\(nowMs)",
        "expiresAtMs": nowMs + 3_000,
      ]))
      try printJson(result)
      return result["status"] as? String == "accepted" ? 0 : 1
    }
    if arguments.count == 2 && arguments[1] == "--reset-profile" {
      let result = try resetProfileSelection()
      if result.runningHostStopped {
        print("Cleared the selected Chrome profile and stopped its active native bridge.")
      } else if result.selectionCleared {
        print("Cleared the selected Chrome profile for the macOS integration.")
      } else {
        print("No selected Chrome profile needed to be cleared.")
      }
      return 0
    }
    if arguments.count == 3 && arguments[1] == "--request" {
      guard let requestData = arguments[2].data(using: .utf8) else {
        throw BridgeError.message("The local native bridge request is not UTF-8")
      }
      try printJson(runClient(requestData: requestData))
      return 0
    }
    if arguments.count >= 2, validExtensionOrigin(arguments[1]) {
      try runNativeHost()
      return 0
    }

    fputs(
      "Usage: tab-out-native-bridge --request '<json>' | --reset-profile | --status | --version\n",
      stderr
    )
    return 64
  } catch BridgeError.endpointUnavailable(let message) {
    fputs("tab-out-native-bridge: \(message)\n", stderr)
    return 2
  } catch {
    fputs("tab-out-native-bridge: \(String(describing: error))\n", stderr)
    return 1
  }
}

exit(main())
