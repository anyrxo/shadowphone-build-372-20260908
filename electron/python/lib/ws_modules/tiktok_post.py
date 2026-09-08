# Module: tiktok_post
# Uploads a video from the device gallery to TikTok with an optional caption.
import asyncio
from lib.ws_modules_shared import WSDeviceAdapter


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Post TikTok video via WebSocket"""
    try:
        caption = config.get("caption", "")

        await device.launch_app("com.zhiliaoapp.musically")
        await asyncio.sleep(4)

        # Tap create button (center bottom)
        create_btn = await device.find_element_by_content_desc("Create")
        if create_btn:
            await device.click(create_btn)
        else:
            await device.tap(540, 2300)
        await asyncio.sleep(2)

        # Tap upload (to use existing video)
        upload_btn = await device.find_element_by_text("Upload")
        if upload_btn:
            await device.click(upload_btn)
        await asyncio.sleep(2)

        # Select first video
        await device.tap(200, 400)
        await asyncio.sleep(1)

        # Tap Next
        next_btn = await device.find_element_by_text("Next")
        if next_btn:
            await device.click(next_btn)
        await asyncio.sleep(2)

        # Tap Next again
        await device.tap(1000, 100)
        await asyncio.sleep(2)

        # Add caption
        if caption:
            caption_area = await device.find_element_by_text("Describe your video")
            if caption_area:
                await device.click(caption_area)
            await asyncio.sleep(0.5)
            await device.send_keys(caption)

        # Post
        post_btn = await device.find_element_by_text("Post")
        if post_btn:
            await device.click(post_btn)

        await asyncio.sleep(5)
        return {"success": True, "caption": caption[:50]}

    except Exception as e:
        return {"success": False, "error": str(e)}
