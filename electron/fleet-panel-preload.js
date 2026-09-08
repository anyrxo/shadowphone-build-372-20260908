'use strict';
const { ipcRenderer } = require('electron')

console.log('[fleet-panel-preload] loaded — injecting window.fleet')

window.fleet = {
  getPhones: () => ipcRenderer.invoke('fleet:get-phones'),
  tailscaleStatus: () => ipcRenderer.invoke('tailscale:status'),
  // 2.16.10: Launch goes through fleet:launch-one (which routes via
  // scrcpy-tray.launchOne — does adb-connect for tailnet phones FIRST,
  // then calls launchScrcpyForSerial with the proper target). The old
  // direct launch-scrcpy IPC was failing silently because it received
  // the phone hostname ("Pixel 6") which adb couldn't resolve as a serial.
  launchScrcpy: (phone) => ipcRenderer.invoke('fleet:launch-one', phone),
  // Per-device models dashboard (sp-core models-dashboard.html, scoped by serial)
  launchDashboard: (phone) => ipcRenderer.invoke('fleet:launch-dashboard', phone),
  // Universal Command Center — fleet-wide schedule/accounts/folders, no device scope
  launchSchedule: () => ipcRenderer.invoke('fleet:launch-schedule'),
  tileAll: () => ipcRenderer.invoke('scrcpy:launch-tiled-all'),

  // 2.16.11: self-diagnostic — Fleet panel "Run Diagnostics" button
  diagnostics: () => ipcRenderer.invoke('diagnostics:collect'),
  copyToClipboard: (text) => navigator.clipboard.writeText(text),

  // 2.16.61: bulk pull-from-cloud (also available via tray)
  cloudSyncPreview: () => ipcRenderer.invoke('sidebar:bulk-sync-preview'),
  cloudSyncRun:     () => ipcRenderer.invoke('sidebar:bulk-sync-from-cloud'),

  // 2.17.0: open the launcher logs folder from Troubleshoot modal
  openLogsFolder:   () => ipcRenderer.invoke('logs:open-folder'),
  // 2.18.11: read full launcher.log for fleet-panel Copy Logs button
  readFullLog:      () => ipcRenderer.invoke('logs:read-full', 'launcher.log'),

  // 2.17.8: Mac scrcpy auto-install (brew install scrcpy)
  macInstallScrcpy: () => ipcRenderer.invoke('mac:install-scrcpy'),
  onMacInstallProgress: (cb) => {
    const listener = (_e, line) => cb(line)
    ipcRenderer.on('mac-install-progress', listener)
    return () => ipcRenderer.removeListener('mac-install-progress', listener)
  },

  // 2.17.14: in-app auto-fix for adb-unauthorized — the launchOne backend
  // fires 'phone-auth-wait' when it's polling for the user to tap "Allow
  // USB debugging" on the phone, and 'phone-auth-done' when it succeeds or
  // times out. Renderer shows a modal so the user knows exactly what to do.
  onPhoneAuthWait: (cb) => {
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on('phone-auth-wait', listener)
    return () => ipcRenderer.removeListener('phone-auth-wait', listener)
  },
  onPhoneAuthDone: (cb) => {
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on('phone-auth-done', listener)
    return () => ipcRenderer.removeListener('phone-auth-done', listener)
  },

  // 2.18.13: app-wide settings persisted to userData/app-settings.json.
  // Currently used for smspool_api_key — the Fleet Settings modal calls
  // these, and the toolbar Create IG modal reads the key for phone signup.
  getAppSetting: (key) => ipcRenderer.invoke('app:get-setting', key),
  setAppSetting: (key, value) => ipcRenderer.invoke('app:set-setting', key, value),
  // USB-to-VPS bridge: live relay endpoints (serial -> pc-tailnet-ip:port) the
  // VPS can `adb connect` to drive USB phones without Tailscale on the phone.
  getUsbVpsStatus: () => ipcRenderer.invoke('usb-vps:status'),

  // 2.16.2: provisioning wizard
  provision: {
    detectUsb:        ()         => ipcRenderer.invoke('provision:detect-usb'),
    installTailscale: (udid)     => ipcRenderer.invoke('provision:install-tailscale', { udid }),
    openTailscale:    (udid)     => ipcRenderer.invoke('provision:open-tailscale',    { udid }),
    waitTailnet:      (udid)     => ipcRenderer.invoke('provision:wait-tailnet',      { udid }),
    enableWifiAdb:    (udid, ip) => ipcRenderer.invoke('provision:enable-wifi-adb',   { udid, ip }),
    exemptBattery:    (udid)     => ipcRenderer.invoke('provision:exempt-battery',    { udid }),
    installCompanion: (udid)     => ipcRenderer.invoke('provision:install-companion', { udid }),
  },

  // Feature 3: YAML per-device plugin registry (device -> plugin -> command -> Run)
  plugins: {
    list:       ()                => ipcRenderer.invoke('plugins:list'),
    run:        (pluginId, phone) => ipcRenderer.invoke('plugins:run', { pluginId, phone }),
    editConfig: ()                => ipcRenderer.invoke('plugins:edit-config'),
  },
}
