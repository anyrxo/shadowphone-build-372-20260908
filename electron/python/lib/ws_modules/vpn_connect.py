# Module: vpn_connect
# Connects to ProtonVPN US Streaming profile on the device.
import asyncio
from lib.ws_modules_shared import WSDeviceAdapter


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Run VPN connection via WebSocket"""
    try:
        # Launch ProtonVPN
        await device.launch_app("ch.protonvpn.android")
        await asyncio.sleep(3)

        # Navigate to Profiles tab
        profiles_tab = await device.find_element_by_text("Profiles")
        if profiles_tab:
            await device.click(profiles_tab)
            await asyncio.sleep(1)
        else:
            # Fallback coordinates
            await device.tap(678, 2232)
            await asyncio.sleep(1)

        # Find and click US Streaming profile
        us_streaming = await device.find_element_by_text("US Streaming", partial=True)
        if not us_streaming:
            us_streaming = await device.find_element_by_text(
                "Streaming US", partial=True
            )

        if us_streaming:
            await device.click(us_streaming)
            await asyncio.sleep(1)

        # Click Connect button
        connect_btn = await device.find_element_by_text("Connect")
        if connect_btn:
            await device.click(connect_btn)
        else:
            await device.tap(540, 1895)

        # Wait for connection
        await asyncio.sleep(10)

        # Verify connected
        protected = await device.find_element_by_text("Protected")
        if protected:
            return {"success": True, "status": "connected"}

        return {"success": False, "error": "Could not verify connection"}

    except Exception as e:
        return {"success": False, "error": str(e)}
