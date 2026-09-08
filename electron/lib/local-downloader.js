/**
 * ShadowPhone Local Content Downloader
 * Uses local yt-dlp to download content from YouTube, TikTok, Instagram
 * Runs on user's machine with their IP (avoids platform blocking)
 */

const path = require('path')
const fs = require('fs')
const { DependencyManager } = require('./dependency-manager')

class LocalDownloader {
    constructor() {
        this.deps = new DependencyManager()
        this.activeDownloads = new Map()
    }

    // Detect platform from URL
    detectPlatform(url) {
        if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube'
        if (url.includes('tiktok.com')) return 'tiktok'
        if (url.includes('instagram.com')) return 'instagram'
        return 'unknown'
    }

    // Format quality for yt-dlp
    getFormatString(quality) {
        switch (quality) {
            case '1080p': return 'bestvideo[height<=1080]+bestaudio/best[height<=1080]'
            case '720p': return 'bestvideo[height<=720]+bestaudio/best[height<=720]'
            case '480p': return 'bestvideo[height<=480]+bestaudio/best[height<=480]'
            case 'best':
            default: return 'bestvideo+bestaudio/best'
        }
    }

    // Download content from URL
    async download(options) {
        const {
            url,
            outputDir,
            maxVideos = 10,
            quality = 'best',
            browser = 'chrome',  // For cookie extraction
            onProgress,
            onLog
        } = options

        const downloadId = Date.now().toString()
        const platform = this.detectPlatform(url)

        // Ensure output directory exists
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true })
        }

        // Build yt-dlp arguments
        const args = [
            '-P', outputDir,
            '-o', '%(title).50s_%(id)s.%(ext)s',
            '-f', this.getFormatString(quality),
            '--merge-output-format', 'mp4',
            '--no-warnings',
            '--no-check-certificates',
            '--ignore-errors',
            '--progress',
            '--newline',  // One progress line per update
        ]

        // Add platform-specific options
        if (platform === 'youtube') {
            // YouTube: extract cookies from browser for age-restricted/members content
            // Note: May fail on Windows with DPAPI error - that's okay for public videos
            try {
                args.push('--cookies-from-browser', browser)
            } catch (e) {
                console.log('[LocalDownloader] Skipping cookies - DPAPI not available')
            }
        } else if (platform === 'tiktok') {
            // TikTok: public content works without cookies, skip to avoid DPAPI errors
            args.push('--sleep-interval', '1')
        } else if (platform === 'instagram') {
            // Instagram: requires login cookies
            // Note: May fail on Windows with DPAPI error
            try {
                args.push('--cookies-from-browser', browser)
            } catch (e) {
                console.log('[LocalDownloader] Skipping cookies - DPAPI not available')
            }
        }

        // Limit number of videos for channel/profile URLs
        if (url.includes('@') || url.includes('/c/') || url.includes('/channel/')) {
            args.push('--playlist-items', `1:${maxVideos}`)
            args.push('--max-downloads', String(maxVideos))
        }

        args.push(url)

        // Track download state
        const state = {
            id: downloadId,
            url,
            platform,
            status: 'downloading',
            progress: 0,
            videosDownloaded: 0,
            filesCreated: [],
            logs: []
        }
        this.activeDownloads.set(downloadId, state)

        // Log helper
        const log = (msg) => {
            state.logs.push(msg)
            if (onLog) onLog(msg)
        }

        log(`Starting download from ${platform}: ${url}`)
        log(`Output: ${outputDir}`)
        log(`Quality: ${quality}, Max videos: ${maxVideos}`)

        try {
            const result = await this.deps.runYtDlp(args, (type, data) => {
                // Parse progress from yt-dlp output
                if (data.includes('[download]')) {
                    const match = data.match(/(\d+\.?\d*)%/)
                    if (match) {
                        state.progress = parseFloat(match[1])
                        if (onProgress) onProgress(state.progress)
                    }
                }

                // Track completed downloads
                if (data.includes('[Merger]') || data.includes('has already been downloaded')) {
                    state.videosDownloaded++
                }

                log(data.trim())
            })

            // Find all downloaded files
            const files = fs.readdirSync(outputDir)
                .filter(f => f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.mkv'))
                .map(f => path.join(outputDir, f))

            state.filesCreated = files
            state.status = 'complete'
            state.progress = 100

            log(`\n✅ Download complete! ${files.length} files downloaded.`)

            return {
                success: true,
                downloadId,
                files,
                videosDownloaded: files.length,
                outputDir
            }

        } catch (error) {
            state.status = 'error'
            log(`\n❌ Error: ${error.message}`)

            return {
                success: false,
                downloadId,
                error: error.message,
                files: state.filesCreated
            }
        }
    }

    // Get status of active download
    getStatus(downloadId) {
        return this.activeDownloads.get(downloadId)
    }

    // Cancel download (not implemented - yt-dlp doesn't support graceful cancel)
    cancel(downloadId) {
        const state = this.activeDownloads.get(downloadId)
        if (state) {
            state.status = 'cancelled'
        }
    }
}

module.exports = { LocalDownloader }
