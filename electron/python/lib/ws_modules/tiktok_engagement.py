# Module: tiktok_engagement
# Watches TikTok videos and likes them based on configured chance.
import asyncio
import random
from lib.ws_modules_shared import WSDeviceAdapter


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """TikTok engagement (like, follow) via WebSocket"""
    try:
        count = config.get("count", 10)
        like_chance = config.get("like_chance", 60) / 100
        completed = 0
        likes = 0

        await device.launch_app("com.zhiliaoapp.musically")
        await asyncio.sleep(4)

        for i in range(count):
            # Watch video for random time
            watch_time = random.uniform(3, 10)
            await asyncio.sleep(watch_time)

            # Like
            if random.random() < like_chance:
                # Double tap center to like
                await device.tap(540, 1200)
                await asyncio.sleep(0.05)
                await device.tap(540, 1200)
                likes += 1

            # Swipe to next video
            await device.swipe(540, 1800, 540, 400, 200)
            await asyncio.sleep(0.5)

            completed += 1

        return {"success": True, "completed": completed, "likes": likes}

    except Exception as e:
        return {"success": False, "error": str(e), "completed": completed}
