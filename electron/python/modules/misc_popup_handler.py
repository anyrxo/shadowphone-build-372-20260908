#!/usr/bin/env python3
"""
🛠️ MISC POPUP HANDLER MODULE
Handle all annoying Instagram popups, notifications, and interruptions
"""

from appium import webdriver
from appium.options.android import UiAutomator2Options
from selenium.webdriver.common.by import By
from selenium.common.exceptions import NoSuchElementException
import time

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

class InstagramPopupHandler:
    def __init__(self, device_id="1A121FDF60082H"):
        self.device_id = device_id
        self.driver = None
        
    def connect_adb(self):
        """Connect via ADB to device"""
        try:
            print("📱 Connecting via ADB for popup handling...")
            
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
            print("✅ ADB Connected for popup handling!")
            return True
        except Exception as e:
            print(f"❌ ADB Connection failed: {e}")
            return False
    
    def disconnect(self):
        if self.driver:
            self.driver.quit()
            print("🔄 Popup handler disconnected")
    
    def handle_all_popups(self, driver=None):
        """Handle all known Instagram popups - can use external driver or internal"""
        try:
            # Use external driver if provided, otherwise use internal
            active_driver = driver if driver else self.driver
            if not active_driver:
                if not self.connect_adb():
                    return False
                active_driver = self.driver
            
            print("🛠️ Scanning for popups...")
            popups_handled = 0
            
            # Handle each type of popup
            if self.handle_notification_popup(active_driver):
                popups_handled += 1
            
            if self.handle_permission_popup(active_driver):
                popups_handled += 1
                
            if self.handle_update_popup(active_driver):
                popups_handled += 1
                
            if self.handle_location_popup(active_driver):
                popups_handled += 1
                
            if self.handle_contacts_popup(active_driver):
                popups_handled += 1
                
            if self.handle_age_verification_popup(active_driver):
                popups_handled += 1
                
            if self.handle_suggested_accounts_popup(active_driver):
                popups_handled += 1
                
            if self.handle_camera_popup(active_driver):
                popups_handled += 1
                
            if self.handle_storage_popup(active_driver):
                popups_handled += 1
                
            if self.handle_no_thanks_popup(active_driver):
                popups_handled += 1
                
            if self.handle_generic_popup(active_driver):
                popups_handled += 1
            
            if popups_handled > 0:
                print(f"✅ Handled {popups_handled} popup(s)!")
                return True
            else:
                print("✅ No popups found")
                return False
                
        except Exception as e:
            print(f"❌ Popup handling failed: {e}")
            return False
    
    def handle_notification_popup(self, driver):
        """Handle notification permission popup"""
        try:
            print("🔔 Checking for notification popup...")
            
            # Common notification popup selectors
            notification_selectors = [
                "//android.widget.Button[contains(@text, 'Not Now')]",
                "//android.widget.Button[contains(@text, 'Not now')]", 
                "//android.widget.Button[contains(@text, 'NO THANKS')]",
                "//android.widget.Button[contains(@text, 'No Thanks')]",
                "//android.widget.Button[contains(@text, 'No, thanks')]",
                "//android.widget.Button[contains(@text, 'No thanks')]",
                "//android.widget.Button[contains(@text, 'Later')]",
                "//android.widget.Button[contains(@text, 'Skip')]",
                "//*[contains(@text, 'Not Now')]",
                "//*[contains(@text, 'Not now')]",
                "//*[contains(@text, 'NO THANKS')]",
                "//*[contains(@text, 'No Thanks')]",
                "//*[contains(@text, 'No, thanks')]",
                "//*[contains(@text, 'No thanks')]",
                "//*[contains(@text, 'Skip')]",
            ]
            
            for selector in notification_selectors:
                try:
                    element = driver.find_element(By.XPATH, selector)
                    element.click()
                    print("✅ Notification popup dismissed!")
                    time.sleep(2)
                    return True
                except NoSuchElementException:
                    continue
            
            # Fallback coordinates for common dismiss positions
            dismiss_coords = [(540, 1400), (400, 1400), (680, 1400)]
            for coord in dismiss_coords:
                try:
                    driver.tap([coord])
                    time.sleep(1)
                except:
                    continue
                    
            return False
        except Exception as e:
            print(f"⚠️ Notification popup handling failed: {e}")
            return False
    
    def handle_permission_popup(self, driver):
        """Handle various permission popups"""
        try:
            print("🔐 Checking for permission popup...")
            
            permission_selectors = [
                "//android.widget.Button[contains(@text, 'DENY')]",
                "//android.widget.Button[contains(@text, 'Deny')]",
                "//android.widget.Button[contains(@text, 'Don\\'t allow')]", 
                "//android.widget.Button[contains(@text, 'ALLOW')]",
                "//android.widget.Button[contains(@text, 'Allow')]",
                "//*[contains(@text, 'DENY')]",
                "//*[contains(@text, 'Deny')]",
            ]
            
            for selector in permission_selectors:
                try:
                    element = driver.find_element(By.XPATH, selector)
                    # For most permissions, we'll deny/dismiss
                    if 'DENY' in selector or 'Deny' in selector:
                        element.click()
                        print("✅ Permission popup denied!")
                        time.sleep(2)
                        return True
                except NoSuchElementException:
                    continue
                    
            return False
        except Exception as e:
            print(f"⚠️ Permission popup handling failed: {e}")
            return False
    
    def handle_update_popup(self, driver):
        """Handle app update popup"""
        try:
            print("🔄 Checking for update popup...")
            
            update_selectors = [
                "//android.widget.Button[contains(@text, 'Skip')]",
                "//android.widget.Button[contains(@text, 'Later')]",
                "//android.widget.Button[contains(@text, 'Not Now')]",
                "//android.widget.Button[contains(@text, 'Remind Me Later')]",
                "//*[contains(@text, 'Skip')]",
                "//*[contains(@text, 'Later')]",
            ]
            
            for selector in update_selectors:
                try:
                    element = driver.find_element(By.XPATH, selector)
                    element.click()
                    print("✅ Update popup dismissed!")
                    time.sleep(2)
                    return True
                except NoSuchElementException:
                    continue
                    
            return False
        except Exception as e:
            print(f"⚠️ Update popup handling failed: {e}")
            return False
    
    def handle_location_popup(self, driver):
        """Handle location permission popup"""
        try:
            print("📍 Checking for location popup...")
            
            location_selectors = [
                "//android.widget.Button[contains(@text, 'Not Now')]",
                "//android.widget.Button[contains(@text, 'Don\\'t Allow')]",
                "//android.widget.Button[contains(@text, 'Skip')]",
                "//*[contains(@text, 'location')]/..//*[contains(@text, 'Not Now')]",
                "//*[contains(@text, 'location')]/..//*[contains(@text, 'Skip')]",
            ]
            
            for selector in location_selectors:
                try:
                    element = driver.find_element(By.XPATH, selector)
                    element.click()
                    print("✅ Location popup dismissed!")
                    time.sleep(2)
                    return True
                except NoSuchElementException:
                    continue
                    
            return False
        except Exception as e:
            print(f"⚠️ Location popup handling failed: {e}")
            return False
    
    def handle_contacts_popup(self, driver):
        """Handle contacts permission popup"""
        try:
            print("👥 Checking for contacts popup...")
            
            contacts_selectors = [
                "//android.widget.Button[contains(@text, 'Not Now')]",
                "//android.widget.Button[contains(@text, 'Skip')]",
                "//*[contains(@text, 'contacts')]/..//*[contains(@text, 'Not Now')]",
                "//*[contains(@text, 'Find Friends')]/..//*[contains(@text, 'Skip')]",
            ]
            
            for selector in contacts_selectors:
                try:
                    element = driver.find_element(By.XPATH, selector)
                    element.click()
                    print("✅ Contacts popup dismissed!")
                    time.sleep(2)
                    return True
                except NoSuchElementException:
                    continue
                    
            return False
        except Exception as e:
            print(f"⚠️ Contacts popup handling failed: {e}")
            return False
    
    def handle_age_verification_popup(self, driver):
        """Handle age verification popup"""
        try:
            print("🎂 Checking for age verification popup...")
            
            age_selectors = [
                "//android.widget.Button[contains(@text, 'Skip')]",
                "//android.widget.Button[contains(@text, 'Not Now')]", 
                "//*[contains(@text, 'birthday')]/..//*[contains(@text, 'Skip')]",
                "//*[contains(@text, 'age')]/..//*[contains(@text, 'Skip')]",
            ]
            
            for selector in age_selectors:
                try:
                    element = driver.find_element(By.XPATH, selector)
                    element.click()
                    print("✅ Age verification popup dismissed!")
                    time.sleep(2)
                    return True
                except NoSuchElementException:
                    continue
                    
            return False
        except Exception as e:
            print(f"⚠️ Age verification popup handling failed: {e}")
            return False
    
    def handle_suggested_accounts_popup(self, driver):
        """Handle suggested accounts to follow popup"""
        try:
            print("💡 Checking for suggested accounts popup...")
            
            suggested_selectors = [
                "//android.widget.Button[contains(@text, 'Skip')]",
                "//android.widget.Button[contains(@text, 'Skip All')]",
                "//android.widget.Button[contains(@text, 'Not Interested')]",
                "//*[contains(@text, 'Suggested')]/..//*[contains(@text, 'Skip')]",
            ]
            
            for selector in suggested_selectors:
                try:
                    element = driver.find_element(By.XPATH, selector)
                    element.click()
                    print("✅ Suggested accounts popup dismissed!")
                    time.sleep(2)
                    return True
                except NoSuchElementException:
                    continue
                    
            return False
        except Exception as e:
            print(f"⚠️ Suggested accounts popup handling failed: {e}")
            return False
    
    def handle_camera_popup(self, driver):
        """Handle camera permission popup"""
        try:
            print("📷 Checking for camera popup...")
            
            camera_selectors = [
                "//android.widget.Button[contains(@text, 'Don\\'t allow')]",
                "//android.widget.Button[contains(@text, 'DENY')]",
                "//*[contains(@text, 'camera')]/..//*[contains(@text, 'Don\\'t allow')]",
            ]
            
            for selector in camera_selectors:
                try:
                    element = driver.find_element(By.XPATH, selector)
                    element.click()
                    print("✅ Camera popup dismissed!")
                    time.sleep(2)
                    return True
                except NoSuchElementException:
                    continue
                    
            return False
        except Exception as e:
            print(f"⚠️ Camera popup handling failed: {e}")
            return False
    
    def handle_storage_popup(self, driver):
        """Handle storage permission popup"""
        try:
            print("💾 Checking for storage popup...")
            
            storage_selectors = [
                "//android.widget.Button[contains(@text, 'Don\\'t allow')]",
                "//android.widget.Button[contains(@text, 'DENY')]",
                "//*[contains(@text, 'storage')]/..//*[contains(@text, 'Don\\'t allow')]",
            ]
            
            for selector in storage_selectors:
                try:
                    element = driver.find_element(By.XPATH, selector)
                    element.click()
                    print("✅ Storage popup dismissed!")
                    time.sleep(2)
                    return True
                except NoSuchElementException:
                    continue
                    
            return False
        except Exception as e:
            print(f"⚠️ Storage popup handling failed: {e}")
            return False
    
    def handle_no_thanks_popup(self, driver):
        """Handle 'No thanks' popup specifically - common Instagram dismissal"""
        try:
            print("🙅 Checking for 'No thanks' popup...")
            
            no_thanks_selectors = [
                "//android.widget.Button[contains(@text, 'No, thanks')]",
                "//android.widget.Button[contains(@text, 'No thanks')]", 
                "//android.widget.Button[contains(@text, 'NO, THANKS')]",
                "//android.widget.Button[contains(@text, 'NO THANKS')]",
                "//android.widget.TextView[contains(@text, 'No, thanks')]",
                "//android.widget.TextView[contains(@text, 'No thanks')]",
                "//*[contains(@text, 'No, thanks')]",
                "//*[contains(@text, 'No thanks')]",
                "//*[contains(@text, 'NO, THANKS')]",
                "//*[contains(@text, 'NO THANKS')]",
            ]
            
            for selector in no_thanks_selectors:
                try:
                    element = driver.find_element(By.XPATH, selector)
                    element.click()
                    print("✅ 'No thanks' popup dismissed!")
                    time.sleep(2)
                    return True
                except NoSuchElementException:
                    continue
            
            # Fallback coordinates for common "No thanks" positions
            no_thanks_coords = [
                (270, 1400),   # Common "No thanks" position bottom left
                (250, 1400),   # Slightly left
                (290, 1400),   # Slightly right  
                (270, 1350),   # Slightly higher
                (270, 1450),   # Slightly lower
                (200, 1400),   # Much further left
                (340, 1400),   # Much further right
                (270, 1300),   # Much higher
                (270, 1500),   # Much lower
            ]
            
            for coord in no_thanks_coords:
                try:
                    print(f"🎯 Trying 'No thanks' at {coord}")
                    driver.tap([coord])
                    time.sleep(2)
                    print(f"✅ Tapped potential 'No thanks' at {coord}!")
                    return True
                except:
                    continue
                    
            return False
        except Exception as e:
            print(f"⚠️ 'No thanks' popup handling failed: {e}")
            return False
    
    def handle_generic_popup(self, driver):
        """Handle generic popups with common dismiss patterns"""
        try:
            print("🔍 Checking for generic popups...")
            
            # Generic dismiss button texts
            generic_selectors = [
                "//android.widget.Button[contains(@text, 'X')]",
                "//android.widget.Button[contains(@text, 'Close')]",
                "//android.widget.Button[contains(@text, 'Dismiss')]",
                "//android.widget.Button[contains(@text, 'OK')]",
                "//android.widget.Button[contains(@text, 'Got it')]",
                "//android.widget.Button[contains(@text, 'Continue')]",
                "//*[contains(@content-desc, 'Close')]",
                "//*[contains(@content-desc, 'Dismiss')]",
            ]
            
            for selector in generic_selectors:
                try:
                    element = driver.find_element(By.XPATH, selector)
                    element.click()
                    print("✅ Generic popup dismissed!")
                    time.sleep(2)
                    return True
                except NoSuchElementException:
                    continue
            
            # Try common X button coordinates (top right)
            x_coords = [(950, 150), (980, 100), (900, 200), (1000, 180)]
            for coord in x_coords:
                try:
                    driver.tap([coord])
                    time.sleep(1)
                    print(f"✅ Tapped potential X button at {coord}!")
                    return True
                except:
                    continue
                    
            return False
        except Exception as e:
            print(f"⚠️ Generic popup handling failed: {e}")
            return False
    
    def quick_popup_scan(self, driver=None):
        """Quick scan and dismiss of most common popups"""
        try:
            active_driver = driver if driver else self.driver
            if not active_driver:
                return False
            
            print("⚡ Quick popup scan...")
            
            # Enhanced "Not now" detection with more variations
            quick_selectors = [
                # "Not Now" variations
                "//android.widget.Button[contains(@text, 'Not Now')]",
                "//android.widget.Button[contains(@text, 'Not now')]",
                "//android.widget.Button[contains(@text, 'NOT NOW')]", 
                "//android.widget.TextView[contains(@text, 'Not Now')]",
                "//android.widget.TextView[contains(@text, 'Not now')]",
                "//*[contains(@text, 'Not Now')]",
                "//*[contains(@text, 'Not now')]", 
                "//*[contains(@text, 'NOT NOW')]",
                
                # Other common dismissals
                "//android.widget.Button[contains(@text, 'Skip')]", 
                "//android.widget.Button[contains(@text, 'Later')]",
                "//android.widget.Button[contains(@text, 'No Thanks')]",
                "//android.widget.Button[contains(@text, 'No, thanks')]",
                "//android.widget.Button[contains(@text, 'No thanks')]",
                "//android.widget.Button[contains(@text, 'X')]",
                "//*[contains(@text, 'Skip')]",
                "//*[contains(@text, 'Later')]",
                "//*[contains(@text, 'No Thanks')]",
                "//*[contains(@text, 'No, thanks')]",
                "//*[contains(@text, 'No thanks')]",
            ]
            
            for selector in quick_selectors:
                try:
                    print(f"🔍 Trying popup selector: {selector}")
                    element = active_driver.find_element(By.XPATH, selector)
                    element.click()
                    print(f"⚡ Quick popup dismissed with selector: {selector}")
                    time.sleep(2)
                    return True
                except NoSuchElementException:
                    continue
                except Exception as e:
                    print(f"⚠️ Selector failed: {e}")
                    continue
            
            # Fallback coordinate tapping for common "Not now" positions
            print("🎯 Trying coordinate fallback for Not now button...")
            not_now_coords = [
                (300, 1400),   # Bottom left "Not now"
                (250, 1400),   # Further left
                (350, 1400),   # Further right
                (300, 1350),   # Slightly higher
                (300, 1450),   # Slightly lower
                (200, 1400),   # Much further left
                (400, 1400),   # Much further right
            ]
            
            for coord in not_now_coords:
                try:
                    print(f"🎯 Trying Not now at {coord}")
                    active_driver.tap([coord])
                    time.sleep(2)
                    print(f"⚡ Tapped potential Not now at {coord}!")
                    return True
                except:
                    continue
                    
            return False
        except Exception as e:
            print(f"⚠️ Quick popup scan failed: {e}")
            return False

# Standalone popup handler function for easy import
def handle_instagram_popups(driver):
    """Standalone function to handle popups with external driver"""
    handler = InstagramPopupHandler()
    return handler.handle_all_popups(driver)

def quick_popup_check(driver):
    """Quick popup check function for external driver"""
    handler = InstagramPopupHandler()
    return handler.quick_popup_scan(driver)

if __name__ == "__main__":
    handler = InstagramPopupHandler()
    
    print("🛠️ INSTAGRAM POPUP HANDLER")
    print("1 - Handle all popups")
    print("2 - Quick popup scan")
    
    choice = input("Choose option (1-2): ").strip()
    
    if choice == "1":
        print("🛠️ Running complete popup handling...")
        success = handler.handle_all_popups()
        if success:
            print("✅ Popup handling completed!")
        else:
            print("⚠️ No popups found or handling failed")
    
    elif choice == "2":
        print("⚡ Running quick popup scan...")
        if handler.connect_adb():
            success = handler.quick_popup_scan()
            if success:
                print("✅ Quick popup scan completed!")
            else:
                print("⚠️ No popups found")
            handler.disconnect()
    
    else:
        print("❌ Invalid choice")