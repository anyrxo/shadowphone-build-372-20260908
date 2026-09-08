# Module: detect_accounts
# Detects logged-in Instagram accounts on the device via profile tab inspection.
import asyncio
import re
from lib.ws_modules_shared import WSDeviceAdapter, _navigate_to_ig_tab


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Detect logged-in Instagram accounts via WebSocket - Resource ID first"""
    try:
        await device.launch_app("com.instagram.android")
        await asyncio.sleep(3)

        accounts = []

        # Tap profile tab via resource ID
        await _navigate_to_ig_tab(device, "profile")
        await asyncio.sleep(2)

        # Get current username from profile
        await device.refresh_screen(force=True)

        # Look for username in various locations
        # Try action bar title
        username_match = re.search(
            r'resource-id="[^"]*action_bar_title[^"]*"[^>]*text="([^"]+)"',
            device._screen_xml or "",
            re.IGNORECASE,
        )
        if username_match:
            accounts.append({"username": username_match.group(1), "is_current": True})

        # Tap username to see account switcher
        await device.tap(540, 200)  # Top area
        await asyncio.sleep(1)
        await device.refresh_screen(force=True)

        # Look for other accounts in the dropdown
        account_matches = re.findall(
            r'text="([a-zA-Z0-9._]+)"[^>]*resource-id="[^"]*username',
            device._screen_xml or "",
            re.IGNORECASE,
        )
        for match in account_matches:
            if match not in [a["username"] for a in accounts]:
                accounts.append({"username": match, "is_current": False})

        # Go back
        await device.back()

        return {"success": True, "accounts": accounts}

    except Exception as e:
        return {"success": False, "error": str(e), "accounts": []}
