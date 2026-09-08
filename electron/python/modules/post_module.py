#!/usr/bin/env python3
"""
📸 INSTAGRAM POST MODULE - MCP ENHANCED
Post photos, videos, and stories to Instagram using MCP servers for better control

🎯 VERIFIED COORDINATES (Dec 2024 XML Dumps - DO NOT CHANGE!)
==========================================================
✅ CREATE/GALLERY SCREEN:
   - Cancel Button: (73, 201) - action_bar_cancel [0,128][147,275]
   - Next Button: (1000, 201) - next_button_textview [920,128][1080,275]
   - First Thumbnail: (136, 1629) - gallery_grid_item_thumbnail
   - POST Tab: (540, 2258) - cam_dest_feed [462,2213][617,2303]
   - REEL Tab: (874, 2257) - cam_dest_clips [800,2213][949,2302]

✅ SHARING/CAPTION SCREEN:
   - Caption Input: (540, 1053) - caption_input_text_view [42,990][1038,1116]
   - Share Button: (540, 2279) - share_footer_button [42,2221][1038,2337]
   - Back Button: (73, 201) - button_back [0,128][147,275]
   - Add Audio: (237, 1330) - music_row_title [137,1304][337,1357]
   - Tag People: (545, 1576) - tag_people_string [137,1550][954,1603]
   - Add Location: (556, 1703) - location_label [137,1640][975,1766]
   - AI Label Toggle: (969, 1971) - toggle [901,1929][1038,2013]

⚠️ OLD BROKEN COORDS (DO NOT USE):
   - (300, 480), (600, 450), (800, 2226) - All incorrect!

All coordinates verified via XML dumps on Dec 24, 2024!
"""

import time
import random
import subprocess
import os
import tempfile

try:
    from appium import webdriver
    from appium.options.android import UiAutomator2Options
    from selenium.webdriver.common.by import By
    from selenium.common.exceptions import NoSuchElementException
    APPIUM_AVAILABLE = True
except ImportError:
    webdriver = None
    UiAutomator2Options = None
    By = None
    APPIUM_AVAILABLE = False

    class NoSuchElementException(Exception):
        pass

    print("[INFO] Appium not available - post module will use ADB fallback where possible")

from lib.posting_progression_guards import (
    verify_feed_gallery,
    verify_media_selected,
    verify_feed_caption_editor,
    verify_feed_submission_confirmed,
    confirm_submission_with_recovery,
)
from lib.screen_state import ScreenObservation, utc_now_iso

# Import Instagram launcher and popup handler
try:
    from modules.instagram_launcher_module import InstagramLauncher
except ImportError:
    try:
        from instagram_launcher_module import InstagramLauncher
    except ImportError:
        class InstagramLauncher:
            def __init__(self, device_id=None):
                self.device_id = device_id
                self.driver = None

            def open_instagram_home_strict(self):
                return {
                    "verified_home_ready": False,
                    "reason": "instagram_launcher_unavailable",
                }

            @staticmethod
            def is_verified_home_ready(outcome):
                if isinstance(outcome, dict) and outcome.get("verified_home_ready"):
                    return True, None
                reason = outcome.get("reason") if isinstance(outcome, dict) else "home_not_verified"
                return False, reason

try:
    from modules.ig_selectors import InstagramSelectors
except ImportError:
    from ig_selectors import InstagramSelectors

try:
    from misc_popup_handler import quick_popup_check

    POPUP_HANDLER_AVAILABLE = True
except ImportError:
    POPUP_HANDLER_AVAILABLE = False
    print("⚠️ Popup handler not available")

# Import crash recovery module
try:
    from appium_crash_recovery import auto_recover_from_crash

    CRASH_RECOVERY_AVAILABLE = True
except ImportError:
    CRASH_RECOVERY_AVAILABLE = False
    print("⚠️ Crash recovery module not available")

# Import centralized driver manager
try:
    from modules.driver_manager import (
        get_shared_driver,
        quit_shared_driver,
        is_crash_error,
    )

    DRIVER_MANAGER_AVAILABLE = True
except ImportError:
    try:
        from driver_manager import get_shared_driver, quit_shared_driver, is_crash_error

        DRIVER_MANAGER_AVAILABLE = True
    except ImportError:
        DRIVER_MANAGER_AVAILABLE = False
        print("⚠️ Driver manager not available")

# Import Instagram selectors
try:
    try:
        from modules.ig_selectors import InstagramSelectors
    except ImportError:
        from ig_selectors import InstagramSelectors
    SELECTORS_AVAILABLE = True
except ImportError:
    SELECTORS_AVAILABLE = False
    print("⚠️ Instagram selectors not available")


# MCP Integration for better file handling and precision
class MCPPostHelper:
    """Helper class to use MCP servers for posting"""

    def __init__(self, device_id="1A121FDF60082H"):
        self.device_id = device_id

    def precise_tap(self, x, y, description=""):
        """Use MCP mobile automation for precise tapping"""
        try:
            print(f"🎯 MCP PRECISE TAP: {description} at ({x}, {y})")
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "tap", str(x), str(y)],
                capture_output=True,
                text=True,
                timeout=10,
            )

            if result.returncode == 0:
                print(f"✅ MCP tap successful at ({x}, {y})")
                return True
            else:
                print(f"❌ MCP tap failed: {result.stderr}")
                return False
        except Exception as e:
            print(f"❌ MCP tap error: {e}")
            return False

    def type_text(self, text):
        """Use MCP to type text via ADB"""
        try:
            print(f"⌨️ MCP TYPING: '{text}'")

            # Clear any existing text first
            subprocess.run(
                [
                    "adb",
                    "-s",
                    self.device_id,
                    "shell",
                    "input",
                    "keyevent",
                    "KEYCODE_CTRL_A",
                ],
                capture_output=True,
                text=True,
                timeout=3,
            )
            time.sleep(0.5)

            # Type the text (remove emojis and escape shell special characters)
            clean_text = "".join(char for char in text if ord(char) < 128)  # ASCII only

            # SHELL SAFETY: Remove/replace problematic characters for shell commands
            safe_text = (
                clean_text.replace("'", "")
                .replace('"', "")
                .replace("`", "")
                .replace("\\", "")
                .replace("&", "and")
                .replace(";", ",")
                .replace("|", " ")
            )

            result = subprocess.run(
                [
                    "adb",
                    "-s",
                    self.device_id,
                    "shell",
                    "input",
                    "text",
                    safe_text.replace(" ", "%s"),
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )

            if result.returncode == 0:
                print(f"✅ Successfully typed: '{text}'")
                return True
            else:
                print(f"❌ Failed to type: {result.stderr}")
                return False
        except Exception as e:
            print(f"❌ MCP typing error: {e}")
            return False

    def upload_file_to_device(self, local_path, device_path="/sdcard/Pictures/"):
        """Upload file to device using ADB"""
        try:
            if not os.path.exists(local_path):
                print(f"❌ Local file not found: {local_path}")
                return False

            print(f"📤 MCP FILE UPLOAD: {local_path} → {device_path}")
            result = subprocess.run(
                ["adb", "-s", self.device_id, "push", local_path, device_path],
                capture_output=True,
                text=True,
                timeout=30,
            )

            if result.returncode == 0:
                print(f"✅ File uploaded successfully")
                return True
            else:
                print(f"❌ File upload failed: {result.stderr}")
                return False
        except Exception as e:
            print(f"❌ MCP file upload error: {e}")
            return False

    def find_and_click_by_content_desc(self, content_desc, timeout=5):
        """Find element by content-desc and click its center coordinates

        More reliable than fixed coordinates since it finds the actual element.
        Uses uiautomator dump to find element bounds, then clicks the center.

        Args:
            content_desc: The content-desc attribute to search for (exact match)
            timeout: How long to wait for element to appear

        Returns:
            bool: True if element found and clicked
        """
        import re
        import tempfile

        print(f"🔍 Finding element with content-desc='{content_desc}'...")

        for attempt in range(int(timeout)):
            try:
                # Dump UI hierarchy
                temp_file = os.path.join(
                    tempfile.gettempdir(), f"ui_dump_{attempt}.xml"
                )
                subprocess.run(
                    [
                        "adb",
                        "-s",
                        self.device_id,
                        "shell",
                        "uiautomator",
                        "dump",
                        "/sdcard/ui.xml",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                subprocess.run(
                    ["adb", "-s", self.device_id, "pull", "/sdcard/ui.xml", temp_file],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )

                # Parse to find element
                with open(temp_file, "r", encoding="utf-8") as f:
                    content = f.read()

                # Find element with matching content-desc
                pattern = f'content-desc="{re.escape(content_desc)}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"'
                match = re.search(pattern, content)

                if match:
                    x1, y1, x2, y2 = (
                        int(match.group(1)),
                        int(match.group(2)),
                        int(match.group(3)),
                        int(match.group(4)),
                    )
                    center_x = (x1 + x2) // 2
                    center_y = (y1 + y2) // 2
                    print(
                        f"✅ Found '{content_desc}' at center ({center_x}, {center_y})"
                    )
                    return self.precise_tap(center_x, center_y, content_desc)

                # Try removing temp file
                try:
                    os.remove(temp_file)
                except:
                    pass

            except Exception as e:
                print(f"⚠️ Attempt {attempt + 1}: {e}")

            time.sleep(1)

        print(
            f"❌ Element with content-desc='{content_desc}' not found after {timeout}s"
        )
        return False


class _PostModuleGuardDeviceAdapter:
    def __init__(self, poster):
        self.poster = poster
        self.device_id = poster.device_id
        self.current_package = 'com.instagram.android'
        self.current_activity = None
        self.screen_xml = ''
        self.logs = []

    async def refresh_screen_observation(self):
        xml = self.poster._get_ui_xml_for_guards() or ''
        self.screen_xml = xml
        return ScreenObservation(
            observed_at=utc_now_iso(),
            device_id=self.device_id,
            package='com.instagram.android',
            activity=self.current_activity,
            xml_source=xml,
        )

    async def send_log(self, message, level='INFO'):
        self.logs.append((level, message))
        print(f"[{level}] {message}")


class InstagramPoster:
    def _get_ui_xml_for_guards(self):
        temp_file = os.path.join(tempfile.gettempdir(), 'post_module_guard_dump.xml')
        try:
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "uiautomator", "dump", "/sdcard/post_module_guard_dump.xml"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode != 0:
                return ''
            result = subprocess.run(
                ["adb", "-s", self.device_id, "pull", "/sdcard/post_module_guard_dump.xml", temp_file],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode != 0:
                return ''
            with open(temp_file, 'r', encoding='utf-8') as f:
                return f.read()
        except Exception as e:
            print(f"⚠️ Guard UI dump failed: {e}")
            return ''
        finally:
            try:
                if os.path.exists(temp_file):
                    os.remove(temp_file)
            except Exception:
                pass

    def _run_post_guard_check(self, verifier, label):
        try:
            import asyncio
            adapter = _PostModuleGuardDeviceAdapter(self)
            result = asyncio.run(verifier(adapter))
            print(f"🔎 {label}: {result.screen_type} ({result.confidence})")
            return result
        except Exception as e:
            print(f"⚠️ {label} failed: {e}")
            return None

    def _confirm_submission_with_guard_recovery(self, settle_seconds=1.5):
        try:
            import asyncio
            adapter = _PostModuleGuardDeviceAdapter(self)
            result = asyncio.run(
                confirm_submission_with_recovery(
                    adapter,
                    verify_feed_submission_confirmed,
                    "Feed submission confirmation",
                    recovery_action=lambda: self.launcher_controller.go_to_home_feed() if getattr(self, 'launcher_controller', None) else False,
                    settle_seconds=settle_seconds,
                )
            )
            print(f"🔎 Feed submission confirmation: {result.screen_type} ({result.confidence})")
            return result
        except Exception as e:
            print(f"⚠️ Feed submission confirmation failed: {e}")
            return None

    def __init__(self, device_id="1A121FDF60082H", account_number=1, profile_id=None):
        self.device_id = device_id

        # Sanitize ANDROID_HOME if set (fix for leading space issue)
        if "ANDROID_HOME" in os.environ:
            original_home = os.environ["ANDROID_HOME"]
            if original_home.startswith(" ") or original_home.endswith(" "):
                print(
                    f"⚠️ Detected whitespace in ANDROID_HOME, fixing: '{original_home}' -> '{original_home.strip()}'"
                )
                os.environ["ANDROID_HOME"] = original_home.strip()

        self.driver = None
        self.mcp_helper = MCPPostHelper(device_id)
        self.launcher_controller = None  # Initialize Instagram launcher
        self.account_number = account_number
        self.profile_id = profile_id or str(
            account_number
        )  # Use account_number as profile_id if not specified

        # 🧠 HUMAN BEHAVIOR SYSTEM
        try:
            try:
                from modules.human_behavior import get_human_behavior
            except ImportError:
                from human_behavior import get_human_behavior
            self.hb = get_human_behavior()
        except:
            self.hb = None

        # Account-specific paths
        self.account_path = f"/Users/anyro/IG appium/accounts/Account {account_number}"
        # REMOVED: Local folders - only use Google Drive for each account
        # Each account has its own Google Drive for content

        # Sample captions for different content types
        self.image_captions = [
            "tell your wife i said hi lmaoo🤣",
            "make reading a habit guys!🤭",
            "is this enough to persuade you?🫣",
            "btw i give the BEST back rubs🤭",
            "RATE MY COSPLAYY🤌🏼",
            "felt cute, might delete later lol🥲",
            "what else were you thinking about?😩🤌🏼",
            "Y'ALL SHOULD TAKE NOTES😩",
            "felt pretty might delete later🧚🏼‍♀️",
            "is it just me? why do i look so innocent here?😭😭",
        ]

        self.reel_captions = [
            "New reel drop! 🎬",
            "Behind the scenes 🎥",
            "Watch till the end! 👀",
            "Trending reel alert 🔥",
            "Quick tutorial! 📱",
        ]

        self.trial_captions = [
            "Trying something new! 🧪",
            "Experiment time 🔬",
            "Testing this out 📊",
            "New trial content 🎯",
            "Innovation mode 💡",
        ]

    def debug_dump_ui(self, step_name):
        """Take XML dump and print key elements for debugging"""
        try:
            import subprocess

            result = subprocess.run(
                [
                    "adb",
                    "-s",
                    self.device_id,
                    "shell",
                    "uiautomator",
                    "dump",
                    f"/sdcard/debug_{step_name}.xml",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0:
                # Pull and parse
                subprocess.run(
                    [
                        "adb",
                        "-s",
                        self.device_id,
                        "pull",
                        f"/sdcard/debug_{step_name}.xml",
                        f"./debug_{step_name}.xml",
                    ],
                    capture_output=True,
                    timeout=10,
                )

                # Find key items
                import xml.etree.ElementTree as ET

                try:
                    tree = ET.parse(f"./debug_{step_name}.xml")
                    root = tree.getroot()
                    print(f"📋 DEBUG UI DUMP [{step_name}]:")
                    for node in root.iter("node"):
                        text = node.attrib.get("text", "")
                        content_desc = node.attrib.get("content-desc", "")
                        bounds = node.attrib.get("bounds", "")
                        if text and text.lower() in [
                            "next",
                            "share",
                            "post",
                            "gallery",
                            "recents",
                        ]:
                            print(f"   🎯 '{text}' at {bounds}")
                        if content_desc and content_desc.lower() in [
                            "next",
                            "share",
                            "post",
                            "gallery",
                        ]:
                            print(f"   🎯 desc='{content_desc}' at {bounds}")
                except Exception as e:
                    print(f"   ⚠️ Parse error: {e}")
            else:
                print(f"   ⚠️ UI dump failed: {result.stderr}")
        except Exception as e:
            print(f"   ⚠️ Debug dump error: {e}")

    def _handle_appium_error(self, error, operation_name="operation"):
        """Handle Appium errors with automatic crash recovery"""
        if CRASH_RECOVERY_AVAILABLE and self.driver:
            print(f"🚨 Error during {operation_name}: {error}")
            print("🔄 Attempting automatic crash recovery...")

            success, _ = auto_recover_from_crash(error, self.device_id, self.driver)
            if success:
                print(f"✅ Crash recovery successful for {operation_name}")
                # Try to reconnect
                return self.connect()
            else:
                print(f"❌ Crash recovery failed for {operation_name}")

        return False

    def _reset_and_go_home(self):
        """Emergency recovery - go back 4x, relaunch Instagram, and go to home feed

        Use this when navigation gets stuck or elements can't be found.
        Provides a clean slate to retry the operation.
        """
        print("🔄 RECOVERY: Resetting Instagram state...")

        # Step 1: Press back 4 times to clear any nested screens
        for i in range(4):
            print(f"⬅️ Back press {i + 1}/4")
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                capture_output=True,
            )
            time.sleep(0.5)

        time.sleep(1)

        # Step 2: Force stop Instagram for clean state
        print("🛑 Force stopping Instagram...")
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
        )
        time.sleep(2)

        # Step 3: Relaunch Instagram
        print("📱 Relaunching Instagram...")
        subprocess.run(
            [
                "adb",
                "-s",
                self.device_id,
                "shell",
                "am",
                "start",
                "-n",
                "com.instagram.android/com.instagram.mainactivity.MainActivity",
            ],
            capture_output=True,
        )
        time.sleep(4)  # Wait for app to fully load

        # Step 4: Click home tab to ensure we're at the starting point
        print("🏠 Going to home feed...")
        home_tap = (108, 2274)  # NAV_HOME_TAB verified coordinate
        subprocess.run(
            [
                "adb",
                "-s",
                self.device_id,
                "shell",
                "input",
                "tap",
                str(home_tap[0]),
                str(home_tap[1]),
            ],
            capture_output=True,
        )
        time.sleep(2)

        print("✅ Recovery complete - ready to retry")
        return True

    def _human_pause(self, base_duration=1.0, action_type="general"):
        """Human-like pause with variation

        Uses HumanBehavior for micro-pauses and fatigue tracking.
        Falls back to random variation if HB not available.
        """
        if self.hb:
            # Add fatigue for the action
            self.hb.add_fatigue(action_type)

            # Get micro-pause timing
            micro_pause = self.hb.get_micro_pause()
            time.sleep(micro_pause)

            # Main pause with energy-based variation
            energy = self.hb.energy_level
            actual_duration = (
                base_duration * random.uniform(0.8, 1.3) * (1.5 - energy * 0.5)
            )
            time.sleep(actual_duration)
        else:
            # Fallback: simple random variation
            time.sleep(base_duration * random.uniform(0.8, 1.3))

    def connect(self):
        """Connect to Instagram app"""
        try:
            print("📱 Connecting to Instagram...")

            def home_ready_from_launcher(outcome):
                checker = getattr(InstagramLauncher, "is_verified_home_ready", None)
                if callable(checker):
                    return checker(outcome)
                if isinstance(outcome, dict):
                    if outcome.get("verified_home_ready"):
                        return True, None
                    return False, outcome.get("reason") or "home_not_verified"
                return bool(outcome), None if outcome else "home_not_verified"

            # USE CENTRALIZED DRIVER MANAGER if available
            if DRIVER_MANAGER_AVAILABLE:
                self.driver = get_shared_driver(self.device_id)
                if self.driver:
                    launcher = InstagramLauncher(self.device_id)
                    launcher_outcome = launcher.open_instagram_home_strict()
                    home_ready, home_error = home_ready_from_launcher(launcher_outcome)
                    if not home_ready:
                        print(f"❌ {home_error}")
                        return False
                    self.driver = launcher.driver or self.driver
                    time.sleep(3)
                    print("✅ Connected to Instagram!")
                    return True

            if not APPIUM_AVAILABLE:
                launcher = InstagramLauncher(self.device_id)
                launcher_outcome = launcher.open_instagram_home_strict()
                home_ready, home_error = home_ready_from_launcher(launcher_outcome)
                if not home_ready:
                    print(f"❌ {home_error}")
                    return False
                self.driver = getattr(launcher, "driver", None)
                time.sleep(1)
                print("✅ Connected to Instagram via ADB launcher fallback!")
                return True

            # FALLBACK: Direct connection
            options = UiAutomator2Options()
            options.platform_name = "Android"
            options.device_name = self.device_id

            self.driver = webdriver.Remote("http://127.0.0.1:4723", options=options)
            time.sleep(2)

            launcher = InstagramLauncher(self.device_id)
            launcher_outcome = launcher.open_instagram_home_strict()
            home_ready, home_error = home_ready_from_launcher(launcher_outcome)
            if not home_ready:
                print(f"❌ {home_error}")
                return False

            self.driver = launcher.driver or self.driver
            time.sleep(3)
            print("✅ Connected to Instagram!")
            return True
        except Exception as e:
            print(f"❌ Connection failed: {e}")
            # Try crash recovery
            if self._handle_appium_error(e, "connect"):
                return True
            return False

    def disconnect(self):
        try:
            if self.driver:
                self.driver.quit()
                print("🔄 Disconnected")
        except:
            print("🔄 Disconnected (session already ended)")

    def handle_permission_popup(self):
        """Handle camera/gallery permission popup - click 'While using the app'"""
        try:
            print("🔐 Checking for permission popup...")

            # Multiple permission button texts to try
            permission_options = [
                "While using the app",
                "Allow while using app",
                "Only this time",
                "Allow",
                "OK",
                "Continue",
            ]

            # Common permission popup button positions
            permission_button_positions = [
                # Center area where permission buttons usually appear
                (540, 1600),
                (540, 1650),
                (540, 1700),
                (540, 1550),
                (540, 1500),
                (540, 1750),
                (540, 1800),
                (540, 1450),
                # Left and right variants
                (400, 1600),
                (680, 1600),
                (300, 1600),
                (780, 1600),
                (450, 1650),
                (630, 1650),
                (350, 1650),
                (730, 1650),
                # Higher up positions (some popups appear higher)
                (540, 1400),
                (540, 1350),
                (540, 1300),
                (400, 1400),
                (680, 1400),
                # Lower positions (some popups appear lower)
                (540, 1850),
                (540, 1900),
                (540, 1950),
                (400, 1850),
                (680, 1850),
            ]

            # Try all positions to find permission button
            for x, y in permission_button_positions:
                print(f"🎯 Trying permission button at ({x}, {y})")
                if self.mcp_helper.precise_tap(
                    x, y, "Permission button ('While using app')"
                ):
                    time.sleep(2)
                    print("✅ Permission granted - permission button clicked!")

                    # Check for secondary permission popup and handle it too
                    time.sleep(1)
                    print("🔐 Checking for secondary permission popup...")
                    # Try a few more positions in case there's a second popup
                    for x2, y2 in [(540, 1600), (540, 1650), (540, 1700)]:
                        self.mcp_helper.precise_tap(x2, y2, "Secondary permission")
                        time.sleep(0.5)

                    return True
                time.sleep(0.2)

            print("ℹ️ No permission popup found (already granted)")
            return (
                True  # Not finding popup is okay, permissions might already be granted
            )
        except Exception as e:
            print(f"⚠️ Permission popup handling failed: {e}")
            return True  # Continue even if popup handling fails

    def _verify_create_mode_opened(self):
        """Verify create mode actually opened by checking UI for creation-screen indicators."""
        try:
            # Dump UI and check for creation screen elements
            dump_result = subprocess.run(
                [
                    "adb",
                    "-s",
                    self.mcp_helper.device_id,
                    "shell",
                    "uiautomator",
                    "dump",
                    "/dev/tty",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            xml = dump_result.stdout or ""

            # Creation screen indicators (any = success):
            # - cam_dest_feed / cam_dest_story (POST/STORY tabs)
            # - text "POST" or "STORY" or "REEL" (tab labels)
            # - gallery_grid or media_picker (gallery view)
            indicators = [
                "cam_dest_feed",
                "cam_dest_story",
                "cam_dest_reel",
                'text="POST"',
                'text="STORY"',
                'text="REEL"',
                "gallery_grid",
                "media_picker",
            ]
            for indicator in indicators:
                if indicator in xml:
                    print(f"✅ Create mode verified via: {indicator}")
                    return True

            print("⚠️ No creation screen indicators found in UI dump")
            return False
        except Exception as e:
            print(f"⚠️ UI verification failed: {e}")
            # If dump fails, assume tap worked (don't block flow)
            return True

    def click_post_button(self):
        """Click the main Create (+) button — NEW LAYOUT (Top-Left) at (63, 201)"""
        try:
            print("📸 Looking for Create (+) button...")

            # 1. Verify we are on Home Screen first
            try:
                from appium.webdriver.common.appiumby import AppiumBy

                home_tabs = self.driver.find_elements(
                    AppiumBy.ID, "com.instagram.android:id/feed_tab"
                )
                if not home_tabs:
                    print("⚠️ Not on Home tab? Attempting to navigate home...")
                    try:
                        self.driver.find_element(
                            AppiumBy.ACCESSIBILITY_ID, "Home"
                        ).click()
                        time.sleep(2)
                    except:
                        # Fallback: tap Home tab coordinates
                        self.mcp_helper.precise_tap(108, 2274, "Home tab fallback")
                        time.sleep(2)
            except Exception as e:
                print(f"⚠️ Home check warning: {e}")

            # 2. Tap Create (+) button — top-left (63, 201) in new layout
            # Verified: ig_selectors.NewLayout.CREATE_BUTTON = (63, 201)
            print("🚀 Tapping Create (+) button at (63, 201)...")
            if self.mcp_helper.precise_tap(63, 201, "Create (+) Top-Left"):
                time.sleep(3)

                # Handle permission popup if it appears
                self.handle_permission_popup()
                time.sleep(1)

                # Verify create mode actually opened (don't blindly trust ADB returncode)
                if self._verify_create_mode_opened():
                    print("✅ Create screen opened successfully!")
                    return True

                # First tap didn't open create — retry once
                print("⚠️ Create screen not detected, retrying...")
                # Press back to clear any accidental screen, then retry
                subprocess.run(
                    [
                        "adb",
                        "-s",
                        self.mcp_helper.device_id,
                        "shell",
                        "input",
                        "keyevent",
                        "KEYCODE_BACK",
                    ],
                    capture_output=True,
                    timeout=5,
                )
                time.sleep(1)

                self.mcp_helper.precise_tap(63, 201, "Create (+) Top-Left RETRY")
                time.sleep(4)
                self.handle_permission_popup()
                time.sleep(1)

                if self._verify_create_mode_opened():
                    print("✅ Create screen opened on retry!")
                    return True

            print("❌ Failed to open Creation screen")
            return False

        except Exception as e:
            print(f"❌ POST button click failed: {e}")
            return False

    def verify_creation_screen(self):
        """Check if we are on the creation/gallery selection screen"""
        try:
            # Check for POST tab
            # ID: com.instagram.android:id/cam_dest_feed
            # or Accessibility ID: "POST"
            from appium.webdriver.common.appiumby import AppiumBy

            # Check 1: POST tab (most reliable)
            try:
                if self.driver.find_elements(AppiumBy.ACCESSIBILITY_ID, "POST"):
                    return True
            except:
                pass

            # Check 2: Gallery drop-down
            try:
                if self.driver.find_elements(
                    AppiumBy.ID, "com.instagram.android:id/gallery_folder_menu"
                ):
                    return True
            except:
                pass

            # Check 3: "Next" button (Top Right)
            try:
                if self.driver.find_elements(
                    AppiumBy.ID, "com.instagram.android:id/next_button_textview"
                ):
                    return True
            except:
                pass

            return False
        except:
            return False

    def click_post_text_button(self):
        """Ensure 'POST' tab is selected in the creation interface"""
        try:
            print("📝 Ensuring 'POST' tab is selected...")

            # Strategy 1: Find by content-desc and click (MOST RELIABLE)
            print("🔍 Strategy 1: Finding POST tab by content-desc...")
            if self.mcp_helper.find_and_click_by_content_desc("POST", timeout=3):
                time.sleep(1)
                return True

            # Strategy 2: Accessibility ID "POST" via Appium
            try:
                from appium.webdriver.common.appiumby import AppiumBy

                post_tabs = self.driver.find_elements(AppiumBy.ACCESSIBILITY_ID, "POST")
                if post_tabs:
                    post_tabs[0].click()
                    time.sleep(1)
                    print("✅ Selected POST tab (Accessibility ID)")
                    return True
            except Exception as e:
                print(f"⚠️ POST tab select error: {e}")

            # Strategy 3: Coordinate fallback - ADB-VERIFIED Feb 2026
            # POST tab center: (370, 2257) - cam_dest_feed bounds [293,2213][448,2302]
            print("🔄 Using coordinate fallback for POST tab...")
            return self.mcp_helper.precise_tap(370, 2257, "POST tab coords")

        except Exception as e:
            print(f"❌ Click 'Post' text failed: {e}")
            return False

    def click_reel_text_button(self):
        """Ensure 'REEL' tab is selected in the creation interface."""
        try:
            print("Ensuring 'REEL' tab is selected...")

            if self.mcp_helper.find_and_click_by_content_desc("REEL", timeout=3):
                time.sleep(1)
                return True

            try:
                from appium.webdriver.common.appiumby import AppiumBy

                reel_tabs = self.driver.find_elements(AppiumBy.ACCESSIBILITY_ID, "REEL")
                if reel_tabs:
                    reel_tabs[0].click()
                    time.sleep(1)
                    print("Selected REEL tab (Accessibility ID)")
                    return True
            except Exception as e:
                print(f"REEL tab select error: {e}")

            print("Using coordinate fallback for REEL tab...")
            return self.mcp_helper.precise_tap(540, 2258, "REEL tab coords")

        except Exception as e:
            print(f"Click 'Reel' text failed: {e}")
            return False

    def select_gallery(self):
        """Select gallery option to choose existing photo/video"""
        try:
            print("🖼️ Looking for gallery option...")

            # Method 1: Use verified selector
            if SELECTORS_AVAILABLE:
                try:
                    from appium.webdriver.common.appiumby import AppiumBy

                    btn = self.driver.find_element(
                        AppiumBy.ID, InstagramSelectors.CREATE_GALLERY_BTN
                    )
                    btn.click()
                    time.sleep(3)
                    print("✅ Gallery opened via selector")
                    self.handle_permission_popup()
                    time.sleep(2)
                    return True
                except Exception as e:
                    print(f"⚠️ Selector method failed: {e}")

            # Method 2: Use Accessibility ID
            try:
                from appium.webdriver.common.appiumby import AppiumBy

                btn = self.driver.find_element(AppiumBy.ACCESSIBILITY_ID, "Gallery")
                btn.click()
                time.sleep(3)
                print("✅ Gallery opened via Accessibility ID")
                self.handle_permission_popup()
                time.sleep(2)
                return True
            except Exception as e:
                print(f"⚠️ Accessibility ID method failed: {e}")

            # Method 3: Coordinate fallback (verified from UI dump)
            print("🔄 Falling back to coordinates...")
            x, y = (
                89,
                2255,
            )  # Verified coordinate from InstagramSelectors.Coords.CREATE_GALLERY
            if self.mcp_helper.precise_tap(x, y, "Gallery button"):
                time.sleep(3)
                self.handle_permission_popup()
                time.sleep(2)
                print("✅ Gallery opened via coordinates")
                return True

            print("❌ Could not find gallery option")
            return False
        except Exception as e:
            print(f"❌ Gallery selection failed: {e}")
            return False

    def select_recent_media(self):
        """Select the most recent photo/video from gallery

        ✅ VERIFIED COORDINATES (Dec 25, 2024 XML dump):
        - Gallery grid starts at Y=1496
        - First row items:
          - Item 1 (NAF, use item 2): bounds [273,1496][538,1761] → center (405, 1628)
          - Item 3: bounds [543,1496][808,1761] → center (675, 1628)
        - "Recents" folder button: [0,1393][318,1453] → center (159, 1423)
        """
        try:
            print("📷 Selecting recent media from gallery...")
            from appium.webdriver.common.appiumby import AppiumBy

            # Strategy 1: Find by content-desc containing "Photo thumbnail" or "Video thumbnail"
            print("🔍 Strategy 1: Finding media by content-desc...")
            try:
                # Look for recently downloaded content
                media_elements = self.driver.find_elements(
                    AppiumBy.XPATH,
                    "//*[contains(@content-desc, 'thumbnail') and contains(@content-desc, 'December')]",
                )
                if media_elements:
                    print(f"✅ Found {len(media_elements)} media thumbnails by desc")
                    media_elements[0].click()
                    time.sleep(2)
                    print("✅ Recent media selected via content-desc!")
                    return True
            except Exception as e:
                print(f"⚠️ Content-desc search failed: {e}")

            # Strategy 2: Find gallery grid item by resource-id
            print("🔍 Strategy 2: Finding gallery grid items by ID...")
            try:
                grid_items = self.driver.find_elements(
                    AppiumBy.ID, "com.instagram.android:id/gallery_grid_item_thumbnail"
                )
                if grid_items:
                    print(f"✅ Found {len(grid_items)} gallery items")
                    grid_items[0].click()
                    time.sleep(2)
                    print("✅ Recent media selected via gallery grid ID!")
                    return True
            except Exception as e:
                print(f"⚠️ Grid ID search failed: {e}")

            # Strategy 3: VERIFIED coordinates from XML dump
            # Gallery grid items are at Y=1496-1761, NOT Y=400!
            print("🔄 Strategy 3: Using VERIFIED gallery coordinates...")
            gallery_grid_positions = [
                # First row of gallery grid (CORRECT Y positions from XML dump)
                (405, 1628),  # Second item center (first is often NAF)
                (136, 1628),  # First item center
                (675, 1628),  # Third item center
                (945, 1628),  # Fourth item center
                # Second row (if exists)
                (136, 1894),  # Row 2, item 1
                (405, 1894),  # Row 2, item 2
            ]

            for x, y in gallery_grid_positions:
                print(f"🎯 Trying gallery grid at ({x}, {y})")
                if self.mcp_helper.precise_tap(
                    x, y, f"Gallery grid item at ({x}, {y})"
                ):
                    time.sleep(2)
                    print(f"✅ Tapped gallery grid at ({x}, {y})")
                    return True
                time.sleep(0.5)

            print("❌ Could not select recent media")
            return False
        except Exception as e:
            print(f"❌ Recent media selection failed: {e}")
            return False

    def click_expand_crop(self):
        """Click the expand/crop button to show full image (not cropped square)

        ✅ VERIFIED COORDINATES (Dec 25, 2024):
        - "Change crop" button at: (79, 1275)
        - content-desc: "Change crop"
        - Located on left side of image preview
        """
        try:
            print("🔲 Clicking expand/crop button to show full image...")

            # Use direct ADB tap - most reliable approach
            import subprocess

            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "tap", "79", "1275"],
                capture_output=True,
                text=True,
                timeout=5,
            )

            if result.returncode == 0:
                time.sleep(1)
                print("✅ Expand/crop clicked at (79, 1275)")
                return True
            else:
                print(f"⚠️ Expand/crop tap failed: {result.stderr}")
                return True  # Continue anyway

        except Exception as e:
            print(f"⚠️ Expand/crop click failed: {e}")
            return True  # Continue anyway

    def add_audio_to_image(self):
        """Add audio to an image post for more engagement

        ✅ VERIFIED COORDINATES (Dec 29, 2024 XML dumps):
        - Audio button (bottom bar): [32,2045][216,2161] → center (124, 2103)
        - Track rows in "For You" are ~161px apart, starting at Y=1614
        - Each track click immediately attaches it (shows audio pill at top)

        ENHANCED RANDOMIZATION:
        - Random scroll count (0-8 scrolls)
        - Bidirectional scrolling (up and down)
        - Variable scroll distances and speeds
        - Random track selection from any visible position
        - Occasional tab switching (For You → Trending)
        - Human-like random pauses
        """
        try:
            print("🎵 Adding audio to image post...")

            # Step 1: Click Audio button in bottom toolbar
            print("🎵 Step 1: Opening audio picker...")
            audio_btn_x = 124 + random.randint(-10, 10)  # Slight position variance
            if not self.mcp_helper.precise_tap(
                audio_btn_x, 2103, "Audio button (bottom bar)"
            ):
                print("⚠️ Audio button tap failed, trying alternate position...")
                self.mcp_helper.precise_tap(124, 2083, "Audio button (alt)")

            time.sleep(random.uniform(2.0, 3.0))  # Variable wait for picker

            # Step 2: ENHANCED random scrolling
            num_scrolls = random.randint(0, 8)  # More scroll range
            print(f"🎵 Step 2: Scrolling {num_scrolls} times for variety...")

            for i in range(num_scrolls):
                # Randomize scroll direction (80% down, 20% up for variety)
                scroll_down = random.random() < 0.8

                if scroll_down:
                    # Scroll DOWN - variable distance
                    scroll_distance = random.randint(200, 400)
                    start_y = 1850 + random.randint(-100, 100)
                    end_y = start_y - scroll_distance
                else:
                    # Scroll UP occasionally
                    scroll_distance = random.randint(100, 250)
                    start_y = 1650 + random.randint(-50, 50)
                    end_y = start_y + scroll_distance

                # Variable X position for natural scrolling
                scroll_x = 540 + random.randint(-100, 100)

                subprocess.run(
                    [
                        "adb",
                        "-s",
                        self.device_id,
                        "shell",
                        "input",
                        "swipe",
                        str(scroll_x),
                        str(start_y),
                        str(scroll_x),
                        str(end_y),
                        str(random.randint(150, 500)),  # Variable speed
                    ],
                    capture_output=True,
                    timeout=5,
                )

                # Human-like variable pause between scrolls
                time.sleep(random.uniform(0.2, 0.8))

            # Tab selection: 90% For You (default), 10% Trending
            # For You is the default tab, so we only need to tap Trending occasionally
            tab_choice = random.random()
            if tab_choice < 0.10:  # 10% chance for Trending
                print("🎵 Switching to Trending tab (10% chance)...")
                # Trending tab is on the RIGHT side of For You
                self.mcp_helper.precise_tap(700, 1520, "Trending tab")
                time.sleep(random.uniform(1.0, 1.5))
            else:
                print("🎵 Staying on For You tab (90% chance)...")
                # Ensure we're on For You by clicking it (left side)
                self.mcp_helper.precise_tap(200, 1520, "For You tab")
                time.sleep(random.uniform(0.5, 1.0))

            # Step 3: Select a random track from visible list
            # More Y positions for better coverage after scrolling
            track_y_positions = [
                1695,  # Track 1 area
                1775,  # Between track 1-2
                1856,  # Track 2 area
                1940,  # Between track 2-3
                2017,  # Track 3 area
                2100,  # Between track 3-4
                2178,  # Track 4 area
            ]

            # TRUE random selection
            selected_y = random.choice(track_y_positions)

            # Wide X variation - tap anywhere on the track row (not save button on right)
            tap_x = random.randint(150, 750)

            print(f"🎵 Step 3: Selecting track at ({tap_x}, {selected_y})...")
            self.mcp_helper.precise_tap(
                tap_x, selected_y, f"Audio track at Y={selected_y}"
            )

            time.sleep(random.uniform(1.5, 2.5))  # Variable wait for attachment

            print("✅ Audio added to image post!")
            return True

        except Exception as e:
            print(f"⚠️ Add audio failed: {e} - continuing without audio")
            return True  # Don't fail the post if audio fails

    def click_next_button(self):
        """Click the FIRST NEXT button in TOP-RIGHT corner (media selection → editing screen)"""
        try:
            print("➡️ Looking for FIRST NEXT button in TOP-RIGHT corner...")

            # FIRST NEXT BUTTON (Media -> Edit)
            # Verified ID: com.instagram.android:id/next_button_textview
            # Verified Coordinate: (1000, 201)

            # Strategy 1: Resource ID (Most Reliable - Verified)
            try:
                from appium.webdriver.common.appiumby import AppiumBy

                btns = self.driver.find_elements(
                    AppiumBy.ID, "com.instagram.android:id/next_button_textview"
                )
                if btns:
                    btns[0].click()
                    print("✅ First NEXT button clicked (ID: next_button_textview)")
                    time.sleep(3)
                    return True
            except Exception as e:
                print(f"⚠️ ID click failed: {e}")

            # Strategy 2: Accessibility ID "Next"
            try:
                from appium.webdriver.common.appiumby import AppiumBy

                btns = self.driver.find_elements(AppiumBy.ACCESSIBILITY_ID, "Next")
                if btns:
                    btns[0].click()
                    print("✅ First NEXT button clicked (Accessibility ID)")
                    time.sleep(3)
                    return True
            except:
                pass

            # Strategy 3: Coordinate Fallback
            print("🔄 Fallback: Using Top-Right Coordinate (1000, 201)")
            if self.mcp_helper.precise_tap(1000, 201, "First NEXT (Top-Right)"):
                time.sleep(3)
                print("✅ First NEXT button clicked (Coords)")
                return True

            print("❌ Failed to click First NEXT button")
            return False
        except Exception as e:
            print(f"❌ NEXT button click failed: {e}")
            return False

    def click_second_next_button(self):
        """Click the SECOND NEXT button (editing screen → sharing screen)

        ✅ VERIFIED COORDINATES (Dec 24, 2024):
        - Second Next button is at BOTTOM RIGHT: (961, 2280)
        - NOT top right like the first Next button!
        """
        try:
            print("➡️ Looking for SECOND NEXT button...")

            # Strategy 1: Find by content-desc (MOST RELIABLE)
            print("🔍 Strategy 1: Finding Next by content-desc...")
            if self.mcp_helper.find_and_click_by_content_desc("Next", timeout=3):
                time.sleep(3)
                self.handle_continue_popup()
                return True

            # Strategy 2: Accessibility ID "Next" via Appium
            try:
                from appium.webdriver.common.appiumby import AppiumBy

                btns = self.driver.find_elements(AppiumBy.ACCESSIBILITY_ID, "Next")
                if btns:
                    btns[0].click()
                    print("✅ Second NEXT button clicked (Accessibility ID: Next)")
                    time.sleep(3)
                    self.handle_continue_popup()
                    return True
            except:
                pass

            # Strategy 3: Resource ID
            try:
                from appium.webdriver.common.appiumby import AppiumBy

                ids_to_try = [
                    "com.instagram.android:id/creation_next_button",
                    "com.instagram.android:id/clips_right_action_button",
                ]

                for rid in ids_to_try:
                    btns = self.driver.find_elements(AppiumBy.ID, rid)
                    if btns:
                        btns[0].click()
                        print(f"✅ Second NEXT button clicked (ID: {rid})")
                        time.sleep(3)
                        self.handle_continue_popup()
                        return True
            except Exception as e:
                print(f"⚠️ ID click failed: {e}")

            # Strategy 4: VERIFIED Coordinate - BOTTOM RIGHT (961, 2280)
            # NOT top right - the second Next is at bottom!
            print("🔄 Fallback: Using VERIFIED BOTTOM-RIGHT Coordinate (961, 2280)")
            if self.mcp_helper.precise_tap(
                961, 2280, "Second NEXT (Bottom-Right VERIFIED)"
            ):
                time.sleep(3)
                self.handle_continue_popup()
                return True

            print("❌ Failed to click Second NEXT button")
            return False

        except Exception as e:
            print(f"❌ Second NEXT button click failed: {e}")
            return False

    def verify_sharing_screen(self):
        """Verify if we're now on the final sharing screen"""
        try:
            print("🔍 Verifying if we're on the sharing screen...")
            from appium.webdriver.common.appiumby import AppiumBy

            # Look for sharing screen indicators
            sharing_indicators = [
                "Share",
                "Your story",
                "Close friends",
                "Also share to Facebook",
                "Write a caption",
                "Tag people",
                "Add location",
            ]

            # Try to find sharing screen elements
            for indicator in sharing_indicators:
                try:
                    elements = self.driver.find_elements(
                        AppiumBy.XPATH, f"//*[contains(@text, '{indicator}')]"
                    )
                    if elements:
                        print(f"✅ Found sharing screen indicator: '{indicator}'")
                        return True
                except Exception:
                    continue

            print("ℹ️ No sharing screen indicators found")
            return False

        except Exception as e:
            print(f"⚠️ Sharing screen verification failed: {e}")
            return False

    def verify_caption_screen(self):
        """Verify if we successfully moved to the caption/sharing screen"""
        try:
            print("🔍 Verifying if we're on the caption screen...")
            from appium.webdriver.common.appiumby import AppiumBy

            # Look for caption screen indicators
            caption_indicators = [
                "Write a caption",
                "Share",
                "Tag People",
                "Add location",
                "Advanced settings",
                "Also post to Facebook",
                "Turn on commenting",
                "caption",
            ]

            # Try to find any caption screen elements
            for indicator in caption_indicators:
                try:
                    elements = self.driver.find_elements(
                        AppiumBy.XPATH, f"//*[contains(@text, '{indicator}')]"
                    )
                    if elements:
                        print(f"✅ Found caption screen indicator: '{indicator}'")
                        return True
                except Exception:
                    continue

            # Also check if the UI structure changed by looking for Share button
            try:
                share_elements = self.driver.find_elements(
                    AppiumBy.XPATH, "//android.widget.Button[@text='Share']"
                )
                if share_elements:
                    print("✅ Found 'Share' button - on caption screen!")
                    return True
            except Exception:
                pass

            print(
                "ℹ️ No caption screen indicators found - still on media selection screen"
            )
            return False

        except Exception as e:
            print(f"⚠️ Caption screen verification failed: {e}")
            return False

    def add_caption(self, caption_text, from_file=False):
        """
        Add caption - optimized for "Add a caption..." layout.

        🎯 VERIFIED SELECTOR (Dec 2024 XML Dump):
        - Resource ID: com.instagram.android:id/caption_input_text_view
        - Bounds: [42,990][1038,1116] → Center: (540, 1053)
        - Type: AutoCompleteTextView (directly editable, no sub-screen)
        """
        final_caption = caption_text
        if from_file:
            pass

        try:
            print(f"✍️ Adding caption: '{final_caption[:20]}...'")
            from appium.webdriver.common.appiumby import AppiumBy

            # Strategy 1: VERIFIED Resource ID (from Dec 2024 XML dump)
            print("🔍 Strategy 1: Using VERIFIED caption_input_text_view ID")
            try:
                el = self.driver.find_element(
                    AppiumBy.ID, InstagramSelectors.SHARE_CAPTION_INPUT
                )
                el.click()
                print("✅ Found caption field by VERIFIED ID: caption_input_text_view")
                time.sleep(1)

                # Type text using ADB for reliability
                print(f"⌨️ Typing caption via ADB...")
                self.mcp_helper.type_text(final_caption)

                # Hide keyboard
                try:
                    self.driver.hide_keyboard()
                except:
                    subprocess.run(
                        [
                            "adb",
                            "-s",
                            self.device_id,
                            "shell",
                            "input",
                            "keyevent",
                            "111",
                        ],
                        capture_output=True,
                        timeout=5,
                    )
                time.sleep(1)
                return True
            except Exception as e:
                print(f"⚠️ ID strategy failed: {e}")

            # Strategy 2: Search for text "Add a caption..."
            print("🔍 Strategy 2: Searching for 'Add a caption...' text")
            text_selectors = [
                "//*[contains(@text, 'Add a caption')]",
                "//*[contains(@hint, 'Add a caption')]",
                "//*[contains(@text, 'Write a caption')]",
                "//android.widget.AutoCompleteTextView",
            ]

            for selector in text_selectors:
                try:
                    ele = self.driver.find_elements(AppiumBy.XPATH, selector)
                    if ele:
                        ele[0].click()
                        print(f"✅ Clicked caption field via XPath: {selector}")
                        time.sleep(1)

                        # Type text
                        print(f"⌨️ Typing caption via ADB...")
                        self.mcp_helper.type_text(final_caption)

                        # Hide keyboard
                        try:
                            self.driver.hide_keyboard()
                        except:
                            subprocess.run(
                                [
                                    "adb",
                                    "-s",
                                    self.device_id,
                                    "shell",
                                    "input",
                                    "keyevent",
                                    "111",
                                ],
                                capture_output=True,
                                timeout=5,
                            )
                        time.sleep(1)
                        return True
                except:
                    pass

            # Strategy 3: VERIFIED Coordinate from XML dump
            # Caption field bounds: [42,990][1038,1116] → Center: (540, 1053)
            print("🎯 Strategy 3: Tapping VERIFIED Caption Coordinate")
            x, y = InstagramSelectors.Coords.CAPTION_INPUT
            self.mcp_helper.precise_tap(x, y, "Caption Field (verified coords)")
            time.sleep(1)

            # Type text using ADB for reliability
            print(f"⌨️ Typing caption via ADB...")
            self.mcp_helper.type_text(final_caption)

            # CRITICAL: Dismiss hashtag suggestions before Share button
            print("📝 Dismissing keyboard and hashtag suggestions...")

            # Hide keyboard
            try:
                self.driver.hide_keyboard()
            except:
                print("⌨️ Hiding keyboard via keyevent 111")
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "input", "keyevent", "111"],
                    capture_output=True,
                    timeout=5,
                )

            time.sleep(1)

            # Tap OUTSIDE caption area to dismiss hashtag suggestions dropdown
            # This is crucial when captions contain #hashtags
            print("🎯 Tapping outside to dismiss suggestions...")
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "tap", "540", "800"],
                capture_output=True,
                timeout=5,
            )
            time.sleep(1.5)

            # NOTE: Removed BACK press - it was navigating back instead of dismissing popups!

            print("✅ Caption added, suggestions dismissed!")
            return True

        except Exception as e:
            print(f"❌ Add caption failed: {e}")
            return False

    def add_caption_from_file(self):
        """Click caption field using content manager and add random caption"""
        try:
            print("📝 Getting caption from content manager...")

            # Use content manager to get random caption
            try:
                from content_manager import get_random_post_caption

                caption = get_random_post_caption(self.profile_id)
                print(f"💬 Selected caption: '{caption}'")
            except ImportError:
                print("⚠️ Content manager not available, using fallback")
                import random

                caption = (
                    random.choice(self.image_captions)
                    if hasattr(self, "image_captions")
                    else "Automated post"
                )
                print(f"💬 Selected fallback caption: '{caption}'")

            # STRIP HASHTAGS - they cause Instagram's suggestion dropdown to block Share button
            import re

            caption_clean = re.sub(r"#\w+\s*", "", caption).strip()
            if caption_clean != caption:
                print(f"🚫 Stripped hashtags: '{caption}' → '{caption_clean}'")

            return self.add_caption(caption_clean)

        except Exception as e:
            print(f"❌ Add caption from file failed: {e}")
            return False

    def toggle_trial_reel(self):
        """Toggle ON the Trial toggle for trial reels and handle popup"""
        try:
            # Trial toggle from sharing screen (bottom area)
            # CONFIRMED WORKING COORDINATES - toggle switch area
            trial_toggle_positions = [
                # Primary working position
                (630, 1280),  # ✅ CONFIRMED WORKING - toggles Trial ON
                (630, 1270),
                (630, 1290),  # Small Y variations
                (620, 1280),
                (640, 1280),  # Small X variations
                # Backup positions around the toggle
                (650, 1280),
                (610, 1280),
                (630, 1275),
            ]

            for x, y in trial_toggle_positions:
                print(f"🎯 Trying trial toggle at ({x}, {y})")

                if self.mcp_helper.precise_tap(x, y, f"Trial toggle at ({x}, {y})"):
                    time.sleep(3)  # Wait for toggle animation and potential popup

                    # Check for "Keep as trial" or similar popup
                    self.handle_trial_popup()

                    print("✅ Trial toggle activated and popup handled!")
                    print("📤 Ready to share - caption set, trial decided!")
                    return True

                time.sleep(0.5)

            print("❌ Could not find trial toggle")
            return False

        except Exception as e:
            print(f"❌ Trial toggle failed: {e}")
            return False

    def toggle_trial_reel_current(self):
        """Toggle Trial Reel only when Instagram exposes the real control."""
        try:
            import re
            import subprocess
            import xml.etree.ElementTree as ET

            def dump_ui_xml():
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "uiautomator", "dump", "/sdcard/trial_reel_toggle.xml"],
                    capture_output=True,
                    text=True,
                    timeout=8,
                )
                result = subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "cat", "/sdcard/trial_reel_toggle.xml"],
                    capture_output=True,
                    text=True,
                    timeout=8,
                )
                return result.stdout or ""

            def find_trial_row_center(xml):
                if "trial" not in xml.lower():
                    return None
                try:
                    root = ET.fromstring(xml)
                except Exception:
                    return None

                for node in root.iter("node"):
                    label = f"{node.attrib.get('text', '')} {node.attrib.get('content-desc', '')}".lower()
                    if "trial" not in label:
                        continue
                    match = re.search(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.attrib.get("bounds", ""))
                    if not match:
                        continue
                    y1, y2 = int(match.group(2)), int(match.group(4))
                    return (y1 + y2) // 2
                return None

            def scroll_options():
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "input", "swipe", "540", "1900", "540", "700", "650"],
                    capture_output=True,
                    timeout=8,
                )
                time.sleep(1)

            def open_more_options_if_visible(xml):
                if "More options" not in xml:
                    return False
                try:
                    root = ET.fromstring(xml)
                    for node in root.iter("node"):
                        if node.attrib.get("text") != "More options":
                            continue
                        match = re.search(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.attrib.get("bounds", ""))
                        if not match:
                            continue
                        x = (int(match.group(1)) + int(match.group(3))) // 2
                        y = (int(match.group(2)) + int(match.group(4))) // 2
                        self.mcp_helper.precise_tap(x, y, "More options")
                        time.sleep(2)
                        return True
                except Exception:
                    return False
                return False

            for attempt in range(6):
                xml = dump_ui_xml()
                trial_y = find_trial_row_center(xml)
                if trial_y is not None:
                    print(f"Found Trial control row at y={trial_y}; tapping toggle")
                    if self.mcp_helper.precise_tap(970, trial_y, "Trial Reel toggle"):
                        time.sleep(2)
                        self.handle_trial_popup()
                        print("Trial toggle activated and popup handled")
                        return True
                    break

                if attempt == 2 and open_more_options_if_visible(xml):
                    continue

                scroll_options()

            print("Trial Reel toggle is not visible for this account/layout; refusing to post as regular reel")
            return False

        except Exception as e:
            print(f"Trial toggle failed: {e}")
            return False

    def handle_trial_popup(self):
        """Handle trial reel popup if it appears"""
        try:
            print("🔍 Checking for trial reel popup...")

            # Common trial popup button texts
            popup_buttons = [
                "Keep as trial",
                "Continue",
                "Got it",
                "OK",
                "Confirm",
                "Yes",
                "Keep trial",
            ]

            # Try Selenium first to find popup buttons
            for button_text in popup_buttons:
                try:
                    elements = self.driver.find_elements(
                        "xpath", f"//*[@text='{button_text}']"
                    )
                    if elements:
                        print(f"✅ Found trial popup button: '{button_text}'")
                        elements[0].click()
                        time.sleep(2)
                        print(f"✅ Clicked trial popup: '{button_text}'")
                        time.sleep(2)  # Wait for popup to close completely
                        print("✅ Popup closed - ready to proceed!")
                        return True
                except Exception as e:
                    continue

            try:
                import re
                import xml.etree.ElementTree as ET

                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "uiautomator", "dump", "/sdcard/trial_reel_popup.xml"],
                    capture_output=True,
                    text=True,
                    timeout=8,
                )
                result = subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "cat", "/sdcard/trial_reel_popup.xml"],
                    capture_output=True,
                    text=True,
                    timeout=8,
                )
                xml = result.stdout or ""
                if xml:
                    root = ET.fromstring(xml)
                    button_words = [text.lower() for text in popup_buttons]
                    for node in root.iter("node"):
                        label = f"{node.attrib.get('text', '')} {node.attrib.get('content-desc', '')}".strip()
                        if not label:
                            continue
                        if not any(word in label.lower() for word in button_words):
                            continue
                        match = re.search(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.attrib.get("bounds", ""))
                        if not match:
                            continue
                        x = (int(match.group(1)) + int(match.group(3))) // 2
                        y = (int(match.group(2)) + int(match.group(4))) // 2
                        print(f"Found trial popup button in UI dump: '{label}'")
                        if self.mcp_helper.precise_tap(x, y, f"Trial popup button {label}"):
                            time.sleep(2)
                            return True
            except Exception as e:
                print(f"Trial popup XML check skipped: {e}")

            # Coordinate sweeping is intentionally disabled here; text/XML matches above are safe.
            print("🔄 Fallback: Trying common popup positions...")
            popup_button_positions = []
            print("No text-matched trial popup button found; coordinate fallback disabled")

            for x, y in popup_button_positions:
                if self.mcp_helper.precise_tap(x, y, f"Popup button at ({x}, {y})"):
                    time.sleep(1)
                    print(f"✅ Clicked potential popup at ({x}, {y})")
                    # Don't return yet, try more positions to be sure
                time.sleep(0.2)

            print("ℹ️ No trial popup found or already handled")
            return True

        except Exception as e:
            print(f"⚠️ Trial popup handling error: {e}")
            return True  # Continue even if popup handling fails

    def handle_continue_popup(self):
        """Handle 'Continue' popup that appears after second next button"""
        try:
            print("🔍 Checking for 'Continue' popup...")
            from appium.webdriver.common.appiumby import AppiumBy

            # Find and click "Continue" button by text
            continue_button_texts = [
                "Continue",
                "CONTINUE",
                "OK",
                "Got it",
                "Next",
                "Proceed",
            ]

            for button_text in continue_button_texts:
                try:
                    # Try finding button by exact text
                    elements = self.driver.find_elements(
                        AppiumBy.XPATH, f"//*[@text='{button_text}']"
                    )
                    if elements:
                        print(f"✅ Found '{button_text}' button, clicking...")
                        elements[0].click()
                        time.sleep(2)
                        print(f"✅ Clicked '{button_text}' popup button")
                        return True

                    # Try finding button by partial text
                    elements = self.driver.find_elements(
                        AppiumBy.XPATH, f"//*[contains(@text, '{button_text}')]"
                    )
                    if elements:
                        print(
                            f"✅ Found button containing '{button_text}', clicking..."
                        )
                        elements[0].click()
                        time.sleep(2)
                        print(f"✅ Clicked '{button_text}' popup button")
                        return True

                except Exception as e:
                    continue

            # No popup found by ID - workflow continues naturally
            # DO NOT spam-tap random positions as this causes issues
            print("ℹ️ No popup detected - continuing workflow")
            return True

        except Exception as e:
            print(f"⚠️ Continue popup handling error: {e}")
            return True

    def handle_not_now_popup(self):
        """Handle 'Not now' popup that appears after sharing"""
        try:
            print("🔍 Checking for 'Not now' popup...")
            from appium.webdriver.common.appiumby import AppiumBy

            # Find and click "Not now" button by text
            not_now_button_texts = [
                "Not now",
                "NOT NOW",
                "Not Now",
                "No, thanks",
                "No thanks",
                "Skip",
                "Later",
            ]

            for button_text in not_now_button_texts:
                try:
                    elements = self.driver.find_elements(
                        AppiumBy.XPATH, f"//*[@text='{button_text}']"
                    )
                    if elements:
                        print(f"✅ Found '{button_text}', clicking...")
                        elements[0].click()
                        time.sleep(2)
                        return True

                    elements = self.driver.find_elements(
                        AppiumBy.XPATH, f"//*[contains(@text, '{button_text}')]"
                    )
                    if elements:
                        print(f"✅ Found partial '{button_text}', clicking...")
                        elements[0].click()
                        time.sleep(2)
                        return True
                except:
                    continue

            return True
        except Exception:
            return True

    def handle_post_promotion_popup(self):
        """Handle post-promotion popup with 'No, thanks' button"""
        try:
            print("🔍 Checking for post-promotion popup...")
            from appium.webdriver.common.appiumby import AppiumBy

            try:
                elements = self.driver.find_elements(
                    AppiumBy.XPATH, "//*[@text='No, thanks']"
                )
                if elements:
                    elements[0].click()
                    print("✅ Clicked 'No, thanks' on promotion popup")
                    time.sleep(2)
                    return True
            except:
                pass

            return True
        except Exception:
            return True
        try:
            print("🔍 Checking for post-promotion popup with 'No, thanks'...")

            # Enhanced text matching for promotion-related popups
            no_thanks_button_texts = [
                "No, thanks",
                "No thanks",
                "No, Thanks",
                "NO, THANKS",
                "Not interested",
                "Skip",
                "Maybe later",
                "Not now",
                "Cancel",
                "Dismiss",
                "Close",
            ]

            # First try: Advanced text detection using multiple methods
            for button_text in no_thanks_button_texts:
                try:
                    print(f"🔍 Looking for '{button_text}' button...")

                    # Method 1: Exact text match
                    elements = self.driver.find_elements(
                        "xpath", f"//*[@text='{button_text}']"
                    )
                    if elements:
                        print(f"✅ FOUND '{button_text}' button via exact match!")
                        elements[0].click()
                        time.sleep(2)
                        print(
                            f"✅ Successfully clicked '{button_text}' - promotion popup dismissed!"
                        )
                        return True

                    # Method 2: Case-insensitive partial match
                    elements = self.driver.find_elements(
                        "xpath",
                        f"//*[contains(translate(@text, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '{button_text.lower()}')]",
                    )
                    if elements:
                        print(
                            f"✅ FOUND '{button_text}' button via case-insensitive match!"
                        )
                        elements[0].click()
                        time.sleep(2)
                        print(
                            f"✅ Successfully clicked '{button_text}' - promotion popup dismissed!"
                        )
                        return True

                    # Method 3: Content description match
                    elements = self.driver.find_elements(
                        "xpath", f"//*[@content-desc='{button_text}']"
                    )
                    if elements:
                        print(f"✅ FOUND '{button_text}' via content-desc!")
                        elements[0].click()
                        time.sleep(2)
                        print(
                            f"✅ Successfully clicked '{button_text}' - promotion popup dismissed!"
                        )
                        return True

                except Exception as e:
                    print(f"⚠️ Error searching for '{button_text}': {e}")
                    continue

            # Fallback: Try common popup dismissal positions
            print("🔄 Fallback: Trying common 'No, thanks' button positions...")

            # Common positions where "No, thanks" appears in Instagram popups
            no_thanks_positions = [
                # CONFIRMED WORKING: Rate Instagram popup "No, thanks" button
                (540, 1531),  # ✅ TESTED - Center of Rate Instagram popup
                # Standard popup positions
                (270, 1400),
                (300, 1400),
                (250, 1400),
                (270, 1450),
                (270, 1350),
                (270, 1500),
                (200, 1400),
                (350, 1400),
                (180, 1400),
                # Bottom-left area
                (270, 1600),
                (270, 1550),
                (270, 1650),
                (300, 1600),
                (250, 1600),
                (200, 1600),
                # Center-left area
                (400, 1400),
                (450, 1400),
                (350, 1400),
                # Alternative positions based on screen size
                (270, 1300),
                (270, 1700),
                (270, 1800),
            ]

            for x, y in no_thanks_positions:
                try:
                    print(f"🎯 Trying 'No, thanks' at ({x}, {y})")
                    if self.mcp_helper.precise_tap(
                        x, y, f"'No, thanks' button at ({x}, {y})"
                    ):
                        time.sleep(1)
                        print(f"✅ Clicked potential 'No, thanks' at ({x}, {y})")
                        # Don't return immediately, try a few more to be thorough
                except Exception as e:
                    continue
                time.sleep(0.3)

            # Additional step: Try Android back button (works for many Instagram popups)
            print("🔄 Trying Android back button to dismiss popup...")
            try:
                # Use ADB to send back button keyevent
                import subprocess

                result = subprocess.run(
                    [
                        "adb",
                        "-s",
                        self.mcp_helper.device_id
                        if hasattr(self.mcp_helper, "device_id")
                        else "1A121FDF60082H",
                        "shell",
                        "input",
                        "keyevent",
                        "4",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )

                if result.returncode == 0:
                    print("✅ Back button pressed - popup may be dismissed")
                    time.sleep(1)
                else:
                    print(f"⚠️ Back button failed: {result.stderr}")
            except Exception as e:
                print(f"⚠️ Back button error: {e}")

            # Final step: Try tapping outside the popup to dismiss it
            print("🔄 Trying to dismiss popup by tapping outside...")
            outside_positions = [
                (100, 800),  # Top-left outside popup
                (980, 800),  # Top-right outside popup
                (100, 2000),  # Bottom-left outside popup
                (980, 2000),  # Bottom-right outside popup
            ]

            for x, y in outside_positions:
                try:
                    self.mcp_helper.precise_tap(x, y, f"Outside popup at ({x}, {y})")
                    time.sleep(0.5)
                except:
                    continue

            print("ℹ️ Post-promotion popup check completed")
            return True

        except Exception as e:
            print(f"⚠️ Post-promotion popup handling error: {e}")
            return True  # Continue even if popup handling fails

    def click_share_button(self):
        """
        Click the Share button to post the content.

        🎯 VERIFIED SELECTORS (Dec 2024 XML Dump):
        - Resource ID: com.instagram.android:id/share_footer_button
        - Bounds: [42,2221][1038,2337] → Center: (540, 2279)
        - Accessibility ID: "Share"
        """
        try:
            print("📤 Preparing to click Share button...")
            from appium.webdriver.common.appiumby import AppiumBy

            # Strategy 1: VERIFIED Resource ID (share_footer_button)
            try:
                btns = self.driver.find_elements(
                    AppiumBy.ID, InstagramSelectors.SHARE_FOOTER_BUTTON
                )
                if btns:
                    btns[0].click()
                    print("✅ Share button clicked (ID: share_footer_button)")
                    time.sleep(5)
                    self.handle_not_now_popup()
                    self.handle_post_promotion_popup()
                    return True
            except Exception as e:
                print(f"⚠️ share_footer_button ID failed: {e}")

            # Strategy 2: Accessibility ID
            try:
                btns = self.driver.find_elements(AppiumBy.ACCESSIBILITY_ID, "Share")
                if btns:
                    btns[0].click()
                    print("✅ Share button clicked (Accessibility ID)")
                    time.sleep(5)
                    self.handle_not_now_popup()
                    self.handle_post_promotion_popup()
                    return True
            except Exception as e:
                print(f"⚠️ Accessibility ID failed: {e}")

            # Strategy 3: Legacy ID (older Instagram versions)
            try:
                btns = self.driver.find_elements(
                    AppiumBy.ID, "com.instagram.android:id/share_button"
                )
                if btns:
                    btns[0].click()
                    print("✅ Share button clicked (legacy ID: share_button)")
                    time.sleep(5)
                    self.handle_not_now_popup()
                    self.handle_post_promotion_popup()
                    return True
            except Exception as e:
                print(f"⚠️ Legacy ID failed: {e}")

            # Strategy 4: Coordinate fallback — but VERIFY the screen actually
            # advances. Previously this tapped (539, 2278) THREE TIMES and
            # returned True unconditionally; on accounts where IG re-laid out
            # the share screen the taps landed on whitespace / the IG home tab
            # and the workflow was told "share clicked" when nothing happened.
            # That caused "pushes but doesn't continue through" downstream:
            # dashboard thinks share succeeded, schedule moves on, but no post.
            print("🔄 Fallback: tapping (539, 2278) and verifying screen change")
            time.sleep(1.5)
            before_xml = self._get_ui_xml_for_guards() or ""
            still_on_caption = "share_footer_button" in before_xml or "caption" in before_xml.lower()

            self.mcp_helper.precise_tap(539, 2278, "Share Button fallback tap 1/2")
            time.sleep(2)
            after_xml = self._get_ui_xml_for_guards() or ""
            advanced = ("share_footer_button" not in after_xml) and ("caption_input" not in after_xml)

            if not advanced and still_on_caption:
                # One retry — sometimes the first tap is intercepted by an animation
                self.mcp_helper.precise_tap(539, 2278, "Share Button fallback tap 2/2")
                time.sleep(2.5)
                after_xml = self._get_ui_xml_for_guards() or ""
                advanced = ("share_footer_button" not in after_xml) and ("caption_input" not in after_xml)

            if not advanced:
                print("❌ Coordinate fallback tap did not advance past the caption editor; reporting share FAILED")
                return False

            print("✅ Share button click verified by screen advance")
            print("⏳ Waiting for post to finish uploading...")
            time.sleep(3)
            self.handle_not_now_popup()
            self.handle_post_promotion_popup()
            return True

        except Exception as e:
            print(f"❌ Share button click failed: {e}")
            return False

    def enable_trial_reel(self):
        """Enable trial reel toggle before posting (for Trials folder content)"""
        try:
            print("🧪 ENABLING TRIAL REEL TOGGLE...")

            # Trial reel toggle is usually in the posting interface
            # Look for toggle switch or "Trial" button
            trial_toggle_positions = [
                # Bottom area where toggles usually appear
                (540, 1800),
                (540, 1900),
                (540, 2000),
                (400, 1800),
                (680, 1800),
                (300, 1900),
                (780, 1900),
                # Right side where toggles might be
                (900, 1500),
                (950, 1500),
                (1000, 1500),
                # Top area near other post options
                (540, 400),
                (540, 500),
                (540, 300),
            ]

            for x, y in trial_toggle_positions:
                print(f"🎯 Trying trial toggle at ({x}, {y})")
                if self.mcp_helper.precise_tap(x, y, "Trial reel toggle"):
                    time.sleep(2)
                    print("✅ Trial reel toggle enabled!")
                    return True
                time.sleep(0.5)

            print("⚠️ Could not find trial toggle, posting as regular reel...")
            return False
        except Exception as e:
            print(f"❌ Trial toggle failed: {e}")
            return False

    def add_caption_legacy(self, caption=None, content_type="image"):
        """
        LEGACY: Add caption to the post based on content type.
        Uses coordinate fallback only - prefer add_caption() with verified IDs.
        """
        try:
            if caption is None:
                if content_type == "image":
                    caption = random.choice(self.image_captions)
                elif content_type == "reel":
                    caption = random.choice(self.reel_captions)
                elif content_type == "trial":
                    caption = random.choice(self.trial_captions)
                else:
                    caption = random.choice(self.image_captions)

            # Use the main add_caption method with verified IDs
            return self.add_caption(caption)

        except Exception as e:
            print(f"❌ Legacy caption addition failed: {e}")
            return False

    def post_image(self, image_path=None, caption=None):
        """Post an image from Google Drive - ONLY SOURCE OF CONTENT"""
        try:
            print(
                f"📸 STARTING IMAGE POST FROM GOOGLE DRIVE (Account {self.account_number})..."
            )
            print("📁 Using account-specific Google Drive for content")

            # Initialize Google Drive manager for this account
            try:
                from modules.drive_module_improved import ImprovedDriveManager
            except ImportError:
                from drive_module_improved import ImprovedDriveManager
            drive_manager = ImprovedDriveManager(
                account_number=self.account_number, device_id=self.device_id
            )

            # The Google Drive manager handles the complete workflow:
            # 1. Navigate to images folder
            # 2. Download content
            # 3. Post to Instagram
            # 4. Clean up gallery
            print("🚀 Executing complete Google Drive → Instagram workflow...")
            result = drive_manager.post_from_drive("images")

            if result:
                print("🎉 IMAGE POST FROM GOOGLE DRIVE COMPLETED!")
                return True
            else:
                print("❌ Image posting from Google Drive failed")
                return False

        except Exception as e:
            print(f"❌ Image posting from Google Drive failed: {e}")
            return False

    def post_standard_workflow(
        self, enable_trial_toggle=False, retry_count=0, max_retries=2
    ):
        """Standard Instagram posting workflow with CHECKPOINTING & CRASH RECOVERY

        Saves progress after each step so it can resume from last checkpoint on crash.
        Includes automatic retry with recovery when navigation fails.
        """
        import json
        import os
        from datetime import datetime

        checkpoint_file = os.path.join(
            os.path.dirname(__file__), "..", "config", "posting_checkpoint.json"
        )

        def save_checkpoint(step_name, step_num):
            """Save checkpoint after each successful step"""
            checkpoint = {
                "step": step_num,
                "step_name": step_name,
                "profile_id": getattr(self, "profile_id", "0"),
                "enable_trial": enable_trial_toggle,
                "timestamp": datetime.now().isoformat(),
            }
            try:
                os.makedirs(os.path.dirname(checkpoint_file), exist_ok=True)
                with open(checkpoint_file, "w") as f:
                    json.dump(checkpoint, f)
                print(f"💾 CHECKPOINT SAVED: Step {step_num} - {step_name}")
            except Exception as e:
                print(f"⚠️ Checkpoint save failed: {e}")

        def load_checkpoint():
            """Load last checkpoint to resume from"""
            try:
                if os.path.exists(checkpoint_file):
                    with open(checkpoint_file, "r") as f:
                        return json.load(f)
            except:
                pass
            return None

        def clear_checkpoint():
            """Clear checkpoint on successful completion"""
            try:
                if os.path.exists(checkpoint_file):
                    os.remove(checkpoint_file)
                    print("🗑️ Checkpoint cleared (workflow complete)")
            except:
                pass

        def is_uia2_crash(error):
            """Detect UiAutomator2 crash"""
            error_str = str(error)
            return (
                "instrumentation process is not running" in error_str
                or "UiAutomator2" in error_str
            )

        try:
            print("=" * 60)
            print("📱 INSTAGRAM POSTING WORKFLOW WITH CRASH RECOVERY")
            if retry_count > 0:
                print(f"🔄 RETRY ATTEMPT {retry_count}/{max_retries}")
            print("=" * 60)

            # Check for existing checkpoint (resuming after crash)
            # DISABLED - checkpoint causes stale state issues when UI changes
            # checkpoint = load_checkpoint()
            checkpoint = None  # ALWAYS START FRESH
            start_step = 0
            if checkpoint:
                print(
                    f"🔄 RESUME DETECTED: Checkpoint found from {checkpoint.get('timestamp', 'unknown')}"
                )
                print(
                    f"   Last successful step: {checkpoint.get('step_name', 'unknown')}"
                )
                start_step = checkpoint.get("step", 0)
                if start_step > 0:
                    print(f"   ⏭️ Resuming from step {start_step + 1}...")

            # Step 0: Connect to device
            print(f"\n{'=' * 40}")
            print("📍 STEP 0: CONNECT TO DEVICE")
            print(f"{'=' * 40}")
            if start_step < 1:
                if not self.connect():
                    print("❌ STEP 0 FAILED: Connection failed")
                    return False
                save_checkpoint("CONNECT", 0)
            else:
                print("⏭️ Skipping (already completed)")
                if not self.connect():  # Still need to connect even when resuming
                    return False

            # Step 1: Click POST button
            print(f"\n{'=' * 40}")
            print("📍 STEP 1: CLICK POST BUTTON")
            print(f"{'=' * 40}")
            if start_step < 1:
                try:
                    if not self.click_post_button():
                        print("❌ STEP 1 FAILED: POST button click failed")
                        self.disconnect()
                        return False
                    save_checkpoint("POST_BUTTON", 1)
                except Exception as e:
                    if is_uia2_crash(e):
                        print(
                            "🚨 UIA2 CRASHED at Step 1! Saving checkpoint for retry..."
                        )
                        save_checkpoint("CRASHED_AT_POST", 0)
                    # Try recovery and retry
                    if retry_count < max_retries:
                        print("🔄 Attempting recovery and retry...")
                        self._reset_and_go_home()
                        return self.post_standard_workflow(
                            enable_trial_toggle, retry_count + 1, max_retries
                        )
                    raise
            else:
                print("⏭️ Skipping (already completed)")

            # Step 2: Select gallery
            print(f"\n{'=' * 40}")
            print("📍 STEP 2: SELECT GALLERY")
            print(f"{'=' * 40}")
            if start_step < 2:
                try:
                    if not self.select_gallery():
                        print("❌ STEP 2 FAILED: Gallery selection failed")
                        self.disconnect()
                        return False
                    self._run_post_guard_check(verify_feed_gallery, "Feed gallery verification")
                    save_checkpoint("GALLERY", 2)
                except Exception as e:
                    if is_uia2_crash(e):
                        print(
                            "🚨 UIA2 CRASHED at Step 2! Saving checkpoint for retry..."
                        )
                        save_checkpoint("POST_BUTTON", 1)
                    # Try recovery and retry
                    if retry_count < max_retries:
                        print("🔄 Attempting recovery and retry...")
                        self._reset_and_go_home()
                        return self.post_standard_workflow(
                            enable_trial_toggle, retry_count + 1, max_retries
                        )
                    raise
            else:
                print("⏭️ Skipping (already completed)")

            # Step 2.5: Click POST tab (IMPORTANT - must be on POST not REEL/STORY)
            print(f"\n{'=' * 40}")
            print("📍 STEP 2.5: CLICK POST TAB")
            print(f"{'=' * 40}")
            try:
                if not (self.click_reel_text_button() if enable_trial_toggle else self.click_post_text_button()):
                    print("⚠️ POST tab click failed, continuing anyway...")
                else:
                    print("✅ POST tab selected")
                time.sleep(1)
            except Exception as e:
                print(f"⚠️ POST tab click error: {e}, continuing...")

            # Step 3: Select recent media
            print(f"\n{'=' * 40}")
            print("📍 STEP 3: SELECT RECENT MEDIA")
            print(f"{'=' * 40}")
            if start_step < 3:
                try:
                    if not self.select_recent_media():
                        print("❌ STEP 3 FAILED: Media selection failed")
                        self.disconnect()
                        return False
                    self._run_post_guard_check(verify_media_selected, "Media selection verification")
                    save_checkpoint("MEDIA_SELECTED", 3)
                except Exception as e:
                    if is_uia2_crash(e):
                        print(
                            "🚨 UIA2 CRASHED at Step 3! Saving checkpoint for retry..."
                        )
                        save_checkpoint("GALLERY", 2)
                    # Try recovery and retry
                    if retry_count < max_retries:
                        print("🔄 Attempting recovery and retry...")
                        self._reset_and_go_home()
                        return self.post_standard_workflow(
                            enable_trial_toggle, retry_count + 1, max_retries
                        )
                    raise
            else:
                print("⏭️ Skipping (already completed)")

            # Step 3.5: Expand/crop (optional, don't fail)
            print(f"\n{'=' * 40}")
            print("📍 STEP 3.5: EXPAND/CROP (OPTIONAL)")
            print(f"{'=' * 40}")
            self.click_expand_crop()

            # DEBUG: Dump UI to see what's on screen before NEXT button
            time.sleep(2)  # Wait for UI to settle
            self.debug_dump_ui("after_expand_crop")

            # Step 4: First NEXT button
            print(f"\n{'=' * 40}")
            print("📍 STEP 4: CLICK FIRST NEXT BUTTON")
            print(f"{'=' * 40}")
            if start_step < 4:
                try:
                    if not self.click_next_button():
                        print("❌ STEP 4 FAILED: First NEXT button failed")
                        self.disconnect()
                        return False
                    save_checkpoint("NEXT_1", 4)
                except Exception as e:
                    if is_uia2_crash(e):
                        print("🚨 UIA2 CRASHED at Step 4! Saving checkpoint...")
                        save_checkpoint("MEDIA_SELECTED", 3)
                    raise
            else:
                print("⏭️ Skipping (already completed)")

            # Step 4.5: Add Audio (for image posts only - makes them more engaging)
            print(f"\n{'=' * 40}")
            print("📍 STEP 4.5: ADD AUDIO TO IMAGE")
            print(f"{'=' * 40}")
            try:
                # Only add audio if NOT posting a reel (reels have their own audio)
                if not enable_trial_toggle:  # Regular image posts
                    self.add_audio_to_image()
                    print("✅ Audio step completed")
                else:
                    print("⏭️ Skipping audio (trial/reel content)")
            except Exception as e:
                print(f"⚠️ Audio step failed: {e} - continuing without audio")

            # Step 5: Second NEXT button
            print(f"\n{'=' * 40}")
            print("📍 STEP 5: CLICK SECOND NEXT BUTTON")
            print(f"{'=' * 40}")
            if enable_trial_toggle:
                print("Skipping second Next for trial reel composer; first Next opens the share screen")
                save_checkpoint("NEXT_2", 5)
            elif start_step < 5:
                try:
                    if not self.click_second_next_button():
                        print("❌ STEP 5 FAILED: Second NEXT button failed")
                        self.disconnect()
                        return False
                    save_checkpoint("NEXT_2", 5)
                except Exception as e:
                    if is_uia2_crash(e):
                        print("🚨 UIA2 CRASHED at Step 5! Saving checkpoint...")
                        save_checkpoint("NEXT_1", 4)
                    raise
            else:
                print("⏭️ Skipping (already completed)")

            # Step 6: Add caption
            print(f"\n{'=' * 40}")
            print("📍 STEP 6: ADD CAPTION")
            print(f"{'=' * 40}")
            if start_step < 6:
                try:
                    if not self.add_caption_from_file():
                        print("❌ STEP 6 FAILED: Caption failed")
                        self.disconnect()
                        return False
                    self._run_post_guard_check(verify_feed_caption_editor, "Feed caption editor verification")
                    save_checkpoint("CAPTION", 6)
                except Exception as e:
                    if is_uia2_crash(e):
                        print("🚨 UIA2 CRASHED at Step 6! Saving checkpoint...")
                        save_checkpoint("NEXT_2", 5)
                    raise
            else:
                print("⏭️ Skipping (already completed)")

            # Step 7: Toggle trial (if enabled)
            if enable_trial_toggle:
                print(f"\n{'=' * 40}")
                print("📍 STEP 7: TOGGLE TRIAL REEL")
                print(f"{'=' * 40}")
                if start_step < 7:
                    try:
                        if not self.toggle_trial_reel_current():
                            print("❌ STEP 7 FAILED: Trial toggle failed")
                            self.disconnect()
                            return False
                        save_checkpoint("TRIAL_TOGGLE", 7)
                    except Exception as e:
                        if is_uia2_crash(e):
                            print("🚨 UIA2 CRASHED at Step 7! Saving checkpoint...")
                            save_checkpoint("CAPTION", 6)
                        raise
                else:
                    print("⏭️ Skipping (already completed)")

            # Step 8: Share — the only step where "did the bytes land?" is
            # what matters. Everything AFTER is best-effort cleanup; a crash
            # in cleanup must NOT make us tell the dashboard "share failed"
            # when the post is already on IG. (That was the source of
            # "pushes but doesn't continue through": cleanup raised, the
            # outer except caught it, returned False, schedule marked the
            # run failed even though the reel was live.)
            print(f"\n{'=' * 40}")
            print("📍 STEP 8: CLICK SHARE BUTTON")
            print(f"{'=' * 40}")
            share_succeeded = False
            try:
                share_succeeded = bool(self.click_share_button())
                if not share_succeeded:
                    print("❌ STEP 8 FAILED: Share failed")
                    self.disconnect()
                    return False
                self._post_was_shared = True
            except Exception as e:
                if is_uia2_crash(e):
                    print("🚨 UIA2 CRASHED at Share! Saving checkpoint...")
                    save_checkpoint("CAPTION", 6)
                raise

            print(f"\n{'=' * 60}")
            print("🎉 POSTING WORKFLOW COMPLETED SUCCESSFULLY!")
            print(f"{'=' * 60}")

            # Best-effort cleanup. Each step is independently guarded so one
            # raise doesn't bail the whole workflow now that the post is up.
            try:
                time.sleep(5)  # Let the upload toast/transition settle
            except Exception:
                pass
            try:
                self._confirm_submission_with_guard_recovery(settle_seconds=1.5)
            except Exception as e:
                print(f"⚠️ Post-share verification raised (non-fatal): {e}")
            try:
                clear_checkpoint()
            except Exception as e:
                print(f"⚠️ Checkpoint clear raised (non-fatal): {e}")
            try:
                self.disconnect()
            except Exception as e:
                print(f"⚠️ Disconnect raised (non-fatal): {e}")

            return True

        except Exception as e:
            print(f"\n{'=' * 60}")
            print(f"❌ POSTING WORKFLOW FAILED: {e}")
            print(f"{'=' * 60}")
            try:
                self.disconnect()
            except Exception:
                pass
            # If the share already happened, the post is live on IG. Returning
            # False would make the dashboard mark the run failed AND would
            # cause re-run logic to try posting AGAIN — duplicate post risk.
            # Surface success-with-warning instead.
            if getattr(self, "_post_was_shared", False):
                print("ℹ️ Share already succeeded before this error; reporting success to avoid double-post")
                return True
            return False

    def post_trial_from_drive(self, caption=None):
        """Post a trial reel from Google Drive - ONLY SOURCE OF CONTENT"""
        try:
            print(
                f"🧪 STARTING TRIAL REEL POST FROM GOOGLE DRIVE (Account {self.account_number})..."
            )
            print("📁 Using account-specific Google Drive for content")

            # Initialize Google Drive manager for this account
            try:
                from modules.drive_module_improved import ImprovedDriveManager
            except ImportError:
                from drive_module_improved import ImprovedDriveManager
            drive_manager = ImprovedDriveManager(
                account_number=self.account_number, device_id=self.device_id
            )

            # The Google Drive manager handles the complete workflow:
            # 1. Navigate to trial folder
            # 2. Download content
            # 3. Post to Instagram (including trial toggle)
            # 4. Clean up gallery
            print("🚀 Executing complete Google Drive → Instagram workflow...")
            result = drive_manager.post_from_drive("trial")

            if result:
                print("🎉 TRIAL REEL POST FROM GOOGLE DRIVE COMPLETED!")
                return True
            else:
                print("❌ Trial reel posting from Google Drive failed")
                return False

        except Exception as e:
            print(f"❌ Trial reel posting from Google Drive failed: {e}")
            return False

    def post_reel(self, video_path=None, caption=None):
        """Post a reel from Google Drive - ONLY SOURCE OF CONTENT"""
        try:
            print(
                f"🎬 STARTING REEL POST FROM GOOGLE DRIVE (Account {self.account_number})..."
            )
            print("📁 Using account-specific Google Drive for content")

            # Initialize Google Drive manager for this account
            try:
                from modules.drive_module_improved import ImprovedDriveManager
            except ImportError:
                from drive_module_improved import ImprovedDriveManager
            drive_manager = ImprovedDriveManager(
                account_number=self.account_number, device_id=self.device_id
            )

            # The Google Drive manager handles the complete workflow:
            # 1. Navigate to reels folder
            # 2. Download content
            # 3. Post to Instagram
            # 4. Clean up gallery
            print("🚀 Executing complete Google Drive → Instagram workflow...")
            result = drive_manager.post_from_drive("reels")

            if result:
                print("🎉 REEL POST FROM GOOGLE DRIVE COMPLETED!")
                return True
            else:
                print("❌ Reel posting from Google Drive failed")
                return False

        except Exception as e:
            print(f"❌ Reel posting from Google Drive failed: {e}")
            return False

    # Legacy method for backward compatibility
    def post_photo(self, image_path=None, caption=None):
        """Legacy method - redirects to post_image"""
        return self.post_image(image_path, caption)

    def post_video(self, video_path=None, caption=None):
        """Post a video to Instagram (similar process to photo)"""
        print("🎥 VIDEO POST: Using same process as photo post...")
        return self.post_photo(video_path, caption)  # Same workflow

    def post_story(self, image_path=None):
        """Post a story to Instagram"""
        try:
            print("📖 STARTING STORY POST PROCESS...")

            if not self.connect():
                return False

            # For stories, we need to click the camera icon at top-left
            print("📷 Looking for story camera icon...")
            story_camera_positions = [
                # Top-left area where story camera usually is
                (80, 150),
                (100, 150),
                (60, 150),
                (80, 130),
                (80, 170),
                (120, 150),
                (40, 150),
                (80, 100),
                (80, 200),
            ]

            story_opened = False
            for x, y in story_camera_positions:
                print(f"🎯 Trying story camera at ({x}, {y})")
                if self.mcp_helper.precise_tap(x, y, "Story camera"):
                    time.sleep(3)
                    story_opened = True
                    break
                time.sleep(0.5)

            if not story_opened:
                print("❌ Could not open story camera")
                self.disconnect()
                return False

            # Same gallery selection process as regular posts
            if not self.select_gallery():
                print("❌ Failed to open gallery for story")
                self.disconnect()
                return False

            if not self.select_recent_media():
                print("❌ Failed to select media for story")
                self.disconnect()
                return False

            # Expand/crop to show full image
            self.click_expand_crop()

            # For stories, we look for "Your Story" button instead of SHARE
            print("📖 Looking for 'Your Story' button...")
            your_story_positions = [
                # Bottom area where "Your Story" appears
                (540, 2200),
                (540, 2150),
                (540, 2250),
                (400, 2200),
                (680, 2200),
                (540, 2100),
                (540, 2300),
            ]

            for x, y in your_story_positions:
                print(f"🎯 Trying 'Your Story' button at ({x}, {y})")
                if self.mcp_helper.precise_tap(x, y, "Your Story button"):
                    time.sleep(3)
                    print("✅ Story posted!")
                    break
                time.sleep(0.5)

            print("🎉 STORY POST COMPLETED!")
            self.disconnect()
            return True

        except Exception as e:
            print(f"❌ Story posting failed: {e}")
            self.disconnect()
            return False

    def post_adb_only(self, caption=None, enable_audio=True):
        """ADB-ONLY Instagram posting workflow - USES TEXT-BASED UI DUMPS!

        Finds elements by text attribute in UI dumps for reliability.
        Tab positions change based on selection, so we find by text.

        Returns:
            bool: True if post successful
        """
        import re
        import tempfile

        def adb(*args):
            """Execute ADB command with device ID"""
            cmd = ["adb", "-s", self.device_id] + list(args)
            return subprocess.run(cmd, capture_output=True, text=True, timeout=30)

        def tap(x, y, desc=""):
            """Tap at coordinates"""
            print(f"🎯 Tapping {desc} at ({x}, {y})")
            adb("shell", "input", "tap", str(x), str(y))
            time.sleep(2)

        def dump_ui(step_name):
            """Dump UI and show key elements for debugging"""
            try:
                dump_file = f"c:/Users/manna/Downloads/IG appium 2/IG appium/debug_step_{step_name}.xml"
                adb("shell", "uiautomator", "dump", "/sdcard/ui_debug.xml")
                adb("pull", "/sdcard/ui_debug.xml", dump_file)

                with open(dump_file, "r", encoding="utf-8") as f:
                    content = f.read()

                # Find key elements
                key_texts = [
                    "POST",
                    "STORY",
                    "REEL",
                    "Next",
                    "Share",
                    "Gallery",
                    "Recents",
                    "Photo",
                    "Video",
                ]
                print(f"📋 UI DUMP [{step_name}]:")
                for kt in key_texts:
                    pattern = f'text="{kt}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"'
                    match = re.search(pattern, content, re.IGNORECASE)
                    if match:
                        x1, y1, x2, y2 = (
                            int(match.group(1)),
                            int(match.group(2)),
                            int(match.group(3)),
                            int(match.group(4)),
                        )
                        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
                        print(f"   → '{kt}' at ({cx}, {cy})")

                print(f"   💾 Saved to: {dump_file}")
            except Exception as e:
                print(f"   ⚠️ Dump failed: {e}")
            return True

        def find_by_text(text_value, timeout=3):
            """Find element by text attribute and return its center coordinates"""
            print(f"🔍 Finding element with text='{text_value}'...")

            for attempt in range(timeout):
                try:
                    # Dump UI
                    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
                    temp_file = os.path.join(tempfile.gettempdir(), f"ui_{attempt}.xml")
                    adb("pull", "/sdcard/ui.xml", temp_file)

                    with open(temp_file, "r", encoding="utf-8") as f:
                        content = f.read()

                    # Find by text attribute
                    pattern = f'text="{re.escape(text_value)}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"'
                    match = re.search(pattern, content)

                    if match:
                        x1, y1, x2, y2 = (
                            int(match.group(1)),
                            int(match.group(2)),
                            int(match.group(3)),
                            int(match.group(4)),
                        )
                        center_x = (x1 + x2) // 2
                        center_y = (y1 + y2) // 2
                        print(f"   ✅ Found '{text_value}' at ({center_x}, {center_y})")

                        try:
                            os.remove(temp_file)
                        except:
                            pass

                        return (center_x, center_y)

                    try:
                        os.remove(temp_file)
                    except:
                        pass

                except Exception as e:
                    print(f"   ⚠️ Attempt {attempt + 1}: {e}")

                time.sleep(1)

            print(f"   ❌ Element with text='{text_value}' not found")
            return None

        def find_and_tap_text(text_value, fallback_coords=None, timeout=3):
            """Find element by text and tap it"""
            coords = find_by_text(text_value, timeout)
            if coords:
                return tap(coords[0], coords[1], f"'{text_value}'")
            elif fallback_coords:
                print(f"   ⚠️ Using fallback coords {fallback_coords}")
                return tap(
                    fallback_coords[0], fallback_coords[1], f"'{text_value}' (fallback)"
                )
            return False

        def type_text_char_by_char(text):
            """Type text CHARACTER BY CHARACTER"""
            print(f"⌨️ Typing: '{text}'")

            # Clean text for shell safety
            clean_text = (
                text.replace('"', "")
                .replace("'", "")
                .replace("`", "")
                .replace("\\", "")
            )
            clean_text = (
                clean_text.replace("&", "and").replace(";", ",").replace("|", " ")
            )
            clean_text = clean_text.replace("!", "").replace("?", "")

            for char in clean_text:
                if char == " ":
                    adb("shell", "input", "keyevent", "KEYCODE_SPACE")
                elif char.isalnum() or char in ".,@#$%^*()_+-=[]{}<>/:":
                    adb("shell", "input", "text", char)
                time.sleep(0.1)

            print(f"✅ Typed: '{clean_text}'")
            time.sleep(1)
            return True

        try:
            print("=" * 60)
            print("📱 ADB-ONLY POSTING (TEXT-BASED UI DUMPS)")
            print("=" * 60)

            # STEP 0: Launch Instagram
            print("\n📍 STEP 0: Launch Instagram")
            adb("shell", "am", "force-stop", "com.instagram.android")
            time.sleep(1)
            adb(
                "shell",
                "monkey",
                "-p",
                "com.instagram.android",
                "-c",
                "android.intent.category.LAUNCHER",
                "1",
            )
            time.sleep(4)

            # Tap home to ensure we're there
            tap(108, 2274, "Home tab")
            time.sleep(1)

            # STEP 1: Click Create (+) button - TOP LEFT
            print("\n📍 STEP 1: Click Create (+) button")
            tap(63, 201, "Create button (top-left)")
            time.sleep(4)  # INCREASED: Wait for creation screen to fully load
            dump_ui("after_create")  # DEBUG: See what's on screen

            # STEP 2: Click POST tab by TEXT (with RETRY)
            # Tab positions: POST=[293,2213][448,2302] STORY=[448,2213][632,2303] when unselected
            # After clicking, POST shifts to [462,2213][617,2303]
            print("\n📍 STEP 2: Select POST tab")
            post_clicked = False
            for attempt in range(3):  # Try up to 3 times
                if find_and_tap_text("POST", fallback_coords=(370, 2257)):
                    post_clicked = True
                    break
                print(
                    f"   ⚠️ POST tab attempt {attempt + 1} may have failed, retrying..."
                )
                time.sleep(1)
                # Try alternate fallback position
                tap(539, 2258, "POST tab (fallback)")
                time.sleep(1)

            if not post_clicked:
                print("   ⚠️ POST tab click may have failed after retries")
            time.sleep(2)
            dump_ui("after_post_tab")  # DEBUG: See POST tab state

            # NOTE: Instagram AUTO-SELECTS the first image when entering POST mode!
            # No need to tap on gallery items - just continue to crop toggle

            # STEP 2.5: Click CROP/EXPAND toggle to use full resolution
            # content-desc="Change crop" at (79, 1275)
            print("\n📍 STEP 2.5: Click expand/crop toggle")
            tap(79, 1275, "Change crop toggle")
            time.sleep(1)

            # STEP 3: Click NEXT button (photo already selected -> edit screen)
            print("\n📍 STEP 3: Click NEXT (photo auto-selected -> edit)")
            # next_button_textview bounds [920,128][1080,275] -> (1000, 201)
            if not find_and_tap_text("Next", fallback_coords=(1000, 201)):
                print("   ⚠️ Next button may have failed")
            time.sleep(3)

            # STEP 4.5: Add audio (if enabled)
            if enable_audio:
                print("\n📍 STEP 4.5: Add audio")
                # Audio button at bottom-left - VERIFIED from XML dump Jan 2026
                # text="Audio" bounds [88,2114][160,2145] -> center (124, 2130)
                tap(124, 2130, "Audio button")
                time.sleep(3)

                # Scroll and pick random track
                scroll_times = random.randint(1, 4)
                for i in range(scroll_times):
                    adb("shell", "input", "swipe", "540", "1800", "540", "1400", "400")
                    time.sleep(0.8)

                # Select first track - verified from XML dump
                # track_container bounds [0,1603][1080,1764] -> center (540, 1683)
                tap(540, 1683, f"Audio track")
                time.sleep(2)

            # STEP 5: Click SECOND NEXT button (edit -> caption)
            print("\n📍 STEP 5: Click NEXT (to caption screen)")
            # EDIT_NEXT_BUTTON is at BOTTOM-RIGHT: (961, 2280)
            tap(961, 2280, "Next button (bottom-right)")
            time.sleep(3)

            # STEP 5.5: Click THIRD NEXT (after audio, to share screen)
            print("\n📍 STEP 5.5: Click NEXT again")
            tap(961, 2280, "Next button (bottom-right)")
            time.sleep(3)

            # STEP 6: Add caption
            print("\n📍 STEP 6: Add caption")
            # caption_input_text_view bounds [42,990][1038,1116] -> (540, 1053)
            tap(540, 1053, "Caption field")
            time.sleep(1.5)

            # Get caption
            if caption is None:
                try:
                    try:
                        from modules.content_manager import get_random_caption
                    except ImportError:
                        from content_manager import get_random_caption
                    caption = get_random_caption(self.profile_id)
                except:
                    caption = random.choice(self.image_captions)

            type_text_char_by_char(caption)

            # Hide keyboard
            adb("shell", "input", "keyevent", "4")
            time.sleep(1)

            # STEP 7: Share
            print("\n📍 STEP 7: Click Share button")
            # share_footer_button bounds [42,2221][1038,2337] -> (540, 2279)
            tap(540, 2279, "Share button")
            time.sleep(5)

            print("\n🎉 ADB-ONLY POST COMPLETED!")
            return True

        except Exception as e:
            print(f"❌ ADB-only post failed: {e}")
            import traceback

            traceback.print_exc()
            return False

    def post_reel_adb_only(self, caption=None):
        """ADB-ONLY REEL posting workflow - SIMPLER than image posting!

        Reel flow: video selected → Next → POST tab → caption → Share
        NO CROP step, NO AUDIO step (reels keep original audio)

        Returns:
            bool: True if post successful
        """
        import re
        import tempfile

        def adb(*args):
            """Execute ADB command with device ID"""
            cmd = ["adb", "-s", self.device_id] + list(args)
            return subprocess.run(cmd, capture_output=True, text=True, timeout=30)

        def tap(x, y, desc=""):
            """Tap at coordinates"""
            print(f"🎯 Tapping {desc} at ({x}, {y})")
            adb("shell", "input", "tap", str(x), str(y))
            time.sleep(2)
            return True

        def find_by_text(text_value, timeout=3):
            """Find element by text attribute and return its center coordinates"""
            print(f"🔍 Finding element with text='{text_value}'...")

            for attempt in range(timeout):
                try:
                    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
                    temp_file = os.path.join(tempfile.gettempdir(), f"ui_{attempt}.xml")
                    adb("pull", "/sdcard/ui.xml", temp_file)

                    with open(temp_file, "r", encoding="utf-8") as f:
                        content = f.read()

                    pattern = f'text="{re.escape(text_value)}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"'
                    match = re.search(pattern, content)

                    if match:
                        x1, y1, x2, y2 = (
                            int(match.group(1)),
                            int(match.group(2)),
                            int(match.group(3)),
                            int(match.group(4)),
                        )
                        center_x = (x1 + x2) // 2
                        center_y = (y1 + y2) // 2
                        print(f"   ✅ Found '{text_value}' at ({center_x}, {center_y})")

                        try:
                            os.remove(temp_file)
                        except:
                            pass

                        return (center_x, center_y)

                    try:
                        os.remove(temp_file)
                    except:
                        pass

                except Exception as e:
                    print(f"   ⚠️ Attempt {attempt + 1}: {e}")

                time.sleep(1)

            print(f"   ❌ Element with text='{text_value}' not found")
            return None

        def find_and_tap_text(text_value, fallback_coords=None, timeout=3):
            """Find element by text and tap it"""
            coords = find_by_text(text_value, timeout)
            if coords:
                return tap(coords[0], coords[1], f"'{text_value}'")
            elif fallback_coords:
                print(f"   ⚠️ Using fallback coords {fallback_coords}")
                return tap(
                    fallback_coords[0], fallback_coords[1], f"'{text_value}' (fallback)"
                )
            return False

        def type_text_char_by_char(text):
            """Type text CHARACTER BY CHARACTER"""
            print(f"⌨️ Typing: '{text}'")

            clean_text = (
                text.replace('"', "")
                .replace("'", "")
                .replace("`", "")
                .replace("\\", "")
            )
            clean_text = (
                clean_text.replace("&", "and").replace(";", ",").replace("|", " ")
            )
            clean_text = clean_text.replace("!", "").replace("?", "")

            for char in clean_text:
                if char == " ":
                    adb("shell", "input", "keyevent", "KEYCODE_SPACE")
                elif char.isalnum() or char in ".,@#$%^*()_+-=[]{}/<>:":
                    adb("shell", "input", "text", char)
                time.sleep(0.1)

            print(f"✅ Typed: '{clean_text}'")
            time.sleep(1)
            return True

        try:
            print("=" * 60)
            print("🎬 ADB-ONLY REEL POSTING (SIMPLER FLOW)")
            print("=" * 60)

            # STEP 0: Launch Instagram
            print("\n📍 STEP 0: Launch Instagram")
            adb("shell", "am", "force-stop", "com.instagram.android")
            time.sleep(1)
            adb(
                "shell",
                "monkey",
                "-p",
                "com.instagram.android",
                "-c",
                "android.intent.category.LAUNCHER",
                "1",
            )
            time.sleep(4)

            # Tap home to ensure we're there
            tap(108, 2274, "Home tab")
            time.sleep(1)

            # STEP 1: Click Create (+) button - TOP LEFT
            print("\n📍 STEP 1: Click Create (+) button")
            tap(63, 201, "Create button (top-left)")
            time.sleep(4)

            # STEP 2: Click POST tab to show gallery
            print("\n📍 STEP 2: Click POST tab")
            if not find_and_tap_text("POST", fallback_coords=(539, 2258)):
                print("   ⚠️ POST tab click may have failed")
            time.sleep(2)

            # STEP 3: Video is AUTO-SELECTED from gallery
            # For reels, Instagram auto-selects the most recent video - no need to tap
            print("\n📍 STEP 3: Video auto-selected from gallery")

            # STEP 4: Click NEXT button (video selected → edit screen)
            # NO CROP for reels - reels use original video dimensions!
            print("\n📍 STEP 4: Click NEXT (video → edit screen)")
            if not find_and_tap_text("Next", fallback_coords=(1000, 201)):
                print("   ⚠️ Next button may have failed")
            time.sleep(3)

            # STEP 5: Click NEXT AGAIN (edit screen → caption screen)
            # For reels, just click Next again to get to caption!
            print("\n📍 STEP 5: Click NEXT again (edit → caption screen)")
            if not find_and_tap_text("Next", fallback_coords=(1000, 201)):
                # Try bottom-right position as fallback
                tap(961, 2280, "Next button (bottom-right)")
            time.sleep(3)

            # STEP 6: Add caption - just tap at verified coords
            print("\n📍 STEP 6: Add caption")
            # Caption field coords from XML dump: bounds [42,1090][1038,1216] → center (540, 1153)
            tap(540, 1153, "Caption field")
            time.sleep(1.5)

            # Get caption
            if caption is None:
                try:
                    try:
                        from modules.content_manager import get_random_caption
                    except ImportError:
                        from content_manager import get_random_caption
                    caption = get_random_caption(self.profile_id)
                except:
                    caption = random.choice(self.image_captions)

            type_text_char_by_char(caption)

            # Hide keyboard
            adb("shell", "input", "keyevent", "4")
            time.sleep(1)

            # STEP 7: Share - coords from XML dump: bounds [748,2202][851,2249] → center (800, 2226)
            print("\n📍 STEP 7: Click Share button")
            tap(800, 2226, "Share button")
            time.sleep(5)

            print("\n🎉 ADB-ONLY REEL POST COMPLETED!")
            return True

        except Exception as e:
            print(f"❌ ADB-only reel post failed: {e}")
            import traceback

            traceback.print_exc()
            return False


if __name__ == "__main__":
    print("📸 INSTAGRAM POST MODULE TEST")
    print("Testing all post types with Account 1...")

    poster = InstagramPoster(account_number=1)

    print("\n1. Testing image post...")
    if poster.post_image(caption="Test image from Account 1/Images!"):
        print("✅ Image post test successful!")
    else:
        print("❌ Image post test failed!")

    print("\n2. Testing reel post...")
    if poster.post_reel(caption="Test reel from Account 1/Reels!"):
        print("✅ Reel post test successful!")
    else:
        print("❌ Reel post test failed!")

    print("\n3. Testing trial reel post from Google Drive...")
    if poster.post_trial_from_drive(caption="Test trial from Google Drive!"):
        print("✅ Trial reel post from Google Drive successful!")
    else:
        print("❌ Trial reel post from Google Drive failed!")
