/**
 * Content Tools IPC Handlers
 * Handles video scraping, fingerprinting, and file management
 */

const { ipcMain, shell, dialog } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

let mainWindow = null
let app = null
let dependencyManager = null
let localDownloader = null
let localFingerprinter = null
let localTemplater = null
let registeredContentActions = null

/**
 * Initialize content handlers with dependencies
 */
function initContentHandlers(options) {
    mainWindow = options.mainWindow
    app = options.app
    dependencyManager = options.dependencyManager
    localDownloader = options.localDownloader
    localFingerprinter = options.localFingerprinter

    // Lazy-load LocalTemplater on first use (avoids circular dep at module load time)
    registerContentHandlers()
}

/**
 * Get path to yt-dlp
 */
function getYtdlpPath() {
    const platform = process.platform
    const binary = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
    const bundledPath = path.join(__dirname, '..', 'tools', binary)
    return fs.existsSync(bundledPath) ? bundledPath : binary
}

/**
 * Get path to FFmpeg
 */
function getFFmpegPath() {
    const platform = process.platform
    const binary = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    const bundledPath = path.join(__dirname, '..', 'tools', binary)
    return fs.existsSync(bundledPath) ? bundledPath : binary
}

/**
 * Register all content-related IPC handlers
 */
function registerContentHandlers() {
    // ─── Filesystem containment helpers (security) ──────────────────────
    // All renderer-supplied paths used for read/write/move/open/download are
    // confined to these roots so a compromised/remote-influenced renderer
    // can't reach arbitrary host files. Mirrors the copy-file guard in
    // main.js (CONTENT_ROOT + path.resolve + startsWith(root + sep)).
    const CONTENT_ROOT = path.join(app.getPath('userData'), 'Content')
    const selectedFolderRoots = new WeakMap()

    // Roots the content UI is legitimately allowed to read/list/create under
    // (these are exactly the dirs handed to the renderer by get-default-folders).
    function allowedFsRoots() {
        const roots = [CONTENT_ROOT]
        for (const key of ['downloads', 'desktop', 'documents', 'userData', 'temp']) {
            try { roots.push(app.getPath(key)) } catch { /* not all platforms expose every key */ }
        }
        return roots.map(r => path.resolve(r))
    }

    // True if `p` resolves to (or under) one of the supplied roots.
    function isUnderRoots(p, roots) {
        const resolved = path.resolve(p)
        return roots.some(r => resolved === r || resolved.startsWith(r + path.sep))
    }

    function isAllowedContentPath(p, event) {
        if (isUnderRoots(p, allowedFsRoots())) return true
        const selectedRoots = selectedFolderRoots.get(event?.sender)
        if (!selectedRoots) return false
        let parent = path.resolve(p)
        const missingParts = []
        while (true) {
            try {
                const resolved = path.join(fs.realpathSync(parent), ...missingParts)
                return isUnderRoots(resolved, [...selectedRoots])
            } catch (error) {
                if (error.code !== 'ENOENT' || path.dirname(parent) === parent) return false
                missingParts.unshift(path.basename(parent))
                parent = path.dirname(parent)
            }
        }
    }

    // SSRF guard: reject loopback / private / link-local / metadata targets.
    function isPrivateHost(hostname) {
        const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
        if (!host) return true
        if (host === 'localhost' || host.endsWith('.local')) return true
        if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true
        return /^(127\.|10\.|192\.168\.|169\.254\.)/.test(host) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    }

    // Check and install dependencies
    ipcMain.handle('check-dependencies', async () => {
        try {
            const status = await dependencyManager.checkAll()
            return { success: true, status }
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    ipcMain.handle('install-dependencies', async (event) => {
        try {
            dependencyManager.onStatus(({ message, progress }) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('dependency-progress', { message, progress })
                }
            })

            const result = await dependencyManager.installMissing()
            return result
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    ipcMain.handle('get-dependency-paths', async () => {
        return {
            binDir: dependencyManager.binDir,
            ytdlp: dependencyManager.getBinaryPath('yt-dlp'),
            ffmpeg: dependencyManager.getBinaryPath('ffmpeg'),
            exiftool: dependencyManager.getBinaryPath('exiftool')
        }
    })

    // Local content download
    ipcMain.handle('local-download', async (event, options) => {
        const { url, outputDir, maxVideos, quality, browser } = options

        // SSRF guard: only http(s) to non-private hosts.
        let parsedUrl
        try { parsedUrl = new URL(String(url)) } catch { return { success: false, error: 'invalid url' } }
        if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
            return { success: false, error: 'unsupported scheme' }
        }
        if (isPrivateHost(parsedUrl.hostname)) {
            return { success: false, error: 'refusing private/loopback host' }
        }

        // Arbitrary-write guard: confine the download root to managed roots.
        const writeRoots = [CONTENT_ROOT, path.resolve(app.getPath('downloads'))].map(r => path.resolve(r))
        const rawOut = String(outputDir || '')
        const resolvedOut = path.isAbsolute(rawOut) ? path.resolve(rawOut) : path.resolve(writeRoots[0], rawOut)
        if (!isUnderRoots(resolvedOut, writeRoots)) {
            return { success: false, error: `Refusing to download outside managed roots (resolved=${resolvedOut})` }
        }

        try {
            const result = await localDownloader.download({
                url,
                outputDir: resolvedOut,
                maxVideos: maxVideos || 10,
                quality: quality || 'best',
                browser: browser || 'chrome',
                onProgress: (progress) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('download-progress', { progress })
                    }
                },
                onLog: (log) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('download-log', { log })
                    }
                }
            })

            return result
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    // Fingerprint videos
    ipcMain.handle('fingerprint-videos', async (event, options) => {
        const { inputDir, outputDir, fingerprintOptions, copies } = options

        try {
            const roots = allowedFsRoots()
            if (!inputDir || !outputDir || !isUnderRoots(inputDir, roots) || !isUnderRoots(outputDir, roots)) {
                return { success: false, error: 'Path not allowed' }
            }
            const result = await localFingerprinter.fingerprintFolder(inputDir, outputDir, {
                ...fingerprintOptions,
                copies: Math.max(1, Math.min(100, parseInt(copies, 10) || 1)),
                onProgress: (progress) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('fingerprint-progress', { progress })
                    }
                },
                onLog: (log) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('fingerprint-log', { log })
                    }
                }
            })

            return result
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    ipcMain.handle('fingerprint-video', async (event, options) => {
        const { inputPath, outputPath, fingerprintOptions } = options

        try {
            const roots = allowedFsRoots()
            if (!inputPath || !outputPath || !isUnderRoots(inputPath, roots) || !isUnderRoots(outputPath, roots)) {
                return { success: false, error: 'Path not allowed' }
            }
            const result = await localFingerprinter.fingerprint(inputPath, outputPath, fingerprintOptions)
            return result
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    // Local templater — Template/Overlay/Spoof on-device (no upload)
    ipcMain.handle('template-run-local', async (event, options) => {
        const { inputDir, outputDir, config } = options || {}
        try {
            if (!inputDir || !outputDir || !isAllowedContentPath(inputDir, event) || !isAllowedContentPath(outputDir, event)) {
                return { success: false, error: 'Path not allowed' }
            }
            const overlayClipPaths = config?.overlay?.clipPaths
            if (overlayClipPaths !== undefined && (
                !Array.isArray(overlayClipPaths) ||
                overlayClipPaths.some(clipPath => !clipPath || !isAllowedContentPath(clipPath, event))
            )) {
                return { success: false, error: 'Path not allowed' }
            }
            if (!localTemplater) {
                const { LocalTemplater } = require('../lib/local-templater')
                localTemplater = new LocalTemplater()
            }
            const result = await localTemplater.processFolder(inputDir, outputDir, config || {}, {
                onProgress: (progress) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('template-progress', { progress })
                    }
                },
                onLog: (log) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('template-log', { log })
                    }
                }
            })
            return result
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    // Write a base64-encoded blob to a temp file — used by the renderer to land
    // overlay clip Blobs onto disk before passing clipPaths to template-run-local.
    ipcMain.handle('write-temp-file', async (event, options) => {
        const { base64, name } = options || {}
        try {
            if (!base64 || !name) return { success: false, error: 'base64 and name required' }
            // Sanitize: keep only the basename component to prevent path traversal.
            const safeName = path.basename(String(name)).replace(/[^a-zA-Z0-9._-]/g, '_') || 'clip'
            const tempDir = path.join(app.getPath('temp'), 'shadowphone-templater')
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true })
            const uniqueName = `${Date.now()}_${Math.random().toString(36).slice(2)}_${safeName}`
            const destPath = path.join(tempDir, uniqueName)
            const buf = Buffer.from(base64, 'base64')
            await fs.promises.writeFile(destPath, buf)
            return { success: true, path: destPath }
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    // Clean up temp overlay clips written by write-temp-file (best-effort).
    ipcMain.handle('cleanup-temp-files', async (event, options) => {
        const { paths } = options || {}
        if (!Array.isArray(paths)) return { success: true }
        const tempDir = path.resolve(path.join(app.getPath('temp'), 'shadowphone-templater'))
        for (const p of paths) {
            try {
                const resolved = path.resolve(String(p))
                // Only delete files that live inside our own temp dir.
                if (resolved.startsWith(tempDir + path.sep) || resolved === tempDir) {
                    await fs.promises.unlink(resolved)
                }
            } catch { /* best-effort */ }
        }
        return { success: true }
    })

    // Originality score — check how "authentic" a file looks as iPhone output
    ipcMain.handle('check-originality', async (event, options) => {
        const { filePath } = options
        try {
            if (!filePath || !isUnderRoots(filePath, allowedFsRoots())) {
                return { score: -1, error: 'Path not allowed' }
            }
            const { OriginalityChecker } = require('../lib/originality-checker')
            const checker = new OriginalityChecker(dependencyManager)
            return await checker.score(filePath)
        } catch (error) {
            return { score: -1, error: error.message }
        }
    })

    // Compare before vs after spoof scores
    ipcMain.handle('compare-originality', async (event, options) => {
        const { beforePath, afterPath } = options
        try {
            const roots = allowedFsRoots()
            if (!beforePath || !afterPath || !isUnderRoots(beforePath, roots) || !isUnderRoots(afterPath, roots)) {
                return { before: 0, after: 0, delta: 0, error: 'Path not allowed' }
            }
            const { OriginalityChecker } = require('../lib/originality-checker')
            const checker = new OriginalityChecker(dependencyManager)
            return await checker.compare(beforePath, afterPath)
        } catch (error) {
            return { before: 0, after: 0, delta: 0, error: error.message }
        }
    })

    // Video scraper
    ipcMain.handle('run-video-scraper', async (event, config) => {
        const { url, outputFolder, maxVideos, applyTemplate, caption, fingerprintOptions } = config

        console.log(`[VideoToolkit] Starting scrape: ${url} -> ${outputFolder}`)

        // SSRF guard on the scrape source.
        try {
            const su = new URL(String(url))
            if ((su.protocol !== 'https:' && su.protocol !== 'http:') || isPrivateHost(su.hostname)) {
                return { success: false, videosDownloaded: 0, error: 'refusing private/loopback or non-http url', log: '' }
            }
        } catch {
            return { success: false, videosDownloaded: 0, error: 'invalid url', log: '' }
        }

        // Arbitrary-write guard: confine the scrape output to managed roots.
        const scrapeRoots = [CONTENT_ROOT, path.resolve(app.getPath('downloads'))].map(r => path.resolve(r))
        if (!outputFolder || !isUnderRoots(outputFolder, scrapeRoots)) {
            return { success: false, videosDownloaded: 0, error: 'output folder outside managed roots', log: '' }
        }

        const log = []
        let videosDownloaded = 0

        try {
            if (!fs.existsSync(outputFolder)) {
                fs.mkdirSync(outputFolder, { recursive: true })
            }

            const ytdlpPath = getYtdlpPath()

            const args = [
                '-P', outputFolder,
                '-o', '%(title).80B [%(id)s].%(ext)s',
                '--merge-output-format', 'mp4',
                '--ignore-errors',
                '--newline',
                '--progress',
                '--force-ipv4',
                '--socket-timeout', '10',
                '--no-cache-dir',
                '-f', 'bv*+ba/b',
                '--playlist-items', `1:${maxVideos}`,
                '--max-downloads', String(maxVideos),
            ]

            if (url.includes('tiktok.com')) {
                args.push('--sleep-interval', '2', '--no-warnings')
            }

            args.push(url)

            log.push(`[yt-dlp] Starting download: ${url}`)
            log.push(`[yt-dlp] Max videos: ${maxVideos}`)

            await new Promise((resolve, reject) => {
                const ytdlp = spawn(ytdlpPath, args, {
                    cwd: outputFolder,
                    env: { ...process.env }
                })

                ytdlp.stdout.on('data', (data) => {
                    const line = data.toString().trim()
                    if (line) {
                        log.push(`[yt-dlp] ${line}`)
                        if (line.includes('[download]') && line.includes('100%')) {
                            videosDownloaded++
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.webContents.send('video-scraper-progress', {
                                    videosDownloaded,
                                    maxVideos,
                                    log: line
                                })
                            }
                        }
                    }
                })

                ytdlp.stderr.on('data', (data) => {
                    const line = data.toString().trim()
                    if (line) log.push(`[yt-dlp ERROR] ${line}`)
                })

                ytdlp.on('close', (code) => {
                    log.push(`[yt-dlp] Finished with code ${code}`)
                    resolve(code)
                })

                ytdlp.on('error', (err) => {
                    log.push(`[yt-dlp] Process error: ${err.message}`)
                    reject(err)
                })
            })

            const videoFiles = fs.readdirSync(outputFolder).filter(f =>
                f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.mkv')
            )
            videosDownloaded = videoFiles.length
            log.push(`[VideoToolkit] Downloaded ${videosDownloaded} videos`)

            // Apply fingerprint if enabled
            if (applyTemplate && fingerprintOptions && videosDownloaded > 0) {
                log.push(`[FFmpeg] Applying fingerprint breaking + template...`)

                const ffmpegPath = getFFmpegPath()
                const processedFolder = path.join(outputFolder, 'processed')

                if (!fs.existsSync(processedFolder)) {
                    fs.mkdirSync(processedFolder, { recursive: true })
                }

                for (const videoFile of videoFiles) {
                    const inputPath = path.join(outputFolder, videoFile)
                    const outputPath = path.join(processedFolder, `processed_${videoFile}`)

                    const filters = []

                    if (fingerprintOptions.pHashDisrupt) {
                        const speed = (0.98 + Math.random() * 0.04).toFixed(3)
                        filters.push(`setpts=${1 / speed}*PTS`)
                    }

                    if (fingerprintOptions.pHashDisrupt) {
                        const brightness = (Math.random() * 0.04 - 0.02).toFixed(3)
                        const contrast = (0.98 + Math.random() * 0.04).toFixed(3)
                        const saturation = (0.97 + Math.random() * 0.06).toFixed(3)
                        filters.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`)
                    }



                    if (fingerprintOptions.microZoom) {
                        const zoom = (1.005 + Math.random() * 0.01).toFixed(4)
                        filters.push(`scale=iw*${zoom}:ih*${zoom},crop=iw/${zoom}:ih/${zoom}`)
                    }

                    if (fingerprintOptions.noiseOverlay) {
                        const noise = Math.floor(Math.random() * 3) + 1
                        filters.push(`noise=c0s=${noise}:allf=t`)
                    }

                    if (caption) {
                        const escapedCaption = caption.replace(/'/g, "\\'").replace(/:/g, "\\:")
                        filters.push(`pad=iw:ih+80:0:80:color=white`)
                        filters.push(`drawtext=text='${escapedCaption}':fontsize=24:fontcolor=black:x=(w-text_w)/2:y=25`)
                    }

                    const filterStr = filters.join(',')

                    const audioFilters = []
                    if (fingerprintOptions.audioShift) {
                        const pitch = (0.97 + Math.random() * 0.06).toFixed(3)
                        audioFilters.push(`asetrate=44100*${pitch},aresample=44100`)
                    }

                    const ffmpegArgs = ['-i', inputPath, '-y']

                    if (filters.length > 0) {
                        ffmpegArgs.push('-vf', filterStr)
                    }

                    if (audioFilters.length > 0) {
                        ffmpegArgs.push('-af', audioFilters.join(','))
                    }

                    if (fingerprintOptions.metadataSpoof) {
                        const iphoneModels = ['iPhone 14 Pro', 'iPhone 13', 'iPhone 12 Pro Max', 'iPhone 15']
                        const model = iphoneModels[Math.floor(Math.random() * iphoneModels.length)]
                        const iosVersions = ['17.2', '17.1', '16.6', '17.3']
                        const ios = iosVersions[Math.floor(Math.random() * iosVersions.length)]

                        ffmpegArgs.push(
                            '-metadata', `creation_time=${new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000).toISOString()}`,
                            '-metadata', `make=Apple`,
                            '-metadata', `model=${model}`,
                            '-metadata', `software=${ios}`,
                            '-metadata', `comment=`,
                            '-metadata', `description=`
                        )
                    }

                    ffmpegArgs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23')
                    ffmpegArgs.push('-c:a', 'aac', '-b:a', '128k')
                    ffmpegArgs.push(outputPath)

                    await new Promise((resolve) => {
                        const ffmpeg = spawn(ffmpegPath, ffmpegArgs)

                        ffmpeg.on('close', (code) => {
                            if (code === 0) {
                                log.push(`[FFmpeg] Processed: ${videoFile}`)
                            } else {
                                log.push(`[FFmpeg] Failed: ${videoFile} (code ${code})`)
                            }
                            resolve(code)
                        })

                        ffmpeg.on('error', (err) => {
                            log.push(`[FFmpeg] Error: ${err.message}`)
                            resolve(-1)
                        })
                    })
                }

                log.push(`[VideoToolkit] Processing complete. Output: ${processedFolder}`)
            }

            return {
                success: true,
                videosDownloaded,
                outputFolder: applyTemplate ? path.join(outputFolder, 'processed') : outputFolder,
                log: log.join('\n')
            }

        } catch (error) {
            log.push(`[VideoToolkit] Error: ${error.message}`)
            console.error('[VideoToolkit] Error:', error)
            return {
                success: false,
                videosDownloaded,
                error: error.message,
                log: log.join('\n')
            }
        }
    })

    // File management
    ipcMain.handle('open-folder', async (event, folderPath) => {
        try {
            if (typeof folderPath !== 'string' || !folderPath) {
                return { success: false, error: 'invalid path' }
            }
            const resolved = path.resolve(folderPath)
            // Reject UNC / device paths outright (\\server\share, \\.\, \\?\)
            if (resolved.startsWith('\\\\')) {
                return { success: false, error: 'unc paths not allowed' }
            }
            // Must be an existing DIRECTORY (blocks .exe/.bat/.lnk/.hta launch)
            let st
            try { st = fs.statSync(resolved) } catch { return { success: false, error: 'not found' } }
            if (!st.isDirectory()) {
                return { success: false, error: 'not a directory' }
            }
            // Must live under an allow-listed root (userData / content root).
            if (!isAllowedContentPath(resolved, event)) {
                return { success: false, error: 'path outside allowed root' }
            }
            await shell.openPath(resolved)
            return { success: true }
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    ipcMain.handle('get-app-path', async () => {
        return app.getPath('userData')
    })

    ipcMain.handle('browse-folder', async (event, options = {}) => {
        const { title = 'Select Folder', defaultPath, properties, filters } = options

        const result = await dialog.showOpenDialog(mainWindow, {
            title,
            defaultPath: defaultPath || app.getPath('downloads'),
            properties: properties || ['openDirectory', 'createDirectory'],
            filters: filters || undefined
        })

        if (result.canceled) {
            return { success: false, canceled: true }
        }

        // Return all selected paths for multi-select, or single path
        if (result.filePaths.length > 1) {
            return { success: true, path: result.filePaths[0], filePaths: result.filePaths }
        }
        return { success: true, path: result.filePaths[0] }
    })

    const selectFiles = async (options = {}) => {
        const { title = 'Select Files', filters } = options
        const result = await dialog.showOpenDialog(mainWindow, {
            title,
            defaultPath: app.getPath('downloads'),
            properties: ['openFile', 'multiSelections'],
            filters: filters || [{ name: 'All Files', extensions: ['*'] }]
        })
        if (result.canceled) return { success: false, canceled: true }
        return { success: true, filePaths: result.filePaths }
    }
    ipcMain.handle('select-files', (_event, options) => selectFiles(options))
    registeredContentActions = Object.freeze({ selectFiles })

    ipcMain.handle('create-folder', async (event, options) => {
        const { parentPath, folderName } = options
        const newPath = path.join(parentPath, folderName)

        if (!isUnderRoots(newPath, allowedFsRoots())) {
            return { success: false, error: 'path outside allowed roots' }
        }

        try {
            if (!fs.existsSync(newPath)) {
                fs.mkdirSync(newPath, { recursive: true })
            }
            return { success: true, path: newPath }
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    ipcMain.handle('list-folder', async (event, folderPath) => {
        try {
            if (!isUnderRoots(folderPath, allowedFsRoots())) {
                return { success: false, error: 'path outside allowed roots' }
            }
            if (!fs.existsSync(folderPath)) {
                return { success: false, error: 'Folder does not exist' }
            }

            // Non-blocking: async readdir + per-entry stat (only for files).
            // Promise.all preserves readdir order; a stat rejection rejects
            // the Promise.all and is caught below — same shape as before.
            const entries = await fs.promises.readdir(folderPath, { withFileTypes: true })
            const files = await Promise.all(entries.map(async (entry) => {
                const full = path.join(folderPath, entry.name)
                return {
                    name: entry.name,
                    path: full,
                    isDirectory: entry.isDirectory(),
                    size: entry.isFile() ? (await fs.promises.stat(full)).size : 0
                }
            }))

            return { success: true, files }
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    ipcMain.handle('get-default-folders', async () => {
        return {
            downloads: app.getPath('downloads'),
            desktop: app.getPath('desktop'),
            documents: app.getPath('documents'),
            userData: app.getPath('userData'),
            temp: app.getPath('temp')
        }
    })

    ipcMain.handle('select-folder', async (event) => {
        const sender = event?.sender
        if (!sender || sender.isDestroyed?.()) return null
        let roots = selectedFolderRoots.get(sender)
        if (!roots) {
            roots = new Set()
            selectedFolderRoots.set(sender, roots)
            const revoke = () => selectedFolderRoots.delete(sender)
            sender.once('destroyed', revoke)
            sender.once('did-navigate', revoke)
        }
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Select Folder',
            properties: ['openDirectory', 'createDirectory']
        })
        // A pending picker must not grant its result to a replacement document.
        if (result.canceled || !result.filePaths[0] || sender.isDestroyed?.() ||
            selectedFolderRoots.get(sender) !== roots) return null
        const selected = result.filePaths[0]
        const canonical = fs.realpathSync(selected)
        roots.add(canonical)
        return selected
    })

    ipcMain.handle('list-files', async (event, folder, extensions) => {
        try {
            if (!isAllowedContentPath(folder, event)) return []
            // Non-blocking read: a missing folder rejects (ENOENT) and the catch
            // below returns [] — same outcome as the prior existsSync precheck.
            const files = await fs.promises.readdir(folder)
            const filtered = files.filter(f => {
                const ext = path.extname(f).toLowerCase().replace(/^\./, '')
                return extensions.some(e => ext === e.toLowerCase().replace(/^\./, ''))
            })
            return filtered
        } catch {
            return []
        }
    })

    ipcMain.handle('read-file-as-buffer', async (event, filePath) => {
        try {
            // Use the same root set as list-files so a user-selected folder
            // that list-files can enumerate can always be read here.
            // (Previously used a narrower set — CONTENT_ROOT+temp+downloads —
            // which caused "No readable input files" when the input folder was
            // on Desktop or Documents, because list-files enumerated the files
            // but read-file-as-buffer rejected every path as outside its roots.)
            const resolved = path.resolve(filePath)
            if (!isAllowedContentPath(resolved, event)) return null
            // Non-blocking read: a missing file rejects and the catch below
            // returns null — same outcome as the prior existsSync precheck.
            const buffer = await fs.promises.readFile(resolved)
            return buffer.toString('base64')
        } catch {
            return null
        }
    })

    ipcMain.handle('move-file', async (event, fromPath, toPath) => {
        // Constrain BOTH sides to CONTENT_ROOT: rename relocates AND removes
        // the source, so an attacker could otherwise displace/exfiltrate a
        // victim file. Guards both ends (unlike copy-file, whose source is a
        // user-picked file).
        const contentRoots = [path.resolve(CONTENT_ROOT)]
        if (!fromPath || !toPath || !isUnderRoots(fromPath, contentRoots) || !isUnderRoots(toPath, contentRoots)) {
            return { success: false, error: 'path outside content root' }
        }
        try {
            const destDir = path.dirname(toPath)
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true })
            }
            fs.renameSync(fromPath, toPath)
            return true
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    // 'copy-file' is registered in main.js with full CONTENT_ROOT path
    // safety; this duplicate registration was throwing
    // "Attempted to register a second handler for 'copy-file'" inside
    // initContentHandlers, which propagated up through createWindow and
    // silently killed the rest of app.whenReady — including the eager-spawn
    // brain IIFE. Removed.

    ipcMain.handle('download-file-url', async (event, url, destPath) => {
        const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024 // 50 MB ceiling (disk-fill guard)

        // Enforce https + SSRF deny on the initial url AND every redirect target.
        function assertSafeUrl(targetUrl) {
            const u = new URL(targetUrl)
            if (u.protocol !== 'https:') throw new Error('non-https url rejected')
            if (isPrivateHost(u.hostname)) throw new Error('private/loopback host rejected')
            return u
        }

        function followRedirects(targetUrl, maxRedirects = 5) {
            return new Promise((resolve, reject) => {
                if (maxRedirects <= 0) return reject(new Error('Too many redirects'))
                let u
                try { u = assertSafeUrl(targetUrl) } catch (e) { return reject(e) }
                require('https').get(u.toString(), (response) => {
                    if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
                        const redirectUrl = new URL(response.headers.location, targetUrl).toString()
                        followRedirects(redirectUrl, maxRedirects - 1).then(resolve, reject)
                    } else {
                        resolve(response)
                    }
                }).on('error', reject)
            })
        }

        try {
            // Contain destPath to CONTENT_ROOT (kills arbitrary-write / Startup-drop).
            const resolvedDest = path.resolve(destPath)
            const root = path.resolve(CONTENT_ROOT)
            if (!(resolvedDest === root || resolvedDest.startsWith(root + path.sep))) {
                return false
            }

            const destDir = path.dirname(resolvedDest)
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true })
            }

            const response = await followRedirects(url)
            return new Promise((resolve, reject) => {
                const file = fs.createWriteStream(resolvedDest)
                let bytes = 0
                const fail = (err) => {
                    response.destroy()
                    file.close(() => {
                        try { fs.unlinkSync(resolvedDest) } catch {}
                        reject(err)
                    })
                }
                file.on('error', fail)
                response.on('data', (chunk) => {
                    bytes += chunk.length
                    if (bytes > MAX_DOWNLOAD_BYTES) fail(new Error('download exceeds size cap'))
                })
                response.pipe(file)
                file.on('finish', () => {
                    file.close(() => resolve(true))
                })
                response.on('error', fail)
            })
        } catch {
            return false
        }
    })

    // ─── Account asset downloader (PFP + Banner per IG account) ──────
    // Used by the bulk import wizard so each row's `pfp` / `banner` URL gets
    // pre-downloaded into the operator's content folder for that account
    // (userData/Content/Instagram/<username>/profile/{pfp,banner}.<ext>).
    // Returns { success, pfp?: path, banner?: path, errors: [...] }.
    ipcMain.handle('account-download-assets', async (event, args) => {
        const { accountUsername, pfpUrl, bannerUrl, platform } = args || {}
        if (!accountUsername || (!pfpUrl && !bannerUrl)) {
            return { success: false, errors: ['accountUsername + at least one of pfpUrl/bannerUrl required'] }
        }

        const cleanPlatform = (platform || 'instagram').toLowerCase()
        const contentRoot = path.join(app.getPath('userData'), 'Content')
        const accountFolder = path.join(
            contentRoot,
            cleanPlatform.charAt(0).toUpperCase() + cleanPlatform.slice(1),
            String(accountUsername).replace(/[^a-zA-Z0-9._-]/g, '_'),
        )
        const profileFolder = path.join(accountFolder, 'profile')
        try { fs.mkdirSync(profileFolder, { recursive: true }) } catch {}

        const downloadOne = async (url, label) => {
            try {
                // Reuse the same follow-redirects helper used by download-file-url
                // with the same https-only + SSRF deny applied to every hop.
                const follow = (targetUrl, maxRedirects = 5) => new Promise((resolve, reject) => {
                    if (maxRedirects <= 0) return reject(new Error('Too many redirects'))
                    let u
                    try {
                        u = new URL(targetUrl)
                        if (u.protocol !== 'https:') throw new Error('non-https url rejected')
                        if (isPrivateHost(u.hostname)) throw new Error('private/loopback host rejected')
                    } catch (e) { return reject(e) }
                    require('https').get(u.toString(), (response) => {
                        if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
                            const redirectUrl = new URL(response.headers.location, targetUrl).toString()
                            follow(redirectUrl, maxRedirects - 1).then(resolve, reject)
                        } else {
                            resolve(response)
                        }
                    }).on('error', reject)
                })

                const response = await follow(url)
                // Sniff extension from Content-Type when URL has none
                const ct = String(response.headers['content-type'] || '').toLowerCase()
                let ext = '.jpg'
                if (ct.includes('png')) ext = '.png'
                else if (ct.includes('webp')) ext = '.webp'
                else if (ct.includes('jpeg') || ct.includes('jpg')) ext = '.jpg'
                else {
                    const urlExt = (url.match(/\.(jpg|jpeg|png|webp)(?:\?|$)/i) || [])[1]
                    if (urlExt) ext = '.' + urlExt.toLowerCase().replace('jpeg', 'jpg')
                }

                const destPath = path.join(profileFolder, label + ext)
                return await new Promise((resolve, reject) => {
                    const file = fs.createWriteStream(destPath)
                    file.on('error', (err) => {
                        file.close(() => { try { fs.unlinkSync(destPath) } catch {}; reject(err) })
                    })
                    response.pipe(file)
                    file.on('finish', () => file.close(() => resolve(destPath)))
                    response.on('error', (err) => {
                        file.close(() => { try { fs.unlinkSync(destPath) } catch {}; reject(err) })
                    })
                })
            } catch (err) {
                return { __error: err && err.message ? err.message : String(err) }
            }
        }

        const result = { success: true, errors: [] }
        if (pfpUrl) {
            const r = await downloadOne(pfpUrl, 'pfp')
            if (typeof r === 'string') result.pfp = r
            else { result.success = false; result.errors.push('pfp: ' + r.__error) }
        }
        if (bannerUrl) {
            const r = await downloadOne(bannerUrl, 'banner')
            if (typeof r === 'string') result.banner = r
            else { result.success = false; result.errors.push('banner: ' + r.__error) }
        }
        return result
    })

    // Cookie extraction
    ipcMain.handle('extract-browser-cookies', async (event, preferredBrowser = 'auto') => {
        const { execFileSync } = require('child_process')
        const tempDir = app.getPath('temp')

        // Allow-list: --cookies-from-browser only ever takes one of these.
        // Blocks command injection via a renderer-controlled `browser` value.
        const ALLOWED_BROWSERS = new Set(['edge', 'firefox', 'brave', 'chrome'])

        const browsers = preferredBrowser === 'auto'
            ? ['edge', 'firefox', 'brave', 'chrome']
            : [preferredBrowser]

        for (const browser of browsers) {
            if (!ALLOWED_BROWSERS.has(browser)) continue
            const tempCookieFile = path.join(tempDir, `cookies_${browser}_${Date.now()}.txt`)

            try {
                console.log(`[Cookies] Trying ${browser}...`)

                // execFileSync with an argv array — no shell parses the input.
                execFileSync(getYtdlpPath(), [
                    '--cookies-from-browser', browser,
                    '--cookies', tempCookieFile,
                    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                    '--skip-download'
                ], {
                    timeout: 30000,
                    windowsHide: true,
                    stdio: ['pipe', 'pipe', 'pipe']
                })

                if (fs.existsSync(tempCookieFile)) {
                    const cookieData = fs.readFileSync(tempCookieFile)
                    fs.unlinkSync(tempCookieFile)

                    if (cookieData.length > 100) {
                        const base64Cookies = cookieData.toString('base64')
                        console.log(`[Cookies] SUCCESS: Extracted ${cookieData.length} bytes from ${browser}`)

                        return {
                            success: true,
                            cookies: base64Cookies,
                            browser: browser,
                            size: cookieData.length
                        }
                    }
                }
            } catch (error) {
                console.log(`[Cookies] ${browser} failed:`, error.message?.substring(0, 100))
                try { if (fs.existsSync(tempCookieFile)) fs.unlinkSync(tempCookieFile) } catch { }
            }
        }

        console.error('[Cookies] All browsers failed')
        return {
            success: false,
            error: 'Cookie extraction failed for all browsers',
            hint: 'Windows blocks Chrome cookie extraction. Try: 1) Close all browsers, 2) Use Firefox or Edge for social media, 3) Continue without cookies (public videos only)',
            triedBrowsers: browsers
        }
    })
}

module.exports = {
    initContentHandlers,
    getContentActions: () => {
        if (!registeredContentActions) throw new Error('Content actions are not initialized.')
        return registeredContentActions
    },
}
