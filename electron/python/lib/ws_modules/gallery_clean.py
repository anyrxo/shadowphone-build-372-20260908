# Module: gallery_clean
# Deletes all files from the device Download folder via the Gallery app UI,
# with content-provider + rm fallback for stubborn files.
import asyncio
from lib.ws_modules_shared import WSDeviceAdapter


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Smart gallery cleaning — ported from proven gallery_cleaning_module.py

    Uses UI-based deletion through the Gallery app (proven coordinates):
    - Single file: 3-dot menu → Delete → OK
    - Multiple files: Select All → Delete → OK
    Falls back to content provider delete if UI method leaves files behind.
    """
    try:
        max_rounds = config.get("max_rounds", 3)
        total_deleted = 0

        # Step 1: Count files in Download folder via shell
        count_result = await device.shell("ls /sdcard/Download/ 2>/dev/null")
        try:
            file_count = len(
                [l for l in count_result.strip().splitlines() if l.strip()]
            )
        except (ValueError, AttributeError):
            file_count = 0

        if file_count == 0:
            return {
                "success": True,
                "deleted": 0,
                "message": "Download folder already empty",
            }

        # Step 2: Force-stop Gallery for clean state
        await device.close_app("com.android.gallery3d")
        await asyncio.sleep(0.5)

        for round_num in range(max_rounds):
            # Re-count before each round
            if round_num > 0:
                count_result = await device.shell("ls /sdcard/Download/ 2>/dev/null")
                try:
                    file_count = len(
                        [l for l in count_result.strip().splitlines() if l.strip()]
                    )
                except (ValueError, AttributeError):
                    file_count = 0
                if file_count == 0:
                    break

            # Step 3: Open Gallery app
            await device.shell("am start -n com.android.gallery3d/.app.GalleryActivity")
            await asyncio.sleep(3)

            if file_count == 1:
                # ━━━ SINGLE FILE: 3-dot menu method (proven fast) ━━━
                await device.tap(270, 1200)  # Enter Download folder
                await asyncio.sleep(0.5)
                await device.tap(1006, 191)  # 3-dot menu (must be fast!)
                await asyncio.sleep(1)
                await device.tap(801, 316)  # Delete
                await asyncio.sleep(1)
                await device.tap(775, 1307)  # OK confirm
                await asyncio.sleep(2)
                total_deleted += 1
            else:
                # ━━━ MULTIPLE FILES: Select All method ━━━
                await device.tap(270, 1200)  # Enter Download folder
                await asyncio.sleep(1.5)
                await device.tap(801, 444)  # Select item
                await asyncio.sleep(1)
                await device.tap(328, 191)  # "0 selected" dropdown
                await asyncio.sleep(1)
                await device.tap(459, 338)  # Select all
                await asyncio.sleep(1)
                await device.tap(858, 191)  # Delete button
                await asyncio.sleep(1)
                await device.tap(775, 1307)  # OK confirm
                await asyncio.sleep(2)
                total_deleted += file_count

            # Force-stop Gallery for clean state
            await device.close_app("com.android.gallery3d")
            await asyncio.sleep(0.5)

        # Step 4: Verify files actually deleted
        verify_result = await device.shell("ls /sdcard/Download/ 2>/dev/null")
        try:
            remaining = len(
                [l for l in verify_result.strip().splitlines() if l.strip()]
            )
        except (ValueError, AttributeError):
            remaining = 0

        if remaining > 0:
            # ━━━ FALLBACK: Content provider delete + direct rm ━━━
            await device.shell(
                "content delete --uri content://media/external/images/media"
            )
            await device.shell(
                "content delete --uri content://media/external/video/media"
            )
            await device.shell(
                "rm -f /sdcard/Download/*.jpg /sdcard/Download/*.png "
                "/sdcard/Download/*.mp4 /sdcard/Download/*.webp "
                "/sdcard/Download/*.mov /sdcard/Download/*.jpeg"
            )
            await asyncio.sleep(1)

            # Clean other common gallery dirs
            for d in ["/sdcard/DCIM/Camera/", "/sdcard/Pictures/Instagram/"]:
                await device.shell(f"rm -f {d}*.jpg {d}*.png {d}*.mp4 {d}*.webp")

            # Media rescan
            await device.shell(
                "am broadcast -a android.intent.action.MEDIA_MOUNTED "
                "-d file:///storage/emulated/0"
            )
            await asyncio.sleep(2)

            # Final verify
            final_result = await device.shell("ls /sdcard/Download/ 2>/dev/null")
            try:
                final_remaining = len(
                    [l for l in final_result.strip().splitlines() if l.strip()]
                )
            except (ValueError, AttributeError):
                final_remaining = 0

            return {
                "success": final_remaining == 0,
                "deleted": total_deleted,
                "remaining": final_remaining,
                "method": "ui_with_fallback",
            }

        return {
            "success": True,
            "deleted": total_deleted,
            "remaining": 0,
            "method": "ui_gallery",
        }

    except Exception as e:
        try:
            await device.close_app("com.android.gallery3d")
        except:
            pass
        return {"success": False, "error": str(e)}
