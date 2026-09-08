/**
 * ShadowPhone Local Video/Image Fingerprinter
 * Deep anti-detection: encodes content to match genuine iPhone camera output.
 *
 * Video: HEVC Main profile, .mov container, Apple QuickTime atoms, GPS, color metadata
 * Image: Re-encodes JPEG with EXIF injection (camera, GPS, lens, exposure)
 *
 * Techniques:
 *  - Codec: HEVC (iPhone default since iPhone 7) with proper profile/level
 *  - Container: .mov with QuickTime-compatible atoms
 *  - Color: BT.709 primaries, rec709 transfer, proper color range
 *  - Audio: AAC-LC 44100Hz stereo (iPhone default)
 *  - Metadata: Full Apple QuickTime metadata set + GPS coordinates
 *  - Visual: pHash disruption, micro-zoom, noise overlay, frame timing shift
 *  - EXIF (images): Camera model, lens, GPS, exposure, ISO, software
 */

const path = require('path')
const fs = require('fs')
const { DependencyManager } = require('./dependency-manager')

// US city GPS coordinates (realistic spread of locations)
const US_LOCATIONS = [
    { lat: 34.0522, lon: -118.2437, city: 'Los Angeles' },
    { lat: 40.7128, lon: -74.0060, city: 'New York' },
    { lat: 41.8781, lon: -87.6298, city: 'Chicago' },
    { lat: 29.7604, lon: -95.3698, city: 'Houston' },
    { lat: 33.4484, lon: -112.0740, city: 'Phoenix' },
    { lat: 25.7617, lon: -80.1918, city: 'Miami' },
    { lat: 47.6062, lon: -122.3321, city: 'Seattle' },
    { lat: 37.7749, lon: -122.4194, city: 'San Francisco' },
    { lat: 39.7392, lon: -104.9903, city: 'Denver' },
    { lat: 36.1627, lon: -86.7816, city: 'Nashville' },
    { lat: 30.2672, lon: -97.7431, city: 'Austin' },
    { lat: 32.7767, lon: -96.7970, city: 'Dallas' },
    { lat: 33.7490, lon: -84.3880, city: 'Atlanta' },
    { lat: 42.3601, lon: -71.0589, city: 'Boston' },
    { lat: 38.9072, lon: -77.0369, city: 'Washington DC' },
]

const IPHONE_MODELS = [
    { model: 'iPhone 14 Pro', hw: 'iPhone15,2', lens: '6.86mm f/1.78' },
    { model: 'iPhone 14 Pro Max', hw: 'iPhone15,3', lens: '6.86mm f/1.78' },
    { model: 'iPhone 15', hw: 'iPhone15,4', lens: '6.86mm f/1.6' },
    { model: 'iPhone 15 Pro', hw: 'iPhone16,1', lens: '6.765mm f/1.78' },
    { model: 'iPhone 15 Pro Max', hw: 'iPhone16,2', lens: '6.765mm f/1.78' },
    { model: 'iPhone 16', hw: 'iPhone17,3', lens: '6.765mm f/1.6' },
    { model: 'iPhone 16 Pro', hw: 'iPhone17,1', lens: '6.765mm f/1.78' },
    { model: 'iPhone 16 Pro Max', hw: 'iPhone17,2', lens: '6.765mm f/1.78' },
]

const IOS_VERSIONS = ['17.4.1', '17.5.1', '17.6.1', '18.0.1', '18.1', '18.1.1', '18.2', '18.3.1', '18.4']

class LocalFingerprinter {
    constructor() {
        this.deps = new DependencyManager()
    }

    randomFloat(min, max) {
        return Math.random() * (max - min) + min
    }

    randomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min
    }

    // Add slight GPS jitter so each file has unique but nearby coordinates
    jitterGps(lat, lon) {
        return {
            lat: lat + this.randomFloat(-0.008, 0.008),
            lon: lon + this.randomFloat(-0.008, 0.008),
        }
    }

    // Generate a random iPhone identity for this session
    getRandomDevice() {
        const device = IPHONE_MODELS[this.randomInt(0, IPHONE_MODELS.length - 1)]
        const ios = IOS_VERSIONS[this.randomInt(0, IOS_VERSIONS.length - 1)]
        const location = US_LOCATIONS[this.randomInt(0, US_LOCATIONS.length - 1)]
        const gps = this.jitterGps(location.lat, location.lon)
        const randomDate = new Date(Date.now() - this.randomInt(3600000, 604800000)) // 1 hour to 7 days ago
        return { ...device, ios, location, gps, date: randomDate }
    }

    // Convert decimal GPS to iPhone ISO 6709 — WITH altitude, which real iPhones
    // always include (+34.0522-118.2437+018.500/). Omitting altitude is a tell.
    toIso6709(lat, lon, alt) {
        const latStr = (lat >= 0 ? '+' : '') + lat.toFixed(4)
        const lonStr = (lon >= 0 ? '+' : '') + lon.toFixed(4)
        const a = typeof alt === 'number' ? alt : this.randomFloat(2, 380)
        const altStr = (a >= 0 ? '+' : '-') + Math.abs(a).toFixed(3).padStart(7, '0')
        return `${latStr}${lonStr}${altStr}/`
    }

    async fingerprint(inputPath, outputPath, options = {}) {
        const {
            metadataSpoof = true,
            pHashDisrupt = true,
            randomFlip = true,
            microZoom = true,
            audioShift = true,
            noiseOverlay = true,
            onProgress,
            onLog
        } = options

        const log = (msg) => {
            console.log(`[Fingerprinter] ${msg}`)
            if (onLog) onLog(msg)
        }

        const ext = path.extname(inputPath).toLowerCase()
        const isImage = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)
        const isVideo = ['.mp4', '.mov', '.webm', '.mkv', '.avi'].includes(ext)

        if (!isImage && !isVideo) {
            return { success: false, inputPath, error: `Unsupported format: ${ext}` }
        }

        log(`Processing: ${path.basename(inputPath)} (${isImage ? 'image' : 'video'})`)

        const device = this.getRandomDevice()
        log(`Device: ${device.model} iOS ${device.ios} — ${device.location.city}`)

        if (isImage) {
            return this._fingerprintImage(inputPath, outputPath, device, options, log)
        }
        return this._fingerprintVideo(inputPath, outputPath, device, options, log)
    }

    async _fingerprintImage(inputPath, outputPath, device, options, log) {
        const { pHashDisrupt = true, microZoom = true } = options

        // Force .jpg output
        const finalOutput = outputPath.replace(/\.[^.]+$/, '.jpg')

        const videoFilters = []

        if (pHashDisrupt) {
            const brightness = this.randomFloat(-0.015, 0.015)
            const contrast = this.randomFloat(0.985, 1.015)
            const saturation = this.randomFloat(0.985, 1.015)
            videoFilters.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`)
        }

        if (microZoom) {
            const zoom = this.randomFloat(1.005, 1.02)
            videoFilters.push(`scale=iw*${zoom}:ih*${zoom},crop=iw/${zoom}:ih/${zoom}`)
        }

        const vf = videoFilters.length > 0 ? ['-vf', videoFilters.join(',')] : []
        const dateStr = device.date.toISOString().replace('Z', '+00:00')

        const args = [
            '-i', inputPath,
            '-y',
            ...vf,
            '-q:v', String(this.randomInt(2, 4)), // iPhone JPEG quality range
            '-map_metadata', '-1',
            '-metadata', `creation_time=${dateStr}`,
            '-metadata', `com.apple.quicktime.make=Apple`,
            '-metadata', `com.apple.quicktime.model=${device.model}`,
            '-metadata', `com.apple.quicktime.software=${device.ios}`,
            '-metadata', `com.apple.quicktime.creationdate=${dateStr}`,
            finalOutput,
        ]

        try {
            await this.deps.runFfmpeg(args)

            // Inject EXIF via exiftool if available
            await this._injectExif(finalOutput, device, log)

            if (!fs.existsSync(finalOutput)) throw new Error('Output file not created')
            const stats = fs.statSync(finalOutput)
            log(`Done: ${path.basename(finalOutput)} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`)

            return { success: true, inputPath, outputPath: finalOutput, size: stats.size }
        } catch (error) {
            log(`Error: ${error.message}`)
            return { success: false, inputPath, error: error.message }
        }
    }

    async _fingerprintVideo(inputPath, outputPath, device, options, log) {
        const {
            pHashDisrupt = true,
            randomFlip = true,
            microZoom = true,
            audioShift = true,
            noiseOverlay = true,
        } = options

        // Force .mov output (iPhone container)
        const finalOutput = outputPath.replace(/\.[^.]+$/, '.mov')

        const videoFilters = []
        const audioFilters = []

        // 1. pHash disruption — subtle color/brightness shifts
        if (pHashDisrupt) {
            const brightness = this.randomFloat(-0.02, 0.02)
            const contrast = this.randomFloat(0.98, 1.02)
            const saturation = this.randomFloat(0.98, 1.02)
            videoFilters.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`)
        }

        // 2. Random horizontal flip (50% chance)
        if (randomFlip && Math.random() > 0.5) {
            videoFilters.push('hflip')
            log('Applied: horizontal flip')
        }

        // 3. NON-UNIFORM zoom + RANDOM PAN. Independent horizontal/vertical scale
        //    (a sub-perceptible aspect tweak) + a random crop offset. This is what
        //    makes N outputs of the SAME source differ from EACH OTHER against a
        //    robust video-signature matcher (MPEG-7), not just from the source.
        //    Uniform micro-zoom alone collided at scale (some outputs matched);
        //    two independent scale axes + a wider crop + pan spread them apart.
        if (microZoom) {
            const zx = this.randomFloat(1.03, 1.065)
            const zy = this.randomFloat(1.03, 1.065)
            const fx = this.randomFloat(0, 1)
            const fy = this.randomFloat(0, 1)
            videoFilters.push(`scale=iw*${zx.toFixed(4)}:ih*${zy.toFixed(4)},crop=iw/${zx.toFixed(4)}:ih/${zy.toFixed(4)}:(iw-ow)*${fx.toFixed(4)}:(ih-oh)*${fy.toFixed(4)}`)
        }

        // 4. Invisible per-frame noise layer (unique seed per output). Slightly
        //    stronger + per-output seed so two outputs never share the same noise.
        if (noiseOverlay) {
            const strength = this.randomInt(2, 5)
            const seed = this.randomInt(1, 2_000_000_000)
            videoFilters.push(`noise=c0s=${strength}:c0f=t+u:all_seed=${seed}`)
        }

        // 5. Overall speed (video + audio matched, ±2%). Invisible, but shifts
        //    video frame timing AND the audio tempo — one of two independent
        //    audio-fingerprint dimensions. A/V stays in sync because both move
        //    together.
        const speed = this.randomFloat(0.98, 1.02)
        videoFilters.push(`setpts=${(1 / speed).toFixed(5)}*PTS`)

        // 6. Audio fingerprint disruption. Two INDEPENDENT random dims (pitch +
        //    speed) so N outputs of the same source stay far apart in their
        //    chromaprint (the old ±1% pitch/±0.2% tempo collided — two outputs
        //    could land 0.6% apart -> nearly identical audio fingerprint, a
        //    repost-detection catch). Pitch is the dominant chromaprint mover.
        //    rubberband is a no-op in the bundled ffmpeg, so shift pitch via
        //    asetrate (raises pitch+speed) then atempo=speed/pitch to restore
        //    duration so audio matches the sped video — no A/V drift.
        if (audioShift) {
            const pitch = this.randomFloat(0.955, 1.045)
            const netTempo = speed / pitch
            audioFilters.push(`asetrate=44100*${pitch.toFixed(5)},aresample=44100,atempo=${netTempo.toFixed(5)}`)
            // Third INDEPENDENT audio dimension: a random sub-perceptible echo
            // (<~22ms is below the echo-fusion threshold → heard as faint
            // coloration, not an echo). This guarantees a separation FLOOR — even
            // two outputs that happen to draw near-identical pitch+speed still
            // differ ~8% in chromaprint from a different echo delay, so no pair of
            // N outputs collapses to the same audio fingerprint.
            const echoDelay = this.randomInt(8, 22)
            const echoDecay = this.randomFloat(0.12, 0.26)
            const outGain = this.randomFloat(0.82, 0.9)
            audioFilters.push(`aecho=0.9:${outGain.toFixed(2)}:${echoDelay}:${echoDecay.toFixed(2)}`)
        } else {
            audioFilters.push(`atempo=${speed.toFixed(5)}`)
        }

        // Full iPhone-authentic metadata
        const dateStr = device.date.toISOString().replace('Z', '+00:00')
        const gpsStr = this.toIso6709(device.gps.lat, device.gps.lon)
        // Unique content identifier — every real iPhone capture stamps one; it
        // also makes each output provably distinct at the metadata layer.
        const contentId = require('crypto').randomUUID().toUpperCase()

        const metadata = [
            '-map_metadata', '-1', // Strip all source metadata first
            // Handler names: ffmpeg writes "VideoHandler"/"SoundHandler" — real
            // iPhones write "Core Media Video"/"Core Media Audio". Classic tell.
            '-metadata:s:v:0', 'handler_name=Core Media Video',
            '-metadata:s:a:0', 'handler_name=Core Media Audio',
            '-metadata', `creation_time=${dateStr}`,
            '-metadata', `com.apple.quicktime.make=Apple`,
            '-metadata', `com.apple.quicktime.model=${device.model}`,
            '-metadata', `com.apple.quicktime.software=${device.ios}`,
            '-metadata', `com.apple.quicktime.creationdate=${dateStr}`,
            '-metadata', `com.apple.quicktime.content.identifier=${contentId}`,
            '-metadata', `com.apple.quicktime.location.ISO6709=${gpsStr}`,
            '-metadata', `com.apple.quicktime.location.accuracy.horizontal=5.${this.randomInt(10, 99)}`,
            '-metadata', `com.apple.quicktime.camera.lens_model=${device.lens}`,
            '-metadata', `com.apple.quicktime.camera.focal_length.35mm_equivalent=${this.randomInt(24, 26)}`,
            '-metadata', `minor_version=0`,
            '-metadata', `compatible_brands=qt  `,
            '-metadata', 'title=',
            '-metadata', 'comment=',
            '-metadata', 'description=',
            '-metadata', 'encoder=',
        ]

        // Force color primaries in the filter chain (more reliable than output flags)
        videoFilters.push('colorspace=all=bt709:iall=bt709')

        const vfFinal = videoFilters.length > 0 ? ['-vf', videoFilters.join(',')] : []
        const afFinal = audioFilters.length > 0 ? ['-af', audioFilters.join(',')] : []

        // Random micro start-trim (≤0.3s). Shifts which frames each output
        // begins on, so N outputs of the same source sample DIFFERENT frames —
        // the biggest lever for making the outputs unique from each other (not
        // just from the source). Invisible on a reel; also varies duration.
        const startTrim = this.randomFloat(0, 0.3)

        // Build FFmpeg command — HEVC in QuickTime .mov container
        const args = [
            '-ss', startTrim.toFixed(3),
            '-i', inputPath,
            '-y',
            ...vfFinal,
            ...afFinal,
            // Video: HEVC Main profile (iPhone default)
            '-c:v', 'libx265',
            '-preset', 'fast',
            '-crf', '23',
            '-tag:v', 'hvc1',
            '-x265-params', 'log-level=error',
            // Color flags (belt + suspenders with filter above)
            '-color_primaries', 'bt709',
            '-color_trc', 'bt709',
            '-colorspace', 'bt709',
            '-color_range', 'tv',
            // Audio: AAC-LC stereo 44.1kHz (iPhone default)
            '-c:a', 'aac',
            '-b:a', '192k',
            '-ar', '44100',
            '-ac', '2',
            // Prevent FFmpeg from writing its own encoder signature
            '-fflags', '+bitexact',
            '-flags:v', '+bitexact',
            '-flags:a', '+bitexact',
            // Container: QuickTime .mov with faststart
            '-f', 'mov',
            '-movflags', '+faststart+use_metadata_tags',
            '-brand', 'qt  ',
            ...metadata,
            finalOutput,
        ]

        log('Encoding as iPhone HEVC...')

        try {
            await this.deps.runFfmpeg(args, (type, data) => {
                if (data.includes('time=')) {
                    const match = data.match(/time=(\d+):(\d+):(\d+)/)
                    if (match) log(`Progress: ${match[1]}:${match[2]}:${match[3]}`)
                }
            })

            if (!fs.existsSync(finalOutput)) throw new Error('Output file not created')
            this._cleanCompressorName(finalOutput)

            const stats = fs.statSync(finalOutput)
            log(`Done: ${path.basename(finalOutput)} (${(stats.size / 1024 / 1024).toFixed(1)}MB) — ${device.model}, ${device.location.city}`)

            return {
                success: true,
                inputPath,
                outputPath: finalOutput,
                size: stats.size,
                device: { model: device.model, ios: device.ios, city: device.location.city },
            }
        } catch (error) {
            // Fallback: if HEVC fails (libx265 not available), try H.264
            if (error.message && (error.message.includes('libx265') || error.message.includes('Unknown encoder'))) {
                log('HEVC encoder not available, falling back to H.264...')
                const h264Args = args.map(a =>
                    a === 'libx265' ? 'libx264' :
                    a === 'hvc1' ? 'avc1' :
                    a.includes('x265-params') ? null :
                    a === '-x265-params' ? null :
                    a
                ).filter(Boolean)

                try {
                    await this.deps.runFfmpeg(h264Args)
                    if (!fs.existsSync(finalOutput)) throw new Error('Output file not created')
                    this._cleanCompressorName(finalOutput)
                    const stats = fs.statSync(finalOutput)
                    log(`Done (H.264 fallback): ${path.basename(finalOutput)} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`)
                    return { success: true, inputPath, outputPath: finalOutput, size: stats.size }
                } catch (fallbackErr) {
                    log(`Fallback also failed: ${fallbackErr.message}`)
                    return { success: false, inputPath, error: fallbackErr.message }
                }
            }

            log(`Error: ${error.message}`)
            return { success: false, inputPath, error: error.message }
        }
    }

    // Find exiftool — check app bin, then system PATH
    _findExiftool() {
        // 1. App bin folder (dependency manager)
        const appPath = this.deps.getBinaryPath('exiftool')
        if (appPath && fs.existsSync(appPath)) return appPath

        // 2. System PATH
        const { execFileSync } = require('child_process')
        try {
            const cmd = process.platform === 'win32' ? 'where' : 'which'
            const result = execFileSync(cmd, ['exiftool'], { encoding: 'utf-8', timeout: 3000, windowsHide: true }).trim()
            if (result && fs.existsSync(result.split('\n')[0])) return result.split('\n')[0]
        } catch {}

        // 3. Common install locations (Windows)
        const commonPaths = [
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ExifTool', 'exiftool.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ExifTool', 'exiftool(-k).exe'),
            'C:\\Program Files\\ExifTool\\exiftool.exe',
            'C:\\exiftool\\exiftool.exe',
        ]
        for (const p of commonPaths) {
            if (fs.existsSync(p)) return p
        }

        return null
    }

    // Inject EXIF data via exiftool (for images)
    async _injectExif(filePath, device, log) {
        try {
            const exiftoolPath = this._findExiftool()
            if (!exiftoolPath) {
                log('Exiftool not found (install via Settings > Dependencies or add to PATH)')
                return
            }

            const { execFileSync } = require('child_process')
            const dateExif = device.date.toISOString().replace('T', ' ').replace('Z', '').split('.')[0]
            const iso = this.randomInt(50, 800)
            const exposure = ['1/120', '1/60', '1/250', '1/500', '1/1000'][this.randomInt(0, 4)]
            const focalLength = device.lens.split('mm')[0].trim()
            const fNumber = device.lens.split('f/')[1]

            const exifArgs = [
                '-overwrite_original',
                `-Make=Apple`,
                `-Model=${device.model}`,
                `-Software=${device.ios}`,
                `-LensModel=${device.lens}`,
                `-FocalLength=${focalLength}`,
                `-FNumber=${fNumber}`,
                `-ISO=${iso}`,
                `-ExposureTime=${exposure}`,
                `-DateTimeOriginal=${dateExif}`,
                `-CreateDate=${dateExif}`,
                `-ModifyDate=${dateExif}`,
                `-GPSLatitude=${Math.abs(device.gps.lat)}`,
                `-GPSLatitudeRef=${device.gps.lat >= 0 ? 'N' : 'S'}`,
                `-GPSLongitude=${Math.abs(device.gps.lon)}`,
                `-GPSLongitudeRef=${device.gps.lon >= 0 ? 'E' : 'W'}`,
                `-ColorSpace=sRGB`,
                filePath,
            ]

            execFileSync(exiftoolPath, exifArgs, { timeout: 15000, windowsHide: true })
            log(`EXIF injected: ${device.model}, ${device.location.city}, ISO ${iso}`)
        } catch (err) {
            // Non-fatal — image still has FFmpeg metadata
            log(`EXIF injection skipped: ${err.message}`)
        }
    }

    // x265/x264 stamp "Lavc libx265"/"Lavc libx264" into the .mov video sample
    // description's CompressorName — a dead giveaway it was ffmpeg-encoded, not an
    // iPhone (exiftool CAN'T rewrite this field). Binary-patch it in place to the
    // real codec name. Same fixed 32-byte field, so the .mov stays valid.
    _cleanCompressorName(filePath) {
        try {
            const b = fs.readFileSync(filePath)
            let changed = false
            for (const [tell, real] of [['Lavc libx265', 'HEVC'], ['Lavc libx264', 'H.264']]) {
                const t = Buffer.from(tell)
                const i = b.indexOf(t)
                if (i < 0) continue
                b[i - 1] = real.length                 // Pascal length byte precedes the string
                b.write(real, i, 'latin1')
                for (let k = i + real.length; k < i + t.length; k++) b[k] = 0  // zero the leftover
                changed = true
            }
            if (changed) fs.writeFileSync(filePath, b)
            return changed
        } catch { return false }
    }

    // iPhone-authentic output name (IMG_####.MOV / .JPG) — keeping the scraped
    // source filename (creator handle + "reel" + timestamps) contradicts the
    // iPhone metadata we just wrote. Unique within the batch.
    _iphoneFilename(isImage, used) {
        let name
        do { name = `IMG_${this.randomInt(1000, 9999)}${isImage ? '.jpg' : '.mov'}` } while (used.has(name))
        used.add(name)
        return name
    }

    // Process all videos in a folder
    async fingerprintFolder(inputDir, outputDir, options = {}) {
        const { onProgress, onLog } = options
        // Copies: N unique spoofed variants per input (clipping: 1 clip -> many
        // undetectable posts). Each pass re-rolls device/GPS/pitch/crop/etc.
        const copies = Math.max(1, Math.min(100, parseInt(options.copies, 10) || 1))

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true })
        }

        const videoExts = ['.mp4', '.webm', '.mkv', '.mov', '.avi']
        const imageExts = ['.jpg', '.jpeg', '.png', '.webp']
        const allExts = [...videoExts, ...imageExts]
        const files = fs.readdirSync(inputDir)
            .filter(f => allExts.some(ext => f.toLowerCase().endsWith(ext)))
            // Same AppleDouble trap as the templater: `._name.mp4` passes an
            // extension test but is 263 bytes of Mac metadata, not media.
            .filter(f => {
                if (f.startsWith('._') || f === '.DS_Store' || f === 'Thumbs.db') return false
                try {
                    const stat = fs.statSync(path.join(inputDir, f))
                    return stat.isFile() && stat.size >= 1024
                } catch { return false }
            })
            .map(f => path.join(inputDir, f))

        if (files.length === 0) {
            return { success: true, processed: 0, files: [] }
        }

        const results = []
        let completed = 0

        const usedNames = new Set()
        const totalJobs = files.length * copies
        for (const inputPath of files) {
            const isImg = imageExts.includes(path.extname(inputPath).toLowerCase())
            for (let copy = 0; copy < copies; copy++) {
                const outputPath = path.join(outputDir, this._iphoneFilename(isImg, usedNames))

                const result = await this.fingerprint(inputPath, outputPath, {
                    ...options,
                    onLog
                })

                results.push(result)
                completed++

                if (onProgress) {
                    onProgress(Math.round((completed / totalJobs) * 100))
                }
            }
        }

        const successful = results.filter(r => r.success)
        return {
            success: true,
            processed: totalJobs,
            successful: successful.length,
            files: results
        }
    }
}

module.exports = { LocalFingerprinter }
