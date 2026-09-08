// electron/lib/media-mime.js
// ── One extension → MIME map for every phone-facing HTTP response ────
// Why: Chromium/Vanadium files a download under the Content-Type the host
// served it with, and MediaProvider keeps that mime on the MediaStore row.
// Serving a reel as application/octet-stream leaves the row labelled
// application/octet-stream, which the brain's posting guard rejects (a video
// manifest item must have mime_type starting with "video/"). The content
// pipeline emits .mov for every reel, so this was live on every scheduled reel
// (2026-07-26 profile 19 / @a.mroczkowska1996 push failure).
// Mirrors the map python/server.py already uses in upload_to_storage — do not
// invent a second convention.

const path = require('path')

const MEDIA_MIME_TYPES = Object.freeze({
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
})

const DEFAULT_MEDIA_MIME_TYPE = 'application/octet-stream'

function mediaMimeType(filename) {
    const extension = path.extname(String(filename || '')).toLowerCase()
    return MEDIA_MIME_TYPES[extension] || DEFAULT_MEDIA_MIME_TYPE
}

module.exports = { MEDIA_MIME_TYPES, DEFAULT_MEDIA_MIME_TYPE, mediaMimeType }
