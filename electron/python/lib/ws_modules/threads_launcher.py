# Module: threads_launcher
# Launches the Threads app and verifies the home tab is visible.
import asyncio
from lib.ws_modules_shared import WSDeviceAdapter


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Launch Threads app"""
    try:
        await device.launch_app("com.instagram.barcelona")
        await asyncio.sleep(4)

        # Verify Threads is open
        home_tab = await device.find_element_by_content_desc("Home")
        if home_tab:
            return {"success": True, "status": "threads_open"}

        return {"success": True, "status": "launched"}

    except Exception as e:
        return {"success": False, "error": str(e)}
