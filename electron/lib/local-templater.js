/**
 * ShadowPhone Local Templater
 * On-device port of Brands/Spoofer/templater.py — runs the proven white-frame
 * Template + caption, optional Spoof (fingerprint), and Overlay (composite)
 * pipelines locally with ffmpeg/exiftool (no server, no upload). Sibling to
 * local-fingerprinter.js (which only does the pure Spoof path).
 *
 * The ffmpeg filtergraphs/flags are byte-for-byte equivalent to templater.py —
 * they encode hard-won iPhone-authenticity fixes; do NOT "improve" them.
 *
 * CAPTION LIMITATION: templater.py renders color-emoji captions via PIL
 * (render_caption_png). PIL is not available in Node, so this port uses ONLY
 * templater.py's documented monochrome drawtext FALLBACK (black text). Color
 * emoji are NOT supported locally — accepted limitation.
 */

const path = require('path')
const fs = require('fs')
const { DependencyManager } = require('./dependency-manager')

const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm']

// An extension test alone is not enough. A folder copied from a Mac (or unzipped
// from a Mac-made archive) carries an AppleDouble sidecar `._name.mp4` next to
// every real `name.mp4` — same extension, ~263 bytes of resource-fork metadata,
// not video. ffmpeg opens each one and dies with "Invalid data found when
// processing input". Observed live: "Content Inspo J" held 478 entries = 239
// real videos + 239 sidecars, and because `._` sorts before letters the job
// spent its first 239 items failing 100% before it reached a single real file.
// Also drops the other usual junk and any file too small to be media.
const MIN_MEDIA_BYTES = 1024

function isRealMediaFile(dir, name) {
    if (name.startsWith('._')) return false            // AppleDouble sidecar
    if (name === '.DS_Store' || name === 'Thumbs.db') return false
    try {
        const stat = fs.statSync(path.join(dir, name))
        return stat.isFile() && stat.size >= MIN_MEDIA_BYTES
    } catch { return false }
}
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']

const OVERLAY_POSITIONS = new Set([
    'main-top', 'main-bottom', 'main-left', 'main-right', 'pip-br', 'pip-bl',
])

const DEFAULT_CONFIG = {
    captions: [],
    captionMode: 'sequential',  // single | sequential | random
    applyTemplate: true,
    applyPoof: true,
    fontSize: 66,
    maxCharsPerLine: 24,
    headerHeight: 160,
    topSafeZone: 250,
    outputWidth: 1080,
    outputHeight: 1920,
    overlay: {
        enabled: false,
        mode: 'sequential',     // sequential | random
        position: 'main-top',   // main-top | main-bottom | main-left | main-right | pip-br | pip-bl
        opacity: 100,           // 0-100
        splitRatio: 50,         // 30-70
        clipPaths: [],
    },
}

const IPHONES = ['iPhone 16 Pro Max', 'iPhone 16 Pro', 'iPhone 17 Pro Max', 'iPhone 17 Pro']
const IOS_VERSIONS = ['18.5', '18.4.1', '18.3.1', '18.2.1', '18.5', '18.4', '18.6.1']
// US cities with late-May DST UTC offset (hours) so creationdate TZ matches GPS.
const US_CITIES = [
    [34.0522, -118.2437, -7],  // Los Angeles PDT
    [40.7128, -74.0060, -4],   // New York EDT
    [41.8781, -87.6298, -5],   // Chicago CDT
    [29.7604, -95.3698, -5],   // Houston CDT
    [33.4484, -112.0740, -7],  // Phoenix MST (no DST)
    [32.7767, -96.7970, -5],   // Dallas CDT
    [37.7749, -122.4194, -7],  // San Francisco PDT
    [47.6062, -122.3321, -7],  // Seattle PDT
    [25.7617, -80.1918, -4],   // Miami EDT
    [33.7490, -84.3880, -4],   // Atlanta EDT
    [36.1699, -115.1398, -7],  // Las Vegas PDT
    [39.7392, -104.9903, -6],  // Denver MDT
]

const FFMPEG_TIMEOUT_MS = 300000  // templater.py uses 300s

class LocalTemplater {
    constructor() {
        this.deps = new DependencyManager()
    }

    randFloat(min, max) {
        return Math.random() * (max - min) + min
    }

    randInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min
    }

    round(n, d) {
        const f = Math.pow(10, d)
        return Math.round(n * f) / f
    }

    choice(arr) {
        return arr[Math.floor(Math.random() * arr.length)]
    }

    // --- helpers ported from templater.py -------------------------------------

    // drawtext needs the Windows drive colon escaped: C:/.. -> C\:/..
    ffmpegEscapeFontfile(p) {
        return p.replace(/\\/g, '/').replace(/:/g, '\\:')
    }

    escapeDrawtext(text) {
        // Straight apostrophes break drawtext's single-quoted text='...'. Swap to
        // the typographic apostrophe — renders identically, not a special char.
        return text
            .replace(/'/g, '’')
            .replace(/\\/g, '\\\\')
            .replace(/:/g, '\\:')
            .replace(/%/g, '\\%')
    }

    resolveCaption(captions, mode, index) {
        const valid = (captions || []).filter(c => String(c).trim())
        if (valid.length === 0) return ''
        if (mode === 'random') return this.choice(valid)
        if (mode === 'sequential') return valid[index % valid.length]
        return valid[0]
    }

    // textwrap.wrap(text, width=maxChars) — greedy word wrap by char count.
    textWrap(text, maxChars) {
        if (!text) return []
        const words = text.split(/\s+/).filter(Boolean)
        const lines = []
        let cur = ''
        for (const word of words) {
            const trial = cur ? cur + ' ' + word : word
            if (trial.length <= maxChars || !cur) {
                cur = trial
            } else {
                lines.push(cur)
                cur = word
            }
        }
        if (cur) lines.push(cur)
        return lines
    }

    // Resolve a usable bold font file per platform, else null.
    resolveFontFile() {
        const candidates = process.platform === 'darwin'
            ? [
                '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
                '/Library/Fonts/Arial.ttf',
                '/System/Library/Fonts/Helvetica.ttc',
            ]
            : [
                'C:/Windows/Fonts/arialbd.ttf',
                'C:/Windows/Fonts/arial.ttf',
            ]
        for (const c of candidates) {
            if (fs.existsSync(c)) return c
        }
        return null
    }

    // Run ffmpeg via DependencyManager with a hard timeout so one hung file
    // (e.g. -shortest waiting on a stream that never ends) can't block the batch.
    async runFfmpeg(args, onOutput) {
        let timer
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS / 1000}s`)),
                FFMPEG_TIMEOUT_MS
            )
        })
        try {
            return await Promise.race([this.deps.runFfmpeg(args, onOutput), timeout])
        } finally {
            clearTimeout(timer)
        }
    }

    // No ffprobe binary. `ffmpeg -i <src>` with no output map exits non-zero and
    // REJECTS; the stderr is carried in error.message. Parse it for stream info.
    async probe(src) {
        let info = ''
        try {
            const { stderr } = await this.deps.runFfmpeg(['-i', src])
            info = stderr || ''
        } catch (e) {
            info = (e && e.message) || ''
        }
        return info
    }

    // Source avg frame rate as 'NN/1' so the white canvas matches it — otherwise
    // the color source defaults to 25fps and downsamples the overlay.
    fpsFromProbe(info) {
        let m = info.match(/(\d+(?:\.\d+)?)\s*fps/)
        if (!m) m = info.match(/(\d+(?:\.\d+)?)\s*tbr/)
        if (m) {
            const v = parseFloat(m[1])
            if (v > 0) return `${Math.round(v)}/1`
        }
        return '30/1'
    }

    audioFromProbe(info) {
        return /Stream #\d+:\d+.*: Audio/.test(info)
    }

    buildIphoneMeta() {
        const device = this.choice(IPHONES)
        const software = this.choice(IOS_VERSIONS)
        const [lat0, lon0, offH] = this.choice(US_CITIES)
        const lat = this.round(lat0 + this.randFloat(-0.02, 0.02), 6)
        const lon = this.round(lon0 + this.randFloat(-0.02, 0.02), 6)
        const alt = this.round(this.randFloat(2, 180), 1)
        const inst = new Date(Date.now() - this.randFloat(1, 72) * 3600 * 1000)
        const fmtUtc = (d) => {
            const p = (n) => String(n).padStart(2, '0')
            return `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ` +
                `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
        }
        const localMs = inst.getTime() + offH * 3600 * 1000
        const local = new Date(localMs)
        const fmtLocal = (d) => {
            const p = (n) => String(n).padStart(2, '0')
            return `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ` +
                `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
        }
        const sign = offH >= 0 ? '+' : '-'
        const offStr = `${sign}${String(Math.abs(offH)).padStart(2, '0')}:00`
        const localNaive = fmtLocal(local)
        return {
            device,
            software,
            lat, lon, alt,
            utc_create: fmtUtc(inst),
            utc_modify: fmtUtc(new Date(inst.getTime() + 2000)),
            local_create: localNaive + offStr,
            local_naive: localNaive,
            offset: offStr,
            lens: `${device} back triple camera 6.765mm f/1.78`,
        }
    }

    // --- metadata: video exiftool ---------------------------------------------

    async spoofMetadataVideo(outPath, meta) {
        const args = [
            '-overwrite_original', '-q',
            '-Keys:Make=Apple',
            `-Keys:Model=${meta.device}`,
            `-Keys:Software=${meta.software}`,
            `-Keys:CreationDate=${meta.local_create}`,
            `-Keys:GPSCoordinates=${meta.lat}, ${meta.lon}, ${meta.alt}`,
            `-QuickTime:CreateDate=${meta.utc_create}`,
            `-QuickTime:ModifyDate=${meta.utc_modify}`,
            `-TrackCreateDate=${meta.utc_create}`,
            `-TrackModifyDate=${meta.utc_modify}`,
            `-MediaCreateDate=${meta.utc_create}`,
            `-MediaModifyDate=${meta.utc_modify}`,
            '-XMP:all=', '-Encoder=',
            outPath,
        ]
        try {
            await this.deps.runExiftool(args)
        } catch (e) {
            // Non-fatal — container patch + ffmpeg metadata still applied.
        }
    }

    // --- Apple container byte-patch (pure Buffer, same-length in place) --------

    _qtWalk(buf, start, end, target, out) {
        const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts'])
        let i = start
        while (i + 8 <= end) {
            let size = buf.readUInt32BE(i)
            const typ = buf.toString('latin1', i + 4, i + 8)
            let hdr = 8
            if (size === 1) {
                // 64-bit size at i+8..i+16; high 32 bits assumed 0 (atoms < 4GiB).
                size = buf.readUInt32BE(i + 12)
                hdr = 16
            } else if (size === 0) {
                size = end - i
            }
            if (size < hdr || i + size > end) break
            if (typ === target) out.push([i, size, hdr])
            if (containers.has(typ) || typ === 'stsd') {
                const child = i + hdr + (typ === 'stsd' ? 8 : 0)
                this._qtWalk(buf, child, i + size, target, out)
            }
            i += size
        }
    }

    appleContainerPatch(filePath) {
        // In-place (same-length, no atom resize -> chunk offsets stay valid) patch
        // of fields ffmpeg can't emit, to exact Apple values: ftyp minor_version=0,
        // vmhd graphicsmode=ditherCopy + opcolor=0x8000, avc1 CompressorName='H.264'.
        let buf
        try {
            buf = fs.readFileSync(filePath)
        } catch (e) {
            return
        }
        const ft = []
        this._qtWalk(buf, 0, buf.length, 'ftyp', ft)
        if (ft.length) {
            const mv = ft[0][0] + ft[0][2] + 4
            buf.fill(0, mv, mv + 4)
        }
        const vm = []
        this._qtWalk(buf, 0, buf.length, 'vmhd', vm)
        for (const [off, , hdr] of vm) {
            const p = off + hdr + 4
            const patch = Buffer.from([0x00, 0x40, 0x80, 0x00, 0x80, 0x00, 0x80, 0x00])
            patch.copy(buf, p)
        }
        const av = []
        this._qtWalk(buf, 0, buf.length, 'avc1', av)
        for (const [off] of av) {
            const cn = off + 8 + 42
            const patch = Buffer.alloc(32, 0)
            patch[0] = 5
            patch.write('H.264', 1, 'latin1')
            patch.copy(buf, cn)
        }
        try {
            fs.writeFileSync(filePath, buf)
        } catch (e) {
            // Non-fatal.
        }
    }

    // --- video pipeline -------------------------------------------------------

    async processVideo(src, outPath, caption, cfg, log) {
        const width = cfg.outputWidth, height = cfg.outputHeight
        const fontSize = cfg.fontSize, maxChars = cfg.maxCharsPerLine, headerHeight = cfg.headerHeight
        const applyTemplate = cfg.applyTemplate, poof = cfg.applyPoof
        const fontFilePath = applyTemplate && caption ? this.resolveFontFile() : null
        const fontfile = fontFilePath ? this.ffmpegEscapeFontfile(fontFilePath) : null

        let lines = caption ? this.textWrap(caption, maxChars) : []
        const padding = 20
        const tsz = cfg.topSafeZone || 0
        const vtop = tsz + headerHeight
        const videoW = width - (padding * 2)
        const videoH = height - vtop - padding

        const info = await this.probe(src)
        const fps = this.fpsFromProbe(info)
        const audioPresent = this.audioFromProbe(info)

        const speed = poof ? this.round(this.randFloat(0.98, 1.02), 3) : 1.0
        const brightness = poof ? this.round(this.randFloat(-0.02, 0.02), 3) : 0
        const contrast = poof ? this.round(this.randFloat(0.98, 1.02), 3) : 1.0
        const saturation = poof ? this.round(this.randFloat(0.97, 1.03), 3) : 1.0
        const hue = poof ? this.round(this.randFloat(-3, 3), 1) : 0
        const gamma = poof ? this.round(this.randFloat(0.97, 1.03), 3) : 1.0
        const zoom = poof ? this.round(this.randFloat(1.005, 1.015), 4) : 1.0
        const audioPitch = poof ? this.round(this.randFloat(0.97, 1.03), 3) : 1.0
        const noiseS = poof ? this.randInt(1, 2) : 0
        const crf = poof ? this.randInt(18, 20) : 18

        const parts = [
            `[0:v]setpts=${1 / speed}*PTS[speed]`,
            `[speed]eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}:gamma=${gamma},hue=h=${hue}[color]`,
            `[color]scale=iw*${zoom}:ih*${zoom}:flags=lanczos,crop=iw/${zoom}:ih/${zoom}[zoomed]`,
        ]
        let scaledIn = 'zoomed'
        if (noiseS > 0) {
            parts.push(`[zoomed]noise=c0s=${noiseS}:allf=t[noisy]`)
            scaledIn = 'noisy'
        }

        // Caption: PIL color-emoji path is unavailable in Node, so always use the
        // monochrome drawtext fallback (templater.py lines 385-395).
        if (applyTemplate && caption && lines.length) {
            if (!fontfile) {
                log('WARNING: no usable font file found — applying frame without caption text')
                lines = []
            }
        }

        if (applyTemplate && caption && lines.length) {
            parts.push(
                `[${scaledIn}]scale=${videoW}:${videoH}:force_original_aspect_ratio=decrease:flags=lanczos[scaled]`,
                `color=c=white:s=${width}x${height}:r=${fps}[bg]`,
                `[bg][scaled]overlay=x=${padding}+((${videoW}-overlay_w)/2):y=${vtop}+((${videoH}-overlay_h)/2):shortest=1[canvas]`
            )
            const lineHeight = fontSize + 12
            const startY = Math.max(10, Math.floor((headerHeight - lines.length * lineHeight) / 2))
            let prev = 'canvas'
            for (let i = 0; i < lines.length; i++) {
                const y = startY + (i * lineHeight)
                const nxt = i < lines.length - 1 ? `txt${i}` : 'out'
                parts.push(
                    `[${prev}]drawtext=fontfile='${fontfile}':text='${this.escapeDrawtext(lines[i])}':` +
                    `fontsize=${fontSize}:fontcolor=black:x=(w-text_w)/2:y=${y}[${nxt}]`
                )
                prev = nxt
            }
        } else if (applyTemplate) {
            parts.push(`[${scaledIn}]scale=${videoW}:${videoH}:force_original_aspect_ratio=decrease:flags=lanczos[scaled]`)
            parts.push(`color=c=white:s=${width}x${height}:r=${fps}[bg]`)
            parts.push(
                `[bg][scaled]overlay=x=${padding}+((${videoW}-overlay_w)/2):y=${vtop}+((${videoH}-overlay_h)/2):shortest=1[out]`
            )
        } else {
            parts.push(`[${scaledIn}]null[out]`)
        }

        const meta = this.buildIphoneMeta()

        const cmd = ['-y', '-i', src]
        cmd.push('-filter_complex', parts.join(';'))
        // filter_units=remove_types=6 strips ALL H.264 SEI (the "x264 - core NNN"
        // signature). +bitexact + empty encoder tag remove ffmpeg's library strings.
        cmd.push('-bsf:v', 'filter_units=remove_types=6', '-fflags', '+bitexact', '-flags:v', '+bitexact')
        if (audioPresent) {
            cmd.push(
                '-af', `aresample=48000,asetrate=48000*${audioPitch},aresample=48000,atempo=${this.round(speed / audioPitch, 4)}`,
                '-map', '[out]', '-map', '0:a?',
                '-metadata:s:a:0', 'handler_name=Core Media Audio', '-metadata:s:a:0', 'encoder='
            )
        } else {
            cmd.push('-map', '[out]', '-an')
        }
        cmd.push(
            '-map_metadata', '-1',
            '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.2',
            '-preset', 'fast', '-crf', String(crf),
            '-video_track_timescale', '600',
            '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
            '-metadata:s:v:0', 'handler_name=Core Media Video', '-metadata:s:v:0', 'encoder='
        )
        if (audioPresent) {
            cmd.push('-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '192k', '-ar', '48000')
        }
        cmd.push('-movflags', '+faststart', '-shortest', outPath)

        await this.runFfmpeg(cmd, (type, data) => {
            const m = data.match(/time=(\d+):(\d+):(\d+)/)
            if (m) log(`Progress: ${m[1]}:${m[2]}:${m[3]}`)
        })

        if (!fs.existsSync(outPath)) throw new Error('Output file not created')

        if (poof) await this.spoofMetadataVideo(outPath, meta)
        this.appleContainerPatch(outPath)  // byte-match Apple muxer fields
        return true
    }

    // --- image pipeline -------------------------------------------------------

    async processImage(src, outPath, caption, cfg, log) {
        const width = cfg.outputWidth, height = cfg.outputHeight
        const fontSize = cfg.fontSize, maxChars = cfg.maxCharsPerLine, headerHeight = cfg.headerHeight
        const applyTemplate = cfg.applyTemplate, poof = cfg.applyPoof
        const fontFilePath = applyTemplate && caption ? this.resolveFontFile() : null
        const fontfile = fontFilePath ? this.ffmpegEscapeFontfile(fontFilePath) : null

        let lines = caption ? this.textWrap(caption, maxChars) : []
        const padding = 20
        const tsz = cfg.topSafeZone || 0
        const vtop = tsz + headerHeight
        const imageW = width - (padding * 2)
        const imageH = height - vtop - padding

        const brightness = poof ? this.round(this.randFloat(-0.02, 0.02), 3) : 0
        const contrast = poof ? this.round(this.randFloat(0.98, 1.02), 3) : 1.0
        const saturation = poof ? this.round(this.randFloat(0.97, 1.03), 3) : 1.0
        const hue = poof ? this.round(this.randFloat(-2.5, 2.5), 1) : 0
        const gamma = poof ? this.round(this.randFloat(0.97, 1.03), 3) : 1.0
        const zoom = poof ? this.round(this.randFloat(1.002, 1.012), 4) : 1.0
        const noiseS = poof ? this.randInt(1, 2) : 0

        const parts = [
            `[0:v]eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}:gamma=${gamma},hue=h=${hue}[color]`,
            `[color]scale=iw*${zoom}:ih*${zoom}:flags=lanczos,crop=iw/${zoom}:ih/${zoom}[zoomed]`,
        ]
        let scaledIn = 'zoomed'
        if (noiseS > 0) {
            parts.push(`[zoomed]noise=c0s=${noiseS}:allf=t[noisy]`)
            scaledIn = 'noisy'
        }

        if (applyTemplate && caption && lines.length) {
            if (!fontfile) {
                log('WARNING: no usable font file found — applying frame without caption text')
                lines = []
            }
        }

        if (applyTemplate && caption && lines.length) {
            parts.push(
                `[${scaledIn}]scale=${imageW}:${imageH}:force_original_aspect_ratio=decrease:flags=lanczos[scaled]`,
                `color=c=white:s=${width}x${height}:d=1[bg]`,
                `[bg][scaled]overlay=x=${padding}+((${imageW}-overlay_w)/2):y=${vtop}+((${imageH}-overlay_h)/2):shortest=1[canvas]`
            )
            const lineHeight = fontSize + 12
            const startY = Math.max(10, Math.floor((headerHeight - lines.length * lineHeight) / 2))
            let prev = 'canvas'
            for (let i = 0; i < lines.length; i++) {
                const y = startY + (i * lineHeight)
                const nxt = i < lines.length - 1 ? `txt${i}` : 'out'
                parts.push(
                    `[${prev}]drawtext=fontfile='${fontfile}':text='${this.escapeDrawtext(lines[i])}':` +
                    `fontsize=${fontSize}:fontcolor=black:x=(w-text_w)/2:y=${y}[${nxt}]`
                )
                prev = nxt
            }
        } else if (applyTemplate) {
            parts.push(`[${scaledIn}]scale=${imageW}:${imageH}:force_original_aspect_ratio=decrease:flags=lanczos[scaled]`)
            parts.push(`color=c=white:s=${width}x${height}:d=1[bg]`)
            parts.push(
                `[bg][scaled]overlay=x=${padding}+((${imageW}-overlay_w)/2):y=${vtop}+((${imageH}-overlay_h)/2):shortest=1[out]`
            )
        } else {
            parts.push(`[${scaledIn}]null[out]`)
        }

        const cmd = [
            '-y', '-i', src,
            '-filter_complex', parts.join(';'),
            '-map', '[out]', '-frames:v', '1', '-map_metadata', '-1', '-q:v', '2',
            outPath,
        ]

        await this.runFfmpeg(cmd)
        if (!fs.existsSync(outPath)) throw new Error('Output file not created')

        if (poof) {
            const m = this.buildIphoneMeta()
            const latRef = m.lat >= 0 ? 'N' : 'S'
            const lonRef = m.lon >= 0 ? 'E' : 'W'
            const subsec = String(this.randInt(100, 999))
            try {
                await this.deps.runExiftool([
                    '-overwrite_original', '-q', '-all=',
                    `-DateTimeOriginal=${m.local_naive}`, `-CreateDate=${m.local_naive}`,
                    `-ModifyDate=${m.local_naive}`,
                    `-OffsetTime=${m.offset}`, `-OffsetTimeOriginal=${m.offset}`,
                    `-OffsetTimeDigitized=${m.offset}`, `-SubSecTimeOriginal=${subsec}`,
                    '-Make=Apple', `-Model=${m.device}`, `-Software=${m.software}`,
                    '-LensMake=Apple', `-LensModel=${m.lens}`,
                    '-LensInfo=6.764999866-15.65999985mm f/1.779999971-2.8',
                    '-Orientation#=1', '-ColorSpace=sRGB', '-ExifIFD:ColorSpace=sRGB',
                    `-GPSLatitude=${Math.abs(m.lat).toFixed(6)}`, `-GPSLatitudeRef=${latRef}`,
                    `-GPSLongitude=${Math.abs(m.lon).toFixed(6)}`, `-GPSLongitudeRef=${lonRef}`,
                    `-GPSAltitude=${m.alt}`, '-GPSAltitudeRef=0',
                    outPath,
                ])
            } catch (e) {
                // Non-fatal — image still carries ffmpeg output.
            }
        }
        return true
    }

    // --- overlay compositing (runs BEFORE template+poof) ----------------------

    async applyOverlay(mainPath, overlayPath, outPath, width, height, position, opacity, splitRatio, log) {
        opacity = Math.max(0, Math.min(100, parseInt(opacity, 10)))
        splitRatio = Math.max(30, Math.min(70, parseInt(splitRatio, 10)))
        const mainRatio = splitRatio / 100.0
        const opacityF = opacity / 100.0
        if (!OVERLAY_POSITIONS.has(position)) position = 'main-top'

        const NORM = ',fps=30,setsar=1,format=yuv420p'
        const NORM_ALPHA = ',fps=30,setsar=1,format=yuva420p'

        let parts
        if (position === 'main-top' || position === 'main-bottom') {
            const mainH = Math.floor(height * mainRatio / 2) * 2
            const overlayH = height - mainH
            parts = [
                `[0:v]scale=${width}:${mainH}:force_original_aspect_ratio=decrease,` +
                `pad=${width}:${mainH}:(ow-iw)/2:(oh-ih)/2:color=black${NORM}[main]`,
                `[1:v]scale=${width}:${overlayH}:force_original_aspect_ratio=decrease,` +
                `pad=${width}:${overlayH}:(ow-iw)/2:(oh-ih)/2:color=black${NORM}[overlay_raw]`,
            ]
            if (opacity < 100) {
                parts.push(
                    `color=black:s=${width}x${overlayH}${NORM}[ov_bg]`,
                    `[overlay_raw]format=yuva420p,colorchannelmixer=aa=${opacityF}[ov_alpha]`,
                    `[ov_bg][ov_alpha]overlay=0:0:shortest=1:format=auto,format=yuv420p[overlay]`
                )
            } else {
                parts.push('[overlay_raw]null[overlay]')
            }
            parts.push(
                position === 'main-top'
                    ? '[main][overlay]vstack=inputs=2[out]'
                    : '[overlay][main]vstack=inputs=2[out]'
            )
        } else if (position === 'main-left' || position === 'main-right') {
            const mainW = Math.floor(width * mainRatio / 2) * 2
            const overlayW = width - mainW
            parts = [
                `[0:v]scale=${mainW}:${height}:force_original_aspect_ratio=decrease,` +
                `pad=${mainW}:${height}:(ow-iw)/2:(oh-ih)/2:color=black${NORM}[main]`,
                `[1:v]scale=${overlayW}:${height}:force_original_aspect_ratio=decrease,` +
                `pad=${overlayW}:${height}:(ow-iw)/2:(oh-ih)/2:color=black${NORM}[overlay_raw]`,
            ]
            if (opacity < 100) {
                parts.push(
                    `color=black:s=${overlayW}x${height}${NORM}[ov_bg]`,
                    `[overlay_raw]format=yuva420p,colorchannelmixer=aa=${opacityF}[ov_alpha]`,
                    `[ov_bg][ov_alpha]overlay=0:0:shortest=1:format=auto,format=yuv420p[overlay]`
                )
            } else {
                parts.push('[overlay_raw]null[overlay]')
            }
            parts.push(
                position === 'main-left'
                    ? '[main][overlay]hstack=inputs=2[out]'
                    : '[overlay][main]hstack=inputs=2[out]'
            )
        } else {  // pip-br | pip-bl
            const pipW = Math.floor(width * 0.25 / 2) * 2
            const pipH = Math.floor(height * 0.25 / 2) * 2
            const pad = 20
            const xExpr = position === 'pip-br' ? `W-w-${pad}` : String(pad)
            const yExpr = `H-h-${pad}`
            parts = [
                `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
                `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black${NORM}[main]`,
                `[1:v]scale=${pipW}:${pipH}:force_original_aspect_ratio=decrease${NORM_ALPHA}[pip_raw]`,
            ]
            parts.push(opacity < 100
                ? `[pip_raw]colorchannelmixer=aa=${opacityF}[pip]`
                : '[pip_raw]null[pip]')
            parts.push(`[main][pip]overlay=${xExpr}:${yExpr}:shortest=1:format=auto[out]`)
        }

        const cmd = [
            '-y', '-i', mainPath,
            '-stream_loop', '-1', '-i', overlayPath,
            '-filter_complex', parts.join(';'),
            '-map', '[out]', '-map', '0:a?',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
            '-movflags', '+faststart', '-shortest',
            outPath,
        ]
        await this.runFfmpeg(cmd)
        if (!fs.existsSync(outPath)) throw new Error('Overlay output not created')
        return true
    }

    // --- folder driver --------------------------------------------------------

    async processFolder(inputDir, outputDir, config = {}, options = {}) {
        const { onProgress, onLog } = options
        const log = (msg) => {
            console.log(`[Templater] ${msg}`)
            if (onLog) onLog(msg)
        }

        // Merge config over defaults (overlay merged separately for partial keys).
        const cfg = { ...DEFAULT_CONFIG, ...config }
        cfg.overlay = { ...DEFAULT_CONFIG.overlay, ...(config.overlay || {}) }

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true })
        }

        const allExts = [...VIDEO_EXTS, ...IMAGE_EXTS]
        const files = fs.readdirSync(inputDir)
            .filter(f => allExts.some(ext => f.toLowerCase().endsWith(ext)))
            .filter(f => isRealMediaFile(inputDir, f))
            .sort()
            .map(f => path.join(inputDir, f))

        if (files.length === 0) {
            return {
                success: false,
                partial: false,
                processed: 0,
                successful: 0,
                failed: 0,
                error: 'No supported media files found in the input folder',
                files: [],
            }
        }

        const overlayEnabled = !!(cfg.overlay.enabled && (cfg.overlay.clipPaths || []).length)
        if (cfg.overlay.enabled && !overlayEnabled) {
            log('Overlay enabled but no clipPaths provided — skipping overlay.')
        }

        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/(\d{8})(\d{6})/, '$1_$2')
        const tmpDir = path.join(outputDir, '_tmp')

        const results = []
        let completed = 0
        // Copies: N unique variants per input (clipping workflow).
        const copies = Math.max(1, Math.min(100, parseInt(config.copies, 10) || 1))
        const totalJobs = files.length * copies

        for (let idx = 0; idx < files.length; idx++) {
            const src = files[idx]
            const filename = path.basename(src)
            const ext = path.extname(src).toLowerCase()
            const stem = path.basename(src, path.extname(src))
            const isImage = IMAGE_EXTS.includes(ext)
            const outExt = isImage ? '.jpg' : '.mov'
          for (let copy = 0; copy < copies; copy++) {
            const outPath = path.join(outputDir, `templated_${stamp}_${idx + 1}_${copies > 1 ? `c${copy + 1}_` : ''}${stem}${outExt}`)

            const caption = cfg.applyTemplate
                ? this.resolveCaption(cfg.captions, cfg.captionMode, idx)
                : ''
            log(`[${idx + 1}/${files.length}] ${filename}${caption ? `  "${caption.slice(0, 40)}"` : ''}`)

            let videoSrc = src
            let tmpOverlay = null
            const result = { success: false, inputPath: src, outputPath: outPath, error: null }

            try {
                // Overlay (videos only) runs first, feeding template+spoof.
                if (overlayEnabled && !isImage) {
                    const clip = cfg.overlay.mode === 'random'
                        ? this.choice(cfg.overlay.clipPaths)
                        : cfg.overlay.clipPaths[idx % cfg.overlay.clipPaths.length]
                    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
                    tmpOverlay = path.join(tmpDir, `ov_${idx + 1}_${stem}.mp4`)
                    log(`    overlay <- ${path.basename(clip)} (${cfg.overlay.position})`)
                    await this.applyOverlay(
                        src, clip, tmpOverlay, cfg.outputWidth, cfg.outputHeight,
                        cfg.overlay.position, cfg.overlay.opacity, cfg.overlay.splitRatio, log
                    )
                    videoSrc = tmpOverlay
                }

                if (isImage) {
                    await this.processImage(src, outPath, caption, cfg, log)
                } else {
                    await this.processVideo(videoSrc, outPath, caption, cfg, log)
                }

                if (fs.existsSync(outPath)) {
                    result.success = true
                    const stats = fs.statSync(outPath)
                    log(`    done: ${path.basename(outPath)} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`)
                } else {
                    result.error = 'Output file not created'
                    log(`    FAILED: ${filename}`)
                }
            } catch (e) {
                result.error = e.message
                log(`    ERROR on ${filename}: ${e.message}`)
            } finally {
                if (tmpOverlay && fs.existsSync(tmpOverlay)) {
                    try { fs.unlinkSync(tmpOverlay) } catch (_) {}
                }
            }

            results.push(result)
            completed++
            if (onProgress) onProgress(Math.round((completed / totalJobs) * 100))
          }
        }

        if (fs.existsSync(tmpDir)) {
            try { fs.rmdirSync(tmpDir) } catch (_) {}
        }

        const successful = results.filter(r => r.success)
        const failed = results.length - successful.length
        return {
            success: failed === 0,
            partial: successful.length > 0 && failed > 0,
            processed: totalJobs,
            successful: successful.length,
            failed,
            error: failed === 0 ? null : `${failed} of ${totalJobs} jobs failed`,
            files: results,
        }
    }
}

module.exports = { LocalTemplater, DEFAULT_CONFIG }
