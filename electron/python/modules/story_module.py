#!/usr/bin/env python3
"""
INSTAGRAM STORY MODULE - ENHANCED v2.2 (Dec 2024)
Human-like story viewing with selector-based interactions and fallback coordinates

VERIFIED COORDINATES (Dec 2024 XML Dumps):
==========================================================
BOTTOM NAVIGATION BAR:
   - Home Tab: (108, 2274) - feed_tab [0,2211][216,2337]
   - Reels Tab: (324, 2274) - clips_tab [216,2211][432,2337]
   - Message Tab: (540, 2274) - direct_tab [432,2211][648,2337]
   - Search Tab: (756, 2274) - search_tab [648,2211][864,2337]
   - Profile Tab: (972, 2274) - profile_tab [864,2211][1080,2337]

STORY POSITIONS (on home feed):
   - First Story (Your story): (147, 415) - skip this for viewing
   - Second Story: (441, 415)
   - Third Story: (735, 415)
   - Fourth Story: (981, 415)

STORY VIEWING CONTROLS:
   - Like/Heart button: (901, 2192)
   - Next story: tap right side (900, 1000)
   - Previous story: tap left side (180, 1000)
   - Pause/Resume: tap center (540, 1000)

HUMANIZATION: Varies viewing times, occasionally taps back, random pauses
"""

import time
import subprocess
import random
import os
import tempfile
import sys

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from lib.bootstrap_profile_guards import BootstrapProfileGuards
from lib.screen_state import ScreenObservation, utc_now_iso, parse_bounds, bounds_center
from lib.instagram_screen_classifier import IG_POPUP_OR_CHALLENGE
from modules.popup_handler import PopupHandler
try:
    from modules.instagram_launcher_module import InstagramLauncher
except ImportError:
    InstagramLauncher = None

# Import crash recovery module
try:
    from appium_crash_recovery import auto_recover_from_crash

    CRASH_RECOVERY_AVAILABLE = True
except ImportError:
    CRASH_RECOVERY_AVAILABLE = False
    print("   Crash recovery module not available")

# Import selectors
try:
    from modules.ig_selectors import InstagramSelectors

    SELECTORS_AVAILABLE = True
except ImportError:
    SELECTORS_AVAILABLE = False
    print("   Instagram selectors not available, using coordinates only")

# Import Discord notifier
try:
    from modules.discord_notifier import get_notifier

    DISCORD_AVAILABLE = True
except ImportError:
    try:
        from discord_notifier import get_notifier

        DISCORD_AVAILABLE = True
    except ImportError:
        DISCORD_AVAILABLE = False


class _AdbPopupDriverAdapter:
    def __init__(self, viewer):
        self.viewer = viewer

    @property
    def page_source(self):
        return self.viewer._dump_ui_xml() or ''

    @property
    def current_package(self):
        return 'com.instagram.android'

    def find_element(self, by, value):
        raise RuntimeError('ADB popup adapter does not support direct selector lookup')

    def back(self):
        subprocess.run(
            ["adb", "-s", self.viewer.device_id, "shell", "input", "keyevent", "4"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return True


class InstagramStoryViewer:
    """Enhanced Instagram Story Viewer with human-like behavior"""

    def _dump_ui_xml(self):
        temp_file = os.path.join(tempfile.gettempdir(), 'story_module_guard_dump.xml')
        try:
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "uiautomator", "dump", "/sdcard/story_module_guard_dump.xml"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode != 0:
                return ''
            result = subprocess.run(
                ["adb", "-s", self.device_id, "pull", "/sdcard/story_module_guard_dump.xml", temp_file],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode != 0:
                return ''
            with open(temp_file, 'r', encoding='utf-8') as f:
                return f.read()
        except Exception as e:
            print(f"⚠️ Story module UI dump failed: {e}")
            return ''
        finally:
            try:
                if os.path.exists(temp_file):
                    os.remove(temp_file)
            except Exception:
                pass

    def _guards_for_xml(self, xml_content):
        return BootstrapProfileGuards(
            lambda: ScreenObservation(
                observed_at=utc_now_iso(),
                device_id=self.device_id,
                package='com.instagram.android',
                xml_source=xml_content,
            ),
            log=print,
        )

    def _verify_home_ready_soft(self):
        xml = self._dump_ui_xml()
        if not xml:
            return None
        result = self._guards_for_xml(xml).verify_home_ready()
        print(f"🔎 Home readiness: {result.screen_type} ({result.confidence})")
        return result

    def _verify_story_viewer_opened_soft(self):
        xml = self._dump_ui_xml()
        if not xml:
            return {"ok": False, "state": "unknown", "confidence": "low", "reasons": ["missing ui dump"]}
        lowered = xml.lower()
        viewer_markers = [
            'reply to',
            'send message',
            'media_layout',
            'story_viewer',
            'toolbar_like_button',
        ]
        matched = [marker for marker in viewer_markers if marker in lowered]
        return {
            "ok": bool(matched),
            "state": "story_viewer_opened" if matched else "unknown",
            "confidence": "medium" if matched else "low",
            "reasons": matched or ["no story viewer markers found"],
        }

    def _verify_safe_exit_soft(self):
        xml = self._dump_ui_xml()
        if not xml:
            return None
        result = self._guards_for_xml(xml).verify_home_ready()
        print(f"🔎 Safe exit state: {result.screen_type} ({result.confidence})")
        return result

    def _soft_recover_home_surface_if_needed(self, verification_result, label="home surface"):
        if not verification_result or verification_result.ok:
            return verification_result
        print(f"⚠️ {label} verification saw {verification_result.screen_type}; trying one bounded back-and-recheck")
        try:
            if verification_result.screen_type == IG_POPUP_OR_CHALLENGE:
                popup_handler = PopupHandler(_AdbPopupDriverAdapter(self))
                assessment = popup_handler.assess_popup_surface()
                print(f"🔔 Popup/challenge assessment: category={assessment.category}, confidence={assessment.confidence}, reasons={assessment.reasons}")
                popup_dismissed = popup_handler.dismiss_any_popup(max_attempts=1)
                post_attempt_assessment = popup_handler.assess_popup_surface()
                print(f"🔔 Popup/challenge response attempted: {popup_dismissed}; follow-up category={post_attempt_assessment.category}, confidence={post_attempt_assessment.confidence}, reasons={post_attempt_assessment.reasons}")
                if post_attempt_assessment.category == 'blocker_like' and not popup_dismissed:
                    return verification_result
                if not popup_dismissed and post_attempt_assessment.category == 'unknown_popup':
                    subprocess.run(
                        ["adb", "-s", self.device_id, "shell", "input", "keyevent", "3"],
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                    time.sleep(1.0)
                    retried = self._verify_home_ready_soft()
                    return self._soft_recover_home_surface_if_needed(retried, f"{label} post-home remediation") if retried and not retried.ok else (retried or verification_result)
            elif verification_result.screen_type == 'ig_profile_picker_or_settings':
                print(f"⚠️ {label} saw profile/settings picker; trying one bounded home-tab re-entry")
                self._tap_home_tab()
            elif verification_result.screen_type == 'ig_create_post_gallery':
                print(f"⚠️ {label} saw create-post gallery; trying one bounded double home-tab exit")
                self._tap_home_tab()
                time.sleep(0.6)
                self._tap_home_tab()
            else:
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
            time.sleep(1.0)
        except Exception as e:
            print(f"⚠️ {label} recovery back failed: {e}")
            return verification_result
        retried = self._verify_home_ready_soft()
        return retried or verification_result

    # Use centralized coordinates from ig_selectors if available
    # Fallback to these if not
    STORY_COORDS = {
        "first": (147, 415),  # First story (your story) - SKIP
        "second": (441, 415),  # Second story - viewable
        "third": (735, 415),  # Third story
        "fourth": (981, 415),  # Fourth story (partial visible)
        "heart": (
            901,
            2160,
        ),  # ADB-VERIFIED Feb 2026: toolbar_like_button ~[849,2108][954,2213]
        "home_tab": (108, 2274),  # Home tab - VERIFIED Dec 2024
        # SAFE TAP ZONE: top-right corner, ABOVE link stickers/CTAs.
        # Link stickers appear center/bottom (Y 600-1800). Progress bar is at Y ~220.
        # Tapping at Y 350-500 avoids all overlays while still advancing.
        "next_story": (950, 450),   # Top-right — safe from link stickers
        "prev_story": (130, 450),   # Top-left — safe from link stickers
        "pause_story": (540, 1000),  # Center tap to pause/resume
    }

    def __init__(self, device_id="1A121FDF60082H", user_id=None, settings=None):
        self.device_id = device_id
        self.driver = None  # Optional Appium driver for selector-based interactions

        # Load settings from Supabase or use defaults
        if settings is None and user_id:
            try:
                from lib.supabase_client import get_story_settings

                settings = get_story_settings(user_id)
                print(
                    f"⚙️ Loaded story settings from Supabase for user {user_id[:8]}..."
                )
            except Exception as e:
                print(f"⚠️ Could not load story settings: {e}")
                settings = {}
        settings = settings or {}

        # 🎯 CONFIGURABLE SETTINGS
        self.like_chance_min = settings.get("like_chance_min", 23)
        self.like_chance_max = settings.get("like_chance_max", 33)
        self.viewing_time_min = settings.get("viewing_time_min", 0.96)
        self.viewing_time_max = settings.get("viewing_time_max", 3.94)
        self.skip_chance = settings.get("skip_chance", 12)
        self.base_like_chance = settings.get("base_like_chance", 28)
        self.jitter_range = settings.get("jitter_range", 30)

        # 🧠 HUMAN BEHAVIOR SYSTEM
        try:
            from modules.human_behavior import get_human_behavior

            self.hb = get_human_behavior()
        except:
            self.hb = None

        # Use coordinates from InstagramSelectors.Coords when available
        if SELECTORS_AVAILABLE:
            self.STORY_COORDS = {
                "first": InstagramSelectors.Coords.STORY_YOUR,
                "second": InstagramSelectors.Coords.STORY_FIRST,
                "third": InstagramSelectors.Coords.STORY_SECOND,
                "fourth": InstagramSelectors.Coords.STORY_THIRD,
                "heart": InstagramSelectors.Coords.STORY_HEART,
                "home_tab": InstagramSelectors.Coords.NAV_HOME_TAB,
                "next_story": InstagramSelectors.Coords.STORY_NEXT,
                "prev_story": InstagramSelectors.Coords.STORY_PREVIOUS,
                "pause_story": (540, 1000),  # Center tap to pause
            }

        # Sanitize ANDROID_HOME if set (fix for leading space issue)
        if "ANDROID_HOME" in os.environ:
            original_home = os.environ["ANDROID_HOME"]
            if original_home.startswith(" ") or original_home.endswith(" "):
                print(f"⚠️ Detected whitespace in ANDROID_HOME, fixing...")
                os.environ["ANDROID_HOME"] = original_home.strip()

    def set_driver(self, driver):
        """Set Appium driver for selector-based interactions"""
        self.driver = driver
        print("✅ Appium driver set for story viewer")

    def _handle_appium_error(self, error, operation_name="operation"):
        """Handle Appium errors with automatic crash recovery"""
        if CRASH_RECOVERY_AVAILABLE and hasattr(self, "driver") and self.driver:
            print(f"🚨 Error during {operation_name}: {error}")
            print("🔄 Attempting automatic crash recovery...")

            success, _ = auto_recover_from_crash(error, self.device_id, self.driver)
            if success:
                print(f"✅ Crash recovery successful for {operation_name}")
                return True
            else:
                print(f"❌ Crash recovery failed for {operation_name}")

        return False

    def _tap_adb(self, x, y, description=""):
        """Tap using ADB with optional jitter for humanization"""
        try:
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "tap", str(x), str(y)],
                capture_output=True,
                text=True,
                timeout=5,
            )

            if result.returncode == 0:
                if description:
                    print(f"   {description} ({x}, {y})")
                return True
            else:
                print(f"   Tap failed: {result.stderr}")
                return False
        except Exception as e:
            print(f"   ADB tap error: {e}")
            return False

    def _human_jitter(self, x, y, jitter_range=30):
        """Add random jitter to coordinates for human-like tapping"""
        jx = x + random.randint(-jitter_range, jitter_range)
        jy = y + random.randint(-jitter_range, jitter_range)
        # Keep within safe story viewing zone (Y: 400-1900)
        jy = max(400, min(1900, jy))
        return jx, jy

    def _is_still_in_instagram(self):
        """Quick check that Instagram is still the foreground app.
        If a link sticker or ad CTA was accidentally tapped, the browser
        will be in focus instead. Returns False if we left Instagram."""
        try:
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "dumpsys", "activity",
                 "activities"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0:
                # Check topResumedActivity — most reliable indicator
                for line in result.stdout[:3000].split('\n'):
                    if 'topResumedActivity' in line:
                        return 'com.instagram.android' in line
                # Fallback: check top task
                return 'com.instagram.android' in result.stdout[:1500]
            return True  # Can't determine, assume OK
        except:
            return True

    def _recover_from_ad_tap(self):
        """Emergency recovery when an ad/link accidentally opened a browser.
        Presses back until we're back in Instagram."""
        print("   AD/LINK DETECTED — recovering...")
        for attempt in range(5):
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                capture_output=True, text=True, timeout=3,
            )
            time.sleep(0.8)
            if self._is_still_in_instagram():
                print("   Recovered to Instagram")
                return True
        # Nuclear option: force launch Instagram
        subprocess.run(
            ["adb", "-s", self.device_id, "shell", "monkey", "-p",
             "com.instagram.android", "-c", "android.intent.category.LAUNCHER", "1"],
            capture_output=True, text=True, timeout=8,
        )
        time.sleep(2)
        return self._is_still_in_instagram()

    def _tap_next_story(self):
        """Tap to go to next story segment/user — safe zone, with ad guard."""
        x, y = self.STORY_COORDS["next_story"]
        # Smaller jitter for safe zone taps (stay in top-right)
        jx, jy = self._human_jitter(x, y, jitter_range=30)
        # Clamp Y to stay in safe zone (above link stickers)
        jy = min(jy, 550)
        jy = max(jy, 300)
        result = self._tap_adb(jx, jy, "Next story")
        # Quick guard: did we accidentally leave Instagram?
        time.sleep(0.3)
        if not self._is_still_in_instagram():
            self._recover_from_ad_tap()
        return result

    def _tap_prev_story(self):
        """Tap to go to previous story segment/user — safe zone."""
        x, y = self.STORY_COORDS["prev_story"]
        jx, jy = self._human_jitter(x, y, jitter_range=30)
        jy = min(jy, 550)
        jy = max(jy, 300)
        return self._tap_adb(jx, jy, "Prev story")

    def _tap_pause_story(self):
        """Tap center to pause/hold story"""
        x, y = self.STORY_COORDS["pause_story"]
        jx, jy = self._human_jitter(x, y, jitter_range=40)
        return self._tap_adb(jx, jy, "Pause/Hold story")

    def _like_story(self):
        """Tap heart button to like story - with timeout protection

        Some stories don't allow likes (close friends, restricted).
        This method has a quick timeout to avoid getting stuck.
        """
        try:
            x, y = self.STORY_COORDS.get("heart", (796, 2192))
            jx, jy = self._human_jitter(x, y, jitter_range=20)
            return self._tap_adb(jx, jy, "Like story heart")
        except Exception as e:
            print(f"   ⚠️ Like failed (story may not allow): {e}")
            return False

    def _ensure_home_and_recover(self):
        """Emergency recovery - go back to home tab when stuck"""
        try:
            # Press back 3 times to exit any nested screens
            for _ in range(3):
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                    capture_output=True,
                    timeout=2,
                )
                time.sleep(0.3)
            # Tap home tab
            time.sleep(0.5)
            return self._tap_home_tab()
        except Exception as e:
            print(f"   ⚠️ Recovery failed: {e}")
            return False

    def _ensure_on_home_feed(self):
        """Ensure Instagram is open AND we're on the home feed (not random screen)

        This prevents story viewing from clicking on random places when IG
        is on a different screen (like DMs, profile, etc.)

        Uses strict launcher home verification contract.
        """
        try:
            if InstagramLauncher is None:
                print("   Instagram launcher unavailable; using ADB home fallback")
                subprocess.run(
                    [
                        "adb",
                        "-s",
                        self.device_id,
                        "shell",
                        "monkey",
                        "-p",
                        "com.instagram.android",
                        "-c",
                        "android.intent.category.LAUNCHER",
                        "1",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=8,
                )
                time.sleep(1.5)
                self._tap_home_tab()
                time.sleep(1.0)
                final_state = self._verify_home_ready_soft()
                if final_state and final_state.ok:
                    print("Instagram home feed verified via ADB fallback")
                    return True

                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                time.sleep(0.5)
                self._tap_home_tab()
                time.sleep(1.0)
                final_state = self._verify_home_ready_soft()
                if final_state and final_state.ok:
                    print("Instagram home feed verified via ADB fallback")
                    return True

                if final_state:
                    print(
                        f"ADB home fallback not verified: {final_state.screen_type} ({final_state.confidence})"
                    )
                return False

            launcher = InstagramLauncher(device_id=self.device_id)
            outcome = launcher.open_instagram_home_strict()
            if not outcome.get("verified_home_ready"):
                print(
                    f"⚠️ Home entry not verified by launcher: {outcome.get('screen_type')} ({outcome.get('reason')})"
                )
                return False

            final_state = self._verify_home_ready_soft()
            if final_state and final_state.ok:
                print("✅ Now on Instagram home feed")
                return True

            if final_state and final_state.screen_type == 'ig_profile':
                print("⚠️ Launcher verified home but local preflight saw ig_profile; trying one bounded semantic Home/feed recovery")
                recovered = False
                if self.driver and SELECTORS_AVAILABLE:
                    try:
                        from appium.webdriver.common.appiumby import AppiumBy
                        home_el = self.driver.find_element(AppiumBy.ID, InstagramSelectors.HOME_TAB)
                        home_el.click()
                        recovered = True
                        print("   Profile-surface Home/feed clicked (Resource ID)")
                    except Exception as e:
                        print(f"   Semantic Home/feed selector failed: {e}")
                if not recovered:
                    try:
                        subprocess.run(
                            ["adb", "-s", self.device_id, "shell", "monkey", "-p", "com.instagram.android", "-c", "android.intent.category.LAUNCHER", "1"],
                            capture_output=True,
                            text=True,
                            timeout=8,
                        )
                        recovered = True
                        print("   Profile-surface no-driver fallback: relaunched Instagram")
                    except Exception as e:
                        print(f"   Profile-surface relaunch fallback failed: {e}")
                if not recovered:
                    self._tap_home_tab()
                time.sleep(1.5)
                final_state = self._verify_home_ready_soft()
                if final_state and final_state.ok:
                    print("✅ Now on Instagram home feed")
                    return True

            if final_state and final_state.screen_type == 'ig_profile_picker_or_settings':
                print("⚠️ Launcher verified home but local preflight saw ig_profile_picker_or_settings; trying one bounded Instagram relaunch")
                try:
                    subprocess.run(
                        ["adb", "-s", self.device_id, "shell", "monkey", "-p", "com.instagram.android", "-c", "android.intent.category.LAUNCHER", "1"],
                        capture_output=True,
                        text=True,
                        timeout=8,
                    )
                except Exception as e:
                    print(f"   Instagram relaunch failed: {e}")
                time.sleep(1.5)
                final_state = self._verify_home_ready_soft()
                if final_state and final_state.ok:
                    print("✅ Now on Instagram home feed")
                    return True

            if final_state and final_state.screen_type == 'ig_create_post_gallery':
                print("⚠️ Launcher verified home but local preflight saw create/gallery-like surface; trying one bounded Home-tab re-entry")
                self._tap_home_tab()
                time.sleep(1.0)
                final_state = self._verify_home_ready_soft()
                if final_state and final_state.ok:
                    print("✅ Now on Instagram home feed")
                    return True

            if final_state:
                print(f"⚠️ Home entry not locally verified after launcher success: {final_state.screen_type} ({final_state.confidence})")
            else:
                print("⚠️ Home entry not locally verified after launcher success: no local verification result")
            return False

        except Exception as e:
            print(f"⚠️ Error ensuring home feed: {e}")
            return False

    def _watch_story_human_like(self, base_duration=3.0):
        """
        Watch a story with human-like behavior:
        - Variable viewing time (0.8x to 1.5x base duration)
        - 15% chance to tap back to re-watch
        - 10% chance to pause briefly (like reading text)
        - Random micro-pauses
        """
        # Variable duration
        duration = base_duration * random.uniform(0.8, 1.5)

        # 10% chance to pause mid-story (simulating reading)
        if random.random() < 0.10:
            watch_first = duration * random.uniform(0.3, 0.6)
            time.sleep(watch_first)
            self._tap_pause_story()  # Hold to pause
            time.sleep(random.uniform(0.5, 1.5))  # "Reading" time
            self._tap_pause_story()  # Release
            time.sleep(duration - watch_first)
        else:
            time.sleep(duration)

        # 15% chance to tap back and re-watch
        if random.random() < 0.15:
            print("   Re-watching...")
            self._tap_prev_story()
            time.sleep(random.uniform(1.0, 2.5))

        return True

    def _tap_home_tab(self):
        """Navigate to home tab using Resource ID or coordinates"""
        if self.driver and SELECTORS_AVAILABLE:
            try:
                from appium.webdriver.common.appiumby import AppiumBy

                # Strategy 1: Resource ID
                el = self.driver.find_element(AppiumBy.ID, InstagramSelectors.HOME_TAB)
                el.click()
                print("   Home tab clicked (Resource ID)")
                return True
            except Exception as e:
                print(f"   Selector failed: {e}")

        # Fallback to coord
        x, y = self.STORY_COORDS["home_tab"]
        return self._tap_adb(x, y, "Home tab")

    def _tap_story_tray(self):
        """Tap on story tray container using Resource ID"""
        if self.driver and SELECTORS_AVAILABLE:
            try:
                from appium.webdriver.common.appiumby import AppiumBy

                # Try story tray container
                tray = self.driver.find_element(
                    AppiumBy.ID, InstagramSelectors.STORY_TRAY_CONTAINER
                )
                if tray:
                    print("   Found story tray container")
                    return True
            except:
                pass
        return False

    def _tap_story_by_index(self, index):
        """Tap a story by its index (0-3) using selectors or coordinates"""
        # Try selector-based tapping first if driver available
        if self.driver and SELECTORS_AVAILABLE:
            try:
                from appium.webdriver.common.appiumby import AppiumBy

                # Strategy 1: Find story containers (outer_container)
                containers = self.driver.find_elements(
                    AppiumBy.ID, InstagramSelectors.STORY_OUTER_CONTAINER
                )

                if len(containers) > index:
                    # Skip first if it's "Your story" (index 0)
                    target_index = index + 1  # Skip your story
                    if target_index < len(containers):
                        containers[target_index].click()
                        print(
                            f"   Tapped story {index + 1} (Resource ID: outer_container)"
                        )
                        return True

                # Strategy 2: Try avatar_container
                avatars = self.driver.find_elements(
                    AppiumBy.ID, InstagramSelectors.STORY_AVATAR_CONTAINER
                )
                if len(avatars) > index:
                    target_index = index + 1
                    if target_index < len(avatars):
                        avatars[target_index].click()
                        print(
                            f"   Tapped story {index + 1} (Resource ID: avatar_container)"
                        )
                        return True

            except Exception as e:
                print(f"   Selector tap failed, using coordinates: {e}")

        # Fallback to coordinate-based tap
        coord_keys = ["second", "third", "fourth"]  # Skip "first" (Your story)
        if index < len(coord_keys):
            x, y = self.STORY_COORDS[coord_keys[index]]
            return self._tap_adb(x, y, f"Tapping story {index + 1}")

        return False

    def view_stories(self, total_stories=1):
        """View stories with natural continuous flow.

        Real behavior: tap a story bubble, then tap through segments naturally
        (right-side taps), occasionally like, and exit when done. NOT back+home
        after every single story.

        Flow:
        1. Open first story bubble
        2. Tap through segments/users continuously
        3. Occasionally like (23-33% per story)
        4. Occasionally pause/re-watch (human behavior)
        5. Exit once done via back or swipe-down
        """
        try:
            print(f"📖 Starting to view {total_stories} stories...")

            print("🏠 Ensuring we're on Instagram home feed...")
            if not self._ensure_on_home_feed():
                print("❌ Could not verify home feed, refusing to proceed with story flow")
                return False

            stories_viewed = 0
            stories_liked = 0
            fatigue = 0

            # Open first viewable story (skip "Your story" at index 0)
            time.sleep(random.uniform(0.5, 1.2))
            if not self._tap_story_by_index(0):
                print("⚠️ Failed to open first story")
                return False

            time.sleep(random.uniform(1.5, 2.5))  # Wait for story to load

            viewer_state = self._verify_story_viewer_opened_soft()
            print(f"🔎 Story viewer: {viewer_state['state']} ({viewer_state['confidence']})")

            while stories_viewed < total_stories:
                stories_viewed += 1
                fatigue += random.uniform(0.02, 0.06)

                print(f"\n   Story {stories_viewed}/{total_stories}")

                # --- Human-like distraction pause (6%) ---
                if self.hb:
                    should_pause, pause_dur = self.hb.get_distraction_pause()
                    if should_pause:
                        print(f"   [distracted {pause_dur:.1f}s]")
                        time.sleep(pause_dur)
                elif random.random() < 0.06:
                    d = random.uniform(1.0, 2.5)
                    print(f"   [distracted {d:.1f}s]")
                    time.sleep(d)

                # --- Skip chance increases with fatigue ---
                skip_chance = (self.skip_chance / 100.0) + (fatigue * 0.15)
                if random.random() < skip_chance:
                    print("   [skipping quickly]")
                    time.sleep(random.uniform(0.3, 0.8))
                else:
                    # Normal viewing with variable duration
                    viewing_time = random.uniform(
                        self.viewing_time_min, self.viewing_time_max
                    )
                    # Reduce viewing time as fatigue builds
                    viewing_time *= max(0.6, 1 - fatigue)
                    print(f"   Watching for {viewing_time:.1f}s...")
                    time.sleep(viewing_time)

                    # 10% chance to pause (like reading text on story)
                    if random.random() < 0.10:
                        pause = random.uniform(0.5, 2.0)
                        print(f"   [reading text {pause:.1f}s]")
                        time.sleep(pause)

                # --- Like chance (decreases with fatigue) ---
                like_chance = random.randint(
                    self.like_chance_min, self.like_chance_max
                )
                effective_like = like_chance * max(0.4, 1 - fatigue)
                if random.randint(1, 100) <= effective_like:
                    print("   Liking...")
                    self._like_story()
                    stories_liked += 1
                    time.sleep(random.uniform(0.3, 0.8))

                # --- Re-watch chance (decreases with fatigue) ---
                if random.random() < (0.12 * max(0.3, 1 - fatigue)):
                    print("   [re-watching]")
                    self._tap_prev_story()
                    time.sleep(random.uniform(1.5, 3.0))
                    # Tap forward again
                    self._tap_next_story()
                    time.sleep(random.uniform(0.3, 0.6))

                # --- Advance to next story ---
                if stories_viewed < total_stories:
                    time.sleep(random.uniform(0.15, 0.5))
                    self._tap_next_story()
                    time.sleep(random.uniform(0.3, 0.8))

            # --- Exit story viewer ---
            print("   Exiting story viewer...")
            if random.random() < 0.35:
                # Swipe down (natural exit)
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "input", "swipe",
                     "540", "800", "540", "1800", "200"],
                    capture_output=True, timeout=3,
                )
            else:
                back_presses = random.choice([1, 1, 1, 2])
                for _ in range(back_presses):
                    subprocess.run(
                        ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                        capture_output=True, timeout=3,
                    )
                    time.sleep(0.3)

            time.sleep(random.uniform(0.8, 1.5))

            # Return to home
            self._tap_home_tab()
            time.sleep(1.5)
            exit_check = self._verify_safe_exit_soft()
            self._soft_recover_home_surface_if_needed(exit_check, "story exit check")

            like_percent = (
                (stories_liked / stories_viewed * 100) if stories_viewed > 0 else 0
            )
            print(
                f"✅ Completed: {stories_viewed} stories, liked {stories_liked} ({like_percent:.1f}%)"
            )

            if DISCORD_AVAILABLE:
                get_notifier().success(
                    "📖 Stories Viewed",
                    f"Viewed: {stories_viewed} | Liked: {stories_liked} ({like_percent:.0f}%)",
                )

            return True

        except Exception as e:
            print(f"❌ Operation failed: {e}")
            if hasattr(self, "_handle_appium_error") and self._handle_appium_error(
                e, "view_stories"
            ):
                return True
            # Emergency recovery
            self._ensure_home_and_recover()
            return False

    def _ensure_instagram_focused(self):
        """Check if Instagram is currently focused/active with enhanced detection"""
        try:
            # Method 1: Check current focus
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "dumpsys", "window", "windows"],
                capture_output=True,
                text=True,
                timeout=10,
            )

            if result.returncode == 0:
                lines = result.stdout.split("\n")
                for line in lines:
                    if (
                        "mCurrentFocus" in line or "mFocusedApp" in line
                    ) and "com.instagram.android" in line:
                        print("✅ Instagram is focused (window focus)")
                        return True

            # Method 2: Check foreground activity
            result2 = subprocess.run(
                [
                    "adb",
                    "-s",
                    self.device_id,
                    "shell",
                    "dumpsys",
                    "activity",
                    "activities",
                ],
                capture_output=True,
                text=True,
                timeout=5,
            )

            if result2.returncode == 0:
                # Check topResumedActivity first; it is the most reliable
                # signal when another app/browser was opened from a story.
                for line in result2.stdout[:3000].split("\n"):
                    if "topResumedActivity" in line:
                        if "com.instagram.android" in line:
                            print("Instagram is focused (top resumed activity)")
                            return True
                        print("Another app is top resumed")
                        return False

                # Fallback: check the top task slice only.
                if "com.instagram.android" in result2.stdout[:1500]:
                    print("Instagram is focused (foreground task)")
                    return True

            # Method 3: Check running processes and bring to foreground
            result3 = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "ps", "-A"],
                capture_output=True,
                text=True,
                timeout=5,
            )

            if result3.returncode == 0:
                if "com.instagram.android" in result3.stdout:
                    print("⚠️ Instagram is running but may not be focused")
                    subprocess.run(
                        [
                            "adb",
                            "-s",
                            self.device_id,
                            "shell",
                            "am",
                            "start",
                            "-n",
                            "com.instagram.android/.activity.MainTabActivity",
                        ],
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                    time.sleep(2)
                    return True

            print("❌ Instagram is not focused or running")
            return False

        except Exception as e:
            print(f"❌ Error checking Instagram focus: {e}")
            return False

    def _relaunch_instagram(self):
        """Relaunch Instagram app with enhanced reliability"""
        try:
            print("🚀 Relaunching Instagram...")

            # Force close Instagram first
            subprocess.run(
                [
                    "adb",
                    "-s",
                    self.device_id,
                    "shell",
                    "am",
                    "force-stop",
                    "com.instagram.android",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )

            time.sleep(3)

            # Launch commands with fallbacks
            launch_commands = [
                [
                    "adb",
                    "-s",
                    self.device_id,
                    "shell",
                    "am",
                    "start",
                    "-n",
                    "com.instagram.android/.activity.MainTabActivity",
                ],
                [
                    "adb",
                    "-s",
                    self.device_id,
                    "shell",
                    "am",
                    "start",
                    "-n",
                    "com.instagram.android/.activity.UrlHandlerActivity",
                ],
                [
                    "adb",
                    "-s",
                    self.device_id,
                    "shell",
                    "monkey",
                    "-p",
                    "com.instagram.android",
                    "-c",
                    "android.intent.category.LAUNCHER",
                    "1",
                ],
            ]

            for i, cmd in enumerate(launch_commands):
                print(f"🔄 Launch attempt {i + 1}/3...")
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)

                if result.returncode == 0:
                    time.sleep(6)

                    if self._ensure_instagram_focused():
                        print("✅ Instagram relaunched successfully")
                        return True
                    else:
                        print(
                            f"⚠️ Launch attempt {i + 1} succeeded but Instagram not focused"
                        )
                        time.sleep(2)
                else:
                    print(f"⚠️ Launch attempt {i + 1} failed: {result.stderr}")
                    time.sleep(1)

            print("❌ All launch attempts failed")
            return False

        except Exception as e:
            print(f"❌ Error relaunching Instagram: {e}")
            return False

    def _like_story(self):
        """Tap heart button to like story using selector or coordinates"""
        try:
            # Try selector first if driver available
            if self.driver and SELECTORS_AVAILABLE:
                try:
                    from appium.webdriver.common.appiumby import AppiumBy

                    # Strategy 1: VERIFIED Resource ID (toolbar_like_button)
                    btn = self.driver.find_element(
                        AppiumBy.ID, InstagramSelectors.STORY_LIKE_BUTTON
                    )
                    btn.click()
                    print("   Liked via Resource ID: toolbar_like_button")
                    return True
                except:
                    pass

                try:
                    # Strategy 2: Accessibility ID "Like"
                    btn = self.driver.find_element(AppiumBy.ACCESSIBILITY_ID, "Like")
                    btn.click()
                    print("   Liked via Accessibility ID")
                    return True
                except:
                    pass

                try:
                    # Strategy 3: toolbar_like_container
                    btn = self.driver.find_element(
                        AppiumBy.ID, InstagramSelectors.STORY_LIKE_CONTAINER
                    )
                    btn.click()
                    print("   Liked via Resource ID: toolbar_like_container")
                    return True
                except:
                    pass

            # Fallback to coordinate tap
            x, y = self.STORY_COORDS["heart"]
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "tap", str(x), str(y)],
                capture_output=True,
                text=True,
                timeout=3,
            )
            if result.returncode == 0:
                print(f"   Liked via coordinates ({x}, {y})")
                return True

        except Exception as e:
            print(f"   Like error: {e}")
        return False

    def get_story_count(self):
        """Get count of visible stories using selectors"""
        if not self.driver or not SELECTORS_AVAILABLE:
            return None  # Can't determine without driver

        try:
            from appium.webdriver.common.appiumby import AppiumBy

            containers = self.driver.find_elements(
                AppiumBy.ID, InstagramSelectors.STORY_OUTER_CONTAINER
            )

            # First container is "Your story", so subtract 1
            return max(0, len(containers) - 1)
        except:
            return None

    def view_stories_human(self, total_stories=5):
        """
        View stories with ULTRA human-like behavior

        Enhanced behaviors:
        - Variable viewing time based on content type estimation
        - Random chance to skip boring stories quickly
        - Double-tap like gesture (more natural than button)
        - Occasional pauses like reading text
        - Random "distraction" pauses (simulating multitasking)
        - Fatigue simulation (slower towards end)
        - Natural exit patterns
        """
        try:
            # Randomize actual count slightly (±20%)
            variance = random.uniform(0.8, 1.2)
            actual_count = max(1, int(total_stories * variance))
            print(f"   Starting human-like story viewing ({actual_count} stories)...")

            # FIXED: Ensure we're on Instagram home feed first (not random screen)
            print("🏠 Ensuring we're on Instagram home feed...")
            if not self._ensure_on_home_feed():
                print("❌ Could not verify home feed, refusing to proceed with story flow")
                return False

            # Tap first viewable story (index 0 = second bubble, skipping "Your story")
            # Random delay before starting (like scrolling feed first)
            time.sleep(random.uniform(0.5, 1.5))

            if not self._tap_story_by_index(0):
                print("   Failed to open first story")
                return False

            time.sleep(random.uniform(1.5, 2.5))  # Variable load time

            stories_viewed = 0
            stories_liked = 0
            stories_skipped = 0

            # Fatigue factor - decreases engagement over time
            fatigue = 0

            while stories_viewed < actual_count:
                stories_viewed += 1

                # HUMAN BEHAVIOR: Update fatigue via centralized system
                if self.hb:
                    self.hb.add_fatigue("story_view")
                    fatigue = self.hb.fatigue_level
                else:
                    fatigue += random.uniform(0.02, 0.05)  # Gradually tire

                print(f"   Story {stories_viewed}/{actual_count}")

                # HUMAN BEHAVIOR: Use centralized distraction pauses
                if self.hb:
                    should_pause, pause_duration = self.hb.get_distraction_pause()
                    if should_pause:
                        print(f"   [distracted {pause_duration:.1f}s]")
                        time.sleep(pause_duration)
                elif random.random() < 0.08:
                    # Fallback: 8% chance to get "distracted" (brief pause)
                    distract_time = random.uniform(1, 2)
                    print(f"   [distracted {distract_time:.1f}s]")
                    time.sleep(distract_time)

                # Configurable skip chance + fatigue bonus
                skip_chance = (self.skip_chance / 100.0) + (
                    fatigue * 0.2
                )  # More skips when tired
                if random.random() < skip_chance:
                    print("   [skipping quickly]")
                    time.sleep(random.uniform(0.3, 0.8))
                    stories_skipped += 1
                else:
                    # Normal viewing with human-like behavior
                    # Base time varies by "content type" estimation
                    content_types = [
                        (2.0, 3.5, "quick"),  # 40% - quick glance
                        (3.5, 5.5, "normal"),  # 35% - normal viewing
                        (5.5, 8.0, "engaged"),  # 20% - really watching
                        (8.0, 12.0, "deep"),  # 5% - very engaged
                    ]
                    roll = random.random()
                    if roll < 0.40:
                        base_min, base_max, _ = content_types[0]
                    elif roll < 0.75:
                        base_min, base_max, _ = content_types[1]
                    elif roll < 0.95:
                        base_min, base_max, _ = content_types[2]
                    else:
                        base_min, base_max, _ = content_types[3]

                    watch_time = random.uniform(base_min, base_max)
                    # Reduce time when fatigued
                    watch_time *= max(0.6, 1 - fatigue)

                    self._watch_story_human_like(watch_time)

                # Like probability decreases with fatigue (configurable)
                base_like = self.base_like_chance / 100.0  # Convert from % to 0-1
                like_chance = base_like * max(0.4, 1 - fatigue)

                if random.random() < like_chance:
                    # 70% use heart button, 30% double-tap center
                    if random.random() < 0.70:
                        print("   Liking...")
                        self._like_story()
                    else:
                        print("   Double-tap like...")
                        x, y = 540, random.randint(900, 1200)
                        self._tap_adb(x, y)
                        time.sleep(0.15)
                        self._tap_adb(
                            x + random.randint(-20, 20), y + random.randint(-20, 20)
                        )

                    stories_liked += 1
                    time.sleep(random.uniform(0.3, 1.0))

                # 15% chance to re-watch (decreases with fatigue)
                if random.random() < (0.15 * max(0.3, 1 - fatigue)):
                    print("   Re-watching...")
                    self._tap_prev_story()
                    time.sleep(random.uniform(1.5, 3.0))

                # Tap to next story (if not last)
                if stories_viewed < actual_count:
                    # Variable tap timing
                    time.sleep(random.uniform(0.2, 0.6))
                    self._tap_next_story()
                    time.sleep(random.uniform(0.3, 0.8))

            # Exit - sometimes swipe down, sometimes back button
            print("   Exiting story viewer...")
            if random.random() < 0.3:
                # Swipe down to exit (more natural)
                subprocess.run(
                    [
                        "adb",
                        "-s",
                        self.device_id,
                        "shell",
                        "input",
                        "swipe",
                        "540",
                        "800",
                        "540",
                        "1800",
                        "200",
                    ],
                    capture_output=True,
                    timeout=3,
                )
            else:
                # Back button
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                    capture_output=True,
                    timeout=3,
                )

            time.sleep(random.uniform(0.8, 1.5))

            # Return to home
            self._tap_home_tab()

            like_pct = (
                (stories_liked / stories_viewed * 100) if stories_viewed > 0 else 0
            )
            print(
                f"   Completed: {stories_viewed} stories, {stories_liked} liked ({like_pct:.0f}%), {stories_skipped} skipped"
            )
            return True

        except Exception as e:
            print(f"   Human story viewing failed: {e}")
            # Emergency recovery to home screen
            print("   🔄 Attempting recovery to home screen...")
            self._ensure_home_and_recover()
            return False


if __name__ == "__main__":
    story_viewer = InstagramStoryViewer()
    print("Story Viewer Modes:")
    print("1 - Regular batch viewing")
    print("2 - Human-like viewing (recommended)")

    mode = input("Choose mode (1/2): ").strip() or "2"
    story_count = int(input("How many stories to view? ") or "6")

    if mode == "2":
        story_viewer.view_stories_human(story_count)
    else:
        story_viewer.view_stories(story_count)
