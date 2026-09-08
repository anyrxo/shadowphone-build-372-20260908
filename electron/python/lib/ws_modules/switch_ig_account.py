# Module: switch_ig_account
# Switches the active Instagram account using the in-app account switcher.
import asyncio
from lib.ws_modules_shared import WSDeviceAdapter, _navigate_to_ig_tab


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Switch Instagram account via WebSocket"""
    try:
        target_username = config.get("username")

        if not target_username:
            return {"success": False, "error": "username required"}

        # Launch Instagram
        await device.launch_app("com.instagram.android")
        await asyncio.sleep(3)

        # Go to profile via resource ID
        await _navigate_to_ig_tab(device, "profile")
        await asyncio.sleep(2)

        # Tap username area to open switcher via resource ID
        username_area = await device.find_element_by_id(
            "com.instagram.android:id/action_bar_username_container"
        )
        if not username_area:
            username_area = await device.find_element_by_id(
                "com.instagram.android:id/action_bar_title"
            )
        if username_area:
            await device.click(username_area)
        else:
            await device.tap(540, 200)
        await asyncio.sleep(1)

        await device.refresh_screen(force=True)

        # Look for target username
        target_account = await device.find_element_by_text(target_username)
        if target_account:
            await device.click(target_account)
            await asyncio.sleep(3)
            return {"success": True, "switched_to": target_username}

        return {
            "success": False,
            "error": f"Account {target_username} not found in switcher",
        }

    except Exception as e:
        return {"success": False, "error": str(e)}
