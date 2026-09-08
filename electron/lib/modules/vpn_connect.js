// electron/lib/modules/vpn_connect.js
// ── vpn_connect ────────────────────────────────────────────────────
// Connects or disconnects ProtonVPN on the device.
// Supports actions: 'connect' (default), 'disconnect'.
// Handles login if credentials are provided and the app requires it.
// Navigates to the Profiles tab to select a named profile (e.g. "Streaming US").

module.exports = async (device, config) => {
    const t0 = Date.now()
    try {
        const action = config.action || 'connect'
        const profile = config.profile || 'Streaming US'
        const email = config.email
        const password = config.password

        // Check if ProtonVPN is installed
        device.sendProgress(5, 'Checking ProtonVPN installation...')
        const pkgList = await device.shell('pm list packages | grep protonvpn')
        if (!pkgList || pkgList.trim().length === 0) {
            return { success: false, error: 'ProtonVPN not installed on device' }
        }

        // Launch ProtonVPN app. Drop the post-launch 1000ms — dismissCommonPopups
        // does its own getScreen so the app has time to render during that
        // ~600-1200ms call. Net savings: 1s per run.
        device.sendProgress(10, 'Launching ProtonVPN...')
        await device.launchApp('ch.protonvpn.android', 2000)
        await device.dismissCommonPopups()

        // Get current screen
        await device.getScreen()
        let screenXml = device.currentScreen || ''
        const lower = screenXml.toLowerCase()

        // Check if already connected — use specific markers, not generic "connected"
        const isConnected = device.textOnScreen('You are protected') ||
                            device.textOnScreen('Disconnect') ||
                            (device.findElementByText('Disconnect') !== null)

        if (action === 'disconnect') {
            device.sendProgress(30, 'Disconnecting VPN...')
            if (isConnected) {
                const disconnectBtn = device.findElementByText('Disconnect') ||
                                     device.findElementByText('DISCONNECT')
                if (disconnectBtn) {
                    await device.tap(disconnectBtn.x, disconnectBtn.y, 1000)
                    device.sendProgress(70, 'Waiting for disconnection...')
                    for (let i = 0; i < 8; i++) {
                        await device.wait(800)
                        await device.getScreen()
                        if (device.textOnScreen('You are unprotected')) {
                            device.sendProgress(100, 'VPN disconnected')
                            return { success: true, data: { message: 'VPN disconnected successfully' } }
                        }
                    }
                }
            }
            if (device.textOnScreen('You are unprotected')) {
                device.sendProgress(100, 'Already disconnected')
                return { success: true, data: { message: 'VPN already disconnected' } }
            }
            return {
                success: false,
                code: 'VPN_DISCONNECT_UNVERIFIED',
                error: 'ProtonVPN did not show a verified disconnected state. Check the VPN app before continuing.',
            }
        }

        // Connect action
        device.sendProgress(20, 'Checking connection status...')
        if (isConnected) {
            device.sendProgress(40, 'Disconnecting before reconnecting...')
            const disconnectBtn = device.findElementByText('Disconnect') ||
                                 device.findElementByText('DISCONNECT')
            if (disconnectBtn) {
                await device.tap(disconnectBtn.x, disconnectBtn.y, 1000)
                for (let i = 0; i < 5; i++) {
                    await device.wait(600)
                    await device.getScreen()
                    if (device.textOnScreen('You are unprotected') || !device.findElementByText('Disconnect')) break
                }
            }
        }

        // Check if login needed
        await device.getScreen()
        screenXml = device.currentScreen || ''
        const needsLogin = screenXml.toLowerCase().includes('sign in') ||
                          screenXml.toLowerCase().includes('login') ||
                          screenXml.toLowerCase().includes('welcome')

        if (needsLogin && email && password) {
            device.sendProgress(25, 'Logging in to ProtonVPN...')

            // Find and fill email field
            const emailField = device.findElementByResourceId('ch.protonvpn.android:id/emailEditText') ||
                              device.findElementByResourceId('ch.protonvpn.android:id/input_email')
            if (emailField) {
                await device.tap(emailField.x, emailField.y, 500)
                await device.inputText(email)
            }

            await device.wait(400)

            // Find and fill password field
            const passwordField = device.findElementByResourceId('ch.protonvpn.android:id/passwordEditText') ||
                                 device.findElementByResourceId('ch.protonvpn.android:id/input_password')
            if (passwordField) {
                await device.tap(passwordField.x, passwordField.y, 500)
                await device.inputText(password)
            }

            await device.wait(400)

            // Tap login button
            const loginBtn = device.findElementByText('Sign in') ||
                            device.findElementByText('Login') ||
                            device.findElementByText('LOG IN')
            if (loginBtn) {
                await device.tap(loginBtn.x, loginBtn.y, 1200)
            }

            // Wait for login to complete
            device.sendProgress(40, 'Processing login...')
            for (let i = 0; i < 8; i++) {
                await device.wait(1000)
                await device.getScreen()
                const loggedXml = device.currentScreen || ''
                if (!loggedXml.toLowerCase().includes('sign in') &&
                    !loggedXml.toLowerCase().includes('loading')) {
                    break
                }
            }
        }

        // Dismiss any popups after login
        await device.dismissCommonPopups()

        // Navigate to Profiles tab first (bottom nav), then find target profile
        device.sendProgress(50, 'Navigating to Profiles tab...')
        await device.getScreen()

        // Tap Profiles in bottom nav
        const profilesTab = device.findElementByText('Profiles')
        if (profilesTab) {
            await device.tap(profilesTab.x, profilesTab.y, 2000)
            await device.getScreen()

            // Handle "Got it" popup on first visit
            if (device.textOnScreen('Got it')) {
                const gotIt = device.findElementByText('Got it')
                if (gotIt) await device.tap(gotIt.x, gotIt.y, 1500)
                await device.getScreen()
            }
        }

        // Find and tap the target profile (e.g. "Streaming US")
        device.sendProgress(55, `Looking for ${profile}...`)
        let profileBtn = device.findElementByText(profile)

        if (!profileBtn) {
            // Scroll to find it
            for (let i = 0; i < 3; i++) {
                await device.scrollDown()
                await device.wait(800)
                await device.getScreen()
                profileBtn = device.findElementByText(profile)
                if (profileBtn) break
            }
        }

        if (profileBtn) {
            device.sendProgress(60, `Connecting to ${profile}...`)
            await device.tap(profileBtn.x, profileBtn.y, 3000)
        } else {
            // Fallback: go back to Home and use Connect button
            device.sendLog(`${profile} not found in Profiles — using Connect button`, 'WARN')
            await device.back()
            await device.wait(1000)
            await device.getScreen()
            const connectBtn = device.findElementByText('Connect')
            if (connectBtn) await device.tap(connectBtn.x, connectBtn.y, 3000)
        }

        // Handle VPN permission dialog
        device.sendProgress(70, 'Handling VPN permissions...')
        for (let i = 0; i < 3; i++) {
            await device.wait(500)
            await device.getScreen()
            const permitBtn = device.findElementByText('Allow') ||
                             device.findElementByText('ALLOW') ||
                             device.findElementByResourceId('android:id/button1')
            if (permitBtn) {
                await device.tap(permitBtn.x, permitBtn.y, 800)
                break
            }
        }

        // Dismiss notifications popup if present
        await device.dismissCommonPopups()

        // Poll for connection. Skip the expensive `getScreen()` (uiautomator
        // dump = 600-1200ms per call) and check tun0 directly — that's the
        // authoritative source of truth and a single shell round-trip
        // (~120-250ms). On a typical 4-6s VPN handshake this cuts the poll
        // overhead from ~6-8s to ~1.5-3s and removes the redundant 800ms
        // "verifying connection" sleep at the end.
        device.sendProgress(80, 'Waiting for VPN tunnel...')
        const startTime = Date.now()
        const timeout = 15000

        while (Date.now() - startTime < timeout) {
            try {
                const ifconfig = await device.shell('ip link | grep tun0')
                if (ifconfig && ifconfig.includes('tun0')) {
                    const elapsed = Date.now() - t0
                    device.sendProgress(100, 'VPN connected successfully')
                    device.sendLog(`module=vpn_connect step=done profile=${profile} elapsed=${elapsed}ms`, 'INFO')
                    return { success: true, data: { message: 'VPN connected successfully', profile, elapsed_ms: elapsed } }
                }
            } catch {
                // tun0 not up yet — keep polling
            }
            await device.wait(400)
        }

        return { success: false, error: 'VPN connection timed out after 15 seconds' }
    } catch (error) {
        return { success: false, error: `VPN connection failed: ${error.message}` }
    }
}
