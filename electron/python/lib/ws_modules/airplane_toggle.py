# Module: airplane_toggle
# Toggles airplane mode on/off or cycles it to refresh IP.
import asyncio
from lib.ws_modules_shared import WSDeviceAdapter


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Toggle airplane mode via WebSocket"""
    try:
        action = config.get("action", "cycle")  # 'on', 'off', or 'cycle'

        if action == "cycle":
            # Turn ON
            await device.shell("cmd connectivity airplane-mode enable")
            await asyncio.sleep(3)
            # Turn OFF
            await device.shell("cmd connectivity airplane-mode disable")
            await asyncio.sleep(5)
        elif action == "on":
            await device.shell("cmd connectivity airplane-mode enable")
            await asyncio.sleep(3)
        elif action == "off":
            await device.shell("cmd connectivity airplane-mode disable")
            await asyncio.sleep(5)

        return {"success": True, "action": action}

    except Exception as e:
        return {"success": False, "error": str(e)}
