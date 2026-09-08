#!/usr/bin/env python3
"""
INSTAGRAM ENGAGEMENT MODULE - v2.3 (Feb 2026)
Performs engagement (Like, Comment, Scroll) on both Home Feed and Reels.
Uses multi-tier fallback: Resource ID → Accessibility ID → Coordinates

ENGAGEMENT SPLIT: 63% Home Feed, 37% Reels (configurable)

VERIFIED SELECTORS (ADB Feb 2026):
==========================================================
HOME FEED:
  - Like: row_feed_button_like → X=63 (Y scroll-dependent)
  - Comment: row_feed_button_comment → X varies on ads!
  - Double-tap: (540, 1415)  # media center
  - ⚠️ Feed button Y is NOT fixed — use resource-ID!

REELS (ALL EXACT MATCH with ig_selectors.Coords):
  - Like: like_button → (1001, 1121)
  - Comment: comment_button → (1001, 1299)
  - Double-tap: (540, 1200)
"""

import time
import random
import subprocess
import sys
import os

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

try:
    from appium import webdriver
    from appium.options.android import UiAutomator2Options
    from appium.webdriver.common.appiumby import AppiumBy
except ImportError:
    webdriver = None
    UiAutomator2Options = None

    class AppiumBy:
        ID = "id"
        ACCESSIBILITY_ID = "accessibility id"
        XPATH = "xpath"

# Add parent directory to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from modules.instagram_launcher_module import InstagramLauncher
except ImportError:
    InstagramLauncher = None
from modules.ig_selectors import InstagramSelectors

# Import crash recovery module
try:
    from appium_crash_recovery import auto_recover_from_crash

    CRASH_RECOVERY_AVAILABLE = True
except ImportError:
    CRASH_RECOVERY_AVAILABLE = False
    print("⚠️ Crash recovery module not available")

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


class InstagramEngager:
    def __init__(
        self, device_id="1A121FDF60082H", user_id=None, settings=None, **kwargs
    ):
        self.device_id = device_id
        self.driver = None
        self.appium_failures = 0  # Track consecutive Appium failures
        self.adb_only_mode = False  # Switch to pure ADB after 3 failures

        # Load settings from Supabase or use defaults
        if settings is None and user_id:
            try:
                from lib.supabase_client import get_engagement_settings

                settings = get_engagement_settings(user_id)
                print(
                    f"⚙️ Loaded engagement settings from Supabase for user {user_id[:8]}..."
                )
            except Exception as e:
                print(f"⚠️ Could not load settings: {e}")
                settings = {}
        settings = settings or {}

        # ⏱️ VIEWING TIMES (configurable) — realistic human ranges
        self.viewing_times = {
            "quick_scroll": (
                settings.get("quick_scroll_min", 0.4),
                settings.get("quick_scroll_max", 1.2),
            ),
            "brief_view": (
                settings.get("brief_view_min", 1.5),
                settings.get("brief_view_max", 3.5),
            ),
            "engaged_view": (
                settings.get("engaged_view_min", 4.0),
                settings.get("engaged_view_max", 8.0),
            ),
            "deep_view": (
                settings.get("deep_view_min", 8.0),
                settings.get("deep_view_max", 15.0),
            ),
            "captivated": (
                settings.get("captivated_min", 15.0),
                settings.get("captivated_max", 25.0),
            ),
        }

        # 🎭 HUMANIZATION SETTINGS (configurable)
        self.humanize = True
        self.jitter_range = settings.get("jitter_range", 30)
        self.micro_pause_range = (
            settings.get("micro_pause_min", 0.05),
            settings.get("micro_pause_max", 0.2),
        )

        # 🎯 ENGAGEMENT RATIOS (configurable)
        self.default_like_chance = settings.get("like_chance", 80)
        self.default_comment_chance = settings.get("comment_chance", 15)
        self.default_feed_ratio = (
            settings.get("feed_ratio", 33) / 100.0
        )  # Convert to 0-1

        # 🧠 HUMAN BEHAVIOR SYSTEM
        try:
            from modules.human_behavior import get_human_behavior

            self.hb = get_human_behavior()
        except:
            self.hb = None

    def _jitter(self, value, range_val=None):
        """Add random jitter to coordinates to avoid pattern detection"""
        if not self.humanize:
            return value
        r = range_val or self.jitter_range
        return value + random.randint(-r, r)

    def _micro_pause(self):
        """Small random pause between actions with human behavior awareness"""
        if self.humanize:
            if self.hb:
                # Use human behavior for smarter micro-pauses
                time.sleep(self.hb.get_micro_pause())
                self.hb.add_fatigue("general")
            else:
                time.sleep(random.uniform(*self.micro_pause_range))

    def _human_tap(self, x, y):
        """Tap with randomized coordinates"""
        jx, jy = self._jitter(x), self._jitter(y)
        subprocess.run(
            ["adb", "-s", self.device_id, "shell", "input", "tap", str(jx), str(jy)],
            timeout=3,
        )
        self._micro_pause()

    def _warmup_browse(self, count=None, mode="feed"):
        """Passive browsing before engaging — scroll without interacting.
        Real humans open the app and scroll a bit before they start liking."""
        if count is None:
            count = random.randint(2, 5)
        print(f"   Warmup: passively scrolling {count} posts ({mode})...")
        for i in range(count):
            # Variable watch time during warmup (shorter, just glancing)
            watch = random.uniform(0.8, 3.0)
            time.sleep(watch)
            # Occasional brief pause like reading a caption
            if random.random() < 0.25:
                time.sleep(random.uniform(0.5, 1.5))
            # Scroll
            self._human_scroll(mode)
            time.sleep(random.uniform(0.2, 0.5))
        print(f"   Warmup complete")

    def _human_scroll(self, mode="reels"):
        """Scroll with natural variation — not the same swipe every time."""
        if mode == "feed":
            # Feed scrolls are shorter, more variable
            base_start_y = 1600
            base_end_y = random.choice([400, 500, 600, 700, 800, 900])
        else:
            # Reels are full-screen swipes
            base_start_y = 1800
            base_end_y = 600

        start_x = 540 + random.randint(-60, 60)
        start_y = base_start_y + random.randint(-100, 100)
        end_x = 540 + random.randint(-60, 60)
        end_y = base_end_y + random.randint(-80, 80)

        # Variable speed — sometimes fast flick, sometimes slow drag
        speed_roll = random.random()
        if speed_roll < 0.15:
            duration = random.randint(80, 140)   # fast flick
        elif speed_roll < 0.70:
            duration = random.randint(180, 350)  # normal
        else:
            duration = random.randint(400, 600)  # slow deliberate scroll

        subprocess.run(
            ["adb", "-s", self.device_id, "shell", "input", "swipe",
             str(start_x), str(start_y), str(end_x), str(end_y), str(duration)],
            capture_output=True, timeout=5,
        )

        # 12% chance: overshoot correction — scroll back up a tiny bit
        if random.random() < 0.12 and mode == "feed":
            time.sleep(random.uniform(0.3, 0.7))
            correction_dist = random.randint(80, 200)
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "swipe",
                 str(540), str(800), str(540), str(800 + correction_dist),
                 str(random.randint(150, 250))],
                capture_output=True, timeout=5,
            )
            print("   [scroll correction]")

        # 8% chance: partial/hesitant scroll — only go halfway then stop
        if random.random() < 0.08:
            time.sleep(random.uniform(0.2, 0.5))
            print("   [hesitant pause]")

    def _profile_peek(self):
        """Tap a username to visit their profile, look around, go back.
        Real users do this constantly out of curiosity."""
        try:
            print("   [profile peek]")
            # Tap username area (top-left of post in feed, or author in reels)
            # Feed: username is typically around (200, varies by scroll position)
            # Reels: author username is bottom-left
            if random.random() < 0.5:
                # Tap author area in reels (bottom-left)
                tap_x = random.randint(80, 300)
                tap_y = random.randint(1900, 2000)
            else:
                # Tap username in feed (top area of visible post)
                tap_x = random.randint(100, 350)
                tap_y = random.randint(160, 250)

            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "tap",
                 str(tap_x), str(tap_y)],
                timeout=3,
            )
            # Look at profile for 2-6 seconds
            peek_time = random.uniform(2.0, 6.0)
            time.sleep(peek_time)

            # Occasionally scroll down their profile grid (30%)
            if random.random() < 0.30:
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "input", "swipe",
                     "540", "1400", "540", "900", str(random.randint(200, 350))],
                    capture_output=True, timeout=5,
                )
                time.sleep(random.uniform(1.0, 3.0))

            # Go back
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                capture_output=True, timeout=3,
            )
            time.sleep(random.uniform(0.5, 1.0))
            return True
        except Exception as e:
            print(f"   Profile peek failed: {e}")
            # Recovery: press back
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                capture_output=True, timeout=3,
            )
            return False

    def _adb_tap_by_resource_id(self, resource_id):
        """Find element by resource ID using XML dump and tap its center

        This works even when Appium is crashed - uses pure ADB!
        Returns True if element found and tapped, False otherwise.
        """
        try:
            import re
            import tempfile

            # Dump UI to device
            dump_result = subprocess.run(
                [
                    "adb",
                    "-s",
                    self.device_id,
                    "shell",
                    "uiautomator",
                    "dump",
                    "/sdcard/eng_temp.xml",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if dump_result.returncode != 0:
                return False

            # Pull and read
            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".xml", delete=False
            ) as f:
                temp_path = f.name
            subprocess.run(
                [
                    "adb",
                    "-s",
                    self.device_id,
                    "pull",
                    "/sdcard/eng_temp.xml",
                    temp_path,
                ],
                capture_output=True,
                timeout=5,
            )

            with open(temp_path, "r", encoding="utf-8") as f:
                xml_content = f.read()

            # Find element bounds by resource ID
            pattern = rf'resource-id="{re.escape(resource_id)}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
            match = re.search(pattern, xml_content)

            if match:
                x1, y1, x2, y2 = map(int, match.groups())
                cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
                subprocess.run(
                    [
                        "adb",
                        "-s",
                        self.device_id,
                        "shell",
                        "input",
                        "tap",
                        str(cx),
                        str(cy),
                    ],
                    timeout=3,
                )
                print(
                    f"   Tapped {resource_id.split('/')[-1]} via ADB+XML at ({cx},{cy})"
                )
                return True
            else:
                print(f"   Element {resource_id.split('/')[-1]} not found in XML")
                return False

        except Exception as e:
            print(f"   ADB tap by ID failed: {e}")
            return False

    def _try_reconnect_appium(self):
        """Try to reconnect Appium when it crashes - faster than XML dumps"""
        try:
            if InstagramLauncher is None:
                return False
            print("   🔄 Attempting Appium reconnect...")

            launcher = InstagramLauncher(self.device_id)

            # Try to get a fresh driver connection
            if launcher.driver:
                self.driver = launcher.driver
                self.appium_failures = 0
                self.adb_only_mode = False
                print("   ✅ Appium reconnected!")
                return True

            # Try connecting fresh
            if launcher.connect_adb():
                self.driver = launcher.driver
                self.appium_failures = 0
                self.adb_only_mode = False
                print("   ✅ Appium reconnected via fresh connection!")
                return True

        except Exception as e:
            print(f"   ⚠️ Appium reconnect failed: {e}")

        return False

    def _handle_appium_error(self, error, operation_name="operation"):
        """Handle Appium errors with automatic crash recovery"""
        if CRASH_RECOVERY_AVAILABLE:
            print(f"🚨 Error during {operation_name}: {error}")
            return False
        return False

    def _ensure_home_and_recover(self):
        """Emergency recovery - go back to home tab when stuck"""
        try:
            print("   🔄 Attempting recovery to home screen...")
            # Press back 3 times to exit any nested screens
            for _ in range(3):
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                    capture_output=True,
                    timeout=2,
                )
                time.sleep(0.3)
            # Tap home tab (verified coordinate)
            time.sleep(0.5)
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "tap", "108", "2274"],
                capture_output=True,
                timeout=3,
            )
            print("   ✅ Recovered to home screen")
            return True
        except Exception as e:
            print(f"   ⚠️ Recovery failed: {e}")
            return False

    def connect(self):
        """Connect to Instagram and navigate to reels tab - WITH ADB FALLBACK"""
        try:
            print("📱 Connecting to Instagram Reels...")

            # PRE-LAUNCH CLEANUP: 2x back to clear any stuck screens
            print("🔄 Pre-launch cleanup: Pressing back 2x...")
            import subprocess

            for _ in range(2):
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                    capture_output=True,
                    timeout=3,
                )
                time.sleep(0.5)
            time.sleep(0.5)

            # LAUNCH INSTAGRAM FIRST (required before clicking any nav tabs)
            if InstagramLauncher is None:
                print("   Instagram launcher unavailable; using ADB-only connection")
                return self.connect_adb_only()

            launcher = InstagramLauncher(self.device_id)

            print("📱 Launching Instagram FIRST...")
            launcher_outcome = launcher.open_instagram_home_strict()
            home_ready, home_error = type(launcher).is_verified_home_ready(launcher_outcome)
            if not home_ready:
                print(f"❌ {home_error}")
                return False
            time.sleep(1.5)

            # Try WebDriver first, fall back to ADB-only
            try:
                if launcher.open_instagram_reels():
                    self.driver = launcher.driver
                    print("✅ Connected to Instagram REELS via WebDriver!")
                    return True
            except Exception as e:
                print(f"⚠️ WebDriver connect failed: {e}")

            # ADB-only fallback
            print("🔄 Using ADB-only connection...")
            return self.connect_adb_only()

        except Exception as e:
            print(f"❌ Connection failed: {e}")
            return False

    def connect_adb_only(self):
        """Connect using pure ADB - NO WEBDRIVER NEEDED!

        This is the most reliable method when UiAutomator2 has issues.
        """
        try:
            print("📱 ADB-ONLY: Connecting to Instagram...")

            if InstagramLauncher is None:
                import re

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
                time.sleep(2)
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "input", "tap", "324", "2274"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                time.sleep(2)
                dump_result = subprocess.run(
                    [
                        "adb",
                        "-s",
                        self.device_id,
                        "shell",
                        "uiautomator",
                        "dump",
                        "/sdcard/engagement_reels_check.xml",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=8,
                )
                xml_result = subprocess.run(
                    [
                        "adb",
                        "-s",
                        self.device_id,
                        "shell",
                        "cat",
                        "/sdcard/engagement_reels_check.xml",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                xml = xml_result.stdout or ""
                clips_selected = bool(
                    re.search(
                        r'resource-id="com\.instagram\.android:id/clips_tab"[^>]*selected="true"',
                        xml,
                        re.DOTALL,
                    )
                    or re.search(
                        r'selected="true"[^>]*resource-id="com\.instagram\.android:id/clips_tab"',
                        xml,
                        re.DOTALL,
                    )
                )
                if dump_result.returncode != 0 or not (
                    "com.instagram.android:id/root_clips_layout" in xml
                    or "com.instagram.android:id/clips_viewer_view_pager" in xml
                    or clips_selected
                ):
                    print("❌ ADB-ONLY: Reels surface was not verified")
                    return False
                self.adb_only_mode = True
                self.driver = None
                print("✅ ADB-ONLY: Connected to Instagram Reels via coordinate fallback")
                return True

            launcher = InstagramLauncher(self.device_id)

            # Use ADB-only launcher methods
            if launcher.open_instagram_reels_adb():
                self.adb_only_mode = True
                self.driver = None  # No WebDriver in ADB-only mode
                print("✅ ADB-ONLY: Connected to Instagram Reels!")
                return True
            else:
                print("❌ ADB-only connection failed")
                return False

        except Exception as e:
            print(f"❌ ADB-only connection failed: {e}")
            return False

    def disconnect(self):
        if self.driver:
            self.driver.quit()
            print("🔄 Disconnected")

    # ⏱️ Maximum time to spend on a single reel (prevents stuck situations)
    MAX_REEL_VIEW_TIME = 30  # seconds

    def detect_ad(self):
        """🚫 Ad/Sponsored detection via ADB XML dump.
        Checks for 'Sponsored' label, ad CTAs, and ad markers in the current screen.
        Returns True if current post/reel is an ad — MUST skip to avoid tracking."""
        try:
            import html
            import re
            import tempfile

            # Quick XML dump to check for ad markers
            dump_result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "uiautomator", "dump",
                 "/sdcard/ad_check.xml"],
                capture_output=True, text=True, timeout=8,
            )
            if dump_result.returncode != 0:
                return False  # Can't determine, assume not ad

            temp_path = os.path.join(tempfile.gettempdir(), "ad_check.xml")
            subprocess.run(
                ["adb", "-s", self.device_id, "pull", "/sdcard/ad_check.xml", temp_path],
                capture_output=True, timeout=5,
            )

            with open(temp_path, "r", encoding="utf-8") as f:
                xml = f.read()

            try:
                os.remove(temp_path)
            except:
                pass

            xml_lower = xml.lower()

            sponsor_phrases = [
                "sponsored",
                "paid partnership",
                "paid for by",
                "advertisement",
            ]
            for attr, value in re.findall(
                r'(text|content-desc)="([^"]*)"',
                xml,
                re.IGNORECASE | re.DOTALL,
            ):
                normalized = re.sub(r"\s+", " ", html.unescape(value).strip().lower())
                if normalized == "ad":
                    print("   AD DETECTED (Ad label)")
                    return True
                for phrase in sponsor_phrases:
                    if (
                        normalized == phrase
                        or normalized.startswith(f"{phrase} ")
                        or f" {phrase} " in f" {normalized} "
                    ):
                        print(f"   AD DETECTED ({phrase})")
                        return True

            # Primary indicators — "Sponsored" label is the definitive marker
            ad_markers = [
                'text="sponsored"',
                'text="Sponsored"',
                'content-desc="sponsored"',
                'content-desc="Sponsored"',
                'text="paid partnership"',
                'text="Paid partnership"',
                'content-desc="paid partnership"',
                'content-desc="Paid partnership"',
                'text="paid for by"',
                'content-desc="paid for by"',
            ]
            for marker in ad_markers:
                if marker.lower() in xml_lower:
                    print("   AD DETECTED (Sponsored label)")
                    return True

            # CTA buttons that only appear on ads
            ad_ctas = [
                "shop now", "learn more", "install now", "sign up",
                "book now", "download", "get offer", "order now",
                "apply now", "contact us", "get quote", "subscribe",
                "watch more", "listen now",
            ]
            for cta in ad_ctas:
                if re.search(rf'(text|content-desc)="[^"]*{re.escape(cta)}[^"]*"', xml, re.IGNORECASE):
                    print(f"   AD DETECTED (CTA: {cta})")
                    return True

            # Ad-specific resource IDs
            ad_resource_ids = [
                "sponsored_label", "reel_item_sponsored_label_footer_pill",
                "ad_label", "ad_header", "ad_cta_button", "ad_cta",
                "branded_content", "paid_partnership",
                "story_item_cta_container", "cta_sticker",
            ]
            for rid in ad_resource_ids:
                if rid in xml_lower:
                    print(f"   AD DETECTED (resource: {rid})")
                    return True

            return False

        except Exception as e:
            # Fail safe — if detection fails, assume not an ad
            return False

    def like(self):
        """❤️ Like current reel using multi-tier strategy"""
        try:
            print("   Liking reel...")

            # Strategy 1: Resource ID (VERIFIED Dec 2024 - toolbar_like_button)
            if self.driver:
                try:
                    like_btn = self.driver.find_element(
                        AppiumBy.ID, InstagramSelectors.STORY_LIKE_BUTTON
                    )
                    like_btn.click()
                    print("   Liked via Resource ID: toolbar_like_button")
                    time.sleep(0.3)
                    return True
                except:
                    pass

                # Strategy 2: clips_like_button (for Reels tab)
                try:
                    like_btn = self.driver.find_element(
                        AppiumBy.ID, InstagramSelectors.REELS_LIKE_BTN
                    )
                    like_btn.click()
                    print("   Liked via Resource ID: clips_like_button")
                    time.sleep(0.3)
                    return True
                except:
                    pass

                # Strategy 3: Accessibility ID "Like"
                try:
                    like_btn = self.driver.find_element(
                        AppiumBy.ACCESSIBILITY_ID, "Like"
                    )
                    like_btn.click()
                    print("   Liked via Accessibility ID")
                    time.sleep(0.3)
                    return True
                except:
                    pass

            # Strategy 4: ADB double-tap center. CRITICAL: verify the like
            # actually registered. Previously this returned True without any
            # check, so on ads, blank frames, or unloaded reels the counter
            # advanced for non-events. We dump UI after and look for the
            # "Liked" content-desc on the toolbar (IG flips the like button
            # accessibility text from "Like" → "Liked" when activated).
            print("   Strategy 4: ADB double-tap center")
            x, y = 540, 1200  # Center of reel
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "tap", str(x), str(y)],
                timeout=2,
            )
            time.sleep(0.08)
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "tap", str(x), str(y)],
                timeout=2,
            )
            time.sleep(0.6)
            try:
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "uiautomator", "dump", "/sdcard/like_check.xml"],
                    timeout=5,
                )
                res = subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "cat", "/sdcard/like_check.xml"],
                    capture_output=True, text=True, timeout=5,
                )
                xml = res.stdout or ""
                liked = 'content-desc="Liked"' in xml or 'text="Liked"' in xml
                if not liked:
                    print(f"   ⚠️ Double-tap at ({x}, {y}) did NOT toggle 'Liked' state — reporting like FAILED")
                    return False
                print(f"   ✅ Double-tap like verified at ({x}, {y})")
            except Exception as ve:
                print(f"   ⚠️ Could not verify like; treating as failure: {ve}")
                return False
            return True

        except Exception as e:
            print(f"   Like failed: {e}")
            return False

    def comment(self):
        """💬 Comment on reel using multi-tier strategy"""
        try:
            print("   Starting comment flow...")

            # 1. Open Comment Section
            print("   Opening comment sheet...")
            comment_opened = False

            # Strategy 1a: Resource ID (clips_comment_button)
            if self.driver:
                try:
                    comment_btn = self.driver.find_element(
                        AppiumBy.ID, InstagramSelectors.REELS_COMMENT_BTN
                    )
                    comment_btn.click()
                    comment_opened = True
                    print("   Comment sheet opened (Resource ID)")
                except:
                    pass

            # Strategy 1b: Accessibility ID "Comment"
            if not comment_opened and self.driver:
                try:
                    comment_btn = self.driver.find_element(
                        AppiumBy.ACCESSIBILITY_ID, "Comment"
                    )
                    comment_btn.click()
                    comment_opened = True
                    print("   Comment sheet opened (Accessibility ID)")
                except:
                    pass

            # Strategy 1c: ADB tap at comment button coords
            if not comment_opened:
                subprocess.run(
                    [
                        "adb",
                        "-s",
                        self.device_id,
                        "shell",
                        "input",
                        "tap",
                        "1001",
                        "1299",
                    ],
                    timeout=3,
                )
                comment_opened = True
                print("   Comment sheet opened (ADB coords)")

            time.sleep(2.5)  # Wait for comment sheet to open

            # 2. Tap Input Field
            input_ready = False

            # Strategy 2a: Resource ID (layout_comment_thread_edittext)
            if self.driver:
                try:
                    field = self.driver.find_element(
                        AppiumBy.ID, InstagramSelectors.COMMENT_INPUT
                    )
                    field.click()
                    input_ready = True
                    print("   Comment input clicked (Resource ID)")
                except:
                    pass

            # Strategy 2b: XPath "Add a comment"
            if not input_ready and self.driver:
                try:
                    field = self.driver.find_element(
                        AppiumBy.XPATH, "//*[contains(@text, 'Add a comment')]"
                    )
                    field.click()
                    input_ready = True
                    print("   Comment input clicked (XPath)")
                except:
                    pass

            # Strategy 2c: ADB tap at verified coordinates
            if not input_ready:
                subprocess.run(
                    [
                        "adb",
                        "-s",
                        self.device_id,
                        "shell",
                        "input",
                        "tap",
                        "543",
                        "1435",
                    ],
                    timeout=3,
                )
                input_ready = True
                print("   Comment input tapped (ADB coords)")

            if not input_ready:
                print("   Could not find input field")
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                    timeout=3,
                )
                return False

            time.sleep(1)

            # 3. Type Comment via ADB (Reliable)
            comment_text = self._get_random_comment()
            print(f"   Typing: {comment_text}")

            # Sanitize for ADB "input text" (spaces need %s)
            adb_text = comment_text.replace(" ", "%s")
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "text", adb_text],
                timeout=5,
            )
            time.sleep(1.5)

            # 4. Post Comment
            print("   Posting comment...")
            posted = False

            # Strategy 4a: Resource ID (layout_comment_thread_post_button_click_area)
            if self.driver:
                try:
                    post_btn = self.driver.find_element(
                        AppiumBy.ID, InstagramSelectors.COMMENT_POST_BTN
                    )
                    post_btn.click()
                    posted = True
                    print("   Post button clicked (Resource ID)")
                except:
                    pass

            # Strategy 4b: ADB tap at verified coordinates
            if not posted:
                subprocess.run(
                    [
                        "adb",
                        "-s",
                        self.device_id,
                        "shell",
                        "input",
                        "tap",
                        "977",
                        "1441",
                    ],
                    timeout=3,
                )
                posted = True
                print("   Post button tapped (ADB coords)")

            time.sleep(1.5)

            # 5. Verify the comment was actually posted before reporting success.
            # Previously this returned True after tapping the post button — but
            # if we tapped the wrong UI element (e.g. the heart on the comment
            # sheet) the post never went through and the dashboard counted a
            # successful comment for a non-event. Confirmation: the EditText
            # should be empty (IG clears it after submit).
            try:
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "uiautomator", "dump", "/sdcard/comment_check.xml"],
                    timeout=5,
                )
                res = subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "cat", "/sdcard/comment_check.xml"],
                    capture_output=True, text=True, timeout=5,
                )
                xml = res.stdout or ""
                # If we still see our typed text in any EditText, the post didn't fire.
                text_still_present = False
                if comment_text and len(comment_text) >= 4:
                    needle = comment_text[:min(20, len(comment_text))].replace('"', '')
                    if f'text="{needle}' in xml:
                        text_still_present = True
                if text_still_present:
                    print(f"   ⚠️ Comment text still in EditText after post-tap — reporting comment FAILED")
                    subprocess.run(["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"], timeout=3)
                    return False
            except Exception as ve:
                print(f"   ⚠️ Comment verification raised (treating as success since text may have cleared): {ve}")

            # 5. Close Comment Sheet
            print("   Closing comment sheet...")
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                timeout=3,
            )
            time.sleep(0.3)
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                timeout=3,
            )
            time.sleep(0.5)

            return True

        except Exception as e:
            print(f"   Comment failed: {e}")
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                timeout=3,
            )
            return False

    def _get_random_comment(self):
        try:
            from content_manager import get_random_comment

            comment = get_random_comment("0")
            # Sanitize for ADB - remove emojis
            import re

            return re.sub(r"[^\x00-\x7F]+", "", comment).strip() or "love this"
        except:
            # Human-like comments organized by length/style for natural variety
            # Weighted selection: 30% short reactions, 40% medium, 20% sentences, 10% questions
            roll = random.random()
            if roll < 0.30:
                # Short reactions (1-2 words) - quick gut reactions
                comments = [
                    "no way", "sheesh", "yooo", "dude", "bruhhh",
                    "nah this", "lowkey fire", "big W", "so clean",
                    "held", "valid", "tough", "insane bro",
                    "dead", "actually crazy", "ok wow", "chills",
                ]
            elif roll < 0.70:
                # Medium reactions (3-6 words) - conversational
                comments = [
                    "this is actually insane", "bro how is this real",
                    "i needed to see this", "why is this so good",
                    "this just made my day", "been thinking about this",
                    "ok this hits different", "nah you snapped on this",
                    "not me watching this again", "the way i gasped",
                    "adding this to my saves", "this energy is unmatched",
                    "literally cant scroll past this", "how do you do this",
                    "i keep coming back to this", "this deserves way more views",
                    "didnt expect to love this", "ok i see you",
                    "this is what i needed today", "underrated honestly",
                ]
            elif roll < 0.90:
                # Full sentences (7+ words) - genuine engagement
                comments = [
                    "i swear this is the best thing on my feed right now",
                    "bro i literally stopped scrolling just for this",
                    "ok wait this actually changed my perspective",
                    "i just sent this to like 5 people no joke",
                    "this is the kind of content i came here for",
                    "not gonna lie this caught me completely off guard",
                    "i have watched this an embarrassing number of times already",
                    "the fact that this doesnt have millions of views is criminal",
                    "genuinely one of the best things ive seen all week",
                    "i dont even follow you but im about to",
                ]
            else:
                # Questions - high engagement signal
                comments = [
                    "wait how did you do that", "is anyone else seeing this",
                    "how is no one talking about this", "can you teach me this",
                    "where was this at", "whats the song called",
                    "bro what camera do you use", "how long did this take you",
                    "do you post more stuff like this", "can i repost this",
                ]
            return random.choice(comments)

    def scroll(self):
        """📜 Scroll to next reel with humanized swipe - WITH RETRY"""
        max_retries = 3

        # Get human behavior scroll pattern if available
        scroll_pattern = None
        if self.hb:
            scroll_pattern = self.hb.get_scroll_pattern()

        for attempt in range(max_retries):
            try:
                # Humanized swipe coordinates (jittered)
                start_x = self._jitter(540, 50)  # Center X ± 50px
                start_y = self._jitter(1800, 100)  # Start Y ± 100px
                end_x = self._jitter(540, 50)
                end_y = self._jitter(600, 100)  # End Y ± 100px

                # Use human behavior duration if available
                if scroll_pattern:
                    duration = scroll_pattern["duration_ms"]
                else:
                    duration = random.randint(150, 300)  # 150-300ms (varied speed)

                result = subprocess.run(
                    [
                        "adb",
                        "-s",
                        self.device_id,
                        "shell",
                        "input",
                        "swipe",
                        str(start_x),
                        str(start_y),
                        str(end_x),
                        str(end_y),
                        str(duration),
                    ],
                    capture_output=True,
                    timeout=5,
                )

                if result.returncode == 0:
                    # Use human behavior pause after scroll
                    if scroll_pattern:
                        time.sleep(scroll_pattern["pause_after"])
                        if self.hb:
                            self.hb.add_fatigue("scroll")
                    else:
                        self._micro_pause()
                    return True

                # Fallback to Appium swipe (also humanized)
                if self.driver:
                    self.driver.swipe(start_x, start_y, end_x, end_y, duration)
                    return True

            except Exception as e:
                print(f"⚠️ Scroll attempt {attempt + 1} failed: {e}")
                time.sleep(0.5)

        # FORCE scroll with simpler command as last resort
        print("🔄 Force scrolling with simple swipe...")
        try:
            subprocess.run(
                [
                    "adb",
                    "-s",
                    self.device_id,
                    "shell",
                    "input",
                    "swipe",
                    "540",
                    "1800",
                    "540",
                    "600",
                    "200",
                ],
                capture_output=True,
                timeout=5,
            )
            time.sleep(0.5)
            return True
        except:
            print("❌ All scroll attempts failed")
            return False

    def smart_engage(self):
        """🚀 Main engagement loop step with humanized behavior"""
        print("\n🤖 Smart Engage Step")

        # 1. Detect Ad
        if self.detect_ad():
            print("⏩ Skipping Ad...")
            self._human_scroll("reels")
            return "skipped_ad"

        # 2. Watch with humanized timing — 5 tiers including captivated
        view_type = random.choices(
            ["quick_scroll", "brief_view", "engaged_view", "deep_view", "captivated"],
            weights=[0.15, 0.35, 0.30, 0.15, 0.05],
        )[0]

        min_time, max_time = self.viewing_times[view_type]
        wait = random.uniform(min_time, max_time)
        print(f"👀 Watching ({view_type}) for {wait:.1f}s...")
        time.sleep(wait)

        # 3. Actions based on view type
        result = {"liked": False, "commented": False, "peeked": False}

        if view_type in ["engaged_view", "deep_view", "captivated"]:
            if random.random() < 0.50:
                result["liked"] = self.like()

            if view_type in ["deep_view", "captivated"] and random.random() < 0.18:
                result["commented"] = self.comment()

            # 10% chance to peek at the creator's profile
            if random.random() < 0.10:
                result["peeked"] = self._profile_peek()
        elif view_type == "brief_view":
            if random.random() < 0.20:
                result["liked"] = self.like()

        # 4. Next reel — use humanized scroll
        self._human_scroll("reels")
        return result

    def smart_engage_with_ratios(self, like_chance=80, comment_chance=15):
        """🚀 Engagement with configurable like/comment ratios - MORE HUMANIZED"""
        print(f"\n🤖 Smart Engage (like: {like_chance}%, comment: {comment_chance}%)")

        # 1. Detect Ad
        if self.detect_ad():
            print("⏩ Skipping Ad...")
            self._human_scroll("reels")
            return "skipped_ad"

        # 2. Watch with humanized timing — 5 tiers
        view_type = random.choices(
            ["quick_scroll", "brief_view", "engaged_view", "deep_view", "captivated"],
            weights=[0.12, 0.33, 0.33, 0.17, 0.05],
        )[0]

        min_time, max_time = self.viewing_times[view_type]
        wait = random.uniform(min_time, max_time)
        print(f"👀 Watching ({view_type}) for {wait:.1f}s...")
        time.sleep(wait)

        # 3. Actions based on CONFIGURABLE RATIOS
        result = {"liked": False, "commented": False, "peeked": False}

        # Only engage on non-quick views
        if view_type != "quick_scroll":
            view_multiplier = {
                "brief_view": 0.5,
                "engaged_view": 1.0,
                "deep_view": 1.2,
                "captivated": 1.4,
            }[view_type]
            effective_like_chance = like_chance * view_multiplier / 100

            if random.random() < effective_like_chance:
                result["liked"] = self.like()

            if view_type in ["engaged_view", "deep_view", "captivated"]:
                effective_comment_chance = comment_chance * view_multiplier / 100
                if random.random() < effective_comment_chance:
                    result["commented"] = self.comment()

            # Profile peek on deep/captivated views (8%)
            if view_type in ["deep_view", "captivated"] and random.random() < 0.08:
                result["peeked"] = self._profile_peek()

        # 4. Next reel — humanized scroll
        self._human_scroll("reels")
        return result

    def verify_on_reels(self):
        """🔍 Verify we're on the Reels screen"""
        try:
            # Check for Reels-specific elements
            self.driver.find_element(AppiumBy.ID, InstagramSelectors.REELS_ROOT_LAYOUT)
            return True
        except:
            try:
                self.driver.find_element(
                    AppiumBy.ID, InstagramSelectors.REELS_UFI_COMPONENT
                )
                return True
            except:
                return False

    def get_current_author(self):
        """Get the username of the current reel's author"""
        try:
            author = self.driver.find_element(
                AppiumBy.ID, InstagramSelectors.REELS_AUTHOR_USERNAME
            )
            return author.text
        except:
            return None

    # ═══════════════════════════════════════════════════════════════════
    # HOME FEED ENGAGEMENT METHODS (VERIFIED Dec 2024)
    # ═══════════════════════════════════════════════════════════════════

    def like_feed(self):
        """Like current post on home feed - reconnects Appium if needed"""
        try:
            print("   Liking feed post...")

            # Strategy 1: Appium (fast when working)
            if not self.adb_only_mode and self.driver:
                try:
                    like_btn = self.driver.find_element(
                        AppiumBy.ID, InstagramSelectors.FEED_LIKE_BTN
                    )
                    like_btn.click()
                    self.appium_failures = 0
                    print("   Liked via Appium")
                    time.sleep(0.3)
                    return True
                except Exception as e:
                    self.appium_failures += 1
                    print(f"   Appium fail #{self.appium_failures}")

                    # Try to reconnect after 2 failures
                    if self.appium_failures >= 2:
                        if self._try_reconnect_appium():
                            # Retry with fresh driver
                            try:
                                like_btn = self.driver.find_element(
                                    AppiumBy.ID, InstagramSelectors.FEED_LIKE_BTN
                                )
                                like_btn.click()
                                print("   Liked via Appium (after reconnect)")
                                time.sleep(0.3)
                                return True
                            except:
                                pass
                        else:
                            self.adb_only_mode = True

            # Strategy 2: ADB + XML dump (last resort - slower but reliable)
            if self._adb_tap_by_resource_id(InstagramSelectors.FEED_LIKE_BTN):
                time.sleep(0.3)
                return True

            print("   ⚠️ Like button not found")
            return False

        except Exception as e:
            print(f"   Feed like failed: {e}")
            return False

    def comment_feed(self):
        """Comment on current post on home feed - reconnects Appium if needed"""
        try:
            print("   Starting feed comment flow...")

            # 1. Open comment section
            opened = False
            if not self.adb_only_mode and self.driver:
                try:
                    comment_btn = self.driver.find_element(
                        AppiumBy.ID, InstagramSelectors.FEED_COMMENT_BTN
                    )
                    comment_btn.click()
                    opened = True
                    self.appium_failures = 0
                    print("   Opened comments (Appium)")
                except:
                    self.appium_failures += 1
                    if self.appium_failures >= 2:
                        if self._try_reconnect_appium():
                            try:
                                comment_btn = self.driver.find_element(
                                    AppiumBy.ID, InstagramSelectors.FEED_COMMENT_BTN
                                )
                                comment_btn.click()
                                opened = True
                                print("   Opened comments (after reconnect)")
                            except:
                                pass
                        else:
                            self.adb_only_mode = True

            if not opened:
                # Last resort: XML lookup
                opened = self._adb_tap_by_resource_id(
                    InstagramSelectors.FEED_COMMENT_BTN
                )
                if not opened:
                    print("   ⚠️ Comment button not found")
                    return False

            time.sleep(1.5)

            # 2. Tap input field (comment sheet is now open, fixed position)
            input_ready = False
            if not self.adb_only_mode and self.driver:
                try:
                    input_field = self.driver.find_element(
                        AppiumBy.ID, InstagramSelectors.COMMENT_INPUT
                    )
                    input_field.click()
                    input_ready = True
                    self.appium_failures = 0
                    print("   Comment input tapped (Appium)")
                except:
                    self.appium_failures += 1
                    if self.appium_failures >= 3:
                        self.adb_only_mode = True

            if not input_ready:
                # Comment sheet position is fixed, so coordinates work here
                input_ready = self._adb_tap_by_resource_id(
                    InstagramSelectors.COMMENT_INPUT
                )
                if not input_ready:
                    # Fallback to fixed coords (sheet is modal, position is stable)
                    x, y = InstagramSelectors.CommentCoords.INPUT_FIELD
                    subprocess.run(
                        [
                            "adb",
                            "-s",
                            self.device_id,
                            "shell",
                            "input",
                            "tap",
                            str(x),
                            str(y),
                        ],
                        timeout=3,
                    )
                    print(f"   Comment input tapped (fixed coords {x},{y})")

            time.sleep(1)

            # 3. Type comment
            comment_text = self._get_random_comment()
            print(f"   Typing: {comment_text}")
            adb_text = comment_text.replace(" ", "%s")
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "text", adb_text],
                timeout=5,
            )
            time.sleep(1.5)

            # 4. Post comment
            posted = False
            if not self.adb_only_mode and self.driver:
                try:
                    post_btn = self.driver.find_element(
                        AppiumBy.ID, InstagramSelectors.COMMENT_POST_BTN
                    )
                    post_btn.click()
                    posted = True
                    self.appium_failures = 0
                    print("   Posted comment (Resource ID)")
                except:
                    self.appium_failures += 1
                    if self.appium_failures >= 3:
                        self.adb_only_mode = True

            if not posted:
                x, y = InstagramSelectors.CommentCoords.POST_BTN
                subprocess.run(
                    [
                        "adb",
                        "-s",
                        self.device_id,
                        "shell",
                        "input",
                        "tap",
                        str(x),
                        str(y),
                    ],
                    timeout=3,
                )
                print(f"   Posted comment (ADB at {x},{y})")

            time.sleep(1.5)

            # 5. Close comment sheet
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                timeout=3,
            )
            time.sleep(0.3)
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                timeout=3,
            )
            time.sleep(0.5)

            return True

        except Exception as e:
            print(f"   Feed comment failed: {e}")
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                timeout=3,
            )
            return False

    def scroll_feed(self):
        """Scroll to next post on home feed"""
        try:
            start_x, start_y = InstagramSelectors.FeedCoords.SCROLL_START
            end_x, end_y = InstagramSelectors.FeedCoords.SCROLL_END

            # Add jitter
            start_x = self._jitter(start_x, 50)
            start_y = self._jitter(start_y, 100)
            end_x = self._jitter(end_x, 50)
            end_y = self._jitter(end_y, 100)
            duration = random.randint(200, 400)

            result = subprocess.run(
                [
                    "adb",
                    "-s",
                    self.device_id,
                    "shell",
                    "input",
                    "swipe",
                    str(start_x),
                    str(start_y),
                    str(end_x),
                    str(end_y),
                    str(duration),
                ],
                capture_output=True,
                timeout=5,
            )

            if result.returncode == 0:
                self._micro_pause()
                return True
            return False
        except Exception as e:
            print(f"   Feed scroll failed: {e}")
            return False

    def smart_engage_feed(self):
        """Smart engagement step for home feed"""
        print("   Home Feed Engage Step")

        # Check for ads before engaging
        if self.detect_ad():
            print("   AD — skipping (no engagement)")
            self._human_scroll("feed")
            return "skipped_ad"

        # Watch with varied timing — 5 tiers
        view_type = random.choices(
            ["quick_scroll", "brief_view", "engaged_view", "deep_view", "captivated"],
            weights=[0.12, 0.33, 0.33, 0.17, 0.05],
        )[0]

        min_time, max_time = self.viewing_times[view_type]
        wait = random.uniform(min_time, max_time)
        print(f"   Watching ({view_type}) for {wait:.1f}s...")
        time.sleep(wait)

        result = {"liked": False, "commented": False, "peeked": False}

        if view_type in ["engaged_view", "deep_view", "captivated"]:
            if random.random() < 0.45:
                result["liked"] = self.like_feed()

            if view_type in ["deep_view", "captivated"] and random.random() < 0.14:
                result["commented"] = self.comment_feed()

            # Profile peek on deep/captivated (12% — more common in feed)
            if view_type in ["deep_view", "captivated"] and random.random() < 0.12:
                result["peeked"] = self._profile_peek()
        elif view_type == "brief_view":
            if random.random() < 0.15:
                result["liked"] = self.like_feed()

        self._human_scroll("feed")
        return result

    def engage_split(self, count=10, feed_ratio=None):
        """
        Main engagement with split: default from settings (or 33% home feed, 67% reels)

        Args:
            count: Total posts to engage with
            feed_ratio: Ratio for home feed (default from settings or 0.33 = 33%)
        """
        # Use configured ratio if not explicitly provided
        if feed_ratio is None:
            feed_ratio = self.default_feed_ratio

        print(
            f"\n   Engagement Session: {count} posts ({feed_ratio * 100:.0f}% feed, {(1 - feed_ratio) * 100:.0f}% reels)"
        )

        # PRE-LAUNCH CLEANUP: 2x back to exit any nested screens
        print("🔄 Pre-launch cleanup: Pressing back 2x...")
        import subprocess

        for _ in range(2):
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"],
                capture_output=True,
                timeout=3,
            )
            time.sleep(0.5)
        time.sleep(0.5)

        # Calculate split
        feed_count = int(count * feed_ratio)
        reels_count = count - feed_count

        stats = {
            "success": True,
            "feed_posts": 0,
            "reels_posts": 0,
            "likes": 0,
            "comments": 0,
        }

        try:
            # Import launcher for navigation
            from modules.instagram_launcher_module import InstagramLauncher

            launcher = InstagramLauncher(self.device_id)

            # LAUNCH INSTAGRAM using ADB-only method (NO WEBDRIVER NEEDED)
            print("📱 Launching Instagram via ADB...")
            if not launcher.launch_instagram_adb():
                # Fallback to monkey command
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
                    timeout=15,
                )
                time.sleep(3)
            print("✅ Instagram launched!")

            # Set to ADB-only mode - no WebDriver needed
            self.adb_only_mode = True

            # Phase 0: Warmup — passive browsing before engaging
            self._warmup_browse(count=random.randint(2, 4), mode="feed")

            # Phase 1: Home Feed engagement
            if feed_count > 0:
                print(f"\n   Phase 1: Home Feed ({feed_count} posts)")
                launcher.go_to_home_adb()  # ADB-only
                time.sleep(2)

                for i in range(feed_count):
                    print(f"\n   Feed Post {i + 1}/{feed_count}")
                    result = self.smart_engage_feed()
                    stats["feed_posts"] += 1
                    if isinstance(result, dict):
                        if result.get("liked"):
                            stats["likes"] += 1
                        if result.get("commented"):
                            stats["comments"] += 1
                    time.sleep(random.uniform(0.5, 1.0))

            # Phase 2: Reels engagement
            if reels_count > 0:
                print(f"\n   Phase 2: Reels ({reels_count} posts)")
                launcher.go_to_reels_adb()  # ADB-only
                time.sleep(2)

                for i in range(reels_count):
                    print(f"\n   Reel {i + 1}/{reels_count}")
                    result = self.smart_engage()
                    stats["reels_posts"] += 1
                    if isinstance(result, dict):
                        if result.get("liked"):
                            stats["likes"] += 1
                        if result.get("commented"):
                            stats["comments"] += 1
                    time.sleep(random.uniform(0.5, 1.0))

            total = stats["feed_posts"] + stats["reels_posts"]
            print(
                f"\n   Completed: {total} posts, {stats['likes']} likes, {stats['comments']} comments"
            )

        except Exception as e:
            print(f"   Engagement error: {e}")
            stats["success"] = False
            stats["error"] = str(e)

        return stats

    def engage_posts(self, count=10, like_chance=80, comment_chance=15):
        """
        🎯 Main engagement method called by dashboard.
        Engages with specified number of posts using smart_engage.

        Args:
            count: Number of posts to engage with
            like_chance: % chance to like each post (0-100)
            comment_chance: % chance to comment on each post (0-100)

        Returns:
            dict with engagement stats
        """
        print(
            f"\\n🎬 Starting engagement session: {count} posts (like: {like_chance}%, comment: {comment_chance}%)..."
        )

        # Connect if not already connected
        if not self.driver:
            if not self.connect():
                return {"success": False, "error": "Failed to connect"}

        stats = {
            "success": True,
            "posts_viewed": 0,
            "likes": 0,
            "comments": 0,
            "ads_skipped": 0,
            "errors": 0,
        }

        try:
            for i in range(count):
                print(f"\\n📺 Post {i + 1}/{count}")

                # MID-ENGAGEMENT RECOVERY: At ~50% mark, press back 5x and reopen to fix stuck screens
                if i > 0 and i == count // 2:
                    print("\\n🔄 MID-ENGAGEMENT RECOVERY (50% mark)...")
                    print("   Pressing back 5x to clear any stuck screens...")
                    for _ in range(5):
                        subprocess.run(
                            [
                                "adb",
                                "-s",
                                self.device_id,
                                "shell",
                                "input",
                                "keyevent",
                                "4",
                            ],
                            capture_output=True,
                            timeout=3,
                        )
                        time.sleep(0.5)
                    time.sleep(1)

                    # Reopen Instagram and go back to reels
                    print("   Reopening Instagram reels...")
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
                        timeout=10,
                    )
                    time.sleep(3)

                    # Tap home first to ensure clean state, then Reels tab
                    subprocess.run(
                        [
                            "adb",
                            "-s",
                            self.device_id,
                            "shell",
                            "input",
                            "tap",
                            "108",
                            "2274",
                        ],
                        capture_output=True,
                        timeout=3,
                    )  # Home tab
                    time.sleep(1)
                    subprocess.run(
                        [
                            "adb",
                            "-s",
                            self.device_id,
                            "shell",
                            "input",
                            "tap",
                            "324",
                            "2274",
                        ],
                        capture_output=True,
                        timeout=3,
                    )  # Reels tab (clips_tab) - FIXED coordinate
                    time.sleep(2)
                    print("   ✅ Recovery complete, resuming engagement...")

                # Get author if available
                author = self.get_current_author()
                if author:
                    print(f"   Author: @{author}")

                # Engage with current post using provided ratios
                result = self.smart_engage_with_ratios(like_chance, comment_chance)
                stats["posts_viewed"] += 1

                if result == "skipped_ad":
                    stats["ads_skipped"] += 1
                elif isinstance(result, dict):
                    if result.get("liked"):
                        stats["likes"] += 1
                    if result.get("commented"):
                        stats["comments"] += 1

                # Random delay between posts
                time.sleep(random.uniform(0.5, 1.5))

            print(f"\\n✅ Engagement complete!")
            print(
                f"   Posts: {stats['posts_viewed']}, Likes: {stats['likes']}, Comments: {stats['comments']}"
            )

            # Discord notification for successful engagement
            if DISCORD_AVAILABLE:
                get_notifier().success(
                    "💜 Engagement Complete",
                    f"Posts: {stats['posts_viewed']} | Likes: {stats['likes']} | Comments: {stats['comments']}",
                )

        except Exception as e:
            print(f"❌ Engagement error: {e}")
            stats["success"] = False
            stats["error"] = str(e)
            stats["errors"] += 1
            # Emergency recovery to home screen
            self._ensure_home_and_recover()

        return stats


if __name__ == "__main__":
    engager = InstagramEngager()
    if engager.connect():
        try:
            print("\n🎬 Starting Engagement Session...")
            for i in range(5):
                print(f"\n📺 Reel {i + 1}")

                # Get author
                author = engager.get_current_author()
                if author:
                    print(f"   Author: @{author}")

                # Engage
                result = engager.smart_engage()
                print(f"   Result: {result}")

                time.sleep(random.uniform(1, 2))

        except KeyboardInterrupt:
            print("\n🛑 Stopped by user")
        finally:
            engager.disconnect()
