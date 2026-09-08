const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

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

function normalizeUsername(raw) {
  if (!raw) return null
  const trimmed = String(raw).trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`)
    const pathParts = parsed.pathname.split('/').filter(Boolean)
    const profilePart = pathParts.find(part => part.startsWith('@'))
    if (profilePart) {
      const normalized = profilePart.replace(/^@/, '').trim().toLowerCase()
      return normalized || null
    }
  } catch {
    // Ignore URL parse failures and fall back to direct username parsing.
  }

  const direct = trimmed.replace(/^@/, '').split(/[/?#]/)[0].trim().toLowerCase()
  if (!direct) return null
  if (!/^[a-z0-9._]+$/i.test(direct)) return null
  return direct
}

function normalizeSoundKey(track, artist) {
  const safeTrack = String(track || 'unknown sound').trim().toLowerCase()
  const safeArtist = String(artist || 'unknown artist').trim().toLowerCase()
  return `${safeTrack}:::${safeArtist}`
}

function formatSoundLabel(track, artist) {
  const safeTrack = String(track || 'Unknown sound').trim()
  const safeArtist = String(artist || '').trim()
  return safeArtist ? `${safeTrack} - ${safeArtist}` : safeTrack
}

function normalizeTrack(track) {
  return String(track || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function isOriginalSound(track) {
  const normalized = normalizeTrack(track)
  return [
    'original sound',
    'suono originale',
    'originalton',
    'son original',
    'som original',
    'original audio',
  ].some(token => normalized.startsWith(token))
}

function extractHashtags(text) {
  const matches = String(text || '').match(/#[\p{L}\p{N}_]+/gu) || []
  return Array.from(new Set(matches.map(tag => tag.toLowerCase())))
}

function median(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2
  }
  return sorted[middle]
}

function isDirectMediaUrl(url) {
  if (!url || typeof url !== 'string') return false
  if (!/^https?:\/\//i.test(url)) return false
  return !/tiktok\.com\/@/i.test(url)
}

function resolveThumbnailUrl(payload) {
  if (typeof payload?.thumbnail === 'string' && payload.thumbnail) return payload.thumbnail
  const thumbnails = Array.isArray(payload?.thumbnails) ? payload.thumbnails : []
  for (const entry of thumbnails) {
    if (entry && typeof entry === 'object' && typeof entry.url === 'string' && entry.url) {
      return entry.url
    }
  }
  return null
}

function resolveDirectMediaUrl(payload) {
  if (isDirectMediaUrl(payload?.url)) {
    return payload.url
  }

  const formats = Array.isArray(payload?.formats) ? payload.formats : []
  const candidates = formats
    .filter((format) => format && typeof format === 'object' && typeof format.url === 'string' && isDirectMediaUrl(format.url))
    .map((format) => ({
      url: format.url,
      height: Number(format.height || 0),
      width: Number(format.width || 0),
      tbr: Number(format.tbr || 0),
      vcodec: String(format.vcodec || ''),
      ext: String(format.ext || ''),
      protocol: String(format.protocol || ''),
    }))
    .filter((format) => format.vcodec !== 'none')
    .sort((a, b) => {
      const aScore = (a.height * 4) + (a.width * 2) + a.tbr + (a.ext === 'mp4' ? 50 : 0) + (a.protocol.includes('m3u8') ? -100 : 0)
      const bScore = (b.height * 4) + (b.width * 2) + b.tbr + (b.ext === 'mp4' ? 50 : 0) + (b.protocol.includes('m3u8') ? -100 : 0)
      return bScore - aScore
    })

  return candidates[0]?.url || null
}

class TikTokTrendFinder {
  constructor({ dependencyManager, app }) {
    this.dependencyManager = dependencyManager
    this.app = app
  }

  getRootDir() {
    return path.join(this.app.getPath('userData'), 'trend-finder', 'tiktok')
  }

  getSnapshotsDir() {
    return path.join(this.getRootDir(), 'snapshots')
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

  async runYtDlpJson(args) {
    const ytdlpPath = this.getYtDlpPath()

    return new Promise((resolve, reject) => {
      const child = spawn(ytdlpPath, args, {
        windowsHide: true,
        env: { ...process.env },
      })

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('error', (error) => {
        reject(error)
      })

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`))
          return
        }

        try {
          resolve(JSON.parse(stdout.trim()))
        } catch (error) {
          reject(new Error(`Could not parse yt-dlp output: ${error.message}`))
        }
      })
    })
  }

  async runYtDlpProfile(username, postsPerCreator) {
    const profileUrl = `https://www.tiktok.com/@${username}`
    return this.runYtDlpJson([
      '--flat-playlist',
      '--dump-single-json',
      '--playlist-end',
      String(postsPerCreator),
      '--skip-download',
      '--no-warnings',
      '--ignore-errors',
      '--extractor-args',
      'TikTokUser:tab=videos',
      profileUrl,
    ])
  }

  async runYtDlpVideoDetails(videoUrl) {
    return this.runYtDlpJson([
      '--dump-single-json',
      '--skip-download',
      '--no-warnings',
      '--ignore-errors',
      videoUrl,
    ])
  }

  buildCreator(payload) {
    const entries = Array.isArray(payload?.entries) ? payload.entries : []
    const username = normalizeUsername(payload?.uploader_url || payload?.webpage_url || payload?.title)
      || normalizeUsername(payload?.title)
      || 'unknown'

    const videos = entries
      .map(entry => {
        const track = String(entry.track || 'Original sound').trim()
        const artist = Array.isArray(entry.artists) && entry.artists.length > 0
          ? String(entry.artists[0] || '').trim()
          : String(entry.artist || entry.channel || entry.uploader || '').trim()
        const timestamp = Number(entry.timestamp || 0)
        const views = Number(entry.view_count || 0)
        const likes = Number(entry.like_count || 0)
        const comments = Number(entry.comment_count || 0)
        const reposts = Number(entry.repost_count || 0)
        const saves = Number(entry.save_count || 0)
        return {
          id: String(entry.id || ''),
          url: String(entry.url || ''),
          mediaUrl: null,
          creatorUsername: username,
          creatorDisplayName: String(entry.channel || entry.uploader || payload?.title || username),
          creatorProfileUrl: `https://www.tiktok.com/@${username}`,
          title: String(entry.title || ''),
          description: String(entry.description || ''),
          track,
          artist,
          soundKey: normalizeSoundKey(track, artist),
          soundLabel: formatSoundLabel(track, artist),
          isOriginalSound: isOriginalSound(track),
          duration: Number(entry.duration || 0),
          timestamp,
          postedAt: timestamp ? new Date(timestamp * 1000).toISOString() : null,
          views,
          likes,
          comments,
          reposts,
          saves,
          thumbnails: Array.isArray(entry.thumbnails) ? entry.thumbnails : [],
          hashtags: extractHashtags(entry.description || entry.title || ''),
        }
      })
      .filter(video => video.id && video.url)

    const viewValues = videos.map(video => video.views).filter(value => value > 0)
    const averageViews = viewValues.length
      ? viewValues.reduce((sum, value) => sum + value, 0) / viewValues.length
      : 0
    const medianViews = median(viewValues)

    const nowSeconds = Math.floor(Date.now() / 1000)
    const recentWindow = nowSeconds - (7 * 24 * 60 * 60)
    const videosLast7Days = videos.filter(video => (video.timestamp || 0) >= recentWindow).length

    return {
      username,
      displayName: String(payload?.title || videos[0]?.creatorDisplayName || username),
      profileUrl: String(payload?.webpage_url || `https://www.tiktok.com/@${username}`),
      totalVisiblePosts: Number(payload?.playlist_count || videos.length || 0),
      scrapedPosts: videos.length,
      averageViews,
      medianViews,
      videosLast7Days,
      videos,
    }
  }

  computeSnapshot(creators, options) {
    const generatedAt = new Date().toISOString()
    const videoRows = []
    const soundMap = new Map()
    const hashtagMap = new Map()

    for (const creator of creators) {
      const baseline = creator.averageViews || creator.medianViews || 1
      for (const video of creator.videos) {
        const ageHours = video.timestamp
          ? Math.max(1, (Date.now() - (video.timestamp * 1000)) / (1000 * 60 * 60))
          : 999
        const recencyWeight = Math.max(0.22, 1 - Math.min(ageHours, 14 * 24) / (14 * 24))
        const creatorLift = baseline > 0 ? video.views / baseline : 0
        const engagementRate = video.views > 0
          ? (video.likes + (video.comments * 3) + (video.reposts * 2) + video.saves) / video.views
          : 0
        const rawViewSignal = Math.min(12, Math.log10(Math.max(video.views, 1)) * 2.6)
        const freshnessBoost = ageHours <= 24 ? 8 : ageHours <= 72 ? 4 : 0
        const viralityScore = (
          rawViewSignal +
          (creatorLift * 24) +
          (engagementRate * 320) +
          freshnessBoost
        ) * recencyWeight

        const enrichedVideo = {
          ...video,
          creatorAverageViews: baseline,
          creatorLift,
          engagementRate,
          ageHours,
          rawViewSignal,
          freshnessBoost,
          viralityScore,
        }
        videoRows.push(enrichedVideo)

        const soundEntry = soundMap.get(video.soundKey) || {
          key: video.soundKey,
          label: video.soundLabel,
          track: video.track,
          artist: video.artist,
          isOriginalSound: video.isOriginalSound,
          occurrences: 0,
          uniqueCreators: new Set(),
          totalViews: 0,
          totalScore: 0,
          latestTimestamp: 0,
          topVideo: null,
          avgLiftAccumulator: 0,
        }
        soundEntry.occurrences += 1
        soundEntry.uniqueCreators.add(video.creatorUsername)
        soundEntry.totalViews += video.views
        soundEntry.totalScore += viralityScore
        soundEntry.avgLiftAccumulator += creatorLift
        soundEntry.latestTimestamp = Math.max(soundEntry.latestTimestamp, video.timestamp || 0)
        if (!soundEntry.topVideo || viralityScore > soundEntry.topVideo.viralityScore) {
          soundEntry.topVideo = enrichedVideo
        }
        soundMap.set(video.soundKey, soundEntry)

        for (const hashtag of video.hashtags) {
          const hashtagEntry = hashtagMap.get(hashtag) || {
            tag: hashtag,
            occurrences: 0,
            uniqueCreators: new Set(),
            totalViews: 0,
            totalScore: 0,
          }
          hashtagEntry.occurrences += 1
          hashtagEntry.uniqueCreators.add(video.creatorUsername)
          hashtagEntry.totalViews += video.views
          hashtagEntry.totalScore += viralityScore
          hashtagMap.set(hashtag, hashtagEntry)
        }
      }
    }

    const topSounds = Array.from(soundMap.values())
      .map(entry => {
        const uniqueCreatorCount = entry.uniqueCreators.size
        const avgLift = entry.occurrences > 0 ? entry.avgLiftAccumulator / entry.occurrences : 0
        const originalPenalty = entry.isOriginalSound && uniqueCreatorCount < 2 ? 0.35 : 1
        const score = (
          (entry.totalScore * 0.72) +
          (uniqueCreatorCount * 24) +
          (entry.occurrences * 7) +
          (avgLift * 18)
        ) * originalPenalty

        const momentumBand =
          score >= 180 ? 'Breakout' :
          score >= 110 ? 'Rising Fast' :
          score >= 60 ? 'Watchlist' :
          'Early'

        return {
          key: entry.key,
          label: entry.label,
          track: entry.track,
          artist: entry.artist,
          isOriginalSound: entry.isOriginalSound,
          occurrences: entry.occurrences,
          uniqueCreators: uniqueCreatorCount,
          totalViews: entry.totalViews,
          avgLift,
          score,
          momentumBand,
          latestAt: entry.latestTimestamp ? new Date(entry.latestTimestamp * 1000).toISOString() : null,
          topVideo: entry.topVideo,
        }
      })
      .filter(sound => {
        if (!options.includeOriginalSounds && sound.isOriginalSound && sound.uniqueCreators < 2) {
          return false
        }
        return sound.totalViews >= options.minViews
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 36)

    const topVideos = [...videoRows]
      .filter(video => video.views >= options.minViews)
      .sort((a, b) => {
        const aScore = (a.viralityScore * 1.08) + (a.creatorLift * 16) + (a.engagementRate * 140)
        const bScore = (b.viralityScore * 1.08) + (b.creatorLift * 16) + (b.engagementRate * 140)
        return bScore - aScore
      })
      .slice(0, 60)

    const topCreators = creators
      .map(creator => {
        const creatorVideos = videoRows.filter(video => video.creatorUsername === creator.username)
        const breakoutCount = creatorVideos.filter(video => video.creatorLift >= 1.5).length
        const freshVideoCount = creatorVideos.filter(video => video.ageHours <= 72).length
        const totalViews = creatorVideos.reduce((sum, video) => sum + video.views, 0)
        const avgLift = creatorVideos.length
          ? creatorVideos.reduce((sum, video) => sum + video.creatorLift, 0) / creatorVideos.length
          : 0
        const avgEngagementRate = creatorVideos.length
          ? creatorVideos.reduce((sum, video) => sum + video.engagementRate, 0) / creatorVideos.length
          : 0
        const breakoutRate = creatorVideos.length ? breakoutCount / creatorVideos.length : 0
        const freshnessRate = creatorVideos.length ? freshVideoCount / creatorVideos.length : 0
        const healthScore = (
          (avgLift * 28) +
          (avgEngagementRate * 260) +
          (breakoutRate * 34) +
          (freshnessRate * 18) +
          (Math.min(creator.videosLast7Days, 14) * 2.5) +
          (Math.log10(Math.max(creator.averageViews, 1)) * 3.5)
        )
        return {
          username: creator.username,
          displayName: creator.displayName,
          profileUrl: creator.profileUrl,
          scrapedPosts: creator.scrapedPosts,
          totalVisiblePosts: creator.totalVisiblePosts,
          averageViews: creator.averageViews,
          medianViews: creator.medianViews,
          videosLast7Days: creator.videosLast7Days,
          breakoutCount,
          freshVideoCount,
          avgCreatorLift: avgLift,
          avgEngagementRate,
          breakoutRate,
          totalViews,
          healthScore,
        }
      })
      .sort((a, b) => b.healthScore - a.healthScore)
      .slice(0, 36)

    const topHashtags = Array.from(hashtagMap.values())
      .map(entry => ({
        tag: entry.tag,
        occurrences: entry.occurrences,
        uniqueCreators: entry.uniqueCreators.size,
        totalViews: entry.totalViews,
        score: (entry.totalScore * 0.68) + (entry.uniqueCreators.size * 16) + (entry.occurrences * 4),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)

    const breakoutVideoCount = videoRows.filter(video => video.creatorLift >= 1.5).length
    const freshVideoCount = videoRows.filter(video => video.ageHours <= 72).length
    const multiCreatorSoundCount = topSounds.filter(sound => sound.uniqueCreators >= 2).length
    const averageEngagementRate = videoRows.length
      ? videoRows.reduce((sum, video) => sum + video.engagementRate, 0) / videoRows.length
      : 0

    return {
      generatedAt,
      config: {
        postsPerCreator: options.postsPerCreator,
        maxCreators: options.maxCreators,
        minViews: options.minViews,
        includeOriginalSounds: options.includeOriginalSounds,
      },
      summary: {
        creatorCount: creators.length,
        videoCount: videoRows.length,
        soundCount: soundMap.size,
        hashtagCount: hashtagMap.size,
        seedCount: options.seedCount,
        breakoutVideoCount,
        freshVideoCount,
        multiCreatorSoundCount,
        failedCreatorCount: options.failedCreators.length,
        averageEngagementRate,
      },
      creators: topCreators,
      topVideos,
      topSounds,
      topHashtags,
      failedCreators: options.failedCreators,
    }
  }

  async enrichTopVideosWithMedia(topVideos, onLog) {
    const enriched = []

    for (const video of topVideos) {
      if (!video?.url) {
        enriched.push(video)
        continue
      }

      try {
        const payload = await this.runYtDlpVideoDetails(video.url)
        const mediaUrl = resolveDirectMediaUrl(payload)
        const thumbnailUrl = resolveThumbnailUrl(payload) || video.thumbnailUrl || video.thumbnails?.[0]?.url || null
        enriched.push({
          ...video,
          mediaUrl,
          thumbnailUrl,
          thumbnails: thumbnailUrl ? [{ url: thumbnailUrl }] : (Array.isArray(video.thumbnails) ? video.thumbnails : []),
        })
      } catch (error) {
        this.emitLog(onLog, `Could not resolve media for ${video.url}: ${error.message || error}`, 'warn')
        enriched.push(video)
      }
    }

    return enriched
  }

  saveSnapshot(snapshot) {
    const snapshotsDir = this.getSnapshotsDir()
    ensureDir(snapshotsDir)
    const fileName = `tiktok_trends_${formatDateForFile()}.json`
    const fullPath = path.join(snapshotsDir, fileName)
    fs.writeFileSync(fullPath, JSON.stringify(snapshot, null, 2), 'utf8')
    return fullPath
  }

  async run(config = {}, callbacks = {}) {
    const onProgress = callbacks.onProgress
    const onLog = callbacks.onLog
    const postsPerCreator = clampInt(config.postsPerCreator, 3, 40, 12)
    const maxCreators = clampInt(config.maxCreators, 1, 250, 180)
    const minViews = clampInt(config.minViews, 0, 1000000000, 0)
    const includeOriginalSounds = Boolean(config.includeOriginalSounds)

    const manualSeeds = Array.isArray(config.manualSeeds)
      ? config.manualSeeds.map(normalizeUsername).filter(Boolean)
      : []

    const seeds = Array.from(new Set(manualSeeds)).slice(0, maxCreators)
    if (!seeds.length) {
      throw new Error('Add at least one TikTok creator username to the shared watchlist before running the scan.')
    }

    this.emitLog(onLog, `Scanning ${seeds.length} TikTok creator${seeds.length === 1 ? '' : 's'} locally with yt-dlp.`)
    this.emitProgress(onProgress, {
      type: 'run_start',
      totalCreators: seeds.length,
      postsPerCreator,
    })

    const creators = []
    const failedCreators = []

    for (let index = 0; index < seeds.length; index += 1) {
      const username = seeds[index]
      this.emitProgress(onProgress, {
        type: 'creator_start',
        current: index + 1,
        totalCreators: seeds.length,
        username,
      })
      this.emitLog(onLog, `Fetching @${username} (${index + 1}/${seeds.length})`)

      try {
        const payload = await this.runYtDlpProfile(username, postsPerCreator)
        const creator = this.buildCreator(payload)
        creators.push(creator)
        this.emitProgress(onProgress, {
          type: 'creator_complete',
          current: index + 1,
          totalCreators: seeds.length,
          username,
          videos: creator.scrapedPosts,
        })
        this.emitLog(onLog, `Scraped ${creator.scrapedPosts} posts from @${username}.`)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown scrape error'
        failedCreators.push({ username, error: message })
        this.emitProgress(onProgress, {
          type: 'creator_error',
          current: index + 1,
          totalCreators: seeds.length,
          username,
          error: message,
        })
        this.emitLog(onLog, `Failed to scrape @${username}: ${message}`, 'error')
      }
    }

    const snapshot = this.computeSnapshot(creators, {
      postsPerCreator,
      maxCreators,
      minViews,
      includeOriginalSounds,
      seedCount: seeds.length,
      failedCreators,
    })

    snapshot.topVideos = await this.enrichTopVideosWithMedia(snapshot.topVideos, onLog)
    const mediaLookup = new Map(snapshot.topVideos.map((video) => [video.id, video]))
    snapshot.topSounds = snapshot.topSounds.map((sound) => ({
      ...sound,
      topVideo: sound.topVideo?.id ? mediaLookup.get(sound.topVideo.id) || sound.topVideo : sound.topVideo,
    }))

    const snapshotPath = this.saveSnapshot(snapshot)

    this.emitProgress(onProgress, {
      type: 'run_complete',
      totalCreators: seeds.length,
      completedCreators: creators.length,
      snapshotPath,
    })
    this.emitLog(onLog, `Trend snapshot saved to ${snapshotPath}`)

    return {
      ...snapshot,
      snapshotPath,
      snapshotDirectory: this.getSnapshotsDir(),
    }
  }
}

module.exports = { TikTokTrendFinder, normalizeUsername }
