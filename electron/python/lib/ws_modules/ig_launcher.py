# Module: ig_launcher
# Launches Instagram and verifies the tab bar is visible.
import asyncio
from lib.ws_modules_shared import WSDeviceAdapter, _dismiss_ig_popups


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Launch Instagram via WebSocket - Resource ID first verification"""
    try:
        # Press back a few times to clear any dialogs
        for _ in range(2):
            await device.back()
            await asyncio.sleep(0.5)

        # Launch Instagram
        await device.launch_app("com.instagram.android")
        await asyncio.sleep(5)

        # Dismiss any startup popups
        await _dismiss_ig_popups(device)

        # Verify we're in Instagram by checking for tab bar resource ID
        tab_bar = await device.find_element_by_id("com.instagram.android:id/tab_bar")
        if tab_bar:
            return {"success": True, "status": "instagram_open"}

        # Try finding home tab by resource ID
        home_tab = await device.find_element_by_id("com.instagram.android:id/feed_tab")
        if home_tab:
            return {"success": True, "status": "instagram_open"}

        # Fallback: content-desc check
        home_tab = await device.find_element_by_content_desc("Home")
        if home_tab:
            return {"success": True, "status": "instagram_open"}

        return {
            "success": True,
            "status": "launched",
            "warning": "Could not verify tab bar",
        }

    except Exception as e:
        return {"success": False, "error": str(e)}
