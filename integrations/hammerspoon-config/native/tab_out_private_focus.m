#import <ApplicationServices/ApplicationServices.h>
#import <Cocoa/Cocoa.h>
#import <LuaSkin/LuaSkin.h>
#import <dlfcn.h>
#import <sys/sysctl.h>

static const char *kAllowedOSBuild = "25F84";
static const uint32_t kCPSUserGenerated = 0x200;

typedef AXError (*AXElementWindowIDFunction)(AXUIElementRef, CGWindowID *);
typedef int (*MainConnectionIDFunction)(void);
typedef CGError (*SetFrontProcessFunction)(ProcessSerialNumber *, uint32_t, uint32_t);
typedef CGError (*PostEventRecordFunction)(ProcessSerialNumber *, uint8_t *);

typedef struct {
  void *applicationServices;
  void *skyLight;
  AXElementWindowIDFunction getWindowID;
  SetFrontProcessFunction setFrontProcess;
  PostEventRecordFunction postEventRecord;
} PrivateFocusSymbols;

static int pushFailure(lua_State *L, NSString *message) {
  lua_pushnil(L);
  lua_pushstring(L, message.UTF8String);
  return 2;
}

static NSString *currentOSBuild(void) {
  size_t size = 0;
  if (sysctlbyname("kern.osversion", NULL, &size, NULL, 0) != 0 || size < 2) return nil;

  char *buffer = calloc(size, 1);
  if (!buffer) return nil;

  NSString *build = nil;
  if (sysctlbyname("kern.osversion", buffer, &size, NULL, 0) == 0) {
    build = [NSString stringWithUTF8String:buffer];
  }
  free(buffer);
  return build;
}

static NSString *baseCapabilityError(void) {
  NSString *osBuild = currentOSBuild();
  if (!osBuild || ![osBuild isEqualToString:[NSString stringWithUTF8String:kAllowedOSBuild]]) {
    return [NSString stringWithFormat:
      @"unsupported macOS build %@; allowed build is %s",
      osBuild ?: @"unknown",
      kAllowedOSBuild
    ];
  }
  if (!AXIsProcessTrusted()) return @"Hammerspoon does not have Accessibility permission";
  return nil;
}

static void closePrivateSymbols(PrivateFocusSymbols *symbols) {
  if (symbols->skyLight) dlclose(symbols->skyLight);
  if (symbols->applicationServices) dlclose(symbols->applicationServices);
  memset(symbols, 0, sizeof(*symbols));
}

static NSString *loadPrivateSymbols(PrivateFocusSymbols *symbols) {
  memset(symbols, 0, sizeof(*symbols));
  symbols->applicationServices = dlopen(
    "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
    RTLD_NOW | RTLD_LOCAL
  );
  symbols->skyLight = dlopen(
    "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
    RTLD_NOW | RTLD_LOCAL
  );
  symbols->getWindowID = symbols->applicationServices
    ? (AXElementWindowIDFunction)dlsym(symbols->applicationServices, "_AXUIElementGetWindow")
    : NULL;
  MainConnectionIDFunction mainConnectionID = symbols->skyLight
    ? (MainConnectionIDFunction)dlsym(symbols->skyLight, "SLSMainConnectionID")
    : NULL;
  symbols->setFrontProcess = symbols->skyLight
    ? (SetFrontProcessFunction)dlsym(symbols->skyLight, "_SLPSSetFrontProcessWithOptions")
    : NULL;
  symbols->postEventRecord = symbols->skyLight
    ? (PostEventRecordFunction)dlsym(symbols->skyLight, "SLPSPostEventRecordTo")
    : NULL;

  if (!symbols->applicationServices
    || !symbols->skyLight
    || !symbols->getWindowID
    || !mainConnectionID
    || !symbols->setFrontProcess
    || !symbols->postEventRecord
  ) {
    closePrivateSymbols(symbols);
    return @"required private focus symbols are unavailable";
  }
  if (mainConnectionID() <= 0) {
    closePrivateSymbols(symbols);
    return @"the private WindowServer connection is unavailable";
  }
  return nil;
}

static NSDictionary *windowInfo(CGWindowID windowID) {
  CFArrayRef rawWindows = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, windowID);
  NSArray *windows = CFBridgingRelease(rawWindows);
  for (NSDictionary *candidate in windows) {
    NSNumber *candidateID = candidate[(__bridge NSString *)kCGWindowNumber];
    if (candidateID.unsignedIntValue == windowID) return candidate;
  }
  return nil;
}

static AXUIElementRef copyWindowElement(
  pid_t pid,
  CGWindowID targetWindowID,
  AXElementWindowIDFunction getWindowID,
  NSString **errorMessage
) {
  AXUIElementRef application = AXUIElementCreateApplication(pid);
  if (!application) {
    *errorMessage = @"could not create the Chrome accessibility element";
    return NULL;
  }

  CFTypeRef rawWindows = NULL;
  AXError copyError = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &rawWindows);
  CFRelease(application);
  if (copyError != kAXErrorSuccess || !rawWindows || CFGetTypeID(rawWindows) != CFArrayGetTypeID()) {
    if (rawWindows) CFRelease(rawWindows);
    *errorMessage = [NSString stringWithFormat:@"could not read Chrome windows (AX error %d)", copyError];
    return NULL;
  }

  CFArrayRef windows = rawWindows;
  AXUIElementRef result = NULL;
  for (CFIndex index = 0; index < CFArrayGetCount(windows); ++index) {
    AXUIElementRef candidate = (AXUIElementRef)CFArrayGetValueAtIndex(windows, index);
    CGWindowID candidateID = 0;
    if (getWindowID(candidate, &candidateID) == kAXErrorSuccess && candidateID == targetWindowID) {
      result = (AXUIElementRef)CFRetain(candidate);
      break;
    }
  }
  CFRelease(windows);

  if (!result) {
    *errorMessage = @"the exact Chrome accessibility window was not found";
    return NULL;
  }

  CFTypeRef role = NULL;
  CFTypeRef subrole = NULL;
  CFTypeRef minimized = NULL;
  AXError roleError = AXUIElementCopyAttributeValue(result, kAXRoleAttribute, &role);
  AXError subroleError = AXUIElementCopyAttributeValue(result, kAXSubroleAttribute, &subrole);
  AXError minimizedError = AXUIElementCopyAttributeValue(result, kAXMinimizedAttribute, &minimized);
  BOOL valid = roleError == kAXErrorSuccess
    && role
    && CFEqual(role, kAXWindowRole)
    && subroleError == kAXErrorSuccess
    && subrole
    && CFEqual(subrole, kAXStandardWindowSubrole)
    && minimizedError == kAXErrorSuccess
    && minimized
    && CFGetTypeID(minimized) == CFBooleanGetTypeID()
    && !CFBooleanGetValue(minimized);

  if (role) CFRelease(role);
  if (subrole) CFRelease(subrole);
  if (minimized) CFRelease(minimized);

  if (!valid) {
    CFRelease(result);
    *errorMessage = @"the target is not a non-minimized standard Chrome window";
    return NULL;
  }

  CFArrayRef actions = NULL;
  AXError actionsError = AXUIElementCopyActionNames(result, &actions);
  BOOL canRaise = actionsError == kAXErrorSuccess
    && actions
    && CFArrayContainsValue(actions, CFRangeMake(0, CFArrayGetCount(actions)), kAXRaiseAction);
  if (actions) CFRelease(actions);
  if (!canRaise) {
    CFRelease(result);
    *errorMessage = @"the target Chrome window does not support AXRaise";
    return NULL;
  }

  return result;
}

static int checkCapability(lua_State *L) {
  @autoreleasepool {
    NSString *error = baseCapabilityError();
    if (error) return pushFailure(L, error);

    PrivateFocusSymbols symbols;
    error = loadPrivateSymbols(&symbols);
    if (error) return pushFailure(L, error);
    closePrivateSymbols(&symbols);

    lua_pushboolean(L, true);
    return 1;
  }
}

static int focusExactWindow(lua_State *L) {
  @autoreleasepool {
    lua_Integer luaPID = luaL_checkinteger(L, 1);
    lua_Integer luaWindowID = luaL_checkinteger(L, 2);
    if (luaPID <= 1 || luaPID > INT_MAX || luaWindowID <= 0 || (uint64_t)luaWindowID > UINT32_MAX) {
      return pushFailure(L, @"pid and window-id must be positive integers in range");
    }

    NSString *capabilityError = baseCapabilityError();
    if (capabilityError) return pushFailure(L, capabilityError);

    pid_t pid = (pid_t)luaPID;
    CGWindowID windowID = (CGWindowID)luaWindowID;
    NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (!application || application.terminated || ![application.bundleIdentifier isEqualToString:@"com.google.Chrome"]) {
      return pushFailure(L, @"pid is not the running Google Chrome application");
    }

    NSDictionary *info = windowInfo(windowID);
    NSNumber *ownerPID = info[(__bridge NSString *)kCGWindowOwnerPID];
    NSNumber *layer = info[(__bridge NSString *)kCGWindowLayer];
    NSNumber *onScreen = info[(__bridge NSString *)kCGWindowIsOnscreen];
    NSString *ownerName = info[(__bridge NSString *)kCGWindowOwnerName];
    if (!info
      || ownerPID.intValue != pid
      || layer.intValue != 0
      || !onScreen.boolValue
      || ![ownerName isEqualToString:@"Google Chrome"]
    ) {
      return pushFailure(L, @"window-id is not an on-screen normal window owned by that Chrome pid");
    }

    PrivateFocusSymbols symbols;
    NSString *symbolsError = loadPrivateSymbols(&symbols);
    if (symbolsError) return pushFailure(L, symbolsError);

    NSString *accessibilityError = nil;
    AXUIElementRef targetWindow = copyWindowElement(pid, windowID, symbols.getWindowID, &accessibilityError);
    if (!targetWindow) {
      closePrivateSymbols(&symbols);
      return pushFailure(L, accessibilityError);
    }

    ProcessSerialNumber psn = {0, 0};
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    OSStatus psnError = GetProcessForPID(pid, &psn);
#pragma clang diagnostic pop
    if (psnError != noErr) {
      CFRelease(targetWindow);
      closePrivateSymbols(&symbols);
      return pushFailure(L, [NSString stringWithFormat:@"could not resolve Chrome's process serial number (%d)", psnError]);
    }

    CGError frontError = symbols.setFrontProcess(&psn, windowID, kCPSUserGenerated);
    if (frontError != kCGErrorSuccess) {
      CFRelease(targetWindow);
      closePrivateSymbols(&symbols);
      return pushFailure(L, [NSString stringWithFormat:@"exact-window foreground call failed (%d)", frontError]);
    }

    uint8_t eventRecord[0x100] = {0};
    eventRecord[0x04] = 0xf8;
    eventRecord[0x3a] = 0x10;
    memcpy(eventRecord + 0x3c, &windowID, sizeof(windowID));
    memset(eventRecord + 0x20, 0xff, 0x10);
    eventRecord[0x08] = 0x01;
    CGError firstEventError = symbols.postEventRecord(&psn, eventRecord);
    eventRecord[0x08] = 0x02;
    CGError secondEventError = symbols.postEventRecord(&psn, eventRecord);
    if (firstEventError != kCGErrorSuccess || secondEventError != kCGErrorSuccess) {
      CFRelease(targetWindow);
      closePrivateSymbols(&symbols);
      return pushFailure(
        L,
        [NSString stringWithFormat:@"exact-window key events failed (%d, %d)", firstEventError, secondEventError]
      );
    }

    AXError raiseError = AXUIElementPerformAction(targetWindow, kAXRaiseAction);
    CFRelease(targetWindow);
    closePrivateSymbols(&symbols);
    if (raiseError != kAXErrorSuccess) {
      return pushFailure(L, [NSString stringWithFormat:@"target-window raise failed (AX error %d)", raiseError]);
    }

    lua_pushboolean(L, true);
    return 1;
  }
}

static const luaL_Reg moduleFunctions[] = {
  {"capability", checkCapability},
  {"focus", focusExactWindow},
  {NULL, NULL},
};

__attribute__((visibility("default")))
int luaopen_tab_out_private_focus(lua_State *L) {
  luaL_newlib(L, moduleFunctions);
  return 1;
}
