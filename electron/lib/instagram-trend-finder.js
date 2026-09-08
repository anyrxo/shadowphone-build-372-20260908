const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function formatDateForFile(date = new Date()) {
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    '_',
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ]
  return parts.join('')
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

class InstagramTrendFinder {
  constructor({ dependencyManager, app }) {
    this.dependencyManager = dependencyManager
    this.app = app
  }

  getRootDir() {
    return path.join(this.app.getPath('userData'), 'trend-finder', 'instagram')
  }

  getSnapshotsDir() {
    return path.join(this.getRootDir(), 'snapshots')
  }

  getPythonCommand() {
    return process.platform === 'win32' ? 'python' : 'python3'
  }

  getRunnerPath() {
    return path.join(__dirname, '..', 'python', 'instagram_trend_finder.py')
  }

  getYtDlpPath() {
    if (this.dependencyManager?.getBinaryPath) {
      return this.dependencyManager.getBinaryPath('yt-dlp')
    }
    return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  }

  emitProgress(callback, data) {
    if (typeof callback === 'function') callback(data)
  }

  emitLog(callback, message, level = 'info') {
    if (typeof callback === 'function') callback({ level, message })
  }

  async listSnapshots() {
    const snapshotsDir = this.getSnapshotsDir()
    ensureDir(snapshotsDir)

    return fs.readdirSync(snapshotsDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => {
        const fullPath = path.join(snapshotsDir, entry.name)
        const stats = fs.statSync(fullPath)
        return {
          name: entry.name,
          path: fullPath,
          size: stats.size,
          updatedAt: stats.mtimeMs,
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async clearSnapshots() {
    const snapshots = await this.listSnapshots()
    let deleted = 0
    for (const snapshot of snapshots) {
      try {
        fs.unlinkSync(snapshot.path)
        deleted += 1
      } catch {
        // Ignore individual delete failures.
      }
    }
    return { deleted }
  }

  async readLatestSnapshot() {
    const snapshots = await this.listSnapshots()
    if (!snapshots.length) return null

    const latest = snapshots[0]
    const raw = fs.readFileSync(latest.path, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      ...parsed,
      snapshotPath: latest.path,
    }
  }

  extractCookiesFromBrowser(preferredBrowser = 'auto') {
    const ytdlpPath = this.getYtDlpPath()
    const tempDir = this.app.getPath('temp')
    const browsers = preferredBrowser === 'auto'
      ? ['firefox', 'edge', 'brave', 'chrome']
      : [preferredBrowser]

    for (const browser of browsers) {
      const tempCookieFile = path.join(tempDir, `instagram_cookies_${browser}_${Date.now()}.txt`)
      try {
        const result = spawnSync(
          ytdlpPath,
          ['--cookies-from-browser', browser, '--cookies', tempCookieFile, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', '--skip-download'],
          {
            windowsHide: true,
            encoding: 'utf8',
            timeout: 30000,
          },
        )

        const size = fs.existsSync(tempCookieFile) ? fs.statSync(tempCookieFile).size : 0
        if (result.status === 0 && size > 100) {
          return { browser, filePath: tempCookieFile }
        }
      } catch {
        // Try the next browser.
      }

      try {
        if (fs.existsSync(tempCookieFile)) fs.unlinkSync(tempCookieFile)
      } catch {
        // Ignore cleanup failures.
      }
    }

    return null
  }

  async run(config = {}, handlers = {}) {
    const { onProgress, onLog } = handlers
    const snapshotsDir = this.getSnapshotsDir()
    ensureDir(snapshotsDir)

    const normalizedConfig = {
      manualSeeds: Array.isArray(config.manualSeeds) ? config.manualSeeds : [],
      postsPerCreator: clampInt(config.postsPerCreator, 3, 15, 8),
      maxCreators: clampInt(config.maxCreators, 1, 250, 120),
      minViews: clampInt(config.minViews, 0, 10000000, 2000),
      lookbackDays: clampInt(config.lookbackDays, 3, 30, 14),
      browser: String(config.browser || 'auto'),
    }

    const configPath = path.join(os.tmpdir(), `instagram_trends_${Date.now()}.json`)
    fs.writeFileSync(configPath, JSON.stringify(normalizedConfig, null, 2), 'utf8')

    const cookies = this.extractCookiesFromBrowser(normalizedConfig.browser)
    if (cookies) {
      this.emitLog(onLog, `Using Instagram cookies from ${cookies.browser}.`)
    } else {
      this.emitLog(onLog, 'No Instagram browser cookies could be extracted. The scan will try anonymous access and may fail.', 'warn')
    }

    const pythonArgs = [
      this.getRunnerPath(),
      'run',
      '--config',
      configPath,
      '--output-dir',
      snapshotsDir,
    ]

    if (cookies?.filePath) {
      pythonArgs.push('--cookies-file', cookies.filePath)
    }

    return new Promise((resolve, reject) => {
      const child = spawn(this.getPythonCommand(), pythonArgs, {
        windowsHide: true,
        env: { ...process.env },
      })

      let stdoutBuffer = ''
      let stderrBuffer = ''
      let resultPayload = null

      const flushLine = (line) => {
        const trimmed = line.trim()
        if (!trimmed) return

        try {
          const payload = JSON.parse(trimmed)
          if (payload.kind === 'log') {
            this.emitLog(onLog, payload.message || 'Instagram trend runner log.')
            return
          }
          if (payload.kind === 'progress') {
            this.emitProgress(onProgress, payload)
            return
          }
          if (payload.kind === 'result') {
            resultPayload = payload
            return
          }
        } catch {
          this.emitLog(onLog, trimmed, 'info')
        }
      }

      child.stdout.on('data', (data) => {
        stdoutBuffer += data.toString()
        const lines = stdoutBuffer.split(/\r?\n/)
        stdoutBuffer = lines.pop() || ''
        for (const line of lines) flushLine(line)
      })

      child.stderr.on('data', (data) => {
        const text = data.toString().trim()
        if (text) {
          stderrBuffer += `${text}\n`
          this.emitLog(onLog, text, 'error')
        }
      })

      child.on('error', (error) => {
        reject(error)
      })

      child.on('close', (code) => {
        try {
          if (stdoutBuffer.trim()) flushLine(stdoutBuffer)
          if (code !== 0) {
            reject(new Error(stderrBuffer.trim() || 'Instagram trend run failed.'))
            return
          }

          const snapshotPath = resultPayload?.snapshotPath
          if (!snapshotPath || !fs.existsSync(snapshotPath)) {
            reject(new Error('Instagram trend run finished without a snapshot file.'))
            return
          }

          const parsed = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
          resolve({
            ...parsed,
            snapshotPath,
            cookieBrowser: cookies?.browser || null,
          })
        } catch (error) {
          reject(error)
        } finally {
          try {
            fs.unlinkSync(configPath)
          } catch {
            // Ignore cleanup failures.
          }
          try {
            if (cookies?.filePath && fs.existsSync(cookies.filePath)) fs.unlinkSync(cookies.filePath)
          } catch {
            // Ignore cleanup failures.
          }
        }
      })
    })
  }
}

module.exports = { InstagramTrendFinder }
