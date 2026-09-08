# Module: threads_engagement
# Scrolls the Threads feed and likes posts based on configured chance.
import asyncio
import random
from lib.ws_modules_shared import WSDeviceAdapter


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Threads engagement via WebSocket"""
    try:
        count = config.get("count", 10)
        like_chance = config.get("like_chance", 70) / 100
        completed = 0
        likes = 0

        await device.launch_app("com.instagram.barcelona")
        await asyncio.sleep(4)

        for i in range(count):
            # Scroll feed
            await device.swipe(540, 1500, 540, 700, 400)
            await asyncio.sleep(random.uniform(1.5, 4))

            # Like
            if random.random() < like_chance:
                like_btn = await device.find_element_by_content_desc("Like")
                if like_btn:
                    await device.click(like_btn)
                    likes += 1

            completed += 1

        return {"success": True, "completed": completed, "likes": likes}

    except Exception as e:
        return {"success": False, "error": str(e), "completed": completed}
