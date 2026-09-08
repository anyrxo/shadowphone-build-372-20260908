// electron/lib/modules/notification.js
// ── Handler: notification ───────────────────────────────────────────
// Shows a desktop notification via Electron and optionally posts to a Discord webhook.

module.exports = async (device, config) => {
    try {
        const message = config.message || 'Workflow step reached'
        const discord_webhook = config.discord_webhook
        let desktop_presented = false
        let desktop_error = null

        try {
            const { Notification } = require('electron')
            if (Notification.isSupported()) {
                const notification = new Notification({ title: 'ShadowPhone', body: message })
                await new Promise((resolve, reject) => {
                    let timer
                    const onShow = () => finish()
                    const onFailed = (_event, error) => finish(new Error(error || 'Desktop notification display failed'))
                    const finish = (error) => {
                        clearTimeout(timer)
                        notification.removeListener('show', onShow)
                        notification.removeListener('failed', onFailed)
                        if (error) reject(error)
                        else resolve()
                    }
                    notification.once('show', onShow)
                    notification.once('failed', onFailed)
                    timer = setTimeout(() => finish(new Error('Desktop notification display timed out')), 5000)
                    try {
                        notification.show()
                    } catch (error) {
                        finish(error)
                    }
                })
                desktop_presented = true
            }
        } catch (e) {
            desktop_error = e.message
        }

        let discord_success = false
        let delivery_error = null
        if (discord_webhook) {
            let requestTimer
            try {
                const https = require('https')
                const url = new URL(discord_webhook)
                const payload = JSON.stringify({ content: `**ShadowPhone** — ${message}` })
                await new Promise((resolve, reject) => {
                    const req = https.request(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                    }, (res) => {
                        res.on('data', () => {})
                        res.on('error', reject)
                        res.on('aborted', () => reject(new Error('Discord webhook response was interrupted')))
                        res.on('end', () => {
                            if (res.statusCode >= 200 && res.statusCode < 300) resolve()
                            else reject(new Error(`Discord webhook rejected delivery (HTTP ${res.statusCode || 'unknown'})`))
                        })
                    })
                    req.on('error', reject)
                    requestTimer = setTimeout(() => req.destroy(new Error('Discord webhook timed out')), 10000)
                    req.write(payload)
                    req.end()
                })
                discord_success = true
            } catch (e) {
                delivery_error = e.message
                device.sendLog(`Discord webhook failed: ${e.message}`, 'WARN')
            } finally {
                clearTimeout(requestTimer)
            }
        }

        const data = { message, desktop: desktop_presented, discord: discord_success }
        if (delivery_error) return { success: false, error: delivery_error, data }
        if (!desktop_presented && !discord_success) {
            return { success: false, error: desktop_error || 'No notification delivery channel is available. Enable desktop notifications or configure a working webhook.', data }
        }
        return { success: true, data }
    } catch (error) {
        return { success: false, error: error.message }
    }
}
