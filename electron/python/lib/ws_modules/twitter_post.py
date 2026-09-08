# Module: twitter_post
# Composes and posts a tweet on Twitter/X.
import asyncio
from lib.ws_modules_shared import WSDeviceAdapter


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Post tweet via WebSocket"""
    try:
        text = config.get("text", "")

        if not text:
            return {"success": False, "error": "text required"}

        await device.launch_app("com.twitter.android")
        await asyncio.sleep(3)

        # Tap compose button
        compose_btn = await device.find_element_by_content_desc("Compose")
        if compose_btn:
            await device.click(compose_btn)
        else:
            await device.tap(960, 2200)  # FAB position
        await asyncio.sleep(2)

        # Type tweet
        await device.send_keys(text)
        await asyncio.sleep(0.5)

        # Post
        post_btn = await device.find_element_by_text("Post")
        if post_btn:
            await device.click(post_btn)

        await asyncio.sleep(3)
        return {"success": True, "text": text[:50]}

    except Exception as e:
        return {"success": False, "error": str(e)}
