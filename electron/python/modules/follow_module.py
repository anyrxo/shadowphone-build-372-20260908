#!/usr/bin/env python3
"""
👥 INSTAGRAM FOLLOW MODULE
Search and follow/unfollow users from usernames.txt
"""

from appium import webdriver
from appium.options.android import UiAutomator2Options
from selenium.webdriver.common.by import By
from selenium.common.exceptions import NoSuchElementException
from appium.webdriver.common.appiumby import AppiumBy
import time
import random
import os
import subprocess
import re
import tempfile

from lib.bootstrap_profile_guards import BootstrapProfileGuards
from lib.screen_state import ScreenObservation, utc_now_iso

# Import Instagram launcher
from modules.instagram_launcher_module import InstagramLauncher
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

class InstagramFollower:
    def _build_observation_from_xml(self, xml_content):
        return ScreenObservation(
            observed_at=utc_now_iso(),
            device_id=self.device_id,
            package='com.instagram.android',
            xml_source=xml_content,
        )

    def _guards_for_xml(self, xml_content):
        return BootstrapProfileGuards(
            lambda: self._build_observation_from_xml(xml_content),
            log=print,
        )

    def _dump_ui_xml(self):
        temp_file = os.path.join(tempfile.gettempdir(), 'follow_module_dump.xml')
        try:
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "uiautomator", "dump", "/sdcard/follow_module_dump.xml"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode != 0:
                return ""
            result = subprocess.run(
                ["adb", "-s", self.device_id, "pull", "/sdcard/follow_module_dump.xml", temp_file],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode != 0:
                return ""
            with open(temp_file, 'r', encoding='utf-8') as f:
                return f.read()
        except Exception as e:
            print(f"⚠️ UI dump failed: {e}")
            return ""
        finally:
            try:
                if os.path.exists(temp_file):
                    os.remove(temp_file)
            except Exception:
                pass

    def _verify_home_ready_soft(self):
        xml = self._dump_ui_xml()
        if not xml:
            return None
        result = self._guards_for_xml(xml).verify_home_ready()
        print(f"🔎 Home readiness: {result.screen_type} ({result.confidence})")
        return result

    def _verify_search_or_profile_state_soft(self, username=""):
        xml = self._dump_ui_xml()
        if not xml:
            return {"ok": False, "state": "unknown", "confidence": "low", "reasons": ["missing ui dump"]}

        lowered = xml.lower()
        normalized_username = re.sub(r'^@+', '', str(username or '').strip()).lower()
        profile_result = self._guards_for_xml(xml).verify_profile_tab()
        if profile_result.ok:
            reasons = [*list(profile_result.reasons or []), 'profile tab verified']
            if normalized_username and normalized_username in lowered:
                reasons.append(f'username visible: {normalized_username}')
            return {"ok": True, "state": "profile_opened", "confidence": profile_result.confidence, "reasons": reasons}

        search_markers = [
            'search',
            'search and explore',
            'results for',
            'accounts',
            'row_search_keyword_title',
            'com.instagram.android:id/action_bar_search_edit_text',
        ]
        matched = [marker for marker in search_markers if marker in lowered]
        if matched:
            return {"ok": True, "state": "search_ready", "confidence": 'medium', "reasons": [f'markers={matched[:3]}']}

        return {"ok": False, "state": profile_result.screen_type, "confidence": profile_result.confidence, "reasons": list(profile_result.reasons or [])}

    def _verify_follow_state_resolution_soft(self):
        xml = self._dump_ui_xml()
        if not xml:
            return {"ok": False, "state": "unknown", "confidence": "low", "reasons": ["missing ui dump"]}

        lowered = xml.lower()
        if 'following' in lowered:
            return {"ok": True, "state": "following", "confidence": "high", "reasons": ['following label visible']}
        if 'requested' in lowered:
            return {"ok": True, "state": "requested", "confidence": "high", "reasons": ['requested label visible']}
        if re.search(r'text="follow"', xml, re.IGNORECASE):
            return {"ok": False, "state": "follow_still_visible", "confidence": "medium", "reasons": ['follow button still visible']}
        profile_result = self._guards_for_xml(xml).verify_profile_tab()
        return {"ok": False, "state": profile_result.screen_type, "confidence": profile_result.confidence, "reasons": list(profile_result.reasons or [])}

    def __init__(self, device_id="1A121FDF60082H", profile_id=None):
        self.device_id = device_id
        self.profile_id = profile_id
        self.driver = None
        self.launcher = InstagramLauncher(device_id)
        
        # Get profile-aware navigation coordinates
        self.nav_coords = InstagramSelectors.get_nav_for_profile(profile_id)
        
        # 🧠 HUMAN BEHAVIOR SYSTEM
        try:
            from modules.human_behavior import get_human_behavior
            self.hb = get_human_behavior()
        except:
            self.hb = None
        
    def _handle_appium_error(self, error, operation_name="operation"):
        """Handle Appium errors with automatic crash recovery"""
        if CRASH_RECOVERY_AVAILABLE and hasattr(self, 'driver') and self.driver:
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
        
    def connect(self):
        """Launch Instagram and connect"""
        try:
            print("📱 Launching Instagram...")

            launcher_outcome = self.launcher.open_instagram_home_strict()
            home_ready, home_error = InstagramLauncher.is_verified_home_ready(launcher_outcome)
            if not home_ready:
                print(f"❌ {home_error}")
                return False

            # Get the driver from the launcher
            self.driver = self.launcher.driver
            print("✅ Instagram launched and connected!")
            return True

        except Exception as e:
            print(f"❌ Instagram launch failed: {e}")
            return False
    
    def disconnect(self):
        if self.launcher:
            self.launcher.disconnect()
        print("🔄 Disconnected")
    
    def check_connection(self):
        """Check if Appium session is still active"""
        try:
            if self.driver:
                current_package = self.driver.current_package
                return True
        except Exception as e:
            print(f"⚠️ Session check failed: {e}")
            return False
        return False
    
    def reconnect(self):
        """Reconnect to Appium if session is lost"""
        try:
            print("🔄 Driver crashed - attempting recovery...")
            if self.launcher and self.launcher.driver:
                try:
                    self.launcher.driver.quit()
                except:
                    pass
                self.launcher.driver = None
                self.driver = None
            
            # Reconnect via launcher
            if self.launcher.connect_adb():
                self.driver = self.launcher.driver
                print("✅ Driver recovered successfully!")
                return True
            else:
                print("❌ Driver recovery failed")
                return False
        except Exception as e:
            print(f"❌ Recovery error: {e}")
            return False
    
    def ensure_homepage(self):
        """Ensure we're on Instagram homepage before starting"""
        try:
            print("🏠 Ensuring we're on Instagram homepage...")
            precheck = self._verify_home_ready_soft()
            if precheck and precheck.ok:
                print("✅ Already on homepage (verified)")
                return True

            launcher_outcome = self.launcher.open_instagram_home_strict()
            home_ready, home_error = InstagramLauncher.is_verified_home_ready(launcher_outcome, prefix="Homepage not verified by launcher")
            if home_ready:
                self.driver = self.launcher.driver
                print("✅ Homepage re-verified via launcher")
                return True

            print(f"❌ {home_error}")
            return False

        except Exception as e:
            print(f"⚠️ Homepage navigation failed: {e}")
            return False
    
    def return_to_homepage(self):
        """Return to homepage after following a user - REQUIRED for next search"""
        try:
            print("🏠 Returning to homepage for next search...")
            
            # Use the same logic as ensure_homepage but with different messaging
            home_selectors = [
                "//*[contains(@content-desc, 'Home')]",
                "//android.widget.Button[contains(@content-desc, 'Home')]",
                "//*[contains(@text, 'Home')]",
            ]
            
            home_found = False
            for selector in home_selectors:
                try:
                    home_button = self.driver.find_element(By.XPATH, selector)
                    home_button.click()
                    print("✅ Returned to home via Selenium!")
                    home_found = True
                    break
                except NoSuchElementException:
                    continue
            
            # Fallback to coordinates
            if not home_found:
                print("🎯 Using coordinates to return home...")
                # Profile-aware coordinate first, then fallbacks
                profile_home = self.nav_coords.get('home', (108, 2274))
                home_coords = [
                    profile_home,       # Profile-aware home button (primary)
                    (108, 2274),        # Standard home button (OLD layout fallback)
                    (100, 2200),        # Alternative position
                ]
                
                for coord in home_coords:
                    try:
                        print(f"🎯 Trying home return at {coord}")
                        self.driver.tap([coord])
                        home_found = True
                        print(f"✅ Returned home via coordinates at {coord}")
                        break
                    except Exception as e:
                        print(f"⚠️ Home return failed at {coord}: {e}")
                        continue
            
            if home_found:
                time.sleep(3)  # Wait for homepage to load
                print("✅ Successfully returned to homepage - ready for next user")
                return True
            else:
                print("⚠️ Could not return to homepage, but continuing...")
                return False
                
        except Exception as e:
            print(f"⚠️ Homepage return failed: {e}")
            return False
    

    def search_user(self, username):
        """Search for a user using robust selector-based workflow"""
        try:
            print(f"🔍 SEARCHING for: @{username}")
            
            # Check connection before starting
            if not self.check_connection():
                print("❌ Connection check failed")
                return False
            
            # Step 1: Click search tab
            print("1️⃣ Clicking search tab...")
            try:
                # Use ID from selectors
                btn = self.driver.find_element(AppiumBy.ID, InstagramSelectors.SEARCH_TAB)
                btn.click()
                time.sleep(3)
                print("✅ Search tab clicked (ID match)!")
                state = self._verify_search_or_profile_state_soft(username)
                print(f"🔎 Search/profile state after search-tab click: {state['state']} ({state['confidence']})")
            except Exception as e:
                print(f"⚠️ Search tab ID failed, trying fallback: {e}")
                # Fallback to Desc/XPATH
                try:
                    btn = self.driver.find_element(AppiumBy.ACCESSIBILITY_ID, "Search and explore")
                    btn.click()
                    print("✅ Search tab clicked (Accessibility ID)!")
                    time.sleep(3)
                    state = self._verify_search_or_profile_state_soft(username)
                    print(f"🔎 Search/profile state after search-tab click: {state['state']} ({state['confidence']})")
                except:
                    print("❌ Could not click search tab")
                    return False
            
            # Step 2: Click search box
            print("2️⃣ Clicking search box...")
            try:
                # Try ID first
                search_field = self.driver.find_element(AppiumBy.ID, InstagramSelectors.SEARCH_EDIT_TEXT)
                search_field.click()
                time.sleep(2)
                print("✅ Search box clicked (ID)!")
            except:
                try:
                    # Fallback to coordinates-ish generic element
                    search_field = self.driver.find_element(AppiumBy.CLASS_NAME, "android.widget.EditText")
                    search_field.click()
                    time.sleep(2)
                    print("✅ Search box clicked (Class Name)!")
                except Exception as e:
                    print(f"❌ Could not click search box: {e}")
                    return False
            
            # Step 3: Type username
            print("3️⃣ Typing username...")
            try:
                # Re-find to avoid stale element
                search_field = self.driver.find_element(AppiumBy.CLASS_NAME, "android.widget.EditText")
                search_field.clear()
                search_field.send_keys(username)
                print(f"✅ Username '{username}' entered!")
                time.sleep(3) # Wait for suggestions
                
                # Verify text entered
                if search_field.text != username:
                    print("⚠️ Text mismatch, using ADB fallback...")
                    # ADB Backup
                    safe_username = username.replace("'", "").replace('"', '').replace('`', '').replace('\\', '').replace('&', 'and').replace(';', ',').replace('|', ' ')
                    subprocess.run(["adb", "-s", self.device_id, "shell", "input", "text", safe_username], timeout=10)
            except Exception as e:
                print(f"⚠️ Type failed: {e}")
                return False
            
            # Step 3.5: Click first suggestion and Accounts tab (Robust Flow)
            print("3️⃣.5️⃣  Navigating to Accounts tab...")
            try:
                # 1. Click first search suggestion to load full results
                try:
                    first_suggestion = self.driver.find_element(AppiumBy.ID, "com.instagram.android:id/row_search_keyword_title")
                    first_suggestion.click()
                    print("✅ Clicked first search suggestion")
                    time.sleep(3)
                except:
                    print("⚠️ Could not click suggestion, pressing Enter")
                    self.driver.press_keycode(66) # Enter
                    time.sleep(3)

                # 2. Click Accounts Tab
                accounts_tab = self.driver.find_element(AppiumBy.XPATH, InstagramSelectors.SEARCH_ACCOUNTS_TAB_XPATH)
                accounts_tab.click()
                print("✅ Clicked Accounts Tab")
                time.sleep(2)
            except Exception as e:
                print(f"⚠️ Navigation to Accounts tab failed: {e}")
                # Continue anyway, might be in Top results
            
            # Step 4: Click first result
            print("4️⃣ Clicking result...")
            try:
                # Wait for results
                time.sleep(2)
                
                # Try to find specific user result by username text
                try:
                    # Method 1: Find by exact username text
                    res = self.driver.find_element(AppiumBy.XPATH, f"//android.widget.TextView[@text='{username}']")
                    res.click()
                    print(f"✅ Clicked exact match: {username}")
                    time.sleep(3)
                    state = self._verify_search_or_profile_state_soft(username)
                    print(f"🔎 Search/profile state after opening result: {state['state']} ({state['confidence']})")
                    return True
                except:
                    pass
                
                # Method 2: Use verified SEARCH_USER_USERNAME selector
                try:
                    res = self.driver.find_element(AppiumBy.ID, InstagramSelectors.SEARCH_USER_USERNAME)
                    res.click()
                    print("✅ Clicked user result (SEARCH_USER_USERNAME)")
                    time.sleep(3)
                    state = self._verify_search_or_profile_state_soft(username)
                    print(f"🔎 Search/profile state after opening result: {state['state']} ({state['confidence']})")
                    return True
                except:
                    pass
                
                # Method 3: Use SEARCH_USER_CONTAINER (the entire row)
                try:
                    res = self.driver.find_element(AppiumBy.ID, InstagramSelectors.SEARCH_USER_CONTAINER)
                    res.click()
                    print("✅ Clicked user result (SEARCH_USER_CONTAINER)")
                    time.sleep(3)
                    state = self._verify_search_or_profile_state_soft(username)
                    print(f"🔎 Search/profile state after opening result: {state['state']} ({state['confidence']})")
                    return True
                except:
                    pass
                
                # Method 4: Legacy keyword title
                try:
                    res = self.driver.find_element(AppiumBy.ID, InstagramSelectors.SEARCH_RESULT_KEYWORD_TITLE)
                    res.click()
                    print("✅ Clicked result (SEARCH_RESULT_KEYWORD_TITLE)")
                    time.sleep(3)
                    state = self._verify_search_or_profile_state_soft(username)
                    print(f"🔎 Search/profile state after opening result: {state['state']} ({state['confidence']})")
                    return True
                except:
                    pass
                
                # Method 5: Coordinate fallback for result list
                print("⚠️ All result selectors failed, tapping first position...")
                self.driver.tap([(540, 435)])  # Updated coordinate based on UI dump
                time.sleep(3)
                return True
                        
            except Exception as e:
                print(f"❌ Result click failed: {e}")
                return False
            
        except Exception as e:
            print(f"❌ Search operation failed: {e}")
            return False
    
    def follow_user(self):
        """Follow current user using Appium selectors"""
        try:
            print("👥 Checking follow status...")
            
            # Check if already followed (by text)
            try:
                # Look for "Following" or "Requested" text
                status_check = self.driver.find_element(AppiumBy.XPATH, "//*[contains(@text, 'Following') or contains(@text, 'Requested')]")
                print("⚠️ User is already followed! Skipping...")
                return "already_following"
            except:
                pass

            pre_follow_state = self._verify_search_or_profile_state_soft()
            print(f"🔎 Pre-follow state: {pre_follow_state['state']} ({pre_follow_state['confidence']})")
            
            # 1. Try ID Based Follow Button
            print("👥 Looking for Follow button...")
            clicked = False
            try:
                btn = self.driver.find_element(AppiumBy.ID, InstagramSelectors.PROFILE_HEADER_FOLLOW_BTN)
                if btn.text.lower() == "follow":
                    btn.click()
                    clicked = True
                    print("✅ Clicked Follow Button (ID Match)")
            except:
                pass
                
            # 2. Try Verified Text Match (Exact)
            if not clicked:
                try:
                    # Verified exact match selector
                    btn = self.driver.find_element(AppiumBy.XPATH, "//*[@text='Follow']")
                    btn.click()
                    clicked = True
                    print("✅ Clicked Follow Button (Exact Text Match)")
                except:
                    # 3. Try Accessibility ID? Usually just "Follow"
                    pass
            
            # 4. Fallback Coordinates (last resort)
            if not clicked:
                print("⚠️ Selectors failed, trying fallback coordinates...")
                self.driver.tap([(960, 1270)])
                clicked = True
            
            if clicked:
                time.sleep(2)
                self._handle_follow_popups()
                follow_resolution = self._verify_follow_state_resolution_soft()
                print(f"🔎 Follow-state resolution: {follow_resolution['state']} ({follow_resolution['confidence']})")
                if follow_resolution['ok']:
                    return True
                print("⚠️ Follow tap completed but follow-state could not be confidently resolved")
                return True
                
            print("❌ Could not find Follow button")
            return False
            
        except Exception as e:
            print(f"❌ Follow operation failed: {e}")
            return False
    
    def _handle_follow_popups(self):
        """Handle any popups that appear after following a user"""
        print("🔍 Checking for follow popups...")
        
        # Common popup types and their OK buttons
        popup_patterns = [
            "//android.widget.Button[@text='OK']",
            "//android.widget.Button[contains(@text, 'OK')]", 
            "//android.widget.TextView[@text='OK']",
            "//*[@text='OK']",
            "//android.widget.Button[@text='Got it']",
            "//android.widget.Button[contains(@text, 'Got it')]",
            "//android.widget.Button[@text='Allow']",
            "//android.widget.Button[@text='Not now']",
            "//android.widget.Button[@text='Skip']",
            "//android.widget.Button[@text='Close']",
            "//android.widget.Button[@text='Cancel']",
            "//android.widget.Button[@text='Dismiss']",
        ]
        
        # Check for popups multiple times as they may appear with delay
        for check_attempt in range(3):
            popup_found = False
            
            for pattern in popup_patterns:
                try:
                    popup_button = self.driver.find_element(By.XPATH, pattern)
                    popup_button.click()
                    print(f"✅ Popup closed using: {pattern}")
                    popup_found = True
                    time.sleep(1)  # Wait for popup to close
                    break
                except NoSuchElementException:
                    continue
                except Exception as e:
                    print(f"⚠️ Error clicking popup button: {e}")
                    continue
            
            if popup_found:
                print("🔄 Checking for additional popups...")
                time.sleep(1)  # Give time for next popup to appear
            else:
                if check_attempt == 0:
                    print("✅ No popups detected")
                break
        
        # Give a moment for any final popups to settle
        time.sleep(1)
    
    def go_home(self):
        """Navigate back to Instagram home feed"""
        try:
            print("🏠 Navigating back to home...")
            # Home button coordinates (profile-aware)
            home_button_coords = self.nav_coords.get('home', (108, 2274))
            self.driver.tap([home_button_coords])
            time.sleep(2)
            print(f"✅ Returned to home feed at {home_button_coords}")
            return True
        except Exception as e:
            print(f"⚠️ Could not navigate to home: {e}")
            return False
    
    def unfollow_user(self):
        """Unfollow current user"""
        try:
            print("👥 Attempting to unfollow...")
            
            # 1. Click "Following" button
            clicked = False
            try:
                # Try ID first
                btn = self.driver.find_element(AppiumBy.ID, InstagramSelectors.PROFILE_HEADER_FOLLOW_BTN)
                btn.click()
                clicked = True
                print("✅ Clicked Following Button (ID)")
            except:
                # Text fallback
                try:
                    btn = self.driver.find_element(AppiumBy.XPATH, "//android.widget.Button[@text='Following']")
                    btn.click()
                    clicked = True
                    print("✅ Clicked Following Button (Text)")
                except:
                    # Coordinate fallback
                    try:
                        self.driver.tap([(540, 1200)])
                        clicked = True
                        print("✅ Tapped Following Button (Coords)")
                    except:
                         pass
                         
            if not clicked:
                print("❌ Could not find Following button")
                return False
                
            time.sleep(1)
            
            # 2. Confirm Unfollow in Dialog
            print("👥 Confirming unfollow...")
            try:
                confirm_btn = self.driver.find_element(AppiumBy.ID, InstagramSelectors.DIALOG_CONFIRM_BTN)
                confirm_btn.click()
                print("✅ Confirmed Unfollow (ID)")
                time.sleep(2)
                return True
            except:
                try:
                    # Text fallback
                    confirm_btn = self.driver.find_element(AppiumBy.XPATH, "//*[@text='Unfollow']")
                    confirm_btn.click()
                    print("✅ Confirmed Unfollow (Text)")
                    time.sleep(2)
                    return True
                except:
                    # Coordinate fallback
                    try:
                        self.driver.tap([(540, 1400)])
                        print("✅ Confirmed Unfollow (Coords)")
                        time.sleep(2)
                        return True
                    except:
                        pass
                        
            print("❌ Unfollow confirmation failed")
            return False

        except Exception as e:
            print(f"❌ Unfollow failed: {e}")
            return False
    
    def follow_users_batch(self, usernames):
        """Follow multiple users with proper cleanup between searches"""
        if not self.connect():
            return
            
        results = {'followed': 0, 'already_following': 0, 'failed': 0}
        
        for i, username in enumerate(usernames, 1):
            print(f"\n👤 Processing {i}/{len(usernames)}: @{username}")
            print("=" * 50)
            
            # SMART CHECK: Verify Instagram focus every 3 users to avoid spam
            if i > 1 and (i-1) % 3 == 0:  # Check every 3rd user (after 3rd, 6th, 9th, etc.)
                if not self._ensure_instagram_focused():
                    print("❌ Lost Instagram focus! Attempting to reconnect...")
                    if not self._recover_instagram_connection():
                        print("❌ Failed to recover Instagram connection, stopping follow batch")
                        break
            
            # Initialize follow_result to avoid UnboundLocalError
            follow_result = False
            
            if self.search_user(username):
                follow_result = self.follow_user()
                if follow_result == "already_following":
                    results['already_following'] += 1
                    print("✅ User already followed (skipped)")
                elif follow_result == True:
                    results['followed'] += 1
                    print("✅ Successfully followed!")
                    # Additional popup check after successful follow
                    print("🔍 Final popup check after follow...")
                    self._handle_follow_popups()
                else:
                    results['failed'] += 1
                    print("❌ Follow failed")
                
                # CRITICAL: Return to homepage after each user (except last)
                if i < len(usernames):  # Don't return home after last user
                    print("🏠 Returning to homepage for next search...")
                    self.return_to_homepage()
                    
            else:
                results['failed'] += 1
                print("❌ Search failed")
                # Still return to homepage even if search failed
                if i < len(usernames):
                    print("🏠 Returning to homepage after search failure...")
                    self.return_to_homepage()
            
            # HUMAN BEHAVIOR: Random delay between follows with distraction pauses
            if self.hb:
                # Use human behavior for more natural delays
                self.hb.add_fatigue('follow')
                
                # Possible distraction pause
                should_pause, pause_duration = self.hb.get_distraction_pause()
                if should_pause:
                    print(f"🧠 [distracted {pause_duration:.1f}s]")
                    time.sleep(pause_duration)
                
                # Base delay varies with energy level
                energy = self.hb.energy_level
                if follow_result == "already_following":
                    base_delay = random.uniform(3, 8) * (1.5 - energy * 0.5)  # Faster when energized
                else:
                    base_delay = random.uniform(10, 20) * (1.5 - energy * 0.5)
                
                print(f"⏳ Human delay: {base_delay:.1f}s (energy: {energy:.0%})")
                time.sleep(base_delay)
            else:
                # Fallback to simple random delay
                if follow_result == "already_following":
                    delay = random.uniform(3, 8)
                    print(f"⏳ Short delay: {delay:.1f}s (already following)")
                    time.sleep(delay)
                else:
                    delay = random.uniform(10, 20)
                    print(f"⏳ Normal delay: {delay:.1f}s")
                    time.sleep(delay)
        
        print("\n" + "=" * 60)
        print(f"✅ BATCH COMPLETE: {results['followed']} newly followed, {results['already_following']} already following, {results['failed']} failed")
        print("=" * 60)
        self.disconnect()
    
    def load_usernames_from_file(self, filename="usernames.txt", profile_id=None, count=50):
        """Load RANDOM usernames from text file with profile-specific support
        
        Priority order:
        1. Content manager (profile-specific)
        2. default_usernames.txt (2,819+ usernames) 
        3. modules/usernames.txt (fallback)
        """
        try:
            # If profile_id is provided, use the content manager system
            if profile_id:
                try:
                    from content_manager import get_usernames_for_follow
                    usernames = get_usernames_for_follow(profile_id, count=count)  # Use requested count
                    if usernames:
                        print(f"📋 Loaded {len(usernames)} RANDOM usernames for profile {profile_id}")
                        for i, username in enumerate(usernames[:10], 1):  # Show first 10
                            print(f"  {i}. @{username}")
                        if len(usernames) > 10:
                            print(f"  ... and {len(usernames) - 10} more")
                        return usernames
                except ImportError:
                    print("⚠️ Content manager not available, falling back to file method")
            
            # Fallback to original file method with RANDOM selection
            # PRIORITY 1: Try the large default usernames file (2,819 usernames)
            large_file_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "default_usernames.txt")
            
            if os.path.exists(large_file_path):
                filepath = large_file_path
                print(f"📋 Using LARGE usernames file: {os.path.basename(filepath)} (2,819+ usernames)")
            else:
                # PRIORITY 2: Try the requested file in modules directory 
                filepath = os.path.join(os.path.dirname(__file__), filename)
                if not os.path.exists(filepath):
                    print(f"❌ File not found: {filepath}")
                    return []
            
            with open(filepath, 'r', encoding='utf-8') as f:
                all_usernames = [line.strip() for line in f if line.strip() and not line.startswith('#')]
            
            if not all_usernames:
                print(f"⚠️ No usernames found in {filename}")
                return []
            
            # RANDOM selection from file
            print(f"🎲 RANDOM SELECTION: Choosing {count} random usernames from {len(all_usernames)} in file")
            if count <= len(all_usernames):
                selected = random.sample(all_usernames, count)
            else:
                # If requesting more than available, allow duplicates
                selected = [random.choice(all_usernames) for _ in range(count)]
            
            print(f"🎯 Selected random usernames from {filename}:")
            for i, username in enumerate(selected, 1):
                print(f"  {i}. @{username}")
            
            return selected
            
        except Exception as e:
            print(f"❌ Failed to load usernames: {e}")
            return []
    
    def follow_users(self, count=5, profile_id=None):
        """Follow a specific number of users from usernames.txt file (for dashboard use)"""
        print(f"📋 INSTAGRAM FOLLOW {count} USERS")
        print("=" * 40)
        
        usernames = self.load_usernames_from_file(profile_id=profile_id)
        if not usernames:
            print("❌ No usernames to process from usernames.txt")
            return False
        
        # Limit to requested count
        usernames_to_follow = usernames[:count]
        
        print(f"🚀 Following {len(usernames_to_follow)} users from file...")
        
        if not self.connect():
            return False
            
        results = {'followed': 0, 'already_following': 0, 'failed': 0}
        
        for i, username in enumerate(usernames_to_follow, 1):
            print(f"\n👤 Processing {i}/{len(usernames_to_follow)}: @{username}")
            print("=" * 50)
            
            # Initialize follow_result to avoid UnboundLocalError
            follow_result = False
            
            if self.search_user(username):
                follow_result = self.follow_user()
                if follow_result == "already_following":
                    results['already_following'] += 1
                    print("✅ User already followed (skipped)")
                elif follow_result == True:
                    results['followed'] += 1
                    print("✅ Successfully followed!")
                    # Additional popup check after successful follow
                    print("🔍 Final popup check after follow...")
                    self._handle_follow_popups()
                else:
                    results['failed'] += 1
                    print("❌ Follow failed")
                
                # CRITICAL: Return to homepage after each user (except last)
                if i < len(usernames_to_follow):  # Don't return home after last user
                    print("🏠 Returning to homepage for next search...")
                    self.return_to_homepage()
                    
            else:
                results['failed'] += 1
                print("❌ Search failed")
                # Still return to homepage even if search failed
                if i < len(usernames_to_follow):
                    print("🏠 Returning to homepage after search failure...")
                    self.return_to_homepage()
            
            # HUMAN BEHAVIOR: Random delay between follows with distraction pauses
            if self.hb:
                # Use human behavior for more natural delays
                self.hb.add_fatigue('follow')
                
                # Possible distraction pause
                should_pause, pause_duration = self.hb.get_distraction_pause()
                if should_pause:
                    print(f"🧠 [distracted {pause_duration:.1f}s]")
                    time.sleep(pause_duration)
                
                # Base delay varies with energy level
                energy = self.hb.energy_level
                if follow_result == "already_following":
                    base_delay = random.uniform(3, 8) * (1.5 - energy * 0.5)  # Faster when energized
                else:
                    base_delay = random.uniform(10, 20) * (1.5 - energy * 0.5)
                
                print(f"⏳ Human delay: {base_delay:.1f}s (energy: {energy:.0%})")
                time.sleep(base_delay)
            else:
                # Fallback to simple random delay
                if follow_result == "already_following":
                    delay = random.uniform(3, 8)
                    print(f"⏳ Short delay: {delay:.1f}s (already following)")
                    time.sleep(delay)
                else:
                    delay = random.uniform(10, 20)
                    print(f"⏳ Normal delay: {delay:.1f}s")
                    time.sleep(delay)
        
        print("\n" + "=" * 60)
        print(f"✅ BATCH COMPLETE: {results['followed']} newly followed, {results['already_following']} already following, {results['failed']} failed")
        print("=" * 60)
        
        # Discord notification
        if DISCORD_AVAILABLE:
            get_notifier().success("👥 Follow Batch Complete", f"Followed: {results['followed']} | Already: {results['already_following']} | Failed: {results['failed']}")
        
        self.disconnect()
        
        # Return True if we successfully followed at least one user
        return results['followed'] > 0

    def follow_from_file(self, filename="usernames.txt"):
        """Follow users from usernames.txt file"""
        print("📋 INSTAGRAM FOLLOW FROM FILE")
        print("=" * 40)
        
        usernames = self.load_usernames_from_file(filename)
        if not usernames:
            print("❌ No usernames to process")
            return
        
        print(f"\n🚀 Starting follow process for {len(usernames)} users...")
        confirm = input("Proceed? (y/n): ").strip().lower()
        
        if confirm != 'y':
            print("❌ Operation cancelled")
            return
        
        self.follow_users_batch(usernames)
    
    def _ensure_instagram_focused(self):
        """Check if Instagram is currently focused/active"""
        try:
            import subprocess
            result = subprocess.run([
                "adb", "-s", self.device_id, "shell", "dumpsys", "window", "windows"
            ], capture_output=True, text=True, timeout=10)
            
            if result.returncode == 0:
                lines = result.stdout.split('\n')
                for line in lines:
                    if ("mCurrentFocus" in line or "mFocusedApp" in line) and "com.instagram.android" in line:
                        return True
            return False
        except:
            return False
    
    def _recover_instagram_connection(self):
        """Attempt to recover Instagram connection and WebDriver session"""
        try:
            print("🔄 Attempting to recover Instagram connection...")
            
            # Try to reconnect current session first
            try:
                current_app = self.driver.current_package
                if current_app == "com.instagram.android":
                    print("✅ WebDriver session is still valid")
                    return True
            except:
                print("⚠️ WebDriver session lost, attempting full reconnection...")
            
            # Close current session if exists
            if self.driver:
                try:
                    self.driver.quit()
                except:
                    pass
                self.driver = None
            
            # Full reconnection
            if self.connect():
                print("✅ Instagram connection recovered successfully")
                return True
            else:
                print("❌ Failed to recover Instagram connection")
                return False
                
        except Exception as e:
            print(f"❌ Error recovering Instagram connection: {e}")
            return False

if __name__ == "__main__":
    follower = InstagramFollower()
    
    print("👥 INSTAGRAM FOLLOW MODULE")
    print("=" * 30)
    print("1 - Follow users from usernames.txt")
    print("2 - Follow users (manual input)")
    print("3 - Test single user")
    
    choice = input("Choose option (1-3): ").strip()
    
    if choice == "1":
        follower.follow_from_file()
        
    elif choice == "2":
        users_input = input("Enter usernames (comma separated): ").strip()
        usernames = [u.strip() for u in users_input.split(",")]
        follower.follow_users_batch(usernames)
        
    elif choice == "3":
        username = input("Enter username to test: ").strip()
        if follower.connect():
            if follower.search_user(username):
                follower.follow_user()
            follower.disconnect()
    
    else:
        print("❌ Invalid choice")