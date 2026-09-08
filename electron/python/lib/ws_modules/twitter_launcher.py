# Module: twitter_launcher
# Launches the Twitter/X app and verifies the home tab is visible.
import asyncio
from lib.ws_modules_shared import WSDeviceAdapter


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Launch Twitter/X app"""
    try:
        await device.launch_app("com.twitter.android")
        await asyncio.sleep(4)

        # Verify we're in Twitter
        home_btn = await device.find_element_by_content_desc("Home")
        if home_btn:
            return {"success": True, "status": "twitter_open"}

        return {"success": True, "status": "launched"}

    except Exception as e:
        return {"success": False, "error": str(e)}
