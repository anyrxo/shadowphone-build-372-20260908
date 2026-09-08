#!/usr/bin/env python3
"""
👤 GRAPHENE OS PROFILE SWITCHING MODULE WITH AIRPLANE MODE + VPN INTEGRATION
Complete workflow: Airplane Mode ON → Profile Switch → Airplane Mode OFF → VPN ON
"""

from appium import webdriver
from appium.options.android import UiAutomator2Options
from appium.webdriver.common.appiumby import AppiumBy
import time
import subprocess
import os

from lib.bootstrap_profile_guards import BootstrapProfileGuards
from lib.screen_state import ScreenObservation

# Import crash recovery module
try:
    from appium_crash_recovery import auto_recover_from_crash
    CRASH_RECOVERY_AVAILABLE = True
except ImportError:
    CRASH_RECOVERY_AVAILABLE = False
    print("⚠️ Crash recovery module not available")

# Import centralized driver manager
try:
    from modules.driver_manager import get_shared_driver, quit_shared_driver, is_crash_error
    DRIVER_MANAGER_AVAILABLE = True
except ImportError:
    try:
        from driver_manager import get_shared_driver, quit_shared_driver, is_crash_error
        DRIVER_MANAGER_AVAILABLE = True
    except ImportError:
        DRIVER_MANAGER_AVAILABLE = False
        print("⚠️ Driver manager not available")

# Import our other modules
from modules.airplane_mode_module import AirplaneModeController
from modules.vpn_module import ProtonVPNConnector

# Import Discord notifier
try:
    from modules.discord_notifier import get_notifier
    DISCORD_AVAILABLE = True
except ImportError:
    DISCORD_AVAILABLE = False

class GrapheneProfileSwitcher:
    def __init__(self, device_id="1A121FDF60082H", dashboard_instance=None):
        self.device_id = device_id
        self.driver = None
        self.dashboard = dashboard_instance  # Reference to dashboard for header functions
        
        # Sanitize ANDROID_HOME if set (fix for leading space issue)
        if 'ANDROID_HOME' in os.environ:
            original_home = os.environ['ANDROID_HOME']
            if original_home.startswith(' ') or original_home.endswith(' '):
                print(f"⚠️ Detected whitespace in ANDROID_HOME, fixing: '{original_home}' -> '{original_home.strip()}'")
                os.environ['ANDROID_HOME'] = original_home.strip()
        
        # Validate device connection on initialization
        self._validate_device_connection()
        
        # Initialize VPN controller (we'll use dashboard for airplane mode)
        self.vpn_connector = ProtonVPNConnector(device_id)
        
        # Only initialize airplane controller if no dashboard provided
        if not self.dashboard:
            self.airplane_controller = AirplaneModeController(device_id)
            
    def _validate_device_connection(self):
        """Validate that the specified device is actually connected"""
        try:
            result = subprocess.run(['adb', 'devices'], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                lines = result.stdout.strip().split('\n')[1:]
                connected_devices = []
                for line in lines:
                    if line.strip() and '\tdevice' in line:
                        device_id = line.split('\t')[0]
                        connected_devices.append(device_id)
                
                if self.device_id in connected_devices:
                    print(f"✅ Device validation: {self.device_id} is connected and ready")
                    return True
                else:
                    print(f"⚠️ Device validation: {self.device_id} not found in connected devices: {connected_devices}")
                    # Auto-update to first available device if dashboard available
                    if connected_devices and self.dashboard:
                        old_device = self.device_id
                        self.device_id = connected_devices[0]
                        print(f"🔄 Auto-updated device: {old_device} → {self.device_id}")
                        return True
                    return False
            else:
                print(f"❌ Device validation failed: ADB error")
                return False
        except Exception as e:
            print(f"❌ Device validation error: {e}")
            return False
        
    def _handle_appium_error(self, error, operation_name="operation"):
        """Handle Appium errors with automatic crash recovery"""
        if CRASH_RECOVERY_AVAILABLE and hasattr(self, 'driver') and self.driver:
            print(f"🚨 Error during {operation_name}: {error}")
            print("🔄 Attempting automatic crash recovery...")
            
            success, _ = auto_recover_from_crash(error, self.device_id, self.driver)
            if success:
                print(f"✅ Crash recovery successful for {operation_name}")
                # Try to reconnect
                if hasattr(self, 'connect'):
                    return self.connect()
            else:
                print(f"❌ Crash recovery failed for {operation_name}")
        
        return False

    def connect(self):
        """Connect via ADB to device"""
        try:
            print("📱 Connecting via ADB...")
            
            # USE CENTRALIZED DRIVER MANAGER if available
            if DRIVER_MANAGER_AVAILABLE:
                self.driver = get_shared_driver(self.device_id)
                if self.driver:
                    print("✅ ADB Connected via driver manager!")
                    return True
            
            # FALLBACK: Direct connection
            options = UiAutomator2Options()
            options.platform_name = "Android"
            options.device_name = self.device_id
            
            self.driver = webdriver.Remote("http://127.0.0.1:4723", options=options)
            time.sleep(2)
            print("✅ ADB Connected!")
            return True
        except Exception as e:
            print(f"❌ ADB Connection failed: {e}")
            if self._handle_appium_error(e, "connect"):
                return True
            return False
    
    def disconnect(self):
        if self.driver:
            self.driver.quit()
            print("🔄 Disconnected")
    
    def open_settings(self):
        """Open Settings app"""
        try:
            print("⚙️ Opening Settings...")
            
            # Method 1: Use activate_app
            try:
                self.driver.activate_app("com.android.settings")
                time.sleep(3)
                print("✅ Settings opened via activate_app!")
                return True
            except:
                print("⚠️ activate_app failed, trying ADB method...")
            
            # Method 2: ADB command fallback
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "am", "start", 
                 "-n", "com.android.settings/.Settings"], 
                capture_output=True, 
                text=True
            )
            
            if result.returncode == 0:
                time.sleep(3)
                print("✅ Settings opened via ADB!")
                return True
            else:
                print("❌ ADB launch failed")
                return False
                
        except Exception as e:
            print(f"❌ Settings launch failed: {e}")
            if self._handle_appium_error(e, "open_settings"):
                return True
            return False
    
    def navigate_to_profiles(self):
        """Navigate to Profiles section in Settings"""
        try:
            print("👤 Navigating to Profiles...")
            
            # Try to find Profiles option
            profiles_selectors = [
                "//android.widget.TextView[@text='Profiles']",
                "//*[contains(@text, 'Profiles')]",
                "//android.widget.TextView[@text='Users & profiles']",
                "//*[contains(@text, 'Users')]",
            ]
            
            for selector in profiles_selectors:
                try:
                    profiles_element = self.driver.find_element(AppiumBy.XPATH, selector)
                    profiles_element.click()
                    time.sleep(2)
                    picker_result = self._verify_profile_picker_screen_result()
                    if picker_result and picker_result.ok:
                        print("✅ Profiles section opened! (verified)")
                    else:
                        print("✅ Profiles section opened!")
                    return True
                except:
                    continue
            
            # If not found, try scrolling and looking again
            print("📜 Scrolling to find Profiles...")
            # Use improved scrolling if possible, but swipe works
            self.driver.swipe(540, 1500, 540, 800, 500)
            time.sleep(1)
            
            for selector in profiles_selectors:
                try:
                    profiles_element = self.driver.find_element(AppiumBy.XPATH, selector)
                    profiles_element.click()
                    time.sleep(2)
                    picker_result = self._verify_profile_picker_screen_result()
                    if picker_result and picker_result.ok:
                        print("✅ Profiles found after scroll! (verified)")
                    else:
                        print("✅ Profiles found after scroll!")
                    return True
                except:
                    continue
            
            print("❌ Could not find Profiles section")
            return False
            
        except Exception as e:
            print(f"❌ Navigate to profiles failed: {e}")
            if self._handle_appium_error(e, "navigate_to_profiles"):
                return True
            return False
    
    def _build_driver_observation(self):
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

    def _verify_profile_picker_screen(self):
        """Best-effort verified state check for settings/profile picker UI before continuing."""
        result = self._verify_profile_picker_screen_result()
        return bool(result and result.ok)

    def _verify_profile_picker_screen_result(self):
        if not self.driver:
            return None
        try:
            guards = BootstrapProfileGuards(self._build_driver_observation, log=print)
            result = guards.verify_profile_picker_or_settings()
            print(
                f"🔎 Profile/settings state: {result.screen_type} ({result.confidence}) reasons={result.reasons}"
            )
            if result.ok:
                print(f"✅ Verified profile/settings screen via classifier: {result.screen_type}")
            return result
        except Exception as e:
            print(f"⚠️ Profile/settings classifier check failed: {e}")
            return None

    def _log_current_profile_state_soft(self):
        current_user_id = self._get_current_user_id()
        current_profile_name = self.get_current_profile()
        print(
            f"🔎 Current profile state: user_id={current_user_id}, profile_name={current_profile_name}"
        )
        return {
            'user_id': current_user_id,
            'profile_name': current_profile_name,
        }

    def _verify_target_profile_active_soft(self, expected_user_id, expected_profile_name=''):
        current_user_id = self._get_current_user_id()
        current_profile_name = self.get_current_profile() if current_user_id is not None else None
        ok = str(current_user_id or '').strip() == str(expected_user_id or '').strip()
        reasons = []
        if ok:
            reasons.append(f'user_id matched target: {expected_user_id}')
        else:
            reasons.append(f'user_id mismatch: current={current_user_id}, expected={expected_user_id}')
        if expected_profile_name:
            normalized_expected = expected_profile_name.lower().strip()
            normalized_current = str(current_profile_name or '').lower().strip()
            if normalized_current:
                if normalized_expected == normalized_current or normalized_expected in normalized_current or normalized_current in normalized_expected:
                    reasons.append(f'profile_name matched target: {current_profile_name}')
                else:
                    reasons.append(f'profile_name observed: {current_profile_name}')
        print(
            f"🔎 Target profile verification: ok={ok}, current_user_id={current_user_id}, current_profile_name={current_profile_name}, reasons={reasons}"
        )
        return {
            'ok': ok,
            'current_user_id': current_user_id,
            'current_profile_name': current_profile_name,
            'reasons': reasons,
        }

    def _verify_post_switch_runtime_ready_soft(self):
        result = self._verify_profile_picker_screen_result()
        if result and result.ok:
            print("✅ Post-switch runtime-ready state observed via settings/profile-picker surface")
            return True
        print("ℹ️ Post-switch runtime-ready state not confirmed from current visible surface")
        return False

    def _get_current_user_id(self):
        """Get the current active user ID via ADB"""
        try:
            result = subprocess.run([
                "adb", "-s", self.device_id, "shell", 
                "am", "get-current-user"
            ], capture_output=True, text=True)
            
            if result.returncode == 0:
                current_user_id = result.stdout.strip()
                return current_user_id
            else:
                print(f"❌ Failed to get current user ID: {result.stderr}")
                return None
                
        except Exception as e:
            print(f"❌ Error getting current user ID: {e}")
            return None

    def _get_user_id_by_profile_name(self, profile_name):
        """Get user ID by profile name from actual device profiles"""
        try:
            # Query device for all user profiles
            result = subprocess.run([
                "adb", "-s", self.device_id, "shell", "pm", "list", "users"
            ], capture_output=True, text=True, timeout=10)
            
            if result.returncode != 0:
                print(f"❌ Failed to list users: {result.stderr}")
                return None
                
            lines = result.stdout.strip().split('\n')
            profile_name_lower = profile_name.lower().strip()
            
            for line in lines:
                if 'UserInfo{' in line:
                    # Parse UserInfo{id:name:flags} format
                    start = line.find('UserInfo{') + 9
                    end = line.find('}', start)
                    if end == -1:
                        continue
                        
                    profile_info = line[start:end]
                    parts = profile_info.split(':')
                    
                    if len(parts) >= 2:
                        user_id = parts[0]
                        # Handle profile names properly - some might have colons
                        profile_name_raw = ':'.join(parts[1:]) if len(parts) > 2 else parts[1]
                        device_profile_name = profile_name_raw.split(':')[0] if ':' in profile_name_raw else profile_name_raw
                        
                        # Clean up device profile name and normalize
                        device_profile_name_clean = device_profile_name.lower().strip()
                        
                        # Handle common name variations
                        if device_profile_name_clean in ['primary']:
                            device_profile_name_clean = 'owner'
                            
                        print(f"📱 Found device profile: ID {user_id} = '{device_profile_name}' (normalized: '{device_profile_name_clean}')")
                        
                        # Match profile names (case insensitive)
                        if (profile_name_lower == device_profile_name_clean or 
                            profile_name_lower in device_profile_name_clean or
                            device_profile_name_clean in profile_name_lower):
                            print(f"✅ Profile name match: '{profile_name}' matches device profile '{device_profile_name}' (ID: {user_id})")
                            return user_id
                            
            print(f"❌ Profile '{profile_name}' not found in device profiles")
            return None
            
        except Exception as e:
            print(f"❌ Error getting user ID by profile name: {e}")
            return None

    def _verify_profile_switch(self, expected_user_id, max_attempts=10, delay=3):
        """Verify that the profile switch actually worked
        
        GrapheneOS profile switches can take 15-30 seconds to fully complete.
        We use 10 attempts × 3 second delay = 30 second max wait.
        """
        print(f"🔍 Verifying profile switch to user ID: {expected_user_id}")
        
        # Initial wait - GrapheneOS needs time to start the switch
        print("⏳ Waiting 5s for GrapheneOS to initiate profile switch...")
        time.sleep(5)
        
        for attempt in range(max_attempts):
            current_user_id = self._get_current_user_id()
            
            if current_user_id == expected_user_id:
                print(f"✅ Profile switch VERIFIED! Current user ID: {current_user_id}")
                return True
            
            print(f"⚠️ Attempt {attempt + 1}/{max_attempts}: Expected user {expected_user_id}, got {current_user_id}")
            time.sleep(delay)
        
        print(f"❌ Profile switch FAILED verification after {max_attempts} attempts (30+ seconds)!")
        return False

    def _switch_profile_direct_adb(self, profile_name="Work profile"):
        """Switch to profile using direct ADB commands with verification - no UI navigation needed"""
        try:
            print(f"🔄 Using direct ADB profile switch to {profile_name} (no UI navigation)...")
            
            # CRITICAL: Validate device connection before switching
            if not self._validate_device_connection():
                print(f"❌ Cannot switch profiles - device {self.device_id} not connected")
                return False
            
            # OPTIMIZED: Get user ID from dashboard's cached profile data if available
            user_id = None
            
            # FIRST: Check if profile_name is actually already a user ID (numeric string like "10", "20")
            if profile_name and profile_name.isdigit():
                print(f"📋 profile_name '{profile_name}' is already a user ID, using directly")
                user_id = profile_name
            elif self.dashboard and hasattr(self.dashboard, 'profiles') and self.dashboard.profiles:
                print(f"📋 Using cached profile data from dashboard (no ADB query needed)")
                for profile_id, profile_data in self.dashboard.profiles.items():
                    if profile_data['name'].lower().strip() == profile_name.lower().strip():
                        user_id = profile_id
                        print(f"✅ Found user ID {user_id} for profile '{profile_name}' in cached data")
                        break
            
            # Fallback: Query device only if dashboard data not available
            if not user_id:
                print(f"⚠️ Dashboard profile data not available, querying device...")
                user_id = self._get_user_id_by_profile_name(profile_name)
                
            # Last resort: Hardcoded fallback
            if not user_id:
                print(f"⚠️ Could not find profile '{profile_name}' anywhere, using fallback mapping")
                profile_map = {
                    "work profile": "10", "work": "10", "personal": "0", "owner": "0", "primary": "0"
                }
                profile_key = profile_name.lower().strip()
                user_id = profile_map.get(profile_key, "10")
            
            print(f"🎯 Switching to user ID: {user_id} for profile: {profile_name}")

            # First check current user/profile state
            pre_switch_state = self._log_current_profile_state_soft()
            current_user_id = pre_switch_state.get('user_id')
            if current_user_id == user_id:
                print(f"✅ Already on target profile! Current user ID: {current_user_id}")
                self._verify_target_profile_active_soft(user_id, profile_name)
                return True

            print(f"📱 Current user ID: {current_user_id} → Target user ID: {user_id}")
            
            # Method 1: Direct user switch command
            print("🔄 Attempting direct switch-user command...")
            result = subprocess.run([
                "adb", "-s", self.device_id, "shell", 
                "am", "switch-user", user_id
            ], capture_output=True, text=True)
            
            if result.returncode == 0:
                print(f"✅ ADB switch-user command executed successfully")
                # GrapheneOS needs more time - wait for screen to transition
                print("⏳ Waiting 8s for GrapheneOS profile screen transition...")
                time.sleep(8)
                
                # Verify the switch worked
                if self._verify_profile_switch(user_id):
                    self._verify_target_profile_active_soft(user_id, profile_name)
                    self._verify_post_switch_runtime_ready_soft()
                    return True
            
            print("⚠️ Direct switch-user failed verification, trying activity manager...")
            
            # Method 2: Activity manager approach
            print("🔄 Attempting start-user + switch-user sequence...")
            result = subprocess.run([
                "adb", "-s", self.device_id, "shell", 
                "am", "start-user", user_id
            ], capture_output=True, text=True)
            
            if result.returncode == 0:
                print(f"✅ Profile started via start-user: {profile_name} (User ID: {user_id})")
                
                # Now switch to it
                time.sleep(2)
                result2 = subprocess.run([
                    "adb", "-s", self.device_id, "shell", 
                    "am", "switch-user", user_id
                ], capture_output=True, text=True)
                
                if result2.returncode == 0:
                    print(f"✅ Switch command executed successfully!")
                    time.sleep(3)
                    
                    # Verify the switch worked
                    if self._verify_profile_switch(user_id):
                        self._verify_target_profile_active_soft(user_id, profile_name)
                        self._verify_post_switch_runtime_ready_soft()
                        return True
            
            # Method 3: Force switch with stop-user first
            print("🔄 Attempting force switch (stop current user first)...")
            if current_user_id and current_user_id != "0":  # Don't stop owner user
                subprocess.run([
                    "adb", "-s", self.device_id, "shell", 
                    "am", "stop-user", current_user_id
                ], capture_output=True, text=True)
                time.sleep(2)
            
            # Start and switch to target user
            subprocess.run([
                "adb", "-s", self.device_id, "shell", 
                "am", "start-user", user_id
            ], capture_output=True, text=True)
            time.sleep(2)
            
            result3 = subprocess.run([
                "adb", "-s", self.device_id, "shell", 
                "am", "switch-user", user_id
            ], capture_output=True, text=True)
            
            if result3.returncode == 0:
                time.sleep(3)
                if self._verify_profile_switch(user_id):
                    self._verify_target_profile_active_soft(user_id, profile_name)
                    self._verify_post_switch_runtime_ready_soft()
                    return True
            
            print("❌ All direct ADB profile switch methods failed verification")
            return False
            
        except Exception as e:
            print(f"❌ Failed to switch profile via ADB: {e}")
            return False
    
    def get_current_profile(self):
        """Get the current active profile name"""
        try:
            current_user_id = self._get_current_user_id()
            if current_user_id is None:
                return None
            
            # OPTIMIZED: Get profile name from dashboard's cached data if available
            profile_name = None
            if self.dashboard and hasattr(self.dashboard, 'profiles') and self.dashboard.profiles:
                if current_user_id in self.dashboard.profiles:
                    profile_name = self.dashboard.profiles[current_user_id]['name']
                    print(f"📋 Using cached profile name: {profile_name} (User ID: {current_user_id})")
                    return profile_name
            
            # Fallback: Query device only if dashboard data not available
            if not profile_name:
                print(f"⚠️ Dashboard profile data not available, querying device...")
                profile_name = self._get_profile_name_by_user_id(current_user_id)
                if profile_name:
                    print(f"📱 Current profile: {profile_name} (User ID: {current_user_id})")
                    return profile_name
            
            # Last resort: Generic name
            fallback_name = f"User {current_user_id}"
            print(f"📱 Current profile: {fallback_name} (User ID: {current_user_id})")
            return fallback_name
            
        except Exception as e:
            print(f"❌ Error getting current profile: {e}")
            return None

    def _get_profile_name_by_user_id(self, user_id):
        """Get profile name by user ID from actual device profiles"""
        try:
            # Query device for all user profiles
            result = subprocess.run([
                "adb", "-s", self.device_id, "shell", "pm", "list", "users"
            ], capture_output=True, text=True, timeout=10)
            
            if result.returncode != 0:
                print(f"❌ Failed to list users: {result.stderr}")
                return None
                
            lines = result.stdout.strip().split('\n')
            
            for line in lines:
                if 'UserInfo{' in line:
                    # Parse UserInfo{id:name:flags} format
                    start = line.find('UserInfo{') + 9
                    end = line.find('}', start)
                    if end == -1:
                        continue
                        
                    profile_info = line[start:end]
                    parts = profile_info.split(':')
                    
                    if len(parts) >= 2:
                        device_user_id = parts[0]
                        # Handle profile names properly - some might have colons
                        profile_name_raw = ':'.join(parts[1:]) if len(parts) > 2 else parts[1]
                        device_profile_name = profile_name_raw.split(':')[0] if ':' in profile_name_raw else profile_name_raw
                        
                        if device_user_id == user_id:
                            # Replace "Primary" with "Owner" for clarity
                            if device_profile_name.lower().strip() in ['primary']:
                                device_profile_name = 'Owner'
                            print(f"✅ Found profile name for user ID {user_id}: '{device_profile_name}'")
                            return device_profile_name
                            
            print(f"❌ Profile name not found for user ID {user_id}")
            return None
            
        except Exception as e:
            print(f"❌ Error getting profile name by user ID: {e}")
            return None

    def list_available_profiles(self):
        """List all available user profiles via ADB"""
        try:
            print("📋 Listing available user profiles...")
            
            result = subprocess.run([
                "adb", "-s", self.device_id, "shell", 
                "pm", "list", "users"
            ], capture_output=True, text=True)
            
            if result.returncode == 0:
                print("👥 Available user profiles:")
                print(result.stdout)
                return result.stdout
            else:
                print("❌ Failed to list user profiles")
                return None
                
        except Exception as e:
            print(f"❌ Error listing profiles: {e}")
            return None

    def rename_profile(self, current_name, new_name):
        """Rename a GrapheneOS profile via Settings UI
        
        Args:
            current_name: Current profile name (e.g., 'Triple Fail')
            new_name: New profile name (e.g., 'Profile 1')
        
        Returns:
            bool: True if rename successful, False otherwise
        """
        try:
            print(f"✏️ RENAMING PROFILE: '{current_name}' → '{new_name}'")
            print("=" * 50)
            
            # Step 1: Get user ID for the profile we want to rename
            user_id = self._get_user_id_by_profile_name(current_name)
            if not user_id:
                print(f"❌ Profile '{current_name}' not found on device")
                return False
            
            print(f"📱 Found profile: User ID {user_id}")
            
            # Step 1.5: Switch TO the profile we're renaming (you can only rename your own profile)
            current_user = self._get_current_user_id()
            if current_user != user_id:
                # Enable airplane mode before switching
                print("✈️ Enabling airplane mode before profile switch...")
                self._enable_airplane_mode_direct_adb()
                time.sleep(2)
                
                print(f"🔄 Switching to profile '{current_name}' (User {user_id}) to rename it...")
                subprocess.run([
                    "adb", "-s", self.device_id, "shell",
                    "am", "switch-user", user_id
                ], capture_output=True, text=True)
                time.sleep(5)  # Wait for profile switch
                print(f"✅ Switched to profile '{current_name}'")
                
                # Disable airplane mode after switching
                print("📶 Disabling airplane mode after profile switch...")
                self._disable_airplane_mode_direct_adb()
                time.sleep(3)
            else:
                print(f"✅ Already on profile '{current_name}' - ready to rename")
            
            # Step 2: Open Settings directly to Multiple Users section
            print("⚙️ Opening Multiple Users settings...")
            result = subprocess.run([
                "adb", "-s", self.device_id, "shell",
                "am", "start", "-a", "android.settings.USER_SETTINGS"
            ], capture_output=True, text=True)
            
            if result.returncode != 0:
                # Fallback to main settings
                subprocess.run([
                    "adb", "-s", self.device_id, "shell",
                    "am", "start", "-n", "com.android.settings/.Settings"
                ], capture_output=True, text=True)
                time.sleep(2)
                
                # Navigate to Multiple Users
                print("📜 Navigating to Multiple Users...")
                subprocess.run([
                    "adb", "-s", self.device_id, "shell",
                    "input", "text", "'Multiple users'"
                ], capture_output=True, text=True)
                time.sleep(1)
                subprocess.run([
                    "adb", "-s", self.device_id, "shell",
                    "input", "keyevent", "66"  # Enter
                ], capture_output=True, text=True)
            
            time.sleep(2)
            
            # Step 3: Find and click the profile to rename
            print(f"🔍 Looking for profile '{current_name}'...")
            
            # Get UI dump to find the profile — /data/local/tmp works across all GrapheneOS profiles
            dump_file = "/data/local/tmp/sp_rename_dump.xml"
            subprocess.run([
                "adb", "-s", self.device_id, "shell",
                "uiautomator", "dump", dump_file
            ], capture_output=True, text=True, timeout=10)
            
            # Pull and parse the dump
            result = subprocess.run([
                "adb", "-s", self.device_id, "shell", "cat", dump_file
            ], capture_output=True, text=True, timeout=10)
            
            ui_xml = result.stdout
            
            # Find the profile name in the UI
            import re
            
            # GrapheneOS shows current profile as "You (ProfileName)" - look for that first
            you_pattern = rf'text="You \({re.escape(current_name)}\)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
            match = re.search(you_pattern, ui_xml, re.IGNORECASE)
            
            if not match:
                # Try just "You (" prefix for partial match
                you_partial = r'text="You \([^"]+\)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
                match = re.search(you_partial, ui_xml)
            
            if not match:
                # Fallback: Look for exact profile name
                pattern = rf'text="{re.escape(current_name)}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
                match = re.search(pattern, ui_xml)
            
            if not match:
                # Try partial match
                pattern = rf'text="[^"]*{re.escape(current_name)}[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
                match = re.search(pattern, ui_xml, re.IGNORECASE)
            
            if match:
                x1, y1, x2, y2 = map(int, match.groups())
                center_x = (x1 + x2) // 2
                center_y = (y1 + y2) // 2
                
                print(f"📍 Found profile at ({center_x}, {center_y})")
                
                # Tap the profile to open edit screen
                subprocess.run([
                    "adb", "-s", self.device_id, "shell",
                    "input", "tap", str(center_x), str(center_y)
                ], capture_output=True, text=True)
                time.sleep(2)
            else:
                print(f"⚠️ Could not find profile '{current_name}' in UI, trying scroll...")
                # Scroll down and retry
                subprocess.run([
                    "adb", "-s", self.device_id, "shell",
                    "input", "swipe", "540", "1500", "540", "800", "500"
                ], capture_output=True, text=True)
                time.sleep(1)
                # Try tap at a default location for profiles list
                # This is a fallback
                print("❌ Profile not found in UI. Manual intervention may be required.")
                return False
            
            # Step 4: Find and edit the name field in the dialog
            print("✏️ Looking for name edit field...")
            time.sleep(1)
            
            # Dump UI again on profile edit dialog
            subprocess.run([
                "adb", "-s", self.device_id, "shell",
                "uiautomator", "dump", dump_file
            ], capture_output=True, text=True, timeout=10)
            
            result = subprocess.run([
                "adb", "-s", self.device_id, "shell", "cat", dump_file
            ], capture_output=True, text=True, timeout=10)
            
            ui_xml = result.stdout
            
            # Look for the user_name EditText (GrapheneOS specific ID)
            user_name_pattern = r'resource-id="com\.android\.settings:id/user_name"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
            edit_match = re.search(user_name_pattern, ui_xml)
            
            if not edit_match:
                # Fallback: generic EditText
                edit_match = re.search(r'class="android\.widget\.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', ui_xml)
            
            if edit_match:
                x1, y1, x2, y2 = map(int, edit_match.groups())
                center_x = (x1 + x2) // 2
                center_y = (y1 + y2) // 2
                
                print(f"📍 Found name field at ({center_x}, {center_y})")
                
                # Tap the field to focus
                subprocess.run([
                    "adb", "-s", self.device_id, "shell",
                    "input", "tap", str(center_x), str(center_y)
                ], capture_output=True, text=True)
                time.sleep(0.5)
                
                # Move cursor to end first
                subprocess.run([
                    "adb", "-s", self.device_id, "shell",
                    "input", "keyevent", "123"  # KEYCODE_MOVE_END
                ], capture_output=True, text=True)
                time.sleep(0.2)
                
                # Delete all existing text by holding backspace (delete 50 chars to be safe)
                for _ in range(50):
                    subprocess.run([
                        "adb", "-s", self.device_id, "shell",
                        "input", "keyevent", "67"  # KEYCODE_DEL
                    ], capture_output=True, text=True)
                time.sleep(0.3)
                
                # Type new name (escape special chars for shell)
                safe_name = new_name.replace(" ", "%s").replace("'", "").replace('"', "").replace("&", "and")
                subprocess.run([
                    "adb", "-s", self.device_id, "shell",
                    "input", "text", safe_name
                ], capture_output=True, text=True)
                time.sleep(0.5)
                
                print(f"✅ Entered new name: '{new_name}'")
            else:
                print("❌ Could not find name edit field in dialog")
                return False
            
            # Step 5: Click OK button
            print("💾 Clicking OK to save...")
            
            # Hide keyboard first (press Back)
            subprocess.run([
                "adb", "-s", self.device_id, "shell",
                "input", "keyevent", "4"  # KEYCODE_BACK
            ], capture_output=True, text=True)
            time.sleep(1)
            
            # Re-dump UI after typing (keyboard may have changed layout)
            subprocess.run([
                "adb", "-s", self.device_id, "shell",
                "uiautomator", "dump", dump_file
            ], capture_output=True, text=True, timeout=10)
            
            result = subprocess.run([
                "adb", "-s", self.device_id, "shell", "cat", dump_file
            ], capture_output=True, text=True, timeout=10)
            
            ui_xml = result.stdout
            
            # Look for OK button by ID
            ok_pattern = r'resource-id="com\.android\.settings:id/button_ok"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
            ok_match = re.search(ok_pattern, ui_xml)
            
            if not ok_match:
                # Fallback: Look for OK text button
                ok_match = re.search(r'text="OK"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', ui_xml)
            
            if ok_match:
                x1, y1, x2, y2 = map(int, ok_match.groups())
                center_x = (x1 + x2) // 2
                center_y = (y1 + y2) // 2
                
                subprocess.run([
                    "adb", "-s", self.device_id, "shell",
                    "input", "tap", str(center_x), str(center_y)
                ], capture_output=True, text=True)
                print("✅ Saved changes!")
            else:
                # Fallback: press Enter to save
                print("⚠️ OK button not found, pressing Enter...")
                subprocess.run([
                    "adb", "-s", self.device_id, "shell",
                    "input", "keyevent", "66"  # Enter
                ], capture_output=True, text=True)
            
            time.sleep(2)
            
            # Step 6: Verify the rename worked
            print("🔍 Verifying rename...")
            new_user_id = self._get_user_id_by_profile_name(new_name)
            
            if new_user_id == user_id:
                print(f"✅ SUCCESS: Profile renamed from '{current_name}' to '{new_name}'!")
                return True
            else:
                print(f"⚠️ Rename may have failed - could not verify new name")
                print("   Check the device manually")
                return False
            
        except Exception as e:
            print(f"❌ Rename profile failed: {e}")
            return False

    def rename_profiles_batch(self, renames):
        """Rename multiple profiles at once
        
        Args:
            renames: List of tuples [(current_name, new_name), ...]
        
        Returns:
            dict: Results {profile_name: success/fail}
        """
        results = {}
        print(f"✏️ BATCH RENAME: {len(renames)} profiles")
        print("=" * 50)
        
        for current_name, new_name in renames:
            success = self.rename_profile(current_name, new_name)
            results[current_name] = "✅ Success" if success else "❌ Failed"
            time.sleep(2)  # Pause between renames
        
        print("\n📋 BATCH RENAME RESULTS:")
        for name, result in results.items():
            print(f"  {name}: {result}")
        
        return results

    def switch_to_profile(self, profile_name="Work profile"):
        """Switch to specified profile using direct ADB or fallback to UI"""
        try:
            # Try direct ADB first (no UI navigation needed)
            if self._switch_profile_direct_adb(profile_name):
                return True
                
            print("⚠️ Direct ADB profile switch failed, falling back to UI navigation...")
            
            # Fallback to UI navigation
            print(f"🔄 UI Fallback: Switching to {profile_name}...")
            
            # Try to find the profile by name
            profile_selectors = [
                f"//android.widget.TextView[@text='{profile_name}']",
                f"//*[contains(@text, '{profile_name}')]",
                "//android.widget.TextView[contains(@text, 'Work')]",
                "//android.widget.TextView[contains(@text, 'Profile')]",
            ]
            
            for selector in profile_selectors:
                try:
                    pre_picker_result = self._verify_profile_picker_screen_result()
                    if pre_picker_result:
                        print(f"🔎 Pre-switch picker state before tap: {pre_picker_result.screen_type} ({pre_picker_result.confidence})")
                    profile_element = self.driver.find_element(AppiumBy.XPATH, selector)
                    profile_element.click()
                    time.sleep(3)
                    target_result = self._verify_target_profile_active_soft(self._get_user_id_by_profile_name(profile_name), profile_name)
                    self._verify_post_switch_runtime_ready_soft()
                    if target_result.get('ok'):
                        print(f"✅ UI Fallback: Switched to {profile_name}! (verified target user)")
                    else:
                        print(f"✅ UI Fallback: Switched to {profile_name}! (tap completed, target not fully verified)")
                    return True
                except:
                    continue
            
            print("❌ Could not switch profile via UI either")
            return False
            
        except Exception as e:
            print(f"❌ Switch profile failed: {e}")
            if self._handle_appium_error(e, "switch_to_profile"):
                return True
            return False
    
    def secure_profile_switch(self, profile_name="Work profile"):
        """Secure profile switch with airplane mode + VPN (alias for complete workflow)"""
        print(f"🔒 SECURE PROFILE SWITCH to: {profile_name}")
        return self.complete_profile_switch_workflow(profile_name)
    
    def _enable_airplane_mode_direct_adb(self):
        """Enable airplane mode using direct ADB commands - no coordinates needed"""
        try:
            print("✈️ Using direct ADB airplane mode enable (no coordinates)...")
            
            # Method 1: Direct settings command
            result = subprocess.run([
                "adb", "-s", self.device_id, "shell", 
                "settings", "put", "global", "airplane_mode_on", "1"
            ], capture_output=True, text=True)
            
            if result.returncode == 0:
                print("✅ Airplane mode enabled via ADB settings")
                # Also trigger the radio change
                subprocess.run([
                    "adb", "-s", self.device_id, "shell", 
                    "am", "broadcast", "-a", "android.intent.action.AIRPLANE_MODE", 
                    "--ez", "state", "true"
                ], capture_output=True)
                time.sleep(3)
                return True
            
            print("⚠️ ADB settings failed, trying toggle method...")
            
            # Method 2: Toggle button command
            result = subprocess.run([
                "adb", "-s", self.device_id, "shell", 
                "cmd", "connectivity", "airplane-mode", "enable"
            ], capture_output=True, text=True)
            
            if result.returncode == 0:
                print("✅ Airplane mode enabled via connectivity command")
                time.sleep(3)
                return True
                
            print("❌ All direct ADB methods failed")
            return False
            
        except Exception as e:
            print(f"❌ Failed to enable airplane mode via ADB: {e}")
            return False
    
    def _disable_airplane_mode_direct_adb(self):
        """Disable airplane mode using direct ADB commands - no coordinates needed"""
        try:
            print("📶 Using direct ADB airplane mode disable (no coordinates)...")
            
            # Method 1: Direct settings command
            result = subprocess.run([
                "adb", "-s", self.device_id, "shell", 
                "settings", "put", "global", "airplane_mode_on", "0"
            ], capture_output=True, text=True)
            
            if result.returncode == 0:
                print("✅ Airplane mode disabled via ADB settings")
                # Also trigger the radio change
                subprocess.run([
                    "adb", "-s", self.device_id, "shell", 
                    "am", "broadcast", "-a", "android.intent.action.AIRPLANE_MODE", 
                    "--ez", "state", "false"
                ], capture_output=True)
                time.sleep(3)
                return True
            
            print("⚠️ ADB settings failed, trying toggle method...")
            
            # Method 2: Toggle button command
            result = subprocess.run([
                "adb", "-s", self.device_id, "shell", 
                "cmd", "connectivity", "airplane-mode", "disable"
            ], capture_output=True, text=True)
            
            if result.returncode == 0:
                print("✅ Airplane mode disabled via connectivity command")
                time.sleep(3)
                return True
                
            print("❌ All direct ADB methods failed")
            return False
            
        except Exception as e:
            print(f"❌ Failed to disable airplane mode via ADB: {e}")
            return False

    def _enable_airplane_mode(self):
        """Enable airplane mode using direct ADB (no coordinates) or fallback methods"""
        try:
            # Try direct ADB first (no coordinates needed)
            if self._enable_airplane_mode_direct_adb():
                return True
                
            # Fallback to dashboard if available
            if self.dashboard and hasattr(self.dashboard, '_airplane_enable_bg'):
                print("✈️ Fallback: Using dashboard airplane mode enable...")
                self.dashboard._airplane_enable_bg()
                time.sleep(3)
                return True
                
            # Last fallback to controller
            elif hasattr(self, 'airplane_controller') and self.airplane_controller:
                print("✈️ Last fallback: Using airplane mode controller...")
                return self.airplane_controller.enable_airplane_mode()
            else:
                print("❌ No airplane mode method available")
                return False
        except Exception as e:
            print(f"❌ Failed to enable airplane mode: {e}")
            return False
    
    def _disable_airplane_mode(self):
        """Disable airplane mode using direct ADB (no coordinates) or fallback methods"""
        try:
            # Try direct ADB first (no coordinates needed)
            if self._disable_airplane_mode_direct_adb():
                return True
                
            # Fallback to dashboard if available
            if self.dashboard and hasattr(self.dashboard, '_airplane_disable_bg'):
                print("📶 Fallback: Using dashboard airplane mode disable...")
                self.dashboard._airplane_disable_bg()
                time.sleep(3)
                return True
                
            # Last fallback to controller
            elif hasattr(self, 'airplane_controller') and self.airplane_controller:
                print("📶 Last fallback: Using airplane mode controller...")
                return self.airplane_controller.disable_airplane_mode()
            else:
                print("❌ No airplane mode method available")
                return False
        except Exception as e:
            print(f"❌ Failed to disable airplane mode: {e}")
            return False

    def complete_profile_switch_workflow(self, profile_name="Work profile"):
        """Complete workflow: Airplane Mode ON → Profile Switch → Airplane Mode OFF → VPN ON"""
        print("👤 COMPLETE PROFILE SWITCH WORKFLOW")
        
        # Discord notification
        if DISCORD_AVAILABLE:
            get_notifier().profile_switch(str(profile_name), int(profile_name) if str(profile_name).isdigit() else 0)
        print("=" * 50)
        
        try:
            # Step 1: Enable Airplane Mode (using header-based approach)
            print("✈️ Step 1: Enabling Airplane Mode via header...")
            if not self._enable_airplane_mode():
                print("❌ Failed to enable airplane mode")
                return False
            
            # Step 2: Wait for network to settle
            print("⏳ Step 2: Waiting for network to settle...")
            time.sleep(5)
            
            # Step 3: Switch profile directly via ADB (no UI navigation needed)
            print("📱 Step 3: Switching profile via direct ADB...")
            if not self.switch_to_profile(profile_name):
                print("❌ Failed to switch profile")
                return False
            
            # Step 4: Wait for profile switch to complete
            print("⏳ Step 4: Waiting for profile switch to complete...")
            time.sleep(8)
            
            # Step 5: Disable Airplane Mode (using direct ADB)
            print("📶 Step 5: Disabling Airplane Mode via direct ADB...")
            if not self._disable_airplane_mode():
                print("❌ Failed to disable airplane mode")
                return False
            
            # Step 6: Wait for network to reconnect
            print("⏳ Step 6: Waiting for network reconnection...")
            time.sleep(10)
            
            # Step 7: Connect VPN
            print("🔒 Step 7: Connecting VPN...")
            if not self.vpn_connector.connect_to_us_streaming():
                print("❌ Failed to connect VPN")
                return False
            
            print("🎉 SUCCESS: Complete profile switch workflow completed!")
            print("✅ Profile switched to:", profile_name)
            print("✅ Airplane mode: OFF")
            print("✅ VPN: Connected to US Streaming")
            
            # Discord success notification
            if DISCORD_AVAILABLE:
                get_notifier().profile_switch_complete(str(profile_name), True)
            
            return True
            
        except Exception as e:
            print(f"❌ Workflow failed: {e}")
            
            # Discord error notification
            if DISCORD_AVAILABLE:
                get_notifier().profile_switch_complete(str(profile_name), False)
            
            return False

def debug_profile_switch():
    """Debug function to test profile switching without full workflow"""
    switcher = GrapheneProfileSwitcher()
    
    print("🔍 PROFILE SWITCH DEBUGGING")
    print("=" * 40)
    
    # Check current profile
    current = switcher.get_current_profile()
    print(f"Current profile: {current}")
    
    # List available profiles
    switcher.list_available_profiles()
    
    # Test profile switch
    profile_name = input("\nEnter profile name to switch to (or Enter for 'Work profile'): ").strip()
    if not profile_name:
        profile_name = "Work profile"
    
    print(f"\n🔄 Testing switch to: {profile_name}")
    success = switcher._switch_profile_direct_adb(profile_name)
    
    if success:
        print("✅ Profile switch test PASSED!")
        # Verify final state
        final_profile = switcher.get_current_profile()
        print(f"Final profile: {final_profile}")
    else:
        print("❌ Profile switch test FAILED!")

if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1 and sys.argv[1] == "--debug":
        debug_profile_switch()
        sys.exit()
    
    switcher = GrapheneProfileSwitcher()
    
    print("👤 GRAPHENE PROFILE SWITCHER")
    print("1 - Switch to Work profile (full workflow)")
    print("2 - Switch to Personal profile (full workflow)")
    print("3 - Custom profile name")
    print("4 - Debug mode (test profile switch only)")
    print("5 - Check current profile")
    
    choice = input("Choose option (1-5): ").strip()
    
    if choice == "1":
        switcher.complete_profile_switch_workflow("Work profile")
    elif choice == "2":
        switcher.complete_profile_switch_workflow("Personal")
    elif choice == "3":
        profile_name = input("Enter profile name: ").strip()
        switcher.complete_profile_switch_workflow(profile_name)
    elif choice == "4":
        debug_profile_switch()
    elif choice == "5":
        current = switcher.get_current_profile()
        if current:
            print(f"✅ Current profile: {current}")
        else:
            print("❌ Could not determine current profile")
    else:
        print("❌ Invalid choice")