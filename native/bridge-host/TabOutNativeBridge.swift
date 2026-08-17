import Darwin
import CoreFoundation
import Foundation

private let placementBridgeVersion = 3
private let controlBridgeVersion = 4
private let bridgeVersionString = "4.0.0"
private let maximumMessageBytes = 64 * 1024
private let maximumRequestLifetimeMs: Int64 = 60_000
private let mergeDesktopCapability = "merge-desktop"

private enum BridgeError: Error, CustomStringConvertible {
  case message(String)

  var description: String {
    switch self {
    case .message(let message): message
    }
  }
}

private func currentTimeMs() -> Int64 {
  Int64(Date().timeIntervalSince1970 * 1_000)
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

private func validCapabilities(_ value: Any?) -> [String]? {
  guard let values = value as? [Any], values.count <= 16 else { return nil }
  var capabilities: [String] = []
  var seen = Set<String>()
  for value in values {
    guard let capability = value as? String,
          capability == mergeDesktopCapability,
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

private func validatePlacementRequest(_ object: [String: Any]) throws -> ValidatedRequest {
  guard finiteNumber(object["version"]) == Double(placementBridgeVersion) else {
    throw BridgeError.message("The native placement protocol version is unsupported")
  }
  let request = try validateDeadline(object, requestKind: "native placement")

  guard let type = object["type"] as? String else {
    throw BridgeError.message("The native placement request type is invalid")
  }
  if type == "status" {
    return request
  }
  if type == "list-profile-windows" {
    return request
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

  return request
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
      throw BridgeError.message("The native bridge is not connected: \(String(cString: strerror(errno)))")
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

private final class BridgeState: @unchecked Sendable {
  private let lock = NSLock()
  private var controllerDescriptor: Int32?
  private var controllerPending = Set<String>()
  private var placementPending: [String: Int32] = [:]
  private var shuttingDown = false

  func registerPlacement(requestId: String, fileDescriptor: Int32) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !shuttingDown, placementPending[requestId] == nil else { return false }
    placementPending[requestId] = fileDescriptor
    return true
  }

  func takePlacement(requestId: String) -> Int32? {
    lock.lock()
    defer { lock.unlock() }
    return placementPending.removeValue(forKey: requestId)
  }

  func registerController(fileDescriptor: Int32) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !shuttingDown, controllerDescriptor == nil else { return false }
    controllerDescriptor = fileDescriptor
    return true
  }

  func forwardToController(requestId: String, object: [String: Any]) -> String? {
    lock.lock()
    defer { lock.unlock() }
    guard !shuttingDown else { return "The native bridge is shutting down" }
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
    let pending = Array(controllerPending)
    controllerPending.removeAll()
    return (true, pending)
  }

  struct ShutdownState {
    let controllerDescriptor: Int32?
    let placementDescriptors: [Int32]
  }

  func beginShutdown() -> ShutdownState {
    lock.lock()
    defer { lock.unlock() }
    shuttingDown = true
    let state = ShutdownState(
      controllerDescriptor: controllerDescriptor,
      placementDescriptors: Array(placementPending.values)
    )
    controllerDescriptor = nil
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

private func handleLocalClient(
  _ fileDescriptor: Int32,
  state: BridgeState,
  nativeOutput: NativeOutput
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
    if finiteNumber(object["version"]) == Double(controlBridgeVersion) {
      responseVersion = controlBridgeVersion
    }
    requestId = validRequestId(object["requestId"]) ?? "invalid"
    if finiteNumber(object["version"]) == Double(controlBridgeVersion),
       object["type"] as? String == "controller-register" {
      let registration = try validateControllerRegistration(object)
      guard state.registerController(fileDescriptor: fileDescriptor) else {
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
    guard state.registerPlacement(requestId: request.requestId, fileDescriptor: fileDescriptor) else {
      throw BridgeError.message("The native placement request ID is already pending")
    }

    guard nativeOutput.send(object) else {
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
  state: BridgeState,
  nativeOutput: NativeOutput
) {
  let requestId = validRequestId(object["requestId"]) ?? "invalid"
  do {
    let request = try validateControlRequest(object)
    if let reason = state.forwardToController(requestId: request.requestId, object: object) {
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
  let path = bridgeSocketURL().path
  let serverSocket = try makeServerSocket(path: path)
  let serverDescriptor = serverSocket.fileDescriptor
  let state = BridgeState()
  let nativeOutput = NativeOutput()

  DispatchQueue.global(qos: .userInitiated).async {
    while !state.isShuttingDown() {
      let clientDescriptor = Darwin.accept(serverDescriptor, nil, nil)
      if clientDescriptor < 0 {
        if errno == EINTR { continue }
        break
      }
      DispatchQueue.global(qos: .utility).async {
        handleLocalClient(clientDescriptor, state: state, nativeOutput: nativeOutput)
      }
    }
  }

  while let object = readNativeMessage() {
    if finiteNumber(object["version"]) == Double(controlBridgeVersion),
       object["type"] as? String != "response" {
      handleNativeControlRequest(object, state: state, nativeOutput: nativeOutput)
      continue
    }
    guard object["type"] as? String == "response",
          finiteNumber(object["version"]) == Double(placementBridgeVersion),
          let requestId = validRequestId(object["requestId"]),
          let status = object["status"] as? String,
          status == "accepted" || status == "rejected",
          let clientDescriptor = state.takePlacement(requestId: requestId)
    else { continue }

    writeLocalMessage(object, to: clientDescriptor)
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
  unlinkSocket(path: path, ifOwnedBy: serverSocket.identity)
  Darwin.shutdown(serverDescriptor, SHUT_RDWR)
  Darwin.close(serverDescriptor)
  _ = flock(serverSocket.lockFileDescriptor, LOCK_UN)
  Darwin.close(serverSocket.lockFileDescriptor)
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

    fputs("Usage: tab-out-native-bridge --request '<json>' | --status | --version\n", stderr)
    return 64
  } catch {
    fputs("tab-out-native-bridge: \(String(describing: error))\n", stderr)
    return 1
  }
}

exit(main())
