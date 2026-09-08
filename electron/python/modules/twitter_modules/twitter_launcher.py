#!/usr/bin/env python3
"""
🐦 TWITTER/X LAUNCHER MODULE - ROBUST IMPLEMENTATION
Advanced Twitter/X app launcher with crash recovery and validation
Based on proven Instagram launcher patterns
"""

from appium import webdriver
from appium.options.android import UiAutomator2Options
from appium.webdriver.common.appiumby import AppiumBy
import time
import subprocess
import socket

# Import crash recovery module - adjusted for dashboard integration
try:
    from appium_crash_recovery import auto_recover_from_crash
    CRASH_RECOVERY_AVAILABLE = True
except ImportError:
    # Fallback for dashboard environment
    try:
        import sys
        import os
        sys.path.append('/Users/anyro/Documents/TW appium/modules/core_modules')
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

class TwitterLauncher:
    def __init__(self, device_id="1A121FDF60082H", **kwargs):
        self.device_id = device_id
        self.driver = None
        
        # Ignore any extra parameters for compatibility
        if kwargs:
            print(f"⚠️ Launcher ignoring extra parameters: {list(kwargs.keys())}")
        
        # Twitter/X app constants
        self.TWITTER_PACKAGE = "com.twitter.android"
        self.TWITTER_ACTIVITY = "com.twitter.android.StartActivity"
        
        # Recovery settings
        self.max_retries = 3
        self.recovery_delay = 2
        
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
        try:
            print("📱 Initiating ADB connection with pre-flight validation...")
            
            # USE CENTRALIZED DRIVER MANAGER if available
            if DRIVER_MANAGER_AVAILABLE:
                print("📱 Using centralized driver manager...")
                self.driver = get_shared_driver(self.device_id)
                if self.driver:
                    print("✅ ADB Connected via driver manager!")
                    return True
            
            # FALLBACK: Direct connection with pre-flight checks
            # PRE-FLIGHT CHECK 1: Validate Appium server is running
            print("🔍 Step 1/4: Checking Appium server status...")
            if not self._validate_appium_server():
                print("❌ Appium server validation failed")
                return False
            
            # PRE-FLIGHT CHECK 2: Validate device is connected and responsive
            print("🔍 Step 2/4: Validating device connectivity...")
            if not self._validate_device_connectivity():
                print("❌ Device connectivity validation failed") 
                return False
                
            # PRE-FLIGHT CHECK 3: Check port availability
            print("🔍 Step 3/4: Verifying port 4723 accessibility...")
            if not self._validate_port_accessibility():
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
                    
            print("❌ All connection attempts failed")
            return False
            
        except Exception as e:
            print(f"❌ connect_adb failed: {e}")
            return self._handle_appium_error(e, "connect_adb")
    
    def _validate_appium_server(self):
        """Validate that Appium server is running and accessible"""
        try:
            # Try to connect to Appium server port
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(5)
            result = sock.connect_ex(('127.0.0.1', 4723))
            sock.close()
            
            if result == 0:
                print("✅ Appium server is running on port 4723")
                return True
            else:
                print("❌ Appium server not accessible on port 4723")
                return False
                
        except Exception as e:
            print(f"❌ Appium server validation error: {e}")
            return False
    
    def _validate_device_connectivity(self):
        """Validate device is connected via ADB"""
        try:
            result = subprocess.run(
                ['adb', '-s', self.device_id, 'shell', 'echo', 'device_connected'],
                capture_output=True, text=True, timeout=10
            )
            
            if result.returncode == 0 and 'device_connected' in result.stdout:
                print(f"✅ Device {self.device_id} is connected and responsive")
                return True
            else:
                print(f"❌ Device {self.device_id} not responding")
                return False
                
        except Exception as e:
            print(f"❌ Device connectivity check failed: {e}")
            return False
    
    def _validate_port_accessibility(self):
        """Validate port 4723 is accessible"""
        try:
            # Simple HTTP request to Appium server
            import urllib.request
            response = urllib.request.urlopen('http://127.0.0.1:4723/status', timeout=5)
            if response.getcode() == 200:
                print("✅ Port 4723 is accessible")
                return True
            else:
                print("❌ Port 4723 not responding correctly")
                return False
                
        except Exception as e:
            print(f"❌ Port accessibility check failed: {e}")
            return False
    
    def _validate_connection_health(self):
        """Validate that the WebDriver connection is healthy"""
        try:
            # Try to get device info
            capabilities = self.driver.capabilities
            if capabilities and 'platformName' in capabilities:
                print(f"✅ Connection health check passed - Platform: {capabilities.get('platformName')}")
                return True
            else:
                print("❌ Connection health check failed - no capabilities")
                return False
                
        except Exception as e:
            print(f"❌ Connection health check error: {e}")
            return False
    
    def standard_twitter_init(self):
        """Standard initialization: Back 4x → Launch → Scroll Up → Home Tab"""
        print("🔄 STANDARD TWITTER INITIALIZATION")
        print("📋 Sequence: Back 4x → Launch → Scroll Up → Home Tab → Ready")
        
        try:
            # Step 1: Back 4x to ensure clean state
            print("🔙 Step 1/4: Pressing back 4x to clear any menus/screens...")
            for i in range(4):
                try:
                    self.driver.back()
                    time.sleep(1)
                    print(f"   🔙 Back press {i+1}/4")
                except Exception as e:
                    print(f"   🔙 Back press {i+1}/4 - {e}")
                    pass
            
            # Step 2: Launch Twitter fresh
            print("🚀 Step 2/4: Launching Twitter fresh...")
            self._force_stop_twitter()
            time.sleep(2)
            
            result = subprocess.run([
                'adb', '-s', self.device_id, 'shell', 'monkey', '-p', self.TWITTER_PACKAGE,
                '-c', 'android.intent.category.LAUNCHER', '1'
            ], capture_output=True, text=True, timeout=15)
            
            if result.returncode == 0:
                print("✅ Twitter launched")
                time.sleep(5)
            else:
                print("❌ Twitter launch failed")
                return False
            
            # Step 3: Scroll up slightly to reveal navigation
            print("📜 Step 3/4: Scrolling up slightly to reveal navigation...")
            self.driver.swipe(540, 800, 540, 900, 300)  # Gentle scroll up
            time.sleep(2)
            print("✅ Scrolled up to reveal navigation")
            
            # Step 4: Click home tab to ensure we're on home feed
            print("🏠 Step 4/4: Clicking home tab...")
            self.driver.tap([(150, 2200)])  # Home tab coordinates
            time.sleep(3)
            print("✅ On home feed")
            
            print("✅ STANDARD INITIALIZATION COMPLETE - Ready for launcher work!")
            return True
            
        except Exception as e:
            print(f"❌ Initialization failed: {e}")
            return False

    def open_twitter_home(self):
        """Open Twitter/X and navigate to home feed"""
        try:
            print("🐦 Opening Twitter/X home feed...")
            
            # Standard initialization
            if not self.standard_twitter_init():
                print("❌ Failed to initialize Twitter")
                return False
            
            # Handle initial popups
            self._handle_initial_popups()
            
            print("✅ Twitter/X home feed opened successfully!")
            return True
            
        except Exception as e:
            print(f"❌ Failed to open Twitter home: {e}")
            return self._handle_appium_error(e, "open_twitter_home")
    
    def _force_stop_twitter(self):
        """Force stop Twitter app for clean launch"""
        try:
            result = subprocess.run(
                ['adb', '-s', self.device_id, 'shell', 'am', 'force-stop', self.TWITTER_PACKAGE],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0:
                print("🔄 Twitter app force stopped for clean launch")
            return True
        except:
            return False
    
    def _launch_twitter_app(self):
        """Launch Twitter app via ADB"""
        try:
            print("🚀 Launching Twitter app...")
            
            # Launch via ADB with activity
            result = subprocess.run([
                'adb', '-s', self.device_id, 'shell', 'am', 'start',
                '-n', f'{self.TWITTER_PACKAGE}/{self.TWITTER_ACTIVITY}',
                '--activity-clear-top'
            ], capture_output=True, text=True, timeout=15)
            
            if result.returncode == 0:
                print("✅ Twitter app launched via ADB")
                time.sleep(3)
                return self._verify_twitter_launched()
            else:
                print(f"❌ ADB launch failed: {result.stderr}")
                return False
                
        except Exception as e:
            print(f"❌ Twitter launch failed: {e}")
            return False
    
    def _verify_twitter_launched(self):
        """Verify Twitter app is running"""
        try:
            # Method 1: Check if Twitter process is running
            result = subprocess.run(
                ['adb', '-s', self.device_id, 'shell', 'pidof', self.TWITTER_PACKAGE],
                capture_output=True, text=True, timeout=5
            )
            
            if result.returncode == 0 and result.stdout.strip():
                print("✅ Twitter app is running (PID found)")
                return True
            
            # Method 2: Check current activity
            result = subprocess.run(
                ['adb', '-s', self.device_id, 'shell', 'dumpsys', 'activity', 'activities', '|', 'grep', 'twitter'],
                capture_output=True, text=True, timeout=5, shell=True
            )
            
            if 'twitter' in result.stdout.lower():
                print("✅ Twitter activity detected")
                return True
            
            print("❌ Twitter app verification failed")
            return False
            
        except Exception as e:
            print(f"❌ Twitter verification error: {e}")
            return False
    
    def _handle_initial_popups(self):
        """Handle initial Twitter popups and permissions"""
        try:
            print("🔍 Checking for initial popups...")
            
            # Wait for app to fully load
            time.sleep(3)
            
            # Look for common popup elements and dismiss them
            popup_selectors = [
                "Allow",
                "OK",
                "Continue",
                "Skip",
                "Not now",
                "Maybe later"
            ]
            
            for selector in popup_selectors:
                try:
                    element = self.driver.find_element(AppiumBy.XPATH, f"//*[@text='{selector}']")
                    element.click()
                    print(f"✅ Dismissed popup: {selector}")
                    time.sleep(1)
                except:
                    continue
            
            # Try to dismiss notification permissions
            try:
                allow_button = self.driver.find_element(AppiumBy.XPATH, "//*[@text='Allow']")
                allow_button.click()
                print("✅ Allowed notifications")
                time.sleep(1)
            except:
                pass
                
        except Exception as e:
            print(f"⚠️ Popup handling failed: {e}")
    
    def _navigate_to_home(self):
        """Navigate to Twitter home feed"""
        try:
            print("🏠 Navigating to home feed...")
            
            # Look for home tab/icon
            home_selectors = [
                "//*[@content-desc='Home']",
                "//*[@text='Home']",
                "//*[contains(@content-desc, 'Home')]",
                "//*[contains(@resource-id, 'home')]"
            ]
            
            for selector in home_selectors:
                try:
                    home_element = self.driver.find_element(AppiumBy.XPATH, selector)
                    home_element.click()
                    print("✅ Clicked home tab")
                    time.sleep(2)
                    return True
                except:
                    continue
            
            # If no home tab found, we might already be on home
            print("⚠️ No home tab found - might already be on home feed")
            return True
            
        except Exception as e:
            print(f"❌ Home navigation failed: {e}")
            return False
    
    def is_twitter_running(self):
        """Check if Twitter is currently running"""
        try:
            result = subprocess.run(
                ['adb', '-s', self.device_id, 'shell', 'pidof', self.TWITTER_PACKAGE],
                capture_output=True, text=True, timeout=5
            )
            return result.returncode == 0 and result.stdout.strip()
        except:
            return False
    
    def restart_twitter(self):
        """Restart Twitter app"""
        print("🔄 Restarting Twitter/X app...")
        self._force_stop_twitter()
        time.sleep(2)
        return self.open_twitter_home()
    
    def close_twitter(self):
        """Close Twitter app"""
        try:
            self._force_stop_twitter()
            print("✅ Twitter app closed")
            return True
        except Exception as e:
            print(f"❌ Failed to close Twitter: {e}")
            return False
    
    def disconnect(self):
        """Disconnect WebDriver"""
        try:
            if self.driver:
                self.driver.quit()
                self.driver = None
                print("✅ WebDriver disconnected")
        except Exception as e:
            print(f"⚠️ Disconnect error: {e}")
    
    def cleanup(self):
        """Clean up resources"""
        self.disconnect()
    
    def __del__(self):
        """Destructor to ensure cleanup"""
        try:
            self.cleanup()
        except:
            pass


# Test function
def test_twitter_launcher():
    """Test Twitter launcher functionality"""
    import sys
    
    if len(sys.argv) > 1:
        device_id = sys.argv[1]
    else:
        # Try to get first connected device
        result = subprocess.run(['adb', 'devices'], capture_output=True, text=True)
        devices = [line.split('\t')[0] for line in result.stdout.split('\n')[1:] if '\tdevice' in line]
        device_id = devices[0] if devices else None
    
    if not device_id:
        print("❌ No device connected")
        return
    
    launcher = TwitterLauncher(device_id)
    
    print(f"🔍 Testing with device: {device_id}")
    
    # Test ADB connection
    if launcher.connect_adb():
        print("✅ ADB connected")
        
        # Test Twitter launch
        if launcher.open_twitter_home():
            print("✅ Twitter home opened successfully")
            
            # Verify it's running
            if launcher.is_twitter_running():
                print("✅ Twitter verified running")
            
            time.sleep(5)
            
            # Test restart
            if launcher.restart_twitter():
                print("✅ Twitter restart successful")
            
        else:
            print("❌ Twitter launch failed")
    else:
        print("❌ ADB connection failed")
    
    launcher.cleanup()


if __name__ == "__main__":
    test_twitter_launcher()