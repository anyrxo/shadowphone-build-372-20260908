/**
 * Spoof Originality Checker
 * Scores how "authentic" a file looks as iPhone camera output.
 * Runs before + after spoofing to show the improvement.
 */

const fs = require('fs')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

// What a real iPhone file should have
const IPHONE_MODELS = new Set([
    'iPhone 14 Pro', 'iPhone 14 Pro Max', 'iPhone 15', 'iPhone 15 Pro',
    'iPhone 15 Pro Max', 'iPhone 16', 'iPhone 16 Pro', 'iPhone 16 Pro Max',
])

class OriginalityChecker {
    constructor(dependencyManager) {
        this.deps = dependencyManager
    }

    // Find a binary — app bin first, then next to ffmpeg, then system PATH
    _findBinary(name) {
        const appPath = this.deps.getBinaryPath(name)
        if (appPath && fs.existsSync(appPath)) return appPath

        // ffprobe lives next to ffmpeg
        if (name === 'ffprobe') {
            const ffmpegPath = this.deps.getBinaryPath('ffmpeg')
            if (ffmpegPath) {
                const probe = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, `ffprobe$1`)
                if (fs.existsSync(probe)) return probe
            }
        }

        // System PATH
        try {
            const cmd = process.platform === 'win32' ? 'where' : 'which'
            const bin = process.platform === 'win32' ? `${name}.exe` : name
            const result = execFileSync(cmd, [bin], { encoding: 'utf-8', timeout: 3000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
            if (result) return result.split('\n')[0].trim()
        } catch {}

        return null
    }

    /**
     * Score a single file's iPhone authenticity (0-100).
     * Higher = looks more like real iPhone camera output.
     */
    async score(filePath) {
        if (!fs.existsSync(filePath)) return { score: 0, checks: {}, error: 'File not found' }

        const ext = path.extname(filePath).toLowerCase()
        const isVideo = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'].includes(ext)

        const checks = {}
        let total = 0
        let earned = 0

        if (isVideo) {
            const meta = this._probeVideo(filePath)

            // Codec: HEVC = iPhone default (25 pts)
            total += 25
            if (meta.codec === 'hevc' || meta.codec === 'h265') { earned += 25; checks.codec = { pass: true, value: 'HEVC', note: 'iPhone default' } }
            else if (meta.codec === 'h264') { earned += 10; checks.codec = { pass: false, value: 'H.264', note: 'Older/compat mode' } }
            else { checks.codec = { pass: false, value: meta.codec || 'unknown', note: 'Not iPhone codec' } }

            // Container: .mov = QuickTime (15 pts)
            total += 15
            if (ext === '.mov') { earned += 15; checks.container = { pass: true, value: '.mov', note: 'QuickTime' } }
            else { checks.container = { pass: false, value: ext, note: 'iPhone uses .mov' } }

            // Color space: bt709 (10 pts)
            total += 10
            if (meta.colorPrimaries?.includes('bt709') || meta.colorSpace?.includes('bt709')) { earned += 10; checks.color = { pass: true, value: 'BT.709' } }
            else { checks.color = { pass: false, value: meta.colorPrimaries || 'none' } }

            // GPS location (15 pts)
            total += 15
            if (meta.gps) { earned += 15; checks.gps = { pass: true, value: meta.gps } }
            else { checks.gps = { pass: false, value: 'none', note: 'No GPS data' } }

            // Apple metadata tags (20 pts)
            total += 20
            if (meta.make === 'Apple' && IPHONE_MODELS.has(meta.model)) { earned += 20; checks.device = { pass: true, value: meta.model } }
            else if (meta.make === 'Apple') { earned += 10; checks.device = { pass: false, value: meta.model || 'unknown model' } }
            else { checks.device = { pass: false, value: meta.make || 'no make tag', note: 'Not Apple' } }

            // Frame rate: 24/30/60fps (10 pts)
            total += 10
            const fps = Math.round(meta.fps || 0)
            if ([24, 25, 30, 60].includes(fps)) { earned += 10; checks.fps = { pass: true, value: `${fps}fps` } }
            else { checks.fps = { pass: false, value: meta.fps ? `${meta.fps}fps` : 'unknown' } }

            // No FFmpeg encoder signature (5 pts)
            total += 5
            if (!meta.encoder || !meta.encoder.toLowerCase().includes('lavf')) { earned += 5; checks.encoder = { pass: true, value: meta.encoder || 'clean' } }
            else { checks.encoder = { pass: false, value: meta.encoder, note: 'FFmpeg signature detected' } }

        } else {
            // Image scoring via exiftool
            const meta = this._probeImage(filePath)

            // Camera Make (15 pts)
            total += 15
            if (meta.Make === 'Apple') { earned += 15; checks.make = { pass: true, value: 'Apple' } }
            else { checks.make = { pass: false, value: meta.Make || 'none' } }

            // Camera Model (20 pts)
            total += 20
            if (IPHONE_MODELS.has(meta.Model)) { earned += 20; checks.model = { pass: true, value: meta.Model } }
            else { checks.model = { pass: false, value: meta.Model || 'none' } }

            // GPS (15 pts)
            total += 15
            if (meta.GPSLatitude && meta.GPSLongitude) { earned += 15; checks.gps = { pass: true, value: `${meta.GPSLatitude}, ${meta.GPSLongitude}` } }
            else { checks.gps = { pass: false, value: 'none' } }

            // Lens info (10 pts)
            total += 10
            if (meta.LensModel) { earned += 10; checks.lens = { pass: true, value: meta.LensModel } }
            else { checks.lens = { pass: false, value: 'none' } }

            // EXIF dates (10 pts)
            total += 10
            if (meta.DateTimeOriginal && meta.CreateDate) { earned += 10; checks.dates = { pass: true, value: meta.DateTimeOriginal } }
            else { checks.dates = { pass: false, value: 'missing' } }

            // iOS Software version (10 pts)
            total += 10
            if (meta.Software && /^1[78]\.\d/.test(meta.Software)) { earned += 10; checks.software = { pass: true, value: meta.Software } }
            else { checks.software = { pass: false, value: meta.Software || 'none' } }

            // Color space (5 pts)
            total += 5
            if (meta.ColorSpace === 'sRGB' || meta.ColorSpace === 'Display P3') { earned += 5; checks.colorSpace = { pass: true, value: meta.ColorSpace } }
            else { checks.colorSpace = { pass: false, value: meta.ColorSpace || 'none' } }

            // Exposure/ISO realistic (10 pts)
            total += 10
            const iso = parseInt(meta.ISO || '0')
            if (iso >= 25 && iso <= 3200 && meta.ExposureTime) { earned += 10; checks.exposure = { pass: true, value: `ISO ${iso}, ${meta.ExposureTime}` } }
            else { checks.exposure = { pass: false, value: iso ? `ISO ${iso}` : 'none' } }

            // No AI tool signatures (5 pts)
            total += 5
            const suspectTags = ['DALL-E', 'Midjourney', 'Stable Diffusion', 'ComfyUI', 'automatic1111', 'flux']
            const allValues = Object.values(meta).join(' ').toLowerCase()
            const hasAiSig = suspectTags.some(t => allValues.includes(t.toLowerCase()))
            if (!hasAiSig) { earned += 5; checks.aiSignature = { pass: true, value: 'clean' } }
            else { checks.aiSignature = { pass: false, value: 'AI tool signature found' } }
        }

        const score = total > 0 ? Math.round((earned / total) * 100) : 0
        return { score, checks, earned, total }
    }

    /**
     * Compare before vs after — metadata scores + visual similarity analysis.
     *
     * Visual checks:
     *  - SSIM (structural similarity): measures how visually similar the files are.
     *    0.85-0.95 = ideal (looks same to humans, different enough for algorithms).
     *    >0.99 = barely changed (pHash disruption failed).
     *    <0.80 = too different (content noticeably altered).
     *  - File hash: SHA-256 of raw bytes. Must be different (proves re-encoding happened).
     *  - File size delta: significant change suggests real re-encoding, not just metadata swap.
     */
    async compare(beforePath, afterPath) {
        const before = await this.score(beforePath)
        const after = await this.score(afterPath)

        // Visual similarity via FFmpeg SSIM
        const visual = this._computeVisualSimilarity(beforePath, afterPath)

        // Perceptual-hash distance (real repost-detection signal). 0 = identical
        // frame (a robust matcher would still flag it); higher = more disrupted.
        const bh = this._dhash(beforePath)
        const ah = this._dhash(afterPath)
        let phashDistance = null
        if (bh && ah) { phashDistance = 0; for (let i = 0; i < 64; i++) if (bh[i] !== ah[i]) phashDistance++ }

        // File-level checks
        const crypto = require('crypto')
        const beforeHash = this._fileHash(beforePath)
        const afterHash = this._fileHash(afterPath)
        const hashDifferent = beforeHash !== afterHash

        const beforeSize = fs.existsSync(beforePath) ? fs.statSync(beforePath).size : 0
        const afterSize = fs.existsSync(afterPath) ? fs.statSync(afterPath).size : 0
        const sizeDelta = beforeSize > 0 ? Math.round(((afterSize - beforeSize) / beforeSize) * 100) : 0

        // SSIM assessment
        let ssimVerdict = 'unknown'
        if (visual.ssim !== null) {
            if (visual.ssim > 0.99) ssimVerdict = 'barely_changed'  // pHash disruption too weak
            else if (visual.ssim > 0.92) ssimVerdict = 'ideal'      // looks same, algorithms see different
            else if (visual.ssim > 0.80) ssimVerdict = 'good'        // noticeable but acceptable
            else ssimVerdict = 'too_different'                        // content visibly altered
        }

        // Grade = iPhone-authenticity (metadata) AND proof it actually changed
        // (unique file + perceptually disrupted). We do NOT grade on SSIM: an
        // intentional h-flip/zoom/noise LOWERS SSIM by design, so it's reported
        // as info, not a quality gate. `changed` is the real repost-evasion test.
        const metaScore = after.score
        const changed = hashDifferent && (phashDistance === null || phashDistance >= 4)
        const grade = (metaScore >= 90 && changed) ? 'A'
            : (metaScore >= 75 && changed) ? 'B'
            : metaScore >= 50 ? 'C'
            : 'F'

        return {
            before: before.score,
            after: after.score,
            delta: after.score - before.score,
            beforeChecks: before.checks,
            afterChecks: after.checks,
            grade,
            visual: {
                ssim: visual.ssim,
                ssimVerdict,
                hashDifferent,
                sizeDelta: `${sizeDelta > 0 ? '+' : ''}${sizeDelta}%`,
                psnr: visual.psnr,
                phashDistance, // 0-64; higher = more perceptually disrupted (repost-evasion)
            },
        }
    }

    /**
     * Compute SSIM and PSNR between two files using FFmpeg.
     * SSIM: 1.0 = identical, 0.0 = completely different.
     * For our use case, 0.85-0.95 is the sweet spot.
     */
    _computeVisualSimilarity(beforePath, afterPath) {
        const result = { ssim: null, psnr: null }
        try {
            const ffmpegPath = this._findBinary('ffmpeg')
            if (!ffmpegPath) return result

            // FFmpeg SSIM filter: compare first frame (images) or first 5 seconds (video)
            const ext = path.extname(afterPath).toLowerCase()
            const isVideo = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'].includes(ext)

            // SSIM needs matching dims. scale2ref scales the AFTER input to the
            // BEFORE input's dimensions (the old `scale=iw:ih` was a no-op — it
            // scaled to its own dims, so any dimension change errored -> null).
            const args = [
                '-i', beforePath,
                '-i', afterPath,
                ...(isVideo ? ['-t', '5'] : []),
                '-filter_complex', `[1:v][0:v]scale2ref=flags=bicubic[scaled][ref];[ref][scaled]ssim`,
                '-f', 'null', '-',
            ]

            // ffmpeg writes SSIM to stderr and exits 0, so execFileSync (which only
            // returns stdout, and only surfaces stderr in its throw path) silently
            // dropped it — SSIM always came back null. spawnSync captures stderr
            // regardless of exit code.
            const r = spawnSync(ffmpegPath, args, { timeout: 30000, windowsHide: true, encoding: 'utf-8', maxBuffer: 1e7 })
            const output = (r.stderr || '') + (r.stdout || '')

            // Parse SSIM: "SSIM All:0.934567 (12.345)" or "All:0.934567"
            const ssimMatch = output.match(/All[:\s]+([\d.]+)/)
            if (ssimMatch) result.ssim = parseFloat(ssimMatch[1])
        } catch (err) {
            console.error('[OriginalityChecker] SSIM computation error:', err.message)
        }
        return result
    }

    // Real perceptual hash (dHash): 9x8 grayscale frame, compare adjacent pixels
    // per row -> 64-bit hash. This is the class of signal platforms use to catch
    // reposts. Returns a 64-char bit string, or null.
    _dhash(filePath) {
        try {
            const ffmpegPath = this._findBinary('ffmpeg')
            if (!ffmpegPath) return null
            const r = spawnSync(ffmpegPath, ['-i', filePath, '-vf', 'scale=9:8,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'], { timeout: 15000, windowsHide: true, maxBuffer: 1e7 })
            const buf = r.stdout
            if (!buf || buf.length < 72) return null
            let bits = ''
            for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) bits += (buf[row * 9 + col] < buf[row * 9 + col + 1]) ? '1' : '0'
            return bits
        } catch { return null }
    }

    _fileHash(filePath) {
        try {
            if (!fs.existsSync(filePath)) return null
            const crypto = require('crypto')
            const data = fs.readFileSync(filePath)
            return crypto.createHash('sha256').update(data).digest('hex')
        } catch {
            return null
        }
    }

    // Extract video metadata via ffprobe/ffmpeg
    _probeVideo(filePath) {
        const result = { codec: null, fps: null, colorPrimaries: null, colorSpace: null, gps: null, make: null, model: null, encoder: null }
        try {
            const probeBin = this._findBinary('ffprobe')
            const ffmpegPath = this._findBinary('ffmpeg')

            let output = ''
            if (probeBin) {
                output = execFileSync(probeBin, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath], { timeout: 15000, windowsHide: true, encoding: 'utf-8' })
                try {
                    const data = JSON.parse(output)
                    const vs = (data.streams || []).find(s => s.codec_type === 'video') || {}
                    result.codec = vs.codec_name
                    if (vs.r_frame_rate) {
                        const parts = vs.r_frame_rate.split('/')
                        result.fps = parts.length === 2 ? parseInt(parts[0]) / parseInt(parts[1]) : parseFloat(vs.r_frame_rate)
                    }
                    result.colorPrimaries = vs.color_primaries
                    result.colorSpace = vs.color_space
                    const tags = { ...(data.format?.tags || {}), ...(vs.tags || {}) }
                    result.make = tags['com.apple.quicktime.make'] || tags['make'] || null
                    result.model = tags['com.apple.quicktime.model'] || tags['model'] || null
                    result.gps = tags['com.apple.quicktime.location.ISO6709'] || tags['location'] || null
                    result.encoder = tags['encoder'] || tags['handler_name'] || null
                } catch {}
            } else if (ffmpegPath && fs.existsSync(ffmpegPath)) {
                try { execFileSync(ffmpegPath, ['-i', filePath, '-f', 'null', '-'], { timeout: 10000, windowsHide: true, encoding: 'utf-8' }) } catch (e) { output = (e.stderr || '') + (e.stdout || '') }
                const codecMatch = output.match(/Video:\s+(\w+)/)
                if (codecMatch) result.codec = codecMatch[1]
                const fpsMatch = output.match(/([\d.]+)\s+fps/)
                if (fpsMatch) result.fps = parseFloat(fpsMatch[1])
            }
        } catch (err) {
            console.error('[OriginalityChecker] probe error:', err.message)
        }
        return result
    }

    // Extract image EXIF via exiftool
    _probeImage(filePath) {
        try {
            const exiftoolPath = this._findBinary('exiftool')
            if (!exiftoolPath) return {}
            const output = execFileSync(exiftoolPath, ['-json', '-n', filePath], { timeout: 10000, windowsHide: true, encoding: 'utf-8' })
            return JSON.parse(output)[0] || {}
        } catch {
            return {}
        }
    }
}

module.exports = { OriginalityChecker }
