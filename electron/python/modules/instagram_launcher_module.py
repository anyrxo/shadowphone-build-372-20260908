#!/usr/bin/env python3
"""
📱 INSTAGRAM LAUNCHER MODULE
Open Instagram app and navigate to home feed using robust Appium Selectors.
"""

from appium import webdriver
from appium.options.android import UiAutomator2Options
from appium.webdriver.common.appiumby import AppiumBy
import time
import subprocess
import sys
import os

# Add parent directory to path to import modules
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.ig_selectors import InstagramSelectors
from lib.instagram_navigation_guards import InstagramNavigationGuards
from lib.instagram_screen_classifier import classify_instagram_screen, IG_HOME, IG_PROFILE
from lib.screen_state import ScreenObservation
from modules.popup_handler import PopupHandler

# Import crash recovery module
try:
    from appium_crash_recovery import auto_recover_from_crash
    CRASH_RECOVERY_AVAILABLE = True
except ImportError:
    CRASH_RECOVERY_AVAILABLE = False
    print("⚠️ Crash recovery module not available")

# Import centralized driver manager
try:
    from modules.driver_manager import get_shared_driver, quit_shared_driver, recover_driver, is_crash_error
    DRIVER_MANAGER_AVAILABLE = True
except ImportError:
    try:
        from driver_manager import get_shared_driver, quit_shared_driver, recover_driver, is_crash_error
        DRIVER_MANAGER_AVAILABLE = True
    except ImportError:
        DRIVER_MANAGER_AVAILABLE = False
        print("⚠️ Driver manager not available, using direct connections")

class InstagramLauncher:
    @staticmethod
    def make_home_ready_outcome(verified: bool, screen_type: str = None, reason: str = None):
        return {
            "verified_home_ready": bool(verified),
            "screen_type": screen_type or (IG_HOME if verified else "unknown"),
            "reason": reason or ("verified_home_ready" if verified else "home_not_verified"),
        }

    @staticmethod
    def _adb_device_available(device_id: str) -> bool:
        try:
            result = subprocess.run(["adb", "devices"], capture_output=True, text=True, timeout=10)
            stdout = result.stdout or ""
            return f"{device_id}\tdevice" in stdout
        except Exception:
            return False

    @staticmethod
    def describe_home_ready_failure(outcome: dict | None, prefix: str = "Failed to verify Instagram home entry") -> str:
        if not isinstance(outcome, dict):
            return f"{prefix}: unknown (invalid_launcher_outcome)"
        screen_type = outcome.get("screen_type") or "unknown"
        reason = outcome.get("reason") or "home_not_verified"
        return f"{prefix}: {screen_type} ({reason})"

    @classmethod
    def is_verified_home_ready(cls, outcome: dict | None, prefix: str = "Failed to verify Instagram home entry") -> tuple[bool, str | None]:
        if isinstance(outcome, dict) and outcome.get("verified_home_ready"):
            return True, None
        return False, cls.describe_home_ready_failure(outcome, prefix=prefix)

    def __init__(self, device_id="1A121FDF60082H", **kwargs):
        self.device_id = device_id
        self.driver = None
        
        # Ignore any extra parameters for compatibility
        if kwargs:
            print(f"⚠️ Launcher ignoring extra parameters: {list(kwargs.keys())}")
        
    def _handle_appium_error(self, error, operation_name="operation"):
        """Handle Appium errors with automatic crash recovery"""
        if CRASH_RECOVERY_AVAILABLE and hasattr(self, 'driver') and self.driver:
            print(f"🚨 Error during {operation_name}: {error}")
            print("🔄 Attempting automatic crash recovery...")
            
            success, _ = auto_recover_from_crash(error, self.device_id, self.driver)
            if success:
                print(f"✅ Crash recovery successful for {operation_name}")
                # Try to reconnect
                return self.connect_adb()
            else:
                print(f"❌ Crash recovery failed for {operation_name}")
        
        return False
        
    def connect_adb(self):
        """Connect via ADB to device with comprehensive validation"""
        self.last_connect_failure_reason = None
        # Sanitize ANDROID_HOME if set (fix for leading space issue)
        if 'ANDROID_HOME' in os.environ:
            original_home = os.environ['ANDROID_HOME']
            if original_home.startswith(' ') or original_home.endswith(' '):
                print(f"⚠️ Detected whitespace in ANDROID_HOME, fixing: '{original_home}' -> '{original_home.strip()}'")
                os.environ['ANDROID_HOME'] = original_home.strip()

        # USE CENTRALIZED DRIVER MANAGER if available
        if DRIVER_MANAGER_AVAILABLE:
            print("📱 Using centralized driver manager...")
            self.driver = get_shared_driver(self.device_id)
            if self.driver:
                print("✅ ADB Connected via driver manager!")
                return True
            else:
                if self._adb_device_available(self.device_id):
                    self.last_connect_failure_reason = "driver_transport_failed"
                else:
                    self.last_connect_failure_reason = "adb_device_unavailable"
                print("❌ Driver manager failed to get driver")
                return False
        
        # FALLBACK: Direct connection (legacy)
        try:
            print("📱 Initiating ADB connection with pre-flight validation...")
            
            # PRE-FLIGHT CHECK 1: Validate Appium server is running
            print("🔍 Step 1/4: Checking Appium server status...")
            if not self._validate_appium_server():
                self.last_connect_failure_reason = "appium_server_unavailable"
                print("❌ Appium server validation failed")
                return False
            
            # PRE-FLIGHT CHECK 2: Validate device is connected and responsive
            print("🔍 Step 2/4: Validating device connectivity...")
            if not self._validate_device_connectivity():
                self.last_connect_failure_reason = "adb_device_unavailable"
                print("❌ Device connectivity validation failed") 
                return False
                
            # PRE-FLIGHT CHECK 3: Check port availability
            print("🔍 Step 3/4: Verifying port 4723 accessibility...")
            if not self._validate_port_accessibility():
                self.last_connect_failure_reason = "appium_transport_unavailable"
                print("❌ Port 4723 accessibility check failed")
                return False
            
            # PRE-FLIGHT CHECK 4: Attempt connection with retry logic
            print("🔍 Step 4/4: Establishing WebDriver connection...")
            for attempt in range(3):  # 3 retry attempts
                try:
                    print(f"📱 Connection attempt {attempt + 1}/3...")
                    
                    options = UiAutomator2Options()
                    options.platform_name = "Android"
                    options.device_name = self.device_id
                    options.automation_name = "UIAutomator2"
                    options.no_reset = True
                    options.full_reset = False
                    options.new_command_timeout = 300  # 5 minutes
                    
                    self.driver = webdriver.Remote("http://127.0.0.1:4723", options=options)
                    time.sleep(2)
                    
                    # Validate connection is actually working
                    if self._validate_connection_health():
                        print("✅ ADB Connected successfully with full validation!")
                        return True
                    else:
                        print(f"❌ Connection health check failed on attempt {attempt + 1}")
                        if self.driver:
                            self.driver.quit()
                        time.sleep(2)  # Wait before retry
                        
                except Exception as e:
                    print(f"❌ Connection attempt {attempt + 1} failed: {e}")
                    if self.driver:
                        try:
                            self.driver.quit()
                        except:
                            pass
                    time.sleep(2)  # Wait before retry
            
            self.last_connect_failure_reason = "driver_transport_failed"
            print("❌ All connection attempts failed after validation")
            return False
            
        except Exception as e:
            self.last_connect_failure_reason = "launcher_transport_unknown"
            print(f"❌ ADB Connection validation failed with exception: {e}")
            return False
    
    def _validate_appium_server(self):
        """Validate Appium server is running and responsive"""
        try:
            import requests
            response = requests.get("http://127.0.0.1:4723/status", timeout=5)
            if response.status_code == 200:
                print("✅ Appium server is responsive")
                return True
            else:
                print(f"❌ Appium server returned status code: {response.status_code}")
                return False
        except Exception as e:
            print(f"❌ Appium server check failed: {e}")
            print("💡 TIP: Start Appium server with: appium --port 4723")
            return False
    
    def _validate_device_connectivity(self):
        """Validate device is connected and responsive via ADB"""
        try:
            import subprocess
            
            # Check if device is listed
            result = subprocess.run(["adb", "devices"], capture_output=True, text=True, timeout=10)
            if self.device_id not in result.stdout:
                print(f"❌ Device {self.device_id} not found in ADB devices list")
                print("💡 TIP: Check USB connection and developer options")
                return False
            
            # Check if device is authorized
            if "unauthorized" in result.stdout:
                print("❌ Device is unauthorized - check device for USB debugging prompt")
                return False
            
            # Test device shell connectivity
            test_result = subprocess.run(["adb", "-s", self.device_id, "shell", "echo", "test"], 
                                       capture_output=True, text=True, timeout=10)
            if test_result.returncode == 0 and "test" in test_result.stdout:
                print("✅ Device is connected and responsive")
                return True
            else:
                print("❌ Device shell connectivity test failed")
                return False
                
        except Exception as e:
            print(f"❌ Device connectivity validation failed: {e}")
            return False
    
    def _validate_port_accessibility(self):
        """Validate port 4723 is accessible"""
        try:
            import socket
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(5)
            result = sock.connect_ex(('127.0.0.1', 4723))
            sock.close()
            
            if result == 0:
                print("✅ Port 4723 is accessible")
                return True
            else:
                print("❌ Port 4723 is not accessible")
                return False
        except Exception as e:
            print(f"❌ Port accessibility check failed: {e}")
            return False
    
    def _validate_connection_health(self):
        """Validate the WebDriver connection is actually healthy"""
        try:
            # Test basic driver functionality
            session_id = self.driver.session_id
            if session_id:
                print(f"✅ WebDriver session established: {session_id[:8]}...")
                return True
            else:
                print("❌ WebDriver session validation failed")
                return False
        except Exception as e:
            print(f"❌ Connection health validation failed: {e}")
            return False
    
    def disconnect(self):
        if self.driver:
            self.driver.quit()
            print("🔄 Disconnected")
    
    def launch_instagram(self):
        """Launch Instagram app with pre-launch cleanup"""
        try:
            print("📱 Launching Instagram...")
            
            # PRE-LAUNCH CLEANUP: Press back 2x (reduced from 4x to look less suspicious)
            print("🔄 Pre-launch cleanup: Pressing back 2x...")
            try:
                for i in range(2):
                    subprocess.run(["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"], 
                                 capture_output=True, timeout=3)
                    time.sleep(0.8)  # Slightly longer delay for human-like behavior
                print("✅ Pre-launch cleanup completed")
            except Exception as cleanup_error:
                print(f"⚠️ Pre-launch cleanup failed (non-critical): {cleanup_error}")
            
            # Method 1: Use activate_app (preferred)
            try:
                self.driver.activate_app("com.instagram.android")
                time.sleep(8)  # Increased wait time for Instagram to fully load
                print("✅ Instagram launched via activate_app!")
                return True
            except:
                print("⚠️ activate_app failed, trying ADB method...")
            
            # Method 2: ADB monkey fallback (NEVER `am start -n .../ModalActivity`
            # — that activity is not exported and throws SecurityException on
            # current IG builds).
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "monkey", "-p",
                 "com.instagram.android", "-c", "android.intent.category.LAUNCHER", "1"],
                capture_output=True,
                text=True
            )
            
            if result.returncode == 0:
                time.sleep(8)  # Increased wait time
                print("✅ Instagram launched via ADB!")
                return True
            else:
                print("❌ ADB launch failed")
                return False
                
        except Exception as e:
            print(f"❌ Instagram launch failed: {e}")
            return False
    
    def _build_driver_observation(self):
        """Best-effort Appium observation for screen classification without flow changes."""
        page_source = None
        package = None
        activity = None
        try:
            page_source = self.driver.page_source
        except Exception:
            page_source = None
        try:
            package = self.driver.current_package
        except Exception:
            package = None
        try:
            activity = self.driver.current_activity
        except Exception:
            activity = None
        return ScreenObservation(
            observed_at="driver_snapshot",
            device_id=self.device_id,
            package=package,
            activity=activity,
            xml_source=page_source,
        )

    def verify_instagram(self):
        """Verify we're in Instagram app"""
        try:
            print("🔍 Verifying Instagram app...")
            observation = self._build_driver_observation()
            current_package = observation.package or ""
            if "instagram" in current_package.lower():
                print(f"✅ In Instagram app: {current_package}")
                return True
            else:
                print(f"❌ Wrong app: {current_package}")
                return False
                
        except Exception as e:
            print(f"❌ Verification failed: {e}")
            return False
    
    def check_connection(self):
        """Check if Appium session is still active - DETECTS UiAutomator2 CRASH"""
        try:
            if self.driver:
                current_package = self.driver.current_package
                return True
        except Exception as e:
            error_str = str(e)
            
            # CRITICAL: Detect UiAutomator2 server crash specifically
            if "instrumentation process is not running" in error_str or "UiAutomator2" in error_str:
                print(f"🚨 UIAUTOMATOR2 CRASHED! Session is dead, forcing reconnection...")
                # Force kill the dead driver
                try:
                    if self.driver:
                        self.driver.quit()
                except:
                    pass
                self.driver = None
                
                # Force reconnect with new session
                return self.reconnect()
            
            print(f"⚠️ Session check failed: {e}")
            
            # Try automatic crash recovery for other errors
            if CRASH_RECOVERY_AVAILABLE:
                print("🔄 Attempting automatic crash recovery...")
                success, _ = auto_recover_from_crash(e, self.device_id, self.driver)
                if success:
                    # Try to reconnect after recovery
                    return self.reconnect()
            
            return False
        return False
    
    def reconnect(self):
        """Reconnect to Appium if session is lost"""
        try:
            print("🔄 Session lost - attempting reconnection...")
            if self.driver:
                try:
                    self.driver.quit()
                except:
                    pass
                self.driver = None
            
            # Reconnect
            if self.connect_adb():
                print("✅ Reconnected successfully!")
                return True
            else:
                print("❌ Reconnection failed")
                return False
        except Exception as e:
            print(f"❌ Reconnection error: {e}")
            return False
    
    def go_to_home_feed(self):
        """Navigate to Instagram home feed using verified Dec 2024 selectors"""
        try:
            print("   Going to home feed...")
            
            # Check connection before starting
            if not self.check_connection():
                print("   Session lost - attempting recovery...")
                if not self.reconnect():
                    return False
            
            # Helper to detect UiAutomator2 crash
            def is_uia2_crash(error):
                error_str = str(error)
                return "instrumentation process is not running" in error_str or "UiAutomator2" in error_str
            
            # Strategy 1: Resource ID (VERIFIED Dec 2024)
            try:
                print(f"   Strategy 1: Resource ID {InstagramSelectors.HOME_TAB}")
                home_tab = self.driver.find_element(AppiumBy.ID, InstagramSelectors.HOME_TAB)
                home_tab.click()
                print("   Home tab clicked (Resource ID)")
                time.sleep(3)
                return True
            except Exception as e:
                if is_uia2_crash(e):
                    print("   🚨 UIA2 CRASHED in Strategy 1! Reconnecting...")
                    if self.reconnect():
                        return self.go_to_home_feed()  # Retry once after reconnect
                    return False
                print(f"   Resource ID failed: {e}")
            
            # Strategy 2: Accessibility ID
            try:
                print("   Strategy 2: Accessibility ID 'Home'")
                home_tab = self.driver.find_element(AppiumBy.ACCESSIBILITY_ID, "Home")
                home_tab.click()
                print("   Home tab clicked (Accessibility ID)")
                time.sleep(3)
                return True
            except Exception as e:
                if is_uia2_crash(e):
                    print("   🚨 UIA2 CRASHED in Strategy 2! Reconnecting...")
                    if self.reconnect():
                        return self.go_to_home_feed()
                    return False
                print("   Accessibility ID failed")
            
            # Strategy 3: Coordinate fallback (VERIFIED Dec 2024) - Use ADB if driver dead
            try:
                print(f"   Strategy 3: Coordinate fallback {InstagramSelectors.Coords.NAV_HOME_TAB}")
                x, y = InstagramSelectors.Coords.NAV_HOME_TAB
                self.driver.tap([(x, y)])
                print(f"   Home tab clicked (coordinates {x}, {y})")
                time.sleep(3)
                return True
            except Exception as e:
                if is_uia2_crash(e):
                    print("   🚨 UIA2 CRASHED in Strategy 3! Using ADB fallback...")
                    # ADB tap doesn't need Appium
                    subprocess.run(["adb", "-s", self.device_id, "shell", "input", "tap", str(x), str(y)], 
                                  capture_output=True, timeout=5)
                    time.sleep(3)
                    return True
                print(f"   Coordinate tap failed: {e}")
            
            return False

        except Exception as e:
            print(f"   Home navigation failed: {e}")
            return False
    
    def go_to_reels_tab(self):
        """Navigate to Instagram Reels tab (clips_tab) using verified Dec 2024 selectors"""
        try:
            print("   Going to Reels tab...")
            
            # Check connection
            if not self.check_connection():
                if not self.reconnect():
                    return False
            
            # Strategy 1: Resource ID (VERIFIED Dec 2024 - clips_tab)
            try:
                print(f"   Strategy 1: Resource ID {InstagramSelectors.REELS_TAB}")
                reels_tab = self.driver.find_element(AppiumBy.ID, InstagramSelectors.REELS_TAB)
                reels_tab.click()
                print("   Reels tab clicked (Resource ID)")
                time.sleep(4)
                return True
            except Exception as e:
                print(f"   Resource ID failed: {e}")
            
            # Strategy 2: Accessibility ID
            try:
                print("   Strategy 2: Accessibility ID 'Reels'")
                reels_tab = self.driver.find_element(AppiumBy.ACCESSIBILITY_ID, "Reels")
                reels_tab.click()
                print("   Reels tab clicked (Accessibility ID)")
                time.sleep(4)
                return True
            except:
                print("   Accessibility ID failed")
            
            # Strategy 3: ADB Deep Link
            try:
                print("   Strategy 3: ADB deep link instagram://reels")
                result = subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "am", "start", 
                     "-a", "android.intent.action.VIEW", "-d", "instagram://reels"],
                    capture_output=True, text=True, timeout=10
                )
                if result.returncode == 0:
                    print("   Reels opened (deep link)")
                    time.sleep(4)
                    return True
            except Exception as e:
                print(f"   Deep link failed: {e}")
            
            # Strategy 4: Coordinate fallback (VERIFIED Dec 2024)
            try:
                print(f"   Strategy 4: Coordinate fallback {InstagramSelectors.Coords.NAV_REELS_TAB}")
                x, y = InstagramSelectors.Coords.NAV_REELS_TAB
                self.driver.tap([(x, y)])
                print(f"   Reels tab clicked (coordinates {x}, {y})")
                time.sleep(4)
                return True
            except:
                pass
            
            return False
            
        except Exception as e:
            print(f"   Reels navigation failed: {e}")
            return False

    def go_to_messages_tab(self):
        """Navigate to Instagram Messages/DM tab using verified Dec 2024 selectors"""
        try:
            print("   Going to Messages tab...")
            
            if not self.check_connection():
                if not self.reconnect():
                    return False
            
            # Strategy 1: Resource ID (VERIFIED Dec 2024 - direct_tab)
            try:
                print(f"   Strategy 1: Resource ID {InstagramSelectors.MESSAGES_TAB}")
                msg_tab = self.driver.find_element(AppiumBy.ID, InstagramSelectors.MESSAGES_TAB)
                msg_tab.click()
                print("   Messages tab clicked (Resource ID)")
                time.sleep(3)
                return True
            except Exception as e:
                print(f"   Resource ID failed: {e}")
            
            # Strategy 2: Accessibility ID
            try:
                print("   Strategy 2: Accessibility ID 'Direct'")
                msg_tab = self.driver.find_element(AppiumBy.ACCESSIBILITY_ID, "Direct")
                msg_tab.click()
                print("   Messages tab clicked (Accessibility ID)")
                time.sleep(3)
                return True
            except:
                print("   Accessibility ID failed")
            
            # Strategy 3: Coordinate fallback (VERIFIED Dec 2024)
            try:
                print(f"   Strategy 3: Coordinate fallback {InstagramSelectors.Coords.NAV_MESSAGES_TAB}")
                x, y = InstagramSelectors.Coords.NAV_MESSAGES_TAB
                self.driver.tap([(x, y)])
                print(f"   Messages tab clicked (coordinates {x}, {y})")
                time.sleep(3)
                return True
            except:
                pass
            
            return False
            
        except Exception as e:
            print(f"   Messages navigation failed: {e}")
            return False

    def go_to_search_tab(self):
        """Navigate to Instagram Search tab using verified Dec 2024 selectors"""
        try:
            print("   Going to Search tab...")
            
            if not self.check_connection():
                if not self.reconnect():
                    return False
            
            # Strategy 1: Resource ID (VERIFIED Dec 2024 - search_tab)
            try:
                print(f"   Strategy 1: Resource ID {InstagramSelectors.SEARCH_TAB}")
                search_tab = self.driver.find_element(AppiumBy.ID, InstagramSelectors.SEARCH_TAB)
                search_tab.click()
                print("   Search tab clicked (Resource ID)")
                time.sleep(3)
                return True
            except Exception as e:
                print(f"   Resource ID failed: {e}")
            
            # Strategy 2: Accessibility ID
            try:
                print("   Strategy 2: Accessibility ID 'Search and explore'")
                search_tab = self.driver.find_element(AppiumBy.ACCESSIBILITY_ID, "Search and explore")
                search_tab.click()
                print("   Search tab clicked (Accessibility ID)")
                time.sleep(3)
                return True
            except:
                print("   Accessibility ID failed")
            
            # Strategy 3: Coordinate fallback (VERIFIED Dec 2024)
            try:
                print(f"   Strategy 3: Coordinate fallback {InstagramSelectors.Coords.NAV_SEARCH_TAB}")
                x, y = InstagramSelectors.Coords.NAV_SEARCH_TAB
                self.driver.tap([(x, y)])
                print(f"   Search tab clicked (coordinates {x}, {y})")
                time.sleep(3)
                return True
            except:
                pass
            
            return False
            
        except Exception as e:
            print(f"   Search navigation failed: {e}")
            return False

    def go_to_profile_tab(self):
        """Navigate to Instagram Profile tab using verified Dec 2024 selectors"""
        try:
            print("   Going to Profile tab...")
            
            if not self.check_connection():
                if not self.reconnect():
                    return False
            
            # Strategy 1: Resource ID (VERIFIED Dec 2024 - profile_tab)
            try:
                print(f"   Strategy 1: Resource ID {InstagramSelectors.PROFILE_TAB}")
                profile_tab = self.driver.find_element(AppiumBy.ID, InstagramSelectors.PROFILE_TAB)
                profile_tab.click()
                print("   Profile tab clicked (Resource ID)")
                time.sleep(3)
                return True
            except Exception as e:
                print(f"   Resource ID failed: {e}")
            
            # Strategy 2: tab_avatar (profile picture in nav bar)
            try:
                print(f"   Strategy 2: Resource ID {InstagramSelectors.TAB_AVATAR}")
                avatar_tab = self.driver.find_element(AppiumBy.ID, InstagramSelectors.TAB_AVATAR)
                avatar_tab.click()
                print("   Profile tab clicked (tab_avatar)")
                time.sleep(3)
                return True
            except:
                print("   tab_avatar failed")
            
            # Strategy 3: Accessibility ID
            try:
                print("   Strategy 3: Accessibility ID 'Profile'")
                profile_tab = self.driver.find_element(AppiumBy.ACCESSIBILITY_ID, "Profile")
                profile_tab.click()
                print("   Profile tab clicked (Accessibility ID)")
                time.sleep(3)
                return True
            except:
                print("   Accessibility ID failed")
            
            # Strategy 4: Coordinate fallback (VERIFIED Dec 2024)
            try:
                print(f"   Strategy 4: Coordinate fallback {InstagramSelectors.Coords.NAV_PROFILE_TAB}")
                x, y = InstagramSelectors.Coords.NAV_PROFILE_TAB
                self.driver.tap([(x, y)])
                print(f"   Profile tab clicked (coordinates {x}, {y})")
                time.sleep(3)
                return True
            except:
                pass
            
            return False
            
        except Exception as e:
            print(f"   Profile navigation failed: {e}")
            return False

    def check_home_feed(self):
        """Verify we're on the home feed"""
        try:
            print("🔍 Checking if we're on home feed...")
            time.sleep(3)
            
            # Check package first
            current_package = self.driver.current_package
            if "instagram" not in current_package.lower():
                print("❌ Not on Instagram")
                return False

            # Check for Story Tray (Enhanced Verification)
            try:
                # Story tray is a strong indicator of home feed
                self.driver.find_element(AppiumBy.XPATH, InstagramSelectors.STORY_TRAY_XPATH)
                print("✅ Confirmed Home Feed (Found Story Tray)!")
                return True
            except:
                print("⚠️ Story tray not found, checking Feed List...")
                try:
                    self.driver.find_element(AppiumBy.ID, InstagramSelectors.FEED_LIST)
                    print("✅ Confirmed Home Feed (Found Feed List)!")
                    return True
                except:
                    print("⚠️ Could not confirm Home Feed elements")
                    # Fallback to simple package check if strict mode irrelevant
                    return True
                
        except Exception as e:
            print(f"❌ Home feed check failed: {e}")
            return False
    
    def check_reels_tab(self):
        """Verify we're on the reels tab"""
        try:
            print("🔍 Checking if we're on reels tab...")
            time.sleep(3)
            
            current_package = self.driver.current_package
            if "instagram" not in current_package.lower():
                print("❌ Not on Instagram")
                return False
                
            # Enhanced check: Look for Like button or specific Reels UI
            try:
                self.driver.find_element(AppiumBy.ID, InstagramSelectors.REELS_LIKE_BTN)
                print("✅ Confirmed Reels Tab (Found Like Button)!")
                return True
            except:
                print("⚠️ Reels specific element not found, assuming success based on navigation")
                return True
                
        except Exception as e:
            print(f"❌ Reels tab check failed: {e}")
            return False
    
    def open_instagram_home(self):
        """Complete workflow: Connect → Launch → Navigate to Home"""
        outcome = self.open_instagram_home_strict()
        return bool(outcome.get("verified_home_ready"))

    def open_instagram_home_strict(self):
        """Return structured launcher outcome with verified-home-ready vs classified failure."""
        print("🚀 Starting Instagram launcher workflow...")

        # Step 1: Connect to device
        if not self.connect_adb():
            print("❌ Failed to connect to device")
            failure_reason = getattr(self, 'last_connect_failure_reason', None) or 'launcher_transport_unknown'
            if failure_reason == 'adb_device_unavailable':
                return self.make_home_ready_outcome(False, screen_type='adb_device_unavailable', reason='adb_device_unavailable')
            if failure_reason in {'driver_transport_failed', 'appium_server_unavailable', 'appium_transport_unavailable'}:
                print("⚠️ Driver/Appium transport failed but ADB may still be available; trying one bounded ADB-only home fallback")

                def _classify_adb_surface():
                    try:
                        xml_content = self.dump_ui_hierarchy() or ''
                        if not xml_content:
                            return 'unknown'
                        inferred_package = 'com.instagram.android' if 'com.instagram.android' in xml_content else None
                        observation = ScreenObservation(
                            observed_at='launcher-adb-fallback-check',
                            device_id=self.device_id,
                            package=inferred_package,
                            xml_source=xml_content,
                        )
                        classification = classify_instagram_screen(observation=observation)
                        if classification.screen_type and classification.screen_type != 'unknown':
                            return classification.screen_type
                        raw_markers = []
                        if 'package="com.android.launcher3"' in xml_content:
                            raw_markers.append('launcher3')
                        if 'package="com.android.dialer"' in xml_content:
                            raw_markers.append('dialer')
                        if 'resource-id="com.instagram.android:id/feed_tab"' in xml_content:
                            raw_markers.append('feed_tab')
                        if 'resource-id="com.instagram.android:id/profile_tab"' in xml_content:
                            raw_markers.append('profile_tab')
                        if 'content-desc="Home"' in xml_content:
                            raw_markers.append('home_desc')
                        if 'content-desc="Profile"' in xml_content:
                            raw_markers.append('profile_desc')
                        if 'Settings' in xml_content:
                            raw_markers.append('settings_text')
                        if 'Recents' in xml_content:
                            raw_markers.append('recents_text')
                        if raw_markers:
                            return 'raw:' + '|'.join(raw_markers[:3])
                        return 'unknown'
                    except Exception:
                        return 'unknown'

                try:
                    if self.open_instagram_home_adb():
                        try:
                            self.go_to_home_adb()
                            time.sleep(1.0)
                        except Exception as adb_surface_stabilize_error:
                            print(f"⚠️ ADB known-surface stabilization failed: {adb_surface_stabilize_error}")
                        fallback_state = _classify_adb_surface()
                        if fallback_state == IG_HOME:
                            return self.make_home_ready_outcome(True, screen_type=IG_HOME, reason='verified_home_ready_via_adb_fallback')
                        if fallback_state == IG_PROFILE:
                            print("⚠️ ADB fallback landed on ig_profile; trying one bounded in-app Home-tab recovery")
                            try:
                                self.go_to_home_adb()
                            except Exception as adb_profile_recovery_error:
                                print(f"⚠️ ADB profile recovery failed: {adb_profile_recovery_error}")
                            fallback_state = _classify_adb_surface()
                            if fallback_state == IG_HOME:
                                return self.make_home_ready_outcome(True, screen_type=IG_HOME, reason='verified_home_ready_via_adb_profile_recovery')
                            return self.make_home_ready_outcome(False, screen_type=fallback_state, reason='adb_profile_recovery_failed')
                        probe = self.get_current_app_adb()
                        best_state = fallback_state
                        probe_package = (probe or {}).get('package')
                        probe_activity = (probe or {}).get('activity')
                        if probe_package and 'instagram' not in probe_package.lower():
                            best_state = f'foreground:{probe_package}'
                        elif probe_activity:
                            best_state = f'{fallback_state}|{probe_activity}' if fallback_state and fallback_state != 'unknown' else probe_activity
                        return self.make_home_ready_outcome(False, screen_type=best_state or 'launcher_transport_failed', reason='adb_home_not_verified')
                except Exception as adb_fallback_error:
                    print(f"⚠️ ADB-only fallback failed: {adb_fallback_error}")
                probe = self.get_current_app_adb()
                probe_package = (probe or {}).get('package')
                probe_activity = (probe or {}).get('activity')
                best_state = 'launcher_transport_failed'
                if probe_package and 'instagram' not in probe_package.lower():
                    best_state = f'foreground:{probe_package}'
                elif probe_activity:
                    best_state = probe_activity
                return self.make_home_ready_outcome(False, screen_type=best_state, reason=failure_reason)
            return self.make_home_ready_outcome(False, screen_type='launcher_connection_unknown', reason=failure_reason)

        try:
            max_attempts = 3
            last_outcome = self.make_home_ready_outcome(False, screen_type="unknown", reason="launcher_not_run")
            for attempt in range(1, max_attempts + 1):
                print(f"📱 ATTEMPT {attempt}/{max_attempts}: Instagram launch sequence...")

                # Step 2: Launch Instagram
                if not self.launch_instagram():
                    print(f"❌ Launch attempt {attempt} failed")
                    last_outcome = self.make_home_ready_outcome(False, screen_type="launch_failed", reason="launch_failed")
                    time.sleep(3)
                    continue

                # Step 3: Verify we're in Instagram
                if not self.verify_instagram():
                    print(f"❌ Verification failed on attempt {attempt}")
                    last_outcome = self.make_home_ready_outcome(False, screen_type="instagram_not_foreground", reason="verify_instagram_failed")
                    continue

                # Step 4+5+6: Navigate to home feed, verify classic checks, then guard with classifier
                nav_guards = InstagramNavigationGuards(self.driver, self.device_id)
                popup_handler = PopupHandler(self.driver)
                last_screen_type = "unknown"

                def _semantic_home_ready_after_nav():
                    nonlocal last_screen_type
                    try:
                        observation = ScreenObservation(
                            observed_at='launcher-home-semantic-check',
                            device_id=self.device_id,
                            package=getattr(self.driver, 'current_package', None),
                            xml_source=self.driver.page_source,
                        )
                        classification = classify_instagram_screen(observation=observation)
                        last_screen_type = classification.screen_type or "unknown"
                        return last_screen_type == IG_HOME
                    except Exception:
                        last_screen_type = "semantic_check_error"
                        return False

                def _navigate_home_once():
                    if not self.go_to_home_feed():
                        return False
                    if _semantic_home_ready_after_nav():
                        return True
                    if not self.check_home_feed():
                        return False
                    return True

                def _bounded_home_nudge():
                    if not self.go_to_home_feed():
                        return False
                    return _semantic_home_ready_after_nav()

                if not nav_guards.ensure_home_with_retry(
                    navigate_home=_navigate_home_once,
                    popup_assess=lambda: popup_handler.assess_popup_surface(),
                    popup_dismiss=lambda: popup_handler.dismiss_any_popup(max_attempts=1),
                    nudge_action=_bounded_home_nudge,
                    attempts=2,
                    settle_seconds=2.5,
                    verify_after_navigation=_semantic_home_ready_after_nav,
                ):
                    print(f"❌ Verified home bootstrap failed on attempt {attempt}")
                    last_outcome = self.make_home_ready_outcome(False, screen_type=last_screen_type, reason="home_not_verified")
                    continue

                # SUCCESS
                print(f"🎉 SUCCESS: Instagram opened and on home feed! (Attempt {attempt})")
                return self.make_home_ready_outcome(True, screen_type=IG_HOME, reason="verified_home_ready")

            print("❌ FINAL FAILURE: Instagram launch workflow failed on all attempts")
            return last_outcome

        finally:
            print("📱 Instagram ready for automation (connection maintained)")
    
    
    def open_instagram_reels(self):
        """Complete workflow: Connect → Launch → Navigate to Reels (Golden ID First)"""
        print("🚀 Starting Instagram Reels launcher (Golden ID)...")
        
        if not self.connect_adb():
            return False
        
        try:
            # Ensure app is running first
            self.driver.activate_app("com.instagram.android")
            time.sleep(2)
            
            if self.go_to_reels_tab():
                print("   SUCCESS: Instagram Reels opened!")
                return True
            else:
                print("   Failed to navigate to reels tab")
                return False
                
        except Exception as e:
            print(f"   Instagram Reels launch failed: {e}")
            return False
    
    def go_to_phone_home(self):
        """Go to phone home screen"""
        try:
            print("🏠 Going to phone home screen...")
            if not self.connect_adb():
                return False
            
            self.driver.press_keycode(3)  # Android HOME key
            time.sleep(2)
            
            current_package = self.driver.current_package
            if "launcher" in current_package.lower():
                print("✅ On phone home screen!")
                return True
            else:
                print(f"⚠️ Not on home screen: {current_package}")
                return False
        except Exception as e:
            print(f"❌ Go to phone home failed: {e}")
            return False
        finally:
            self.disconnect()
    
    def close_instagram(self):
        """Close Instagram app and return to phone home screen"""
        try:
            print("📱 Closing Instagram...")
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "am", "force-stop", "com.instagram.android"], 
                capture_output=True, text=True
            )
            
            if result.returncode == 0:
                print("✅ Instagram closed!")
                time.sleep(1)
                # Ensure home screen
                if self.connect_adb():
                    self.driver.press_keycode(3)
                    self.disconnect()
                return True
            return False
        except Exception as e:
            print(f"❌ Close Instagram failed: {e}")
            return False
    
    def get_current_app(self):
        """Check what app is currently active"""
        try:
            if not self.connect_adb():
                return None
            current_package = self.driver.current_package
            current_activity = self.driver.current_activity
            print(f"📱 Current app: {current_package}")
            print(f"🔍 Current activity: {current_activity}")
            return {"package": current_package, "activity": current_activity}
        except Exception as e:
            print(f"❌ Get current app failed: {e}")
            return None
        finally:
            self.disconnect()

    def go_to_creation_tab(self):
        """Navigate to Instagram Creation/Post tab (Top-Left on Home)"""
        try:
            print("📸 Going to Creation/Post tab...")
            
            # Step 1: Must be on Home Feed first
            if not self.go_to_home_feed():
                print("❌ Could not get to Home Feed first")
                return False
                
            # Step 2: Tap Home again to scroll to top (ensures top bar is visible)
            try:
                print("🔄 Refreshing Home to show top bar...")
                home_tab = self.driver.find_element(AppiumBy.ID, InstagramSelectors.HOME_TAB)
                home_tab.click()
                time.sleep(2)
            except:
                pass
                
            # Step 3: Click New Post Button
            try:
                print(f"🎯 Finding New Post Button: {InstagramSelectors.NEW_POST_BUTTON}")
                # Try finding by ID
                new_post_btn = self.driver.find_element(AppiumBy.ID, InstagramSelectors.NEW_POST_BUTTON)
                new_post_btn.click()
                print("✅ Tapped New Post button!")
                time.sleep(3)
                return True
            except Exception as e:
                print(f"⚠️ Primary ID click failed: {e}")
                
                # Fallback: Accessibility ID likely "New Post" or "Create"
                try:
                    create_btn = self.driver.find_element(AppiumBy.ACCESSIBILITY_ID, "New Post")
                    create_btn.click()
                    print("✅ Tapped New Post (Accessibility ID)!")
                    return True
                except:
                    pass
                    
                # Fallback: Coordinates (Top-Left)
                try:
                    print("📍 Using fallback coordinates for Top-Left button...")
                    # Approx 60, 200 based on standard 1080x2400
                    self.driver.tap([(63, 201)]) 
                    print("✅ Tapped New Post (Coordinates)!")
                    return True
                except:
                    print("❌ All creation button methods failed")
                    return False

        except Exception as e:
            print(f"❌ Creation navigation failed: {e}")
            return False

    # ═══════════════════════════════════════════════════════════════════
    # ADB-ONLY METHODS - NO WEBDRIVER/UIAUTOMATOR2 REQUIRED
    # ═══════════════════════════════════════════════════════════════════
    
    def launch_instagram_adb(self):
        """Launch Instagram using pure ADB - NO WEBDRIVER NEEDED!
        
        This is the most reliable method when UiAutomator2 has issues.
        """
        print("📱 ADB-ONLY: Launching Instagram...")
        
        # Press back 2x to clear any overlays
        for _ in range(2):
            subprocess.run(["adb", "-s", self.device_id, "shell", "input", "keyevent", "4"], 
                          capture_output=True, timeout=3)
            time.sleep(0.5)
        
        # Force stop Instagram for clean state
        subprocess.run(["adb", "-s", self.device_id, "shell", "am", "force-stop", "com.instagram.android"],
                      capture_output=True, timeout=5)
        time.sleep(1)
        
        # Launch Instagram using monkey command (MOST RELIABLE)
        result = subprocess.run(
            ["adb", "-s", self.device_id, "shell", "monkey", "-p", "com.instagram.android", 
             "-c", "android.intent.category.LAUNCHER", "1"],
            capture_output=True, text=True, timeout=10
        )
        
        if result.returncode == 0:
            time.sleep(4)
            print("✅ Instagram launched via ADB monkey!")
            return True
        else:
            print(f"❌ ADB launch failed: {result.stderr}")
            return False
    
    def go_to_home_adb(self):
        """Navigate to home feed using pure ADB taps"""
        print("🏠 ADB-ONLY: Going to home feed...")
        x, y = InstagramSelectors.Coords.NAV_HOME_TAB  # (108, 2274)
        subprocess.run(["adb", "-s", self.device_id, "shell", "input", "tap", str(x), str(y)],
                      capture_output=True, timeout=5)
        time.sleep(2)
        print(f"✅ Home tab tapped at ({x}, {y})")
        return True
    
    def go_to_reels_adb(self):
        """Navigate to reels using pure ADB taps"""
        print("🎬 ADB-ONLY: Going to reels...")
        x, y = InstagramSelectors.Coords.NAV_REELS_TAB  # (324, 2274)
        subprocess.run(["adb", "-s", self.device_id, "shell", "input", "tap", str(x), str(y)],
                      capture_output=True, timeout=5)
        time.sleep(2)
        print(f"✅ Reels tab tapped at ({x}, {y})")
        return True
    
    def go_to_profile_adb(self):
        """Navigate to profile using pure ADB taps"""
        print("👤 ADB-ONLY: Going to profile...")
        x, y = InstagramSelectors.Coords.NAV_PROFILE_TAB  # (972, 2274)
        subprocess.run(["adb", "-s", self.device_id, "shell", "input", "tap", str(x), str(y)],
                      capture_output=True, timeout=5)
        time.sleep(2)
        print(f"✅ Profile tab tapped at ({x}, {y})")
        return True
    
    def go_to_search_adb(self):
        """Navigate to search using pure ADB taps"""
        print("🔍 ADB-ONLY: Going to search...")
        x, y = InstagramSelectors.Coords.NAV_SEARCH_TAB  # (756, 2274)
        subprocess.run(["adb", "-s", self.device_id, "shell", "input", "tap", str(x), str(y)],
                      capture_output=True, timeout=5)
        time.sleep(2)
        print(f"✅ Search tab tapped at ({x}, {y})")
        return True
    
    def open_instagram_reels_adb(self):
        """Complete ADB-only workflow: Launch Instagram → Navigate to Reels
        
        No WebDriver, no UiAutomator2, just pure ADB commands.
        """
        print("🚀 ADB-ONLY: Opening Instagram Reels...")
        
        if not self.launch_instagram_adb():
            return False
        
        # Go to home first to ensure consistent state
        self.go_to_home_adb()
        time.sleep(1)
        
        # Then go to reels
        if self.go_to_reels_adb():
            print("🎉 ADB-ONLY: Instagram Reels ready!")
            return True
        
        return False
    
    def open_instagram_home_adb(self):
        """Complete ADB-only workflow: Launch Instagram → Home Feed
        
        No WebDriver, no UiAutomator2, just pure ADB commands.
        """
        print("🚀 ADB-ONLY: Opening Instagram Home...")
        
        if not self.launch_instagram_adb():
            return False
        
        if self.go_to_home_adb():
            print("🎉 ADB-ONLY: Instagram Home ready!")
            return True
        
        return False

    def dump_ui_hierarchy(self):
        """Return a fresh UIAutomator hierarchy without relying on a host file."""
        remote_path = f"/sdcard/.shadowphone-launcher-{os.getpid()}-{time.time_ns()}.xml"
        try:
            dumped = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "uiautomator", "dump", remote_path],
                capture_output=True,
                timeout=15,
            )
            if dumped.returncode != 0:
                return ""

            read_back = subprocess.run(
                ["adb", "-s", self.device_id, "exec-out", "cat", remote_path],
                capture_output=True,
                timeout=8,
            )
            if read_back.returncode != 0:
                return ""

            raw = read_back.stdout or b""
            xml_content = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
            hierarchy_start = xml_content.find("<hierarchy")
            if hierarchy_start < 0:
                return ""
            declaration_start = xml_content.rfind("<?xml", 0, hierarchy_start)
            return xml_content[declaration_start if declaration_start >= 0 else hierarchy_start:]
        except Exception as error:
            print(f"⚠️ ADB UI hierarchy dump failed: {error}")
            return ""
        finally:
            try:
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "rm", "-f", remote_path],
                    capture_output=True,
                    timeout=5,
                )
            except Exception:
                pass

    def get_current_app_adb(self):
        """Best-effort ADB-only foreground package/activity probe."""
        try:
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "dumpsys", "window", "windows"],
                capture_output=True,
                text=True,
                timeout=8,
            )
            output = result.stdout or ""
            for line in output.splitlines():
                lowered = line.lower()
                if ("mcurrentfocus" in lowered or "mfocusedapp" in lowered) and "/" in line:
                    focus = line.split()[-1]
                    package = focus.split('/')[0].strip() or None
                    activity = focus.split('/', 1)[1].strip() if '/' in focus else None
                    return {"package": package, "activity": activity}
        except Exception as e:
            print(f"⚠️ ADB foreground probe failed: {e}")
        return {"package": None, "activity": None}


if __name__ == "__main__":
    launcher = InstagramLauncher()
    
    print("📱 INSTAGRAM LAUNCHER (APPIUM ENHANCED)")
    print("1 - Open Instagram and go to home")
    print("2 - Open Instagram and go to reels")
    print("3 - Check current app")
    print("4 - Close Instagram")
    print("5 - Go to phone home screen")
    
    choice = input("Choose option (1-5): ").strip()
    
    if choice == "1":
        launcher.open_instagram_home()
        input("Press Enter to disconnect...")
        launcher.disconnect()
    elif choice == "2":
        launcher.open_instagram_reels()
        input("Press Enter to disconnect...")
        launcher.disconnect()
    elif choice == "3":
        launcher.get_current_app()
    elif choice == "4":
        launcher.close_instagram()
    elif choice == "5":
        launcher.go_to_phone_home()
