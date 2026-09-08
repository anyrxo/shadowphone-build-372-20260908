# Cloudflared bundled binaries

The portal feature (web-mirror) spawns `cloudflared tunnel --url
http://localhost:<port>` per device to expose ws-scrcpy through a
`https://NAME.trycloudflare.com` quick-tunnel. Binaries are Apache-2.0,
safe to bundle. Latest releases:
https://github.com/cloudflare/cloudflared/releases

## Layout

```
electron/vendor/cloudflared/
  win32-x64/cloudflared.exe       <-- COMMITTED LOCALLY (Win machine)
  darwin-arm64/cloudflared        <-- TO FILL IN VIA MAC CI
  darwin-x64/cloudflared          <-- TO FILL IN VIA MAC CI
  linux-x64/cloudflared           <-- optional, not shipped today
```

`electron/lib/cloudflared-tunnel.js` resolves the binary in this order:

1. `process.resourcesPath/cloudflared/<platform>-<arch>/cloudflared(.exe)`
   — packaged app (via `extraResources` in `electron/package.json`).
2. `electron/vendor/cloudflared/<platform>-<arch>/cloudflared(.exe)`
   — dev / unpacked run.
3. `cloudflared` on PATH — last resort.

## Verifying the bundled binary

```powershell
.\vendor\cloudflared\win32-x64\cloudflared.exe --version
```

Should print `cloudflared version 2024.x.x` (or newer).

## License

`cloudflared` is Apache-2.0. Drop `LICENSE` alongside each binary if
your platform's signing toolchain requires it.
