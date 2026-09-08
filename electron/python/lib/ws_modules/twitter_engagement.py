# Module: twitter_engagement
# Scrolls the Twitter/X feed, liking and retweeting based on configured chances.
import asyncio
import random
from lib.ws_modules_shared import WSDeviceAdapter


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Twitter engagement (like, retweet) via WebSocket"""
    try:
        count = config.get("count", 10)
        like_chance = config.get("like_chance", 70) / 100
        retweet_chance = config.get("retweet_chance", 20) / 100
        completed = 0
        likes = 0
        retweets = 0

        # Launch Twitter
        await device.launch_app("com.twitter.android")
        await asyncio.sleep(3)

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

            # Retweet
            if random.random() < retweet_chance:
                rt_btn = await device.find_element_by_content_desc("Repost")
                if rt_btn:
                    await device.click(rt_btn)
                    await asyncio.sleep(0.5)
                    # Tap Repost option
                    repost_opt = await device.find_element_by_text("Repost")
                    if repost_opt:
                        await device.click(repost_opt)
                        retweets += 1

            completed += 1

        return {
            "success": True,
            "completed": completed,
            "likes": likes,
            "retweets": retweets,
        }

    except Exception as e:
        return {"success": False, "error": str(e), "completed": completed}
