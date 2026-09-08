/**
 * content-counter.js — per-account content inventory for the Models Dashboard.
 *
 * Counts the media files inside one IG account folder:
 *   Content/phones/<phone>/profiles/<profile>/instagram/<account>/<subfolders>
 * Active (un-posted) media lives in images/videos/reels/trial_reels/stories;
 * posted media rotates into used_<type>/ (see content-paths.js PLATFORM_SUBFOLDERS
 * + executor/media.js move_to_used). reels INCLUDES trial_reels per the dashboard
 * contract. Tolerant of missing folders (=> 0). Phone-free, pure fs.
 */
'use strict'
const fs = require('fs')
const path = require('path')

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm'])
const MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS])

// Active media subfolders that make up `remaining`. reels = reels + trial_reels.
const ACTIVE_SUBFOLDERS = {
    images:  ['images'],
    videos:  ['videos'],
    reels:   ['reels', 'trial_reels'],
    stories: ['stories'],
}
// Posted media subfolders summed into `posted`.
const USED_SUBFOLDERS = [
    'used_images', 'used_videos', 'used_reels', 'used_trial_reels', 'used_stories',
]

// Count media files directly inside <accountDir>/<sub>. Missing folder => 0.
// Ignores dotfiles, _meta.json, subdirectories, and non-media extensions.
async function countFolder(accountDir, sub) {
    const dir = path.join(accountDir, sub)
    let entries
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch (_) {
        return 0
    }
    let n = 0
    for (const e of entries) {
        if (!e.isFile()) continue
        const name = e.name
        if (name.startsWith('.')) continue
        if (name === '_meta.json') continue
        if (MEDIA_EXTS.has(path.extname(name).toLowerCase())) n++
    }
    return n
}

// Sum countFolder over a list of subfolders (in parallel). reduce-sum is
// commutative so Promise.all array order doesn't affect the total.
async function _sumFolders(accountDir, subs) {
    const counts = await Promise.all(subs.map((f) => countFolder(accountDir, f)))
    return counts.reduce((s, x) => s + x, 0)
}

async function countPerAccount(accountDir) {
    const [images, videos, reels, stories, posted] = await Promise.all([
        _sumFolders(accountDir, ACTIVE_SUBFOLDERS.images),
        _sumFolders(accountDir, ACTIVE_SUBFOLDERS.videos),
        _sumFolders(accountDir, ACTIVE_SUBFOLDERS.reels),
        _sumFolders(accountDir, ACTIVE_SUBFOLDERS.stories),
        _sumFolders(accountDir, USED_SUBFOLDERS),
    ])
    const remaining = images + videos + reels + stories
    return { images, videos, reels, stories, remaining, posted, lowContent: remaining < 5 }
}

const _cache = new Map() // cacheKey -> { at:<ms>, counts }

async function countPerAccountCached(cacheKey, accountDir, ttlMs = 30000) {
    const hit = _cache.get(cacheKey)
    if (hit && (Date.now() - hit.at) < ttlMs) return hit.counts
    const counts = await countPerAccount(accountDir)
    _cache.set(cacheKey, { at: Date.now(), counts })
    return counts
}

function _zero() {
    return { images: 0, videos: 0, reels: 0, stories: 0, remaining: 0, posted: 0, lowContent: true }
}
function _hasMedia(c) { return (c.remaining + c.posted) > 0 }

// Legacy FLAT layout: <contentRoot>/instagram/<account>. Content predating the
// nested phones/profiles tree lives here (e.g. Content/Instagram/eileenswrld).
// account is lowercased to match ensureAccountScaffold's on-disk convention.
async function countPerAccountFlat(contentRoot, account) {
    if (!contentRoot) return _zero()
    return countPerAccount(path.join(contentRoot, 'instagram', String(account || '').toLowerCase()))
}

// Best-of resolver for the Models Dashboard: prefer the nested account dir when it
// has media, else fall back to the flat legacy dir, else return the (zero) result
// so a genuinely-empty account (detect_accounts found it but it has no content
// anywhere) correctly stays 0 instead of borrowing another layout's numbers.
async function countBest(contentRoot, nestedAccountDir, account) {
    const nested = nestedAccountDir ? await countPerAccount(nestedAccountDir) : _zero()
    if (_hasMedia(nested)) return nested
    const flat = await countPerAccountFlat(contentRoot, account)
    return _hasMedia(flat) ? flat : nested
}

module.exports = { countPerAccount, countPerAccountCached, countPerAccountFlat, countBest }
