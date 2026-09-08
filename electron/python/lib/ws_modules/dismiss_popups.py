# Module: dismiss_popups
# Dismisses any visible popups on screen by tapping known dismiss text labels.
import asyncio
from lib.ws_modules_shared import WSDeviceAdapter


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Dismiss any visible popups via WebSocket"""
    try:
        dismissed = 0
        max_attempts = config.get("max_attempts", 5)

        dismiss_texts = [
            "Got it",
            "OK",
            "Dismiss",
            "Close",
            "Not Now",
            "Skip",
            "Cancel",
            "Maybe Later",
            "Done",
            "I Understand",
        ]

        for _ in range(max_attempts):
            await device.refresh_screen(force=True)

            for text in dismiss_texts:
                btn = await device.find_element_by_text(text)
                if btn:
                    await device.click(btn)
                    dismissed += 1
                    await asyncio.sleep(0.5)
                    break
            else:
                # No popup found, we're done
                break

        return {"success": True, "dismissed": dismissed}

    except Exception as e:
        return {"success": False, "error": str(e)}
