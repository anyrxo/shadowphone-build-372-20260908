# Module: twitter_follow
# Searches for and follows a list of Twitter/X users.
import asyncio
from lib.ws_modules_shared import WSDeviceAdapter


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Follow Twitter users via WebSocket"""
    try:
        usernames = config.get("usernames", [])
        followed = []

        await device.launch_app("com.twitter.android")
        await asyncio.sleep(3)

        for username in usernames:
            # Tap search
            search_btn = await device.find_element_by_content_desc("Search")
            if search_btn:
                await device.click(search_btn)
            await asyncio.sleep(1)

            # Type username
            search_input = await device.find_element_by_text("Search")
            if search_input:
                await device.click(search_input)
            await asyncio.sleep(0.5)

            await device.send_keys(username)
            await asyncio.sleep(2)

            # Tap first result
            await device.tap(540, 400)
            await asyncio.sleep(2)

            # Tap Follow
            follow_btn = await device.find_element_by_text("Follow")
            if follow_btn:
                await device.click(follow_btn)
                followed.append(username)

            await device.back()
            await asyncio.sleep(1)

        return {"success": True, "followed": followed}

    except Exception as e:
        return {"success": False, "error": str(e), "followed": followed}
