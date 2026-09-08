# Module: vpn_disconnect
# Disconnects ProtonVPN on the device.
import asyncio
from lib.ws_modules_shared import WSDeviceAdapter


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Disconnect VPN via WebSocket"""
    try:
        await device.launch_app("ch.protonvpn.android")
        await asyncio.sleep(2)

        disconnect_btn = await device.find_element_by_text("Disconnect")
        if disconnect_btn:
            await device.click(disconnect_btn)
            await asyncio.sleep(3)
            return {"success": True, "status": "disconnected"}

        return {"success": False, "error": "Disconnect button not found"}

    except Exception as e:
        return {"success": False, "error": str(e)}
