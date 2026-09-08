# Module: threads_post
# Composes and posts a text thread on Threads.
import asyncio
from lib.ws_modules_shared import WSDeviceAdapter


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Post to Threads via WebSocket"""
    try:
        text = config.get("text", "")

        if not text:
            return {"success": False, "error": "text required"}

        await device.launch_app("com.instagram.barcelona")
        await asyncio.sleep(4)

        # Tap compose
        compose_btn = await device.find_element_by_content_desc("Create")
        if compose_btn:
            await device.click(compose_btn)
        else:
            await device.tap(540, 2300)
        await asyncio.sleep(2)

        # Type text
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
