#!/usr/bin/env python3
"""
✈️ AIRPLANE MODE CONTROL MODULE
Turn airplane mode on/off via quick settings
"""

from appium import webdriver
from appium.options.android import UiAutomator2Options
import time
import subprocess
import os

# Import crash recovery module
try:
    from appium_crash_recovery import auto_recover_from_crash
    CRASH_RECOVERY_AVAILABLE = True
except ImportError:
    CRASH_RECOVERY_AVAILABLE = False
    print("⚠️ Crash recovery module not available")

# Import centralized driver manager
try:
    from modules.driver_manager import get_shared_driver, is_crash_error
    DRIVER_MANAGER_AVAILABLE = True
except ImportError:
    try:
        from driver_manager import get_shared_driver, is_crash_error
        DRIVER_MANAGER_AVAILABLE = True
    except ImportError:
        DRIVER_MANAGER_AVAILABLE = False

# Import settings selectors
try:
    from modules.ig_selectors import AndroidSettingsSelectors
    SETTINGS_SELECTORS_AVAILABLE = True
except ImportError:
    SETTINGS_SELECTORS_AVAILABLE = False
    print("⚠️ Android Settings selectors not available")

# Import Appium By for XPath
try:
    from selenium.webdriver.common.by import By
    from appium.webdriver.common.appiumby import AppiumBy
except ImportError:
    pass

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

class AirplaneModeController:
    def __init__(self, device_id="1A121FDF60082H"):
        self.device_id = device_id
        self.driver = None
        
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
        # Sanitize ANDROID_HOME if set (fix for leading space issue)
        if 'ANDROID_HOME' in os.environ:
            original_home = os.environ['ANDROID_HOME']
            if original_home.startswith(' ') or original_home.endswith(' '):
                print(f"⚠️ Detected whitespace in ANDROID_HOME, fixing: '{original_home}' -> '{original_home.strip()}'")
                os.environ['ANDROID_HOME'] = original_home.strip()

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
            # Try crash recovery
            if self._handle_appium_error(e, "connect"):
                return True
            return False
    
    def disconnect(self):
        if self.driver:
            self.driver.quit()
            print("🔄 Disconnected")
    
    def open_quick_settings(self):
        """Open quick settings panel"""
        try:
            print("⚙️ Opening quick settings...")
            
            # Swipe down from top to open notifications
            self.driver.swipe(540, 50, 540, 800, 500)
            time.sleep(1)
            
            # Swipe down again to open full quick settings
            self.driver.swipe(540, 300, 540, 800, 500)
            time.sleep(2)
            
            print("✅ Quick settings opened!")
            return True
            
        except Exception as e:
            print(f"❌ Failed to open quick settings: {e}")
            if self._handle_appium_error(e, "open_quick_settings"):
                return True
            return False
    
    def find_internet_button(self):
        """Find and tap internet/wifi button (where airplane mode is located)"""
        try:
            print("🌐 Looking for Internet button (contains airplane mode)...")
            
            # Internet button coordinates in quick settings (usually top-left area)
            internet_coords = [
                (130, 520),    # Top left - typical internet button position
                (270, 520),    # Top center-left
                (130, 650),    # Second row left
                (270, 650),    # Second row center-left
            ]
            
            for coord in internet_coords:
                try:
                    print(f"🎯 Trying Internet button at {coord}")
                    self.driver.tap([coord])
                    time.sleep(2)
                    print("✅ Internet button tapped!")
                    return True
                except Exception as e:
                    print(f"⚠️ Internet button failed at {coord}: {e}")
                    continue
            
            print("❌ Could not find Internet button")
            return False
            
        except Exception as e:
            print(f"❌ Find internet button failed: {e}")
            if self._handle_appium_error(e, "find_internet_button"):
                return True
            return False
    
    def toggle_airplane_mode(self):
        """Toggle airplane mode on/off using Settings app (more reliable than quick settings)"""
        try:
            print("✈️ Toggling airplane mode via Settings app...")
            
            # Open Settings to Airplane Mode directly
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "am", "start", 
                 "-a", "android.settings.AIRPLANE_MODE_SETTINGS"],
                capture_output=True, text=True
            )
            time.sleep(2)
            
            # Method 1: Use verified selectors (XPath for switch)
            if SETTINGS_SELECTORS_AVAILABLE:
                try:
                    # Find the switch widget
                    switch = self.driver.find_element(By.XPATH, AndroidSettingsSelectors.AirplaneMode.SWITCH)
                    switch.click()
                    time.sleep(1)
                    print("✅ Airplane mode toggled via switch selector!")
                    return True
                except Exception as e:
                    print(f"⚠️ Switch selector failed: {e}")
                
                # Try clicking the row instead
                try:
                    row = self.driver.find_element(By.XPATH, AndroidSettingsSelectors.AirplaneMode.ROW)
                    row.click()
                    time.sleep(1)
                    print("✅ Airplane mode toggled via row selector!")
                    return True
                except Exception as e:
                    print(f"⚠️ Row selector failed: {e}")
            
            # Method 2: Text-based XPath fallback
            xpath_selectors = [
                "//android.widget.Switch[@resource-id='com.android.settings:id/switchWidget']",
                "//android.widget.LinearLayout[.//android.widget.TextView[@text='Airplane mode']]",
                "//android.widget.TextView[@text='Airplane mode']",
            ]
            
            for selector in xpath_selectors:
                try:
                    element = self.driver.find_element(By.XPATH, selector)
                    element.click()
                    time.sleep(1)
                    print(f"✅ Airplane mode toggled via XPath!")
                    return True
                except:
                    continue
            
            # Method 3: Coordinate fallback (verified from UI dump)
            print("🔄 Falling back to coordinates...")
            # Switch bounds from UI dump: [901,818][1038,944] -> center (969, 881)
            x, y = (969, 881)
            try:
                self.driver.tap([(x, y)])
                time.sleep(1)
                print(f"✅ Airplane mode toggled via coordinates ({x}, {y})!")
                return True
            except Exception as e:
                print(f"⚠️ Coordinate tap failed: {e}")
            
            print("❌ Could not toggle airplane mode")
            return False
            
        except Exception as e:
            print(f"❌ Toggle airplane mode failed: {e}")
            if self._handle_appium_error(e, "toggle_airplane_mode"):
                return True
            return False
    
    def close_quick_settings(self):
        """Close quick settings panel"""
        try:
            print("🔄 Closing quick settings...")
            
            # Swipe up to close or tap outside
            self.driver.swipe(540, 800, 540, 50, 500)
            time.sleep(1)
            
            print("✅ Quick settings closed!")
            return True
            
        except Exception as e:
            print(f"❌ Failed to close quick settings: {e}")
            if self._handle_appium_error(e, "close_quick_settings"):
                return True
            return False
    
    def enable_airplane_mode(self):
        """Complete workflow to enable airplane mode"""
        print("✈️ ENABLING AIRPLANE MODE")
        print("=" * 30)
        
        if not self.connect():
            return False
        
        try:
            # Step 1: Open quick settings
            if not self.open_quick_settings():
                return False
            
            # Step 2: Find internet button
            if not self.find_internet_button():
                return False
            
            # Step 3: Toggle airplane mode
            if not self.toggle_airplane_mode():
                return False
            
            # Step 4: Close settings
            self.close_quick_settings()
            
            print("✅ AIRPLANE MODE ENABLED!")
            return True
            
        finally:
            self.disconnect()
    
    def disable_airplane_mode(self):
        """Complete workflow to disable airplane mode"""
        print("✈️ DISABLING AIRPLANE MODE")
        print("=" * 30)
        
        if not self.connect():
            return False
        
        try:
            # Step 1: Open quick settings
            if not self.open_quick_settings():
                return False
            
            # Step 2: Find internet button
            if not self.find_internet_button():
                return False
            
            # Step 3: Toggle airplane mode
            if not self.toggle_airplane_mode():
                return False
            
            # Step 4: Close settings
            self.close_quick_settings()
            
            print("✅ AIRPLANE MODE DISABLED!")
            return True
            
        finally:
            self.disconnect()
    
    def get_airplane_status(self):
        """Get current airplane mode status using ADB"""
        try:
            print("🔍 Checking airplane mode status...")
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "settings", "get", "global", "airplane_mode_on"],
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if result.returncode == 0:
                status = result.stdout.strip()
                is_on = (status == "1")
                print(f"✅ Airplane mode status: {'ON' if is_on else 'OFF'}")
                return is_on
            else:
                print(f"❌ Failed to get airplane status: {result.stderr}")
                return False
                
        except Exception as e:
            print(f"❌ Error checking airplane status: {e}")
            return False
    
    def airplane_on(self):
        """Enable airplane mode using simple ADB command"""
        try:
            print("✈️ Enabling airplane mode via ADB...")
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "settings", "put", "global", "airplane_mode_on", "1"],
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if result.returncode == 0:
                # Also toggle the radio
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "am", "broadcast", "-a", "android.intent.action.AIRPLANE_MODE", "--ez", "state", "true"],
                    capture_output=True,
                    text=True,
                    timeout=10
                )
                print("✅ Airplane mode enabled via ADB")
                
                # Discord notification
                if DISCORD_AVAILABLE:
                    get_notifier().info("✈️ Airplane Mode", "Airplane mode **ENABLED**")
                
                return True
            else:
                print(f"❌ Failed to enable airplane mode: {result.stderr}")
                return False
                
        except Exception as e:
            print(f"❌ Error enabling airplane mode: {e}")
            return False
    
    def airplane_off(self):
        """Disable airplane mode using simple ADB command"""
        try:
            print("📶 Disabling airplane mode via ADB...")
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "settings", "put", "global", "airplane_mode_on", "0"],
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if result.returncode == 0:
                # Also toggle the radio
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "am", "broadcast", "-a", "android.intent.action.AIRPLANE_MODE", "--ez", "state", "false"],
                    capture_output=True,
                    text=True,
                    timeout=10
                )
                print("✅ Airplane mode disabled via ADB")
                
                # Discord notification
                if DISCORD_AVAILABLE:
                    get_notifier().info("📶 Airplane Mode", "Airplane mode **DISABLED** - Network reconnecting")
                
                return True
            else:
                print(f"❌ Failed to disable airplane mode: {result.stderr}")
                return False
                
        except Exception as e:
            print(f"❌ Error disabling airplane mode: {e}")
            return False
    
    def connect_adb(self):
        """Simple ADB connection check"""
        try:
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "echo", "connected"],
                capture_output=True,
                text=True,
                timeout=5
            )
            return result.returncode == 0
        except:
            return False

if __name__ == "__main__":
    controller = AirplaneModeController()
    
    print("✈️ AIRPLANE MODE CONTROLLER")
    print("1 - Enable airplane mode")
    print("2 - Disable airplane mode")
    
    choice = input("Choose option (1-2): ").strip()
    
    if choice == "1":
        controller.enable_airplane_mode()
    elif choice == "2":
        controller.disable_airplane_mode()
    else:
        print("❌ Invalid choice")