# Module: stats_scraper
# Scrapes follower/following/posts counts from an Instagram profile page.
import asyncio
import re
from lib.ws_modules_shared import WSDeviceAdapter, _navigate_to_ig_tab


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Scrape Instagram profile stats via WebSocket"""
    try:
        username = config.get("username")  # If None, scrape own profile

        # Launch Instagram
        await device.launch_app("com.instagram.android")
        await asyncio.sleep(3)

        if username:
            # Go to search via resource ID and find user
            await _navigate_to_ig_tab(device, "search")
            await asyncio.sleep(2)

            search_input = await device.find_element_by_id(
                "com.instagram.android:id/action_bar_search_edit_text"
            )
            if search_input:
                await device.click(search_input)
            await asyncio.sleep(0.5)

            await device.send_keys(username)
            await asyncio.sleep(2)

            await device.tap(540, 400)  # First result
            await asyncio.sleep(2)
        else:
            # Go to own profile via resource ID
            await _navigate_to_ig_tab(device, "profile")
            await asyncio.sleep(2)

        # Refresh screen and extract stats
        await device.refresh_screen(force=True)
        xml = device._screen_xml or ""

        stats = {}

        # Extract followers count
        follower_match = re.search(
            r'text="([\d,\.KMB]+)\s*followers?"', xml, re.IGNORECASE
        )
        if follower_match:
            stats["followers"] = follower_match.group(1)

        # Extract following count
        following_match = re.search(
            r'text="([\d,\.KMB]+)\s*following"', xml, re.IGNORECASE
        )
        if following_match:
            stats["following"] = following_match.group(1)

        # Extract posts count
        posts_match = re.search(r'text="([\d,\.KMB]+)\s*posts?"', xml, re.IGNORECASE)
        if posts_match:
            stats["posts"] = posts_match.group(1)

        return {"success": True, "stats": stats, "username": username}

    except Exception as e:
        return {"success": False, "error": str(e)}
