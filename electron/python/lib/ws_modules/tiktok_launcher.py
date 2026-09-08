# Module: tiktok_launcher
# Launches the TikTok app and verifies it opened successfully.
import asyncio
from lib.ws_modules_shared import WSDeviceAdapter


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Launch TikTok app"""
    try:
        await device.launch_app("com.zhiliaoapp.musically")
        await asyncio.sleep(4)

        # Verify TikTok is open
        await device.refresh_screen(force=True)
        xml = device._screen_xml or ""

        if "com.zhiliaoapp.musically" in xml or "tiktok" in xml.lower():
            return {"success": True, "status": "tiktok_open"}

        return {"success": True, "status": "launched"}

    except Exception as e:
        return {"success": False, "error": str(e)}
