/**
 * ShadowPhone Dependency Manager
 * Auto-downloads yt-dlp, ffmpeg, and exiftool on first launch
 * Stores binaries in userData/bin/ for persistent access
 */

const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const { execSync, spawn } = require('child_process')
const { pipeline } = require('stream/promises')
const { createWriteStream } = require('fs')
const { Readable } = require('stream')

// Binary URLs for Windows (primary platform)
const BINARY_SOURCES = {
    'yt-dlp': {
        windows: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
        darwin: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
        linux: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
    },
    'ffmpeg': {
        // Using BtbN's static builds - essentials package (~30MB)
        windows: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
        darwin: 'https://evermeet.cx/ffmpeg/getrelease/zip',
        linux: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz'
    },
    'exiftool': {
        // ExifTool standalone Windows executable - direct from exiftool.org.
        // The zip contains 'exiftool(-k).exe' which we rename. NOTE: exiftool.org
        // hosts ONLY the current version and rotates the filename on each release
        // (13.47 -> 13.59 -> ...), so a pinned URL 404s the moment they bump and
        // silently breaks the whole video engine. These are FALLBACK pins only —
        // installDependency resolves the live version from the homepage first
        // (resolveExiftoolUrl). Keep the fallbacks reasonably current.
        // Windows binary is hosted on SourceForge now (exiftool.org root 404s the
        // versioned zip). URL ends in /download (302 -> mirror -> zip).
        windows: 'https://sourceforge.net/projects/exiftool/files/exiftool-13.59_64.zip/download',
        darwin: 'https://exiftool.org/ExifTool-13.59.pkg',
        linux: 'https://exiftool.org/Image-ExifTool-13.59.tar.gz'
    }
}

class DependencyManager {
    constructor() {
        this._binDir = null  // Lazy-loaded
        this.platform = process.platform === 'win32' ? 'windows' : process.platform
        this.statusCallbacks = []
    }

    // Lazy-load binDir (app.getPath only works after app is ready)
    get binDir() {
        if (!this._binDir) {
            this._binDir = path.join(app.getPath('userData'), 'bin')
        }
        return this._binDir
    }

    // Subscribe to status updates
    onStatus(callback) {
        this.statusCallbacks.push(callback)
    }

    // Emit status to all subscribers
    emitStatus(message, progress = null) {
        console.log(`[DependencyManager] ${message}`)
        this.statusCallbacks.forEach(cb => cb({ message, progress }))
    }

    // Get path to a binary
    getBinaryPath(name) {
        const ext = this.platform === 'windows' ? '.exe' : ''
        return path.join(this.binDir, `${name}${ext}`)
    }

    // Check if a binary exists and is executable
    async checkBinary(name) {
        const binPath = this.getBinaryPath(name)

        if (!fs.existsSync(binPath)) {
            console.log(`[DependencyManager] ${name} not found at ${binPath}`)
            return { installed: false, path: binPath }
        }

        // Verify it runs - use correct version flags for each tool
        try {
            let testArg
            if (name === 'exiftool') testArg = '-ver'
            else if (name === 'ffmpeg') testArg = '-version'  // ffmpeg uses single dash
            else testArg = '--version'  // yt-dlp uses double dash

            console.log(`[DependencyManager] Verifying ${name} with: "${binPath}" ${testArg}`)
            execSync(`"${binPath}" ${testArg}`, {
                timeout: 10000,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            })
            console.log(`[DependencyManager] ${name} verified successfully`)
            return { installed: true, path: binPath }
        } catch (error) {
            console.log(`[DependencyManager] ${name} exists but failed verification:`, error.message)
            return { installed: false, path: binPath }
        }
    }

    // Check all dependencies
    async checkAll() {
        const results = {}
        for (const name of ['yt-dlp', 'ffmpeg', 'exiftool']) {
            results[name] = await this.checkBinary(name)
        }
        return results
    }

    // Fetch a small text document (follows redirects, bounded, times out). Used
    // to resolve the live exiftool version off exiftool.org's homepage.
    fetchText(url) {
        return new Promise((resolve, reject) => {
            const req = (u, depth = 0) => {
                if (depth > 5) return reject(new Error('too many redirects'))
                const r = https.get(u, { headers: { 'User-Agent': 'ShadowPhone/1.0' } }, (res) => {
                    if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                        res.resume()
                        return req(res.headers.location, depth + 1)
                    }
                    if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)) }
                    let data = ''
                    res.setEncoding('utf8')
                    res.on('data', (c) => {
                        data += c
                        if (data.length > 1024 * 1024) { res.destroy(); resolve(data) }
                    })
                    res.on('end', () => resolve(data))
                })
                r.on('error', reject)
                r.setTimeout(20000, () => r.destroy(new Error('timeout')))
            }
            req(url)
        })
    }

    // exiftool ships a new version ~weekly and the Windows zip lives on
    // SourceForge (exiftool.org root 404s the versioned zip). Pin any version and
    // it dies on the next bump. Resolve the CURRENT version from exiftool.org's
    // ver.txt (one line, e.g. "13.59") and build the SourceForge download URL;
    // fall back to the kept-current static pin if the fetch fails.
    async resolveExiftoolUrl() {
        const fallback = BINARY_SOURCES.exiftool[this.platform]
        if (this.platform !== 'windows') return fallback
        try {
            const ver = (await this.fetchText('https://exiftool.org/ver.txt')).trim()
            if (/^\d+\.\d+$/.test(ver)) {
                const url = `https://sourceforge.net/projects/exiftool/files/exiftool-${ver}_64.zip/download`
                console.log(`[DependencyManager] Resolved live exiftool ${ver}: ${url}`)
                return url
            }
        } catch (e) {
            console.warn(`[DependencyManager] exiftool version resolve failed, using pin: ${e.message}`)
        }
        return fallback
    }

    // Download file with progress
    async downloadFile(url, destPath, onProgress) {
        return new Promise((resolve, reject) => {
            // Ensure bin directory exists
            const dir = path.dirname(destPath)
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true })
            }

            const safeUnlink = (filePath) => {
                try {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath)
                    }
                } catch (e) {
                    // Ignore unlink errors
                }
            }

            const request = (urlString, depth = 0) => {
                if (depth > 6) return reject(new Error('too many redirects'))
                console.log(`[DependencyManager] Fetching: ${urlString}`)
                const req = https.get(urlString, {
                    headers: { 'User-Agent': 'ShadowPhone/1.0' }
                }, (response) => {
                    // Handle redirects (incl. 307/308 which GitHub/CDNs also use)
                    if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                        console.log(`[DependencyManager] Redirect to: ${response.headers.location}`)
                        response.resume()
                        return request(response.headers.location, depth + 1)
                    }

                    if (response.statusCode !== 200) {
                        console.error(`[DependencyManager] HTTP ${response.statusCode}`)
                        response.resume()
                        return reject(new Error(`HTTP ${response.statusCode} for ${urlString}`))
                    }

                    // Create fresh file stream for actual download
                    const file = createWriteStream(destPath)
                    const totalSize = parseInt(response.headers['content-length'], 10)
                    let downloaded = 0

                    console.log(`[DependencyManager] Downloading ${totalSize || 'unknown'} bytes to ${destPath}`)

                    response.on('data', (chunk) => {
                        downloaded += chunk.length
                        if (onProgress && totalSize) {
                            onProgress(Math.round((downloaded / totalSize) * 100))
                        }
                    })

                    response.pipe(file)

                    file.on('finish', () => {
                        file.close()
                        console.log(`[DependencyManager] Download complete: ${destPath}`)
                        resolve(destPath)
                    })

                    file.on('error', (err) => {
                        file.close()
                        safeUnlink(destPath)
                        reject(err)
                    })
                })
                req.on('error', (err) => {
                    console.error(`[DependencyManager] Download error:`, err.message)
                    safeUnlink(destPath)
                    reject(err)
                })
                // Kill a stalled socket (no bytes for 60s) so a hung CDN doesn't
                // leave the engine "setting up" forever.
                req.setTimeout(60000, () => req.destroy(new Error('download timed out (stalled connection)')))
            }

            request(url)
        })
    }

    // Extract zip file (Windows)
    async extractZip(zipPath, destDir, binaryName) {
        const AdmZip = require('adm-zip')
        const zip = new AdmZip(zipPath)
        const tempExtract = path.join(destDir, 'temp_extract')

        console.log(`[DependencyManager] Extracting ${zipPath} to ${tempExtract}`)

        // Extract to temp
        zip.extractAllTo(tempExtract, true)

        // Log all files for debugging
        const listFiles = (dir, indent = '') => {
            const files = fs.readdirSync(dir, { withFileTypes: true })
            for (const file of files) {
                console.log(`[DependencyManager] ${indent}${file.name}`)
                if (file.isDirectory()) {
                    listFiles(path.join(dir, file.name), indent + '  ')
                }
            }
        }
        listFiles(tempExtract)

        // Find the binary in extracted files
        // For exiftool, the zip contains 'exiftool(-k).exe'
        const findBinary = (dir, name) => {
            const files = fs.readdirSync(dir, { withFileTypes: true })
            for (const file of files) {
                const fullPath = path.join(dir, file.name)
                if (file.isDirectory()) {
                    const found = findBinary(fullPath, name)
                    if (found) return found
                } else {
                    const lowerName = file.name.toLowerCase()
                    // Match patterns: exact name, name-something, name(-k), or name with version
                    const isMatch = lowerName.startsWith(name.toLowerCase()) &&
                        (file.name.endsWith('.exe') || !file.name.includes('.'))
                    if (isMatch) {
                        console.log(`[DependencyManager] Found binary: ${file.name}`)
                        return fullPath
                    }
                }
            }
            return null
        }

        const binaryPath = findBinary(tempExtract, binaryName)
        if (binaryPath) {
            const destPath = this.getBinaryPath(binaryName)
            console.log(`[DependencyManager] Copying ${binaryPath} to ${destPath}`)
            fs.copyFileSync(binaryPath, destPath)

            // For exiftool, we also need to copy the exiftool_files folder
            // which contains the Perl runtime DLLs
            if (binaryName === 'exiftool') {
                const binaryDir = path.dirname(binaryPath)
                const filesFolder = path.join(binaryDir, 'exiftool_files')
                if (fs.existsSync(filesFolder)) {
                    const destFilesFolder = path.join(destDir, 'exiftool_files')
                    console.log(`[DependencyManager] Copying exiftool_files folder to ${destFilesFolder}`)
                    // Recursive copy
                    const copyRecursive = (src, dest) => {
                        if (!fs.existsSync(dest)) {
                            fs.mkdirSync(dest, { recursive: true })
                        }
                        const items = fs.readdirSync(src, { withFileTypes: true })
                        for (const item of items) {
                            const srcPath = path.join(src, item.name)
                            const destPath = path.join(dest, item.name)
                            if (item.isDirectory()) {
                                copyRecursive(srcPath, destPath)
                            } else {
                                fs.copyFileSync(srcPath, destPath)
                            }
                        }
                    }
                    copyRecursive(filesFolder, destFilesFolder)
                    console.log(`[DependencyManager] exiftool_files folder copied successfully`)
                } else {
                    console.log(`[DependencyManager] No exiftool_files folder found (might be standalone version)`)
                }
            }

            // ffprobe ships in the same ffmpeg zip and the originality checker
            // needs it for video metadata scoring — copy it alongside ffmpeg or
            // "original vs spoofed" scoring silently degrades on a fresh install.
            if (binaryName === 'ffmpeg') {
                const probeSrc = findBinary(tempExtract, 'ffprobe')
                if (probeSrc) {
                    const probeDest = this.getBinaryPath('ffprobe')
                    console.log(`[DependencyManager] Copying ffprobe ${probeSrc} -> ${probeDest}`)
                    fs.copyFileSync(probeSrc, probeDest)
                    if (this.platform !== 'windows') fs.chmodSync(probeDest, '755')
                } else {
                    console.warn('[DependencyManager] ffprobe not found in ffmpeg zip')
                }
            }

            // Make executable on Unix
            if (this.platform !== 'windows') {
                fs.chmodSync(destPath, '755')
            }
        } else {
            console.error(`[DependencyManager] Could not find ${binaryName} binary in extracted files`)
        }

        // Cleanup
        fs.rmSync(tempExtract, { recursive: true, force: true })
        fs.unlinkSync(zipPath)

        return this.getBinaryPath(binaryName)
    }

    // Download and install a single dependency
    async installDependency(name) {
        // exiftool's URL is resolved live (version rotates); others are static.
        const url = name === 'exiftool'
            ? await this.resolveExiftoolUrl()
            : BINARY_SOURCES[name]?.[this.platform]
        if (!url) {
            throw new Error(`No download URL for ${name} on ${this.platform}`)
        }

        // Ensure bin directory exists
        if (!fs.existsSync(this.binDir)) {
            fs.mkdirSync(this.binDir, { recursive: true })
        }

        // .zip either directly (ffmpeg BtbN) or embedded before a /download
        // suffix (SourceForge exiftool: .../exiftool-13.59_64.zip/download).
        const isZip = url.endsWith('.zip') || url.includes('.zip/') || url.includes('.zip?')
        const downloadPath = isZip
            ? path.join(this.binDir, `${name}.zip`)
            : this.getBinaryPath(name)

        this.emitStatus(`Downloading ${name}...`, 0)

        try {
            await this.downloadFile(url, downloadPath, (progress) => {
                this.emitStatus(`Downloading ${name}...`, progress)
            })

            if (isZip) {
                this.emitStatus(`Extracting ${name}...`)
                await this.extractZip(downloadPath, this.binDir, name)
            } else if (this.platform !== 'windows') {
                // Make executable on Unix
                fs.chmodSync(downloadPath, '755')
            }

            this.emitStatus(`${name} installed!`, 100)
            return true
        } catch (error) {
            this.emitStatus(`Failed to install ${name}: ${error.message}`)
            throw error
        }
    }

    // Install all missing dependencies
    async installMissing() {
        const status = await this.checkAll()
        const missing = Object.entries(status)
            .filter(([_, info]) => !info.installed)
            .map(([name]) => name)

        // ffprobe rides in the ffmpeg zip (not in checkAll). On installs
        // predating the alongside-copy, ffmpeg is present but ffprobe is absent,
        // degrading video authenticity scoring — recover it by reinstalling
        // ffmpeg (which now also copies ffprobe).
        if (!missing.includes('ffmpeg') && !fs.existsSync(this.getBinaryPath('ffprobe'))) {
            console.log('[DependencyManager] ffprobe missing — reinstalling ffmpeg to recover it')
            missing.push('ffmpeg')
        }

        if (missing.length === 0) {
            this.emitStatus('All dependencies installed!')
            return { success: true, installed: [] }
        }

        this.emitStatus(`Installing ${missing.length} dependencies...`)
        const installed = []

        for (const name of missing) {
            try {
                await this.installDependency(name)
                installed.push(name)
            } catch (error) {
                console.error(`Failed to install ${name}:`, error)
                return {
                    success: false,
                    installed,
                    failed: name,
                    error: error.message
                }
            }
        }

        this.emitStatus('All dependencies ready!')
        return { success: true, installed }
    }

    // Run yt-dlp with arguments
    runYtDlp(args, onOutput) {
        const binPath = this.getBinaryPath('yt-dlp')
        return new Promise((resolve, reject) => {
            const proc = spawn(binPath, args, { windowsHide: true })

            let stdout = ''
            let stderr = ''

            proc.stdout.on('data', (data) => {
                const text = data.toString()
                stdout += text
                if (onOutput) onOutput('stdout', text)
            })

            proc.stderr.on('data', (data) => {
                const text = data.toString()
                stderr += text
                if (onOutput) onOutput('stderr', text)
            })

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve({ stdout, stderr })
                } else {
                    reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`))
                }
            })

            proc.on('error', reject)
        })
    }

    // Run ffmpeg with arguments
    runFfmpeg(args, onOutput) {
        const binPath = this.getBinaryPath('ffmpeg')
        return new Promise((resolve, reject) => {
            const proc = spawn(binPath, args, { windowsHide: true })

            let stderr = '' // ffmpeg outputs progress to stderr

            proc.stderr.on('data', (data) => {
                const text = data.toString()
                stderr += text
                if (onOutput) onOutput('stderr', text)
            })

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve({ stderr })
                } else {
                    reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`))
                }
            })

            proc.on('error', reject)
        })
    }

    // Run exiftool with arguments
    runExiftool(args, onOutput) {
        const binPath = this.getBinaryPath('exiftool')
        return new Promise((resolve, reject) => {
            const proc = spawn(binPath, args, { windowsHide: true })

            let stdout = ''
            let stderr = ''

            proc.stdout.on('data', (data) => {
                stdout += data.toString()
            })

            proc.stderr.on('data', (data) => {
                stderr += data.toString()
            })

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve({ stdout, stderr })
                } else {
                    reject(new Error(`exiftool exited with code ${code}: ${stderr}`))
                }
            })

            proc.on('error', reject)
        })
    }
}

module.exports = { DependencyManager }
