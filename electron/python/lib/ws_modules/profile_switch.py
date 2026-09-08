# Module: profile_switch
# Switches GrapheneOS user profile via ADB.
import asyncio
from lib.ws_modules_shared import WSDeviceAdapter


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Switch GrapheneOS profile via WebSocket"""
    try:
        profile_id = config.get("profile_id") or config.get("profile_name")

        if not profile_id:
            return {"success": False, "error": "No profile_id provided"}

        # Get current user
        current = await device.shell("am get-current-user")
        current_id = current.strip()

        if current_id == str(profile_id):
            return {"success": True, "message": "Already on target profile"}

        # Switch profile using ADB
        await device.shell(f"am switch-user {profile_id}")
        await asyncio.sleep(8)  # GrapheneOS needs time

        # Verify switch
        new_current = await device.shell("am get-current-user")
        if new_current.strip() == str(profile_id):
            return {"success": True, "profile_id": profile_id}

        return {"success": False, "error": "Profile switch verification failed"}

    except Exception as e:
        return {"success": False, "error": str(e)}
