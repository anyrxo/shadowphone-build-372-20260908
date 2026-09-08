const { contextBridge, ipcRenderer } = require('electron')

// Expose protected methods to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Device management
  getDevices: () => ipcRenderer.invoke('get-devices'),
  refreshDevices: () => ipcRenderer.invoke('refresh-devices'),
  adbConnect: (target) => ipcRenderer.invoke('adb-connect', target),
  adbDisconnect: (target) => ipcRenderer.invoke('adb-disconnect', target),
  onDevicesUpdated: (callback) => {
    // Returning an unsubscribe fn from event-bridge methods is essential —
    // without it, React Strict Mode / HMR / any remount of the consuming
    // tree stacks duplicate listeners. Each duplicate fires setDevices
    // again, causing visible device-list flicker and stale selectedDevice.
    const listener = (event, devices) => callback(devices)
    ipcRenderer.on('devices-updated', listener)
    return () => ipcRenderer.removeListener('devices-updated', listener)
  },

  // ==================== NEW DEVICE DETECTION ====================
  // Listen for new device popup trigger
  onNewDeviceDetected: (callback) => {
    const listener = (event, device) => callback(device)
    ipcRenderer.on('new-device-detected', listener)
    return () => ipcRenderer.removeListener('new-device-detected', listener)
  },
  // Set saved devices from Supabase (call on app init)
  setSavedDevices: (devices) => ipcRenderer.invoke('set-saved-devices', devices),
  // Add device to saved list (after user confirms popup)
  addDeviceToSaved: (device) => ipcRenderer.invoke('add-device-to-saved', device),
  // Remove device from saved list
  removeDeviceFromSaved: (serial) => ipcRenderer.invoke('remove-device-from-saved', serial),
  // Get connected devices with saved status
  getDevicesWithStatus: () => ipcRenderer.invoke('get-devices-with-status'),
  // Dismiss new device popup (user clicked "Not Now")
  dismissNewDevice: (serial) => ipcRenderer.invoke('dismiss-new-device', serial),
  // Device nicknames — local override stored in userData by serial
  getDeviceNicknames: () => ipcRenderer.invoke('get-device-nicknames'),
  setDeviceNickname: (serial, nickname) => ipcRenderer.invoke('set-device-nickname', serial, nickname),
  // Per-device connection-transport preference (Auto/USB/WiFi) keyed by hwSerial
  getDeviceTransport: () => ipcRenderer.invoke('get-device-transport'),
  setDeviceTransport: (hwSerial, pref) => ipcRenderer.invoke('set-device-transport', hwSerial, pref),
  // App settings + USB-to-VPS adb-server-share, so the Phones tab can expose/close
  // the PC's USB phones to a remote VPS over Tailscale (global — shares all USB phones).
  getAppSetting: (key) => ipcRenderer.invoke('app:get-setting', key),
  setAppSetting: (key, value) => ipcRenderer.invoke('app:set-setting', key, value),
  getUsbVpsStatus: () => ipcRenderer.invoke('usb-vps:status'),
  // Open the per-phone Models Dashboard (replaces the floating "Phones" pill + Fleet panel
  // detour — the sidebar Phones tab now launches the dashboard directly).
  launchDashboard: (serial) => ipcRenderer.invoke('fleet:launch-dashboard', serial),

  // Device control
  takeScreenshot: (serial) => ipcRenderer.invoke('take-screenshot', serial),
  executeTap: (serial, x, y) => ipcRenderer.invoke('execute-tap', serial, x, y),
  executeSwipe: (serial, x1, y1, x2, y2, duration) =>
    ipcRenderer.invoke('execute-swipe', serial, x1, y1, x2, y2, duration),
  inputText: (serial, text) => ipcRenderer.invoke('input-text', serial, text),
  pressKey: (serial, keycode) => ipcRenderer.invoke('press-key', serial, keycode),
  devicePower: (serial, action) => ipcRenderer.invoke('device-power', serial, action),
  lockScreen: (serial) => ipcRenderer.invoke('phone:lock', { serial }),

  // App management
  launchApp: (serial, packageName) => ipcRenderer.invoke('launch-app', serial, packageName),
  getInstalledApps: (serial) => ipcRenderer.invoke('get-installed-apps', serial),

  // Utilities
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Session recovery — clears cookies/cache to fix stuck Clerk auth
  clearSession: () => ipcRenderer.invoke('clear-session'),

  // ADB Installation
  checkAdb: () => ipcRenderer.invoke('check-adb'),
  installAdb: () => ipcRenderer.invoke('install-adb'),
  onAdbInstallProgress: (callback) => {
    const listener = (event, progress) => callback(progress)
    ipcRenderer.on('adb-install-progress', listener)
    return () => ipcRenderer.removeListener('adb-install-progress', listener)
  },

  // Auto-updates
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  // Accepts either a URL string (legacy) or { downloadUrl, fileSize }.
  // Forwarding fileSize lets the main process verify the download is
  // byte-complete before it's ever executed.
  downloadUpdate: (urlOrOptions) => ipcRenderer.invoke('download-update', urlOrOptions),
  installUpdate: (installerPath) => ipcRenderer.invoke('install-update', installerPath),
  onUpdateAvailable: (callback) => {
    const listener = (event, info) => callback(info)
    ipcRenderer.on('update-available', listener)
    return () => ipcRenderer.removeListener('update-available', listener)
  },
  onUpdateDownloaded: (callback) => {
    const listener = (event, filePath) => callback(filePath)
    ipcRenderer.on('update-downloaded', listener)
    return () => ipcRenderer.removeListener('update-downloaded', listener)
  },
  onUpdateDownloadError: (callback) => {
    const listener = (event, error) => callback(error)
    ipcRenderer.on('update-download-error', listener)
    return () => ipcRenderer.removeListener('update-download-error', listener)
  },
  onUpdateDownloadProgress: (callback) => {
    // Payload: { bytes, total, pct, version }
    const listener = (event, info) => callback(info)
    ipcRenderer.on('update-download-progress', listener)
    return () => ipcRenderer.removeListener('update-download-progress', listener)
  },

  // App info
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  getRuntimeCapabilities: () => Object.freeze({ ownerDocumentShareV1: true }),

  // API config (Railway URL and secret from env)
  getApiConfig: () => ipcRenderer.invoke('get-api-config'),

  // Module execution
  getModules: () => ipcRenderer.invoke('get-modules'),
  runModule: (config) => ipcRenderer.invoke('run-module', config),
  abortModule: (runId) => ipcRenderer.invoke('abort-module', runId),
  adbPushFile: (opts) => ipcRenderer.invoke('adb-push-file', opts),
  adbPushContentFolder: (opts) => ipcRenderer.invoke('adb-push-content-folder', opts),
  // 2.17.8: direct vanadium HTTP push — for the dashboard's Quick Upload.
  // Bypasses the Content folder + push_content module dance; works on any
  // GrapheneOS profile (owner or non-owner) without account-folder lookup.
  vanadiumUploadFile: (opts) => ipcRenderer.invoke('vanadium-upload-file', opts),
  selectFiles: (opts) => ipcRenderer.invoke('select-files', opts),
  isModuleExecutionActive: () => ipcRenderer.invoke('is-module-execution-active'),
  detectAccounts: (deviceId) => ipcRenderer.invoke('detect-accounts', deviceId),
  onModuleProgress: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('module-progress', listener)
    return () => ipcRenderer.removeListener('module-progress', listener)
  },

  // ==================== BRAIN STATUS (LOCAL vs RAILWAY) ====================
  // Topbar pill polls this on mount + every 30s so multi-machine users can
  // SEE which dispatch path their app is on. Companion event
  // 'brain-disconnected' flips the pill red the moment the local brain
  // silently drops out and the renderer falls back to Railway.
  brainGetStatus: () => ipcRenderer.invoke('brain:get-status'),
  // Manual restart from the topbar Brain Status pill when the brain is DOWN.
  brainRestart: () => ipcRenderer.invoke('brain:restart'),
  // External link to python.org so users without Python 3.11 can install it
  // from the pill's "Install Python 3.11" CTA without us bundling a runtime.
  onBrainDisconnected: (callback) => {
    const listener = (event, payload) => callback(payload)
    ipcRenderer.on('brain-disconnected', listener)
    return () => ipcRenderer.removeListener('brain-disconnected', listener)
  },

  // ==================== WEB-MIRROR PORTAL ====================
  // One ws-scrcpy server for the whole fleet, behind a token auth-proxy +
  // cloudflared tunnel. The operator starts it and shares the secret link.
  portalStart: () => ipcRenderer.invoke('portal:start'),
  portalStop: () => ipcRenderer.invoke('portal:stop'),
  portalStatus: () => ipcRenderer.invoke('portal:status'),
  portalOpenWindow: (serial) => ipcRenderer.invoke('portal:open-window', { serial }),
  portalIssueDeviceLink: (serial, label) => ipcRenderer.invoke('portal:issue-device-link', { serial, label }),
  portalListTokens: () => ipcRenderer.invoke('portal:list-tokens'),
  portalRevokeToken: (token) => ipcRenderer.invoke('portal:revoke-token', { token }),

  // ==================== WEBSOCKET MODULE EXECUTION ====================
  // Real-time module execution with server-controlled logic
  runModuleWs: (config) => ipcRenderer.invoke('run-module-ws', config),
  abortModuleWs: (runId) => ipcRenderer.invoke('abort-module-ws', runId),
  respondToModulePrompt: (runId, promptId, action) => ipcRenderer.invoke('respond-to-module-prompt', runId, promptId, action),
  checkModuleWsSupport: (moduleId) => ipcRenderer.invoke('check-module-ws-support', moduleId),
  checkServerHealth: () => ipcRenderer.invoke('check-server-health'),

  // ==================== LOCAL MODULE EXECUTION ====================
  // Local module execution without server (pure Electron-based)
  runModuleLocal: (...args) => {
    // ModuleRunner passes 5 separate args: (runId, moduleId, deviceId, profileId, moduleConfig)
    // Handler expects a single config object
    if (args.length >= 3 && typeof args[0] === 'string' && typeof args[1] === 'string') {
      return ipcRenderer.invoke('run-module-local', {
        runId: args[0], moduleId: args[1], deviceId: args[2], profileId: args[3], moduleConfig: args[4]
      })
    }
    // Single object call (backward compat)
    return ipcRenderer.invoke('run-module-local', args[0])
  },
  checkModuleLocalSupport: (moduleId) => ipcRenderer.invoke('check-module-local-support', moduleId),

  // ==================== POWER SAVE / BACKGROUND THROTTLING ====================
  // Reference-counted handles so the renderer can ask the OS to keep the
  // app awake while a module run is in flight, then release on completion.
  acquireActiveRun: () => ipcRenderer.invoke('acquire-active-run'),
  releaseActiveRun: () => ipcRenderer.invoke('release-active-run'),

  openCreateIg: (input) => ipcRenderer.invoke('account-creation:open', input),

  // ==================== BATCH ACCOUNT CREATION ====================
  // Create Instagram account via account_creation module
  batchCreateAccount: (config) => ipcRenderer.invoke('batch-create-account', config),
  // Listen for batch account creation progress
  onBatchCreateProgress: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('batch-create-progress', listener)
    return () => ipcRenderer.removeListener('batch-create-progress', listener)
  },


  // Profile management
  getProfiles: (serial) => ipcRenderer.invoke('get-device-profiles', serial),
  getDeviceProfiles: (serial) => ipcRenderer.invoke('get-device-profiles', serial),
  getCurrentProfile: (serial) => ipcRenderer.invoke('get-current-profile', serial),
  switchProfile: (config) => ipcRenderer.invoke('switch-profile', config),
  createProfile: (serial, name, options) => ipcRenderer.invoke('create-profile', serial, name, options),
  deleteProfile: (serial, userId) => ipcRenderer.invoke('delete-profile', serial, userId),
  renameProfile: (serial, userId, newName) => ipcRenderer.invoke('rename-profile', serial, userId, newName),
  // Local profile nickname overrides (saved per device+profile in userData).
  // The renderer doesn't strictly need these — get-device-profiles already
  // merges the nickname into displayName — but exposing them lets settings
  // panels show + clear individual overrides.
  getProfileNicknames: (serial) => ipcRenderer.invoke('get-profile-nicknames', serial),
  setProfileNickname: (serial, profileId, nickname) => ipcRenderer.invoke('set-profile-nickname', serial, profileId, nickname),
  onProfileSwitchProgress: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('profile-switch-progress', listener)
    return () => ipcRenderer.removeListener('profile-switch-progress', listener)
  },
  onProfileSwitched: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('profile-switched', listener)
    return () => ipcRenderer.removeListener('profile-switched', listener)
  },

  // ==================== DIRECT DEVICE ACTIONS ====================
  // Quick actions that work immediately via ADB (no server needed)
  openInstagram: (serial) => ipcRenderer.invoke('open-instagram', serial),
  openInstagramDm: (serial) => ipcRenderer.invoke('open-instagram-dm', serial),
  openInstagramProfile: (serial, username) => ipcRenderer.invoke('open-instagram-profile', serial, username),
  toggleAirplane: (serial) => ipcRenderer.invoke('toggle-airplane', serial),
  resetIp: (serial, waitMs) => ipcRenderer.invoke('reset-ip', serial, waitMs),
  // Phone fleet controls (handlers take { serial }) — consolidation from fleet window
  pingLatency: (serial) => ipcRenderer.invoke('phone:ping-latency', { serial }),
  getAdbProcessStats: () => ipcRenderer.invoke('adb-process-stats'),
  screenToggle: (serial) => ipcRenderer.invoke('phone:screen-toggle', { serial }),
  wakeUnlock: (serial) => ipcRenderer.invoke('phone:wake-unlock', { serial }),
  openGallery: (serial) => ipcRenderer.invoke('phone:open-gallery', { serial }),
  clearGallery: (serial) => ipcRenderer.invoke('phone:clear-gallery', { serial }),
  getCurrentUser: (serial) => ipcRenderer.invoke('phone:get-current-user', { serial }),
  // Live on-device IG profile edits (drive the phone via ADB automation) — Command Center parity
  editInstagramProfile: (payload) => ipcRenderer.invoke('dashboard:edit-profile', payload),
  editBio: (serial, userId, account, bioText) => ipcRenderer.invoke('dashboard:edit-bio', { serial, userId, account, bioText }),
  changeAvatar: (serial, userId, account) => ipcRenderer.invoke('dashboard:change-avatar', { serial, userId, account }),
  // Bulk fleet ops on selected accounts (Command Center BulkBar parity)
  fleetScan: (serial, profileIds) => ipcRenderer.invoke('fleet:scan', { serial, profileIds }),
  insightsFetch: (serial, profileIds) => ipcRenderer.invoke('insights:fetch', { serial, profileIds }),
  sidebarOpenFolder: (serial, userId, platform, account) => ipcRenderer.invoke('sidebar:open-folder', { serial, userId, platform, account }),
  getScreenState: (serial) => ipcRenderer.invoke('get-screen-state', serial),
  clearInstagramData: (serial) => ipcRenderer.invoke('clear-instagram-data', serial),
  forceStopInstagram: (serial) => ipcRenderer.invoke('force-stop-instagram', serial),

  // ==================== SCRCPY PHONE MIRROR ====================
  launchScrcpy: (serial, managed) => ipcRenderer.invoke('launch-scrcpy', serial, managed),
  launchAllScrcpy: () => ipcRenderer.invoke('launch-scrcpy-all'),
  stopScrcpy: (serial) => ipcRenderer.invoke('stop-scrcpy', serial),
  stopAllScrcpy: () => ipcRenderer.invoke('stop-scrcpy-all'),
  checkScrcpy: () => ipcRenderer.invoke('check-scrcpy'),
  installScrcpy: () => ipcRenderer.invoke('install-scrcpy'),
  // Mac diagnostics — call from devtools when a user reports scrcpy issues.
  diagnoseScrcpyMac: (serial) => ipcRenderer.invoke('mac:diagnose-scrcpy', serial),

  // Platform info
  platform: process.platform,
  isElectron: true,

  // ==================== USER SESSION MANAGEMENT ====================
  // Set user session when Clerk auth completes (includes JWT for server verification)
  setUserSession: (userId, email, sessionToken) => ipcRenderer.invoke('set-user-session', { userId, email, sessionToken }),
  // Get current user session
  getUserSession: () => ipcRenderer.invoke('get-user-session'),
  // Clear session on logout
  clearUserSession: () => ipcRenderer.invoke('clear-user-session'),
  // Listen for admin status updates (sent after session set)
  onAdminStatus: (callback) => {
    ipcRenderer.on('admin-status', (event, data) => callback(data))
  },

  // ==================== VIDEO TOOLKIT / CONTENT TOOLS ====================
  // Run video scraper (yt-dlp + FFmpeg processing)
  runVideoScraper: (config) => ipcRenderer.invoke('run-video-scraper', config),
  // Open folder in file explorer
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  // Get app path for default output folder
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  // Extract cookies from user's browser for authenticated downloads
  extractBrowserCookies: (browser) => ipcRenderer.invoke('extract-browser-cookies', browser),
  // Listen for video scraper progress updates
  onVideoScraperProgress: (callback) => {
    ipcRenderer.on('video-scraper-progress', (event, data) => callback(data))
  },

  // ==================== LOCAL CONTENT SCRAPER ====================
  // Check if dependencies (yt-dlp, ffmpeg, exiftool) are installed
  checkDependencies: () => ipcRenderer.invoke('check-dependencies'),
  // Install missing dependencies
  installDependencies: () => ipcRenderer.invoke('install-dependencies'),
  // Get paths to installed binaries
  getDependencyPaths: () => ipcRenderer.invoke('get-dependency-paths'),
  // Listen for dependency install progress
  onDependencyProgress: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('dependency-progress', listener)
    return () => ipcRenderer.removeListener('dependency-progress', listener)
  },

  // Local content download (uses user's IP, no cloud blocking)
  localDownload: (options) => ipcRenderer.invoke('local-download', options),
  // Listen for download progress
  onDownloadProgress: (callback) => {
    ipcRenderer.on('download-progress', (event, data) => callback(data))
  },
  // Listen for download logs
  onDownloadLog: (callback) => {
    ipcRenderer.on('download-log', (event, data) => callback(data))
  },

  // Fingerprint videos (local ffmpeg processing)
  fingerprintVideos: (options) => ipcRenderer.invoke('fingerprint-videos', options),
  fingerprintVideo: (options) => ipcRenderer.invoke('fingerprint-video', options),
  checkOriginality: (options) => ipcRenderer.invoke('check-originality', options),
  compareOriginality: (options) => ipcRenderer.invoke('compare-originality', options),
  // Listen for fingerprint progress
  onFingerprintProgress: (callback) => {
    ipcRenderer.on('fingerprint-progress', (event, data) => callback(data))
  },
  // Listen for fingerprint logs
  onFingerprintLog: (callback) => {
    ipcRenderer.on('fingerprint-log', (event, data) => callback(data))
  },

  // ==================== LOCAL TEMPLATER (Template / Overlay / Spoof on-device) ====================
  // Run Template+Overlay+Spoof locally via bundled ffmpeg (no upload, no server).
  templateRunLocal: (options) => ipcRenderer.invoke('template-run-local', options),
  // Write a base64-encoded overlay clip Blob to a temp file; returns { success, path }.
  writeTempFile: (options) => ipcRenderer.invoke('write-temp-file', options),
  // Delete temp overlay clips after the local template run completes.
  cleanupTempFiles: (options) => ipcRenderer.invoke('cleanup-temp-files', options),
  // Listen for local template progress (0-100) — registered once, no removeListener.
  onTemplateProgress: (callback) => {
    ipcRenderer.on('template-progress', (event, data) => callback(data))
  },
  // Listen for per-step log lines from the local templater.
  onTemplateLog: (callback) => {
    ipcRenderer.on('template-log', (event, data) => callback(data))
  },

  // Folder management
  browseFolder: (options) => ipcRenderer.invoke('browse-folder', options),
  createFolder: (options) => ipcRenderer.invoke('create-folder', options),
  listFolder: (folderPath) => ipcRenderer.invoke('list-folder', folderPath),
  getDefaultFolders: () => ipcRenderer.invoke('get-default-folders'),
  // Create ShadowPhone content folders for an account (images, reels, used_images, used_reels)
  createContentFolders: (platform, accountName, customPath) => ipcRenderer.invoke('create-content-folders', { platform, accountName, customPath }),

  // Handle quota exceeded
  onQuotaExceeded: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('quota-exceeded', listener)
    return () => ipcRenderer.removeListener('quota-exceeded', listener)
  },
  // Handle subscription expired (trial or paid)
  onSubscriptionExpired: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('subscription-expired', listener)
    return () => ipcRenderer.removeListener('subscription-expired', listener)
  },

  // ==================== AI BATCH GENERATOR ====================
  // Select folder (returns path string or null)
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  // ReelsMax local project inspection / execution
  reelsMaxInspect: (projectDir) => ipcRenderer.invoke('reelsmax:inspect', projectDir),
  reelsMaxClearOutput: (projectDir) => ipcRenderer.invoke('reelsmax:clearOutput', projectDir),
  reelsMaxRun: (options) => ipcRenderer.invoke('reelsmax:run', options),
  reelsMaxOpenFolder: (folderPath) => ipcRenderer.invoke('reelsmax:openFolder', folderPath),
  onReelsMaxProgress: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('reelsmax-progress', listener)
    return () => ipcRenderer.removeListener('reelsmax-progress', listener)
  },
  onReelsMaxLog: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('reelsmax-log', listener)
    return () => ipcRenderer.removeListener('reelsmax-log', listener)
  },
  tiktokTrendsRun: (config) => ipcRenderer.invoke('tiktok-trends:run', config),
  tiktokTrendsListSnapshots: () => ipcRenderer.invoke('tiktok-trends:listSnapshots'),
  tiktokTrendsReadLatestSnapshot: () => ipcRenderer.invoke('tiktok-trends:readLatestSnapshot'),
  tiktokTrendsClearSnapshots: () => ipcRenderer.invoke('tiktok-trends:clearSnapshots'),
  tiktokTrendsOpenSnapshots: () => ipcRenderer.invoke('tiktok-trends:openSnapshots'),
  instagramTrendsRun: (config) => ipcRenderer.invoke('instagram-trends:run', config),
  instagramTrendsListSnapshots: () => ipcRenderer.invoke('instagram-trends:listSnapshots'),
  instagramTrendsReadLatestSnapshot: () => ipcRenderer.invoke('instagram-trends:readLatestSnapshot'),
  instagramTrendsClearSnapshots: () => ipcRenderer.invoke('instagram-trends:clearSnapshots'),
  instagramTrendsOpenSnapshots: () => ipcRenderer.invoke('instagram-trends:openSnapshots'),
  onTikTokTrendsProgress: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('tiktok-trends-progress', listener)
    return () => ipcRenderer.removeListener('tiktok-trends-progress', listener)
  },
  onTikTokTrendsLog: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('tiktok-trends-log', listener)
    return () => ipcRenderer.removeListener('tiktok-trends-log', listener)
  },
  onInstagramTrendsProgress: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('instagram-trends-progress', listener)
    return () => ipcRenderer.removeListener('instagram-trends-progress', listener)
  },
  onInstagramTrendsLog: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('instagram-trends-log', listener)
    return () => ipcRenderer.removeListener('instagram-trends-log', listener)
  },
  // List files with extension filter
  listFiles: (folder, extensions) => ipcRenderer.invoke('list-files', folder, extensions),
  // Read file as base64 for upload
  readFileAsBase64: (filePath) => ipcRenderer.invoke('read-file-as-buffer', filePath),
  // Move file to new location  
  moveFile: (from, to) => ipcRenderer.invoke('move-file', from, to),
  // Copy file to new location (preserves original)
  copyFile: (from, to) => ipcRenderer.invoke('copy-file', from, to),
  // Download file from URL
  // Download file from URL
  downloadFileUrl: (url, destPath) => ipcRenderer.invoke('download-file-url', url, destPath),

  // ==================== NATIVE OS NOTIFICATIONS ====================
  // Show native desktop notification (works when app is minimized)
  showNativeNotification: (options) => ipcRenderer.invoke('show-native-notification', options),
  // Listen for native notification clicks
  onNativeNotificationClick: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('native-notification-click', listener)
    return () => ipcRenderer.removeListener('native-notification-click', listener)
  },

  // ==================== DIAGNOSTIC LOGS ====================
  // Open the Brain logs folder (<userData>/logs/) in the OS file
  // manager so users can grab the .log files when reporting a bug.
  logsOpenFolder: () => ipcRenderer.invoke('logs:openFolder'),
  // Read the last N lines of a named log file. Whitelisted server-side.
  logsTail: (name, maxLines = 200) => ipcRenderer.invoke('logs:tail', name, maxLines),

  // ==================== LOCAL CONTENT FOLDER SYSTEM ====================
  // Get content root folder path
  contentGetRoot: () => ipcRenderer.invoke('content:getRoot'),
  // Create account content folders (images, reels, used_images, used_reels)
  contentCreateAccountFolders: (platform, accountUsername) =>
    ipcRenderer.invoke('content:createAccountFolders', platform, accountUsername),
  // List files in account's content folder
  contentListLocal: (platform, accountUsername, subfolder) =>
    ipcRenderer.invoke('content:listLocal', platform, accountUsername, subfolder),
  // Get file counts for all subfolders
  contentGetCounts: (platform, accountUsername) =>
    ipcRenderer.invoke('content:getCounts', platform, accountUsername),
  // Move file to used folder after posting
  contentMoveToUsed: (filePath) => ipcRenderer.invoke('content:moveToUsed', filePath),
  // Open content folder in file explorer
  contentOpenFolder: (platform, accountUsername, subfolder) =>
    ipcRenderer.invoke('content:openFolder', platform, accountUsername, subfolder),
  // Delete account content folders (when account removed)
  contentDeleteAccountFolders: (platform, accountUsername) =>
    ipcRenderer.invoke('content:deleteAccountFolders', platform, accountUsername),
  // Validate all account folders - check/create missing folders
  contentValidateAccountFolders: (platform, accounts) =>
    ipcRenderer.invoke('content:validateAccountFolders', platform, accounts),
  // Get default templates (comments, captions, story_captions)
  contentGetDefaults: () => ipcRenderer.invoke('content:getDefaults'),
  // Save default templates  
  contentSaveDefaults: (defaults) => ipcRenderer.invoke('content:saveDefaults', defaults),
  // Apply defaults to all existing accounts. Preserves per-account customizations
  // unless { force: true } is passed (default false = safe seed-only behavior).
  contentApplyDefaultsToAll: (options) => ipcRenderer.invoke('content:applyDefaultsToAll', options),
  // Read a caption/comment pool — per-account file first, falls back to defaults
  // kind: 'captions' | 'story_captions' | 'comments'
  contentGetCaptionPool: (platform, accountUsername, kind) =>
    ipcRenderer.invoke('content:getCaptionPool', platform, accountUsername, kind),

  // ==================== GOOGLE DRIVE DOWNLOAD ====================
  // List files in a Google Drive folder
  driveListFiles: (driveUrl) => ipcRenderer.invoke('drive:listFiles', driveUrl),
  // Download all images/videos from Drive folder to account's local content folder
  driveDownloadToContent: (config) => ipcRenderer.invoke('drive:downloadToContent', config),
  // Download PFP + Banner for a specific account (bulk import wizard uses this
  // to pre-populate per-account profile assets before the account_creation cycle).
  accountDownloadAssets: (config) => ipcRenderer.invoke('account-download-assets', config),
  // Listen for drive download progress
  onDriveDownloadProgress: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('drive:downloadProgress', listener)
    return () => ipcRenderer.removeListener('drive:downloadProgress', listener)
  },

  // ==================== REDDIT CAPTIONS (CLIENT-SIDE FETCH) ====================
  // Fetch Reddit post titles directly from user's machine (bypasses cloud IP blocks)
  fetchRedditCaptions: (subreddit, limit) => ipcRenderer.invoke('fetch-reddit-captions', subreddit, limit),

  // ==================== 2.16.0: NATIVE SCRCPY LAUNCHER ====================
  scrcpyLaunch: (payload) => ipcRenderer.invoke('scrcpy:launch', payload),
  scrcpyLaunchTiledAll: () => ipcRenderer.invoke('scrcpy:launch-tiled-all'),
  tailscaleStatus: () => ipcRenderer.invoke('tailscale:status'),

  // ==================== FLEET / PROVISION (web-window bridge) ====================
  // Provisioning wizard — each step maps directly to a provision:* IPC handler.
  provisionDetectUsb:       ()             => ipcRenderer.invoke('provision:detect-usb'),
  provisionInstallTailscale:(udid)         => ipcRenderer.invoke('provision:install-tailscale', { udid }),
  provisionOpenTailscale:   (udid)         => ipcRenderer.invoke('provision:open-tailscale',    { udid }),
  provisionWaitTailnet:     (udid)         => ipcRenderer.invoke('provision:wait-tailnet',       { udid }),
  provisionEnableWifiAdb:   (udid, ip)     => ipcRenderer.invoke('provision:enable-wifi-adb',    { udid, ip }),
  provisionExemptBattery:   (udid)         => ipcRenderer.invoke('provision:exempt-battery',     { udid }),
  provisionInstallCompanion:(udid)         => ipcRenderer.invoke('provision:install-companion',  { udid }),

  // ── Wireless pairing wizard (Feature 1) ── adb pair+connect over the tailnet.
  provisionPairCode:    (host, port, code) => ipcRenderer.invoke('pair:code',    { host, port, code }),
  provisionPairConnect: (opts)             => ipcRenderer.invoke('pair:connect', opts),
  provisionQrStart:     ()                 => ipcRenderer.invoke('pair:qr-start'),
  provisionQrCancel:    ()                 => ipcRenderer.invoke('pair:qr-cancel'),
  onPairProgress: (callback) => {
    const listener = (event, payload) => callback(payload)
    ipcRenderer.on('pair-progress', listener)
    return () => ipcRenderer.removeListener('pair-progress', listener)
  },

  // Fleet — phone list, launch, schedule, diagnostics, logs.
  // fleet:launch-one expects the whole phone object (udid, tailnetIp, port, etc.)
  fleetGetPhones:     ()       => ipcRenderer.invoke('fleet:get-phones'),
  fleetLaunchOne:     (phone)  => ipcRenderer.invoke('fleet:launch-one', phone),
  fleetLaunchSchedule:()       => ipcRenderer.invoke('fleet:launch-schedule'),
  // diagnostics:collect accepts an optional opts object (e.g. { raw: true })
  diagnosticsCollect: (opts)   => ipcRenderer.invoke('diagnostics:collect', opts),
  // logs:read-full expects a log name string; 'launcher.log' is the primary use-case.
  logsReadFull:       (name)   => ipcRenderer.invoke('logs:read-full', name),

  // Auth events — emitted by scrcpy-tray.launchOne during the 60s "tap Allow"
  // recovery window. The web window receives these so a web-driven Launch can
  // show the same overlay the fleet panel shows. Must return an unsubscribe fn.
  onPhoneAuthWait: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('phone-auth-wait', h)
    return () => ipcRenderer.removeListener('phone-auth-wait', h)
  },
  onPhoneAuthDone: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('phone-auth-done', h)
    return () => ipcRenderer.removeListener('phone-auth-done', h)
  },

  // ==================== SCHEDULE (web Schedule tab — health band + bulk retime) ====================
  // scheduleListAll mirrors the fleet window's bridge: returns { ok, rows: [...] }
  // from schedule:list-all (electron/handlers/schedule-handlers.js).
  scheduleListAll: () => ipcRenderer.invoke('schedule:list-all'),
  // build-exceptions / propose-retimes are PURE (no phone driving). The renderer
  // passes the loaded roster + slots; handlers live in schedule-exceptions-handler.js.
  buildScheduleExceptions: (phones, slotsByHandle, opts) =>
    ipcRenderer.invoke('schedule:build-exceptions', phones, slotsByHandle, opts),
  proposeScheduleRetimes: (args) =>
    ipcRenderer.invoke('schedule:propose-retimes', args),
  // fleet:scan-progress is broadcast during a device scan (model-handlers.js).
  onScanProgress: (cb) => {
    const l = (_e, data) => cb(data)
    ipcRenderer.on('fleet:scan-progress', l)
    return () => ipcRenderer.removeListener('fleet:scan-progress', l)
  },

  // ==================== INSIGHTS (Command Center: StatsDrawer + Fleet Analytics) ====================
  // Read-only getters straight to the on-device time-series store
  // (electron/lib/insights-store.js). LOCAL desktop data only — NOT Supabase.
  // Handlers in electron/handlers/insights-handlers.js destructure { account, sinceTs }
  // from a single payload object, so wrap the args accordingly.
  getInsights: (account, sinceTs) => ipcRenderer.invoke('insights:get', { account, sinceTs }),
  getInsightsLatest: (account) => ipcRenderer.invoke('insights:get-latest', { account }),
  // Fleet-wide series — no arg. ONE method shared by Fleet Analytics + FleetPulse.
  getInsightsAllSeries: () => ipcRenderer.invoke('insights:get-all-series'),

  // ==================== SCHEDULE FIRE-NOW (ScheduleOverlay inline editor) ====================
  // Manual dispatch of a single slot. Handler (schedule-handlers.js:307) destructures
  // { accountKey, serial, userId, platform, slotIndex, key } from one payload object.
  // Fire-and-forget on the renderer side; refresh parent state via onRunsUpdate.
  scheduleFireNow: (args) => ipcRenderer.invoke('schedule:fire-now', args),

  // ==================== SCHEDULE CRUD + POST NOW (web Schedule tab — final sweep) ====================
  // Per-account schedule read/write + manual dispatch for the Schedule-tab account
  // rows (Post Now, context menu "Edit slots", enable/disable). All handlers live in
  // electron/handlers/schedule-handlers.js and destructure a single payload object.
  // scheduleGet → _getSchedule (schedule-handlers.js:148)
  scheduleGet: (args) => ipcRenderer.invoke('schedule:get', args),
  // scheduleSave → _saveSchedule (schedule-handlers.js:240); patch = partial schedule row
  scheduleSave: (args) => ipcRenderer.invoke('schedule:save', args),
  // scheduleToggleActive → _toggleActive (schedule-handlers.js:291)
  scheduleToggleActive: (args) => ipcRenderer.invoke('schedule:toggle-active', args),
  // scheduleRunNow → _runNow (schedule-handlers.js:295); full workflow-level manual run for a slot
  scheduleRunNow: (args) => ipcRenderer.invoke('schedule:run-now', args),
  // scheduleListAccounts → _listAccounts (schedule-handlers.js:331); no args
  scheduleListAccounts: () => ipcRenderer.invoke('schedule:list-accounts'),
  // dashboardPostNow → dashboard:post-now (main.js:4158); low-level single-account post.
  // Honors the per-phone busy lock; picks the post module from slot.content_type.
  dashboardPostNow: (args) => ipcRenderer.invoke('dashboard:post-now', args),
  // fleetValidateFolders → fleet:validate-folders (model-handlers.js:356).
  // Pass a device serial to scope the check/create, or omit for the fleet-wide sweep.
  fleetValidateFolders: (serial) => ipcRenderer.invoke('fleet:validate-folders', serial),

  // ==================== BULK CREATE IG ACCOUNTS (web Accounts tab) ====================
  // Channels live in electron/handlers/bulk-creation-handlers.js. SPENDING RISK:
  // bulkCreateStart runs the real account_creation_phone module (~$0.42/acct).
  bulkCreatePreview: (serial) => ipcRenderer.invoke('bulk:preview', { serial }),
  bulkCreateStart: (serial, config, resume) =>
    ipcRenderer.invoke('bulk:start', { serial, config, resume }),
  bulkCreateStatus: (serial) => ipcRenderer.invoke('bulk:status', { serial }),
  bulkCreateStop: (serial) => ipcRenderer.invoke('bulk:stop', { serial }),
  onBulkCreateProgress: (cb) => {
    const l = (_e, data) => cb(data)
    ipcRenderer.on('bulk:progress', l)
    return () => ipcRenderer.removeListener('bulk:progress', l)
  },

  // ==================== CLOUD SYNC + MAC SCRCPY INSTALL (P1 consolidation) ====================
  cloudSyncPreview: () => ipcRenderer.invoke('sidebar:bulk-sync-preview'),
  cloudSyncRun:     () => ipcRenderer.invoke('sidebar:bulk-sync-from-cloud'),
  macInstallScrcpy: () => ipcRenderer.invoke('mac:install-scrcpy'),
  onMacInstallProgress: (cb) => {
    const l = (_e, data) => cb(data)
    ipcRenderer.on('mac-install-progress', l)
    return () => ipcRenderer.removeListener('mac-install-progress', l)
  },
})

// Notify renderer that we're in Electron
window.addEventListener('DOMContentLoaded', () => {
  window.isElectron = true
})
