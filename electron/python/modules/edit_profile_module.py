"""
Instagram Edit Profile Module
Automates profile editing: Name, Username, Bio, and Links
Based on Golden IDs from APPIUM_DISCOVERY_EDIT_PROFILE.md (Dec 2025)
"""

import time
import subprocess
from appium import webdriver
from appium.webdriver.common.appiumby import AppiumBy
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import (
    NoSuchElementException, 
    TimeoutException, 
    StaleElementReferenceException,
    InvalidElementStateException
)

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


class InstagramProfileEditor:
    """
    Handles Instagram profile editing automation.
    Uses Golden IDs for reliable element interaction.
    """
    
    # Golden IDs from discovery document
    SELECTORS = {
        # Navigation
        'edit_profile_button': 'Edit profile',  # UIAutomator text
        'edit_profile_button_id': 'com.instagram.android:id/row_profile_header_edit_profile_button',
        
        # Field buttons (navigate to input screens)
        'name_button': 'com.instagram.android:id/full_name',
        'username_button': 'com.instagram.android:id/username',
        'bio_button_text': 'Bio',  # UIAutomator text
        'bio_button_id': 'com.instagram.android:id/bio',
        'links_button_text': 'Add link',  # or 'Links'
        'link_option_text': 'com.instagram.android:id/link_option_text',
        
        # Universal input field (same across all edit screens)
        'input_field_xpath': '//android.widget.EditText[@resource-id="com.instagram.android:id/prism_form_field_container"]/android.widget.EditText',
        
        # Action buttons
        'save_button': 'com.instagram.android:id/action_bar_button_action',
        'back_button': 'com.instagram.android:id/action_bar_button_back',
        'confirm_change_button': 'com.instagram.android:id/igds_alert_dialog_primary_button',
        
        # Profile tab
        'profile_tab': 'com.instagram.android:id/profile_tab',
        'tab_avatar': 'com.instagram.android:id/tab_avatar',
    }
    
    def __init__(self, device_id=None, driver=None):
        """
        Initialize the profile editor.
        
        Args:
            device_id: ADB device ID
            driver: Optional existing Appium driver
        """
        self.device_id = device_id
        self.driver = driver
        self.connected = False
        
    def connect(self):
        """Connect to the device via Appium"""
        if self.driver:
            self.connected = True
            return True
        
        # USE CENTRALIZED DRIVER MANAGER if available
        if DRIVER_MANAGER_AVAILABLE:
            self.driver = get_shared_driver(self.device_id)
            if self.driver:
                self.connected = True
                print(f"✅ Connected to Instagram via driver manager")
                return True
            
        # FALLBACK: Direct connection
        try:
            capabilities = {
                "platformName": "Android",
                "automationName": "UiAutomator2",
                "deviceName": self.device_id or "Android",
                "noReset": True,
                "fullReset": False,
                "appPackage": "com.instagram.android",
                "appActivity": "com.instagram.android.activity.MainTabActivity",
                "newCommandTimeout": 300,
                "uiautomator2ServerInstallTimeout": 60000,
            }
            
            if self.device_id:
                capabilities["udid"] = self.device_id
                
            self.driver = webdriver.Remote(
                'http://localhost:4723',
                options=webdriver.options.base.AppiumOptions().load_capabilities(capabilities)
            )
            self.connected = True
            print(f"✅ Connected to Instagram for profile editing")
            return True
            
        except Exception as e:
            print(f"❌ Failed to connect: {e}")
            return False
    
    def disconnect(self):
        """Disconnect from Appium"""
        if self.driver and not self.connected:
            try:
                self.driver.quit()
            except:
                pass
        self.driver = None
        self.connected = False
    
    def _clear_field_adb(self, char_count=50):
        """Clear text field using ADB backspace keyevents"""
        try:
            for _ in range(char_count):
                if self.device_id:
                    subprocess.run(
                        ['adb', '-s', self.device_id, 'shell', 'input', 'keyevent', '67'],
                        capture_output=True, timeout=2
                    )
                else:
                    subprocess.run(
                        ['adb', 'shell', 'input', 'keyevent', '67'],
                        capture_output=True, timeout=2
                    )
            return True
        except Exception as e:
            print(f"⚠️ ADB clear failed: {e}")
            return False
    
    def _input_text_adb(self, text):
        """Input text using ADB (more reliable than Appium)"""
        try:
            # Replace spaces with %s for ADB
            escaped_text = text.replace(' ', '%s').replace("'", "\\'")
            
            if self.device_id:
                subprocess.run(
                    ['adb', '-s', self.device_id, 'shell', 'input', 'text', escaped_text],
                    capture_output=True, timeout=10
                )
            else:
                subprocess.run(
                    ['adb', 'shell', 'input', 'text', escaped_text],
                    capture_output=True, timeout=10
                )
            return True
        except Exception as e:
            print(f"⚠️ ADB input failed: {e}")
            return False
    
    def _wait_and_click(self, by, value, timeout=10):
        """Wait for element and click it"""
        try:
            element = WebDriverWait(self.driver, timeout).until(
                EC.presence_of_element_located((by, value))
            )
            element.click()
            return True
        except TimeoutException:
            print(f"⚠️ Element not found: {value}")
            return False
        except Exception as e:
            print(f"⚠️ Click failed: {e}")
            return False
    
    def _find_element_safe(self, by, value, timeout=5):
        """Safely find an element with timeout"""
        try:
            return WebDriverWait(self.driver, timeout).until(
                EC.presence_of_element_located((by, value))
            )
        except:
            return None
    
    def navigate_to_profile(self):
        """Navigate to the profile tab"""
        try:
            # Try profile tab by ID first
            if self._wait_and_click(AppiumBy.ID, self.SELECTORS['profile_tab'], timeout=5):
                time.sleep(2)
                return True
                
            # Try tab avatar
            if self._wait_and_click(AppiumBy.ID, self.SELECTORS['tab_avatar'], timeout=5):
                time.sleep(2)
                return True
                
            print("⚠️ Could not find profile tab")
            return False
            
        except Exception as e:
            print(f"❌ Navigate to profile failed: {e}")
            return False
    
    def enter_edit_profile(self):
        """Click 'Edit profile' button to enter editing mode"""
        try:
            # First try by text (more stable)
            try:
                edit_btn = self.driver.find_element(
                    AppiumBy.ANDROID_UIAUTOMATOR,
                    f'new UiSelector().text("{self.SELECTORS["edit_profile_button"]}")'
                )
                edit_btn.click()
                time.sleep(2)
                print("✅ Entered Edit Profile mode")
                return True
            except:
                pass
            
            # Try by ID
            if self._wait_and_click(AppiumBy.ID, self.SELECTORS['edit_profile_button_id'], timeout=5):
                time.sleep(2)
                print("✅ Entered Edit Profile mode (via ID)")
                return True
                
            print("⚠️ Could not find Edit profile button")
            return False
            
        except Exception as e:
            print(f"❌ Enter edit profile failed: {e}")
            return False
    
    def _enter_field_screen(self, field_type):
        """Enter a specific field editing screen (Name, Username, Bio)"""
        try:
            if field_type == 'name':
                # Click Name button
                if self._wait_and_click(AppiumBy.ID, self.SELECTORS['name_button'], timeout=5):
                    time.sleep(1.5)
                    return True
                # Fallback to text
                try:
                    btn = self.driver.find_element(
                        AppiumBy.ANDROID_UIAUTOMATOR,
                        'new UiSelector().text("Name")'
                    )
                    btn.click()
                    time.sleep(1.5)
                    return True
                except:
                    pass
                    
            elif field_type == 'username':
                # Click Username button
                if self._wait_and_click(AppiumBy.ID, self.SELECTORS['username_button'], timeout=5):
                    time.sleep(1.5)
                    return True
                # Fallback to text
                try:
                    btn = self.driver.find_element(
                        AppiumBy.ANDROID_UIAUTOMATOR,
                        'new UiSelector().text("Username")'
                    )
                    btn.click()
                    time.sleep(1.5)
                    return True
                except:
                    pass
                    
            elif field_type == 'bio':
                # Click Bio button (text is more reliable)
                try:
                    btn = self.driver.find_element(
                        AppiumBy.ANDROID_UIAUTOMATOR,
                        f'new UiSelector().text("{self.SELECTORS["bio_button_text"]}")'
                    )
                    btn.click()
                    time.sleep(1.5)
                    return True
                except:
                    pass
                # Try by ID
                if self._wait_and_click(AppiumBy.ID, self.SELECTORS['bio_button_id'], timeout=5):
                    time.sleep(1.5)
                    return True
                    
            elif field_type == 'link':
                # Click Add link/Links button
                try:
                    btn = self.driver.find_element(
                        AppiumBy.ANDROID_UIAUTOMATOR,
                        'new UiSelector().textContains("Add link")'
                    )
                    btn.click()
                    time.sleep(1.5)
                    return True
                except:
                    pass
                try:
                    btn = self.driver.find_element(
                        AppiumBy.ANDROID_UIAUTOMATOR,
                        'new UiSelector().textContains("Links")'
                    )
                    btn.click()
                    time.sleep(1.5)
                    return True
                except:
                    pass
                    
            print(f"⚠️ Could not enter {field_type} screen")
            return False
            
        except Exception as e:
            print(f"❌ Enter {field_type} screen failed: {e}")
            return False
    
    def _edit_field(self, new_value, clear_chars=50):
        """Edit the current field (after entering field screen)"""
        try:
            # Find the input field using the universal XPath
            input_field = self._find_element_safe(
                AppiumBy.XPATH,
                self.SELECTORS['input_field_xpath'],
                timeout=5
            )
            
            if not input_field:
                print("⚠️ Input field not found")
                return False
            
            # Click to focus the field
            input_field.click()
            time.sleep(0.5)
            
            # Clear using ADB backspace (more reliable)
            print(f"🧹 Clearing field with {clear_chars} backspaces...")
            self._clear_field_adb(clear_chars)
            time.sleep(0.5)
            
            # Input new text using ADB
            print(f"📝 Entering new value: {new_value[:20]}...")
            self._input_text_adb(new_value)
            time.sleep(1)
            
            return True
            
        except Exception as e:
            print(f"❌ Edit field failed: {e}")
            return False
    
    def _save_and_go_back(self, expect_confirmation=False):
        """Save changes and go back"""
        try:
            # Click save/done button
            if self._wait_and_click(AppiumBy.ID, self.SELECTORS['save_button'], timeout=5):
                time.sleep(2)
                
                # Handle confirmation dialog if expected (e.g., for name change)
                if expect_confirmation:
                    try:
                        confirm_btn = self._find_element_safe(
                            AppiumBy.ID,
                            self.SELECTORS['confirm_change_button'],
                            timeout=3
                        )
                        if confirm_btn:
                            confirm_btn.click()
                            time.sleep(1)
                            print("✅ Confirmed change")
                    except:
                        pass
                
                print("✅ Saved changes")
                return True
            
            # Try accessibility ID "Done"
            try:
                done_btn = self.driver.find_element(
                    AppiumBy.ACCESSIBILITY_ID, "Done"
                )
                done_btn.click()
                time.sleep(2)
                
                if expect_confirmation:
                    try:
                        confirm_btn = self._find_element_safe(
                            AppiumBy.ID,
                            self.SELECTORS['confirm_change_button'],
                            timeout=3
                        )
                        if confirm_btn:
                            confirm_btn.click()
                            time.sleep(1)
                    except:
                        pass
                
                print("✅ Saved changes (via Done)")
                return True
            except:
                pass
            
            print("⚠️ Could not find save button")
            return False
            
        except Exception as e:
            print(f"❌ Save failed: {e}")
            return False
    
    def update_name(self, new_name):
        """Update the profile display name"""
        try:
            print(f"📛 Updating name to: {new_name}")
            
            if not self._enter_field_screen('name'):
                return False
                
            if not self._edit_field(new_name, clear_chars=50):
                return False
                
            if not self._save_and_go_back(expect_confirmation=True):
                return False
            
            print(f"✅ Name updated to: {new_name}")
            return True
            
        except Exception as e:
            print(f"❌ Update name failed: {e}")
            return False
    
    def update_username(self, new_username):
        """Update the profile username"""
        try:
            print(f"👤 Updating username to: {new_username}")
            
            if not self._enter_field_screen('username'):
                return False
                
            if not self._edit_field(new_username, clear_chars=50):
                return False
            
            time.sleep(1)  # Extra wait for username validation
            
            if not self._save_and_go_back(expect_confirmation=False):
                return False
            
            print(f"✅ Username updated to: {new_username}")
            return True
            
        except Exception as e:
            print(f"❌ Update username failed: {e}")
            return False
    
    def update_bio(self, new_bio):
        """Update the profile bio"""
        try:
            print(f"📝 Updating bio to: {new_bio[:30]}...")
            
            if not self._enter_field_screen('bio'):
                return False
                
            # Bio can be longer, use more backspaces
            if not self._edit_field(new_bio, clear_chars=150):
                return False
                
            if not self._save_and_go_back(expect_confirmation=False):
                return False
            
            print(f"✅ Bio updated successfully")
            return True
            
        except Exception as e:
            print(f"❌ Update bio failed: {e}")
            return False
    
    def add_link(self, url, title=None):
        """Add or update a profile link"""
        try:
            print(f"🔗 Adding link: {url}")
            
            if not self._enter_field_screen('link'):
                return False
            
            # Look for "Add external link" button
            time.sleep(1)
            try:
                add_link_btn = self.driver.find_element(
                    AppiumBy.ANDROID_UIAUTOMATOR,
                    'new UiSelector().textContains("Add external link")'
                )
                add_link_btn.click()
                time.sleep(1.5)
            except:
                # Try "Add link" if external not found
                try:
                    add_link_btn = self.driver.find_element(
                        AppiumBy.ANDROID_UIAUTOMATOR,
                        'new UiSelector().text("Add link")'
                    )
                    add_link_btn.click()
                    time.sleep(1.5)
                except:
                    print("⚠️ Add link button not found")
                    return False
            
            # Enter the URL
            if not self._edit_field(url, clear_chars=100):
                return False
            
            # Save the link
            if not self._save_and_go_back(expect_confirmation=False):
                return False
            
            # Go back again (from Links screen to Edit Profile)
            time.sleep(1)
            try:
                back_btn = self._find_element_safe(
                    AppiumBy.ID,
                    self.SELECTORS['back_button'],
                    timeout=3
                )
                if back_btn:
                    back_btn.click()
                    time.sleep(1)
            except:
                pass
            
            print(f"✅ Link added: {url}")
            return True
            
        except Exception as e:
            print(f"❌ Add link failed: {e}")
            return False
    
    def update_full_profile(self, name=None, username=None, bio=None, link=None):
        """
        Update multiple profile fields in one go.
        
        Args:
            name: New display name (optional)
            username: New username (optional)
            bio: New bio text (optional)
            link: New link URL (optional)
            
        Returns:
            dict with success status for each field
        """
        results = {
            'name': None,
            'username': None,
            'bio': None,
            'link': None,
            'overall': False
        }
        
        try:
            # Navigate to profile first
            print("🚀 Starting full profile update...")
            self.navigate_to_profile()
            time.sleep(1)
            
            # Enter Edit Profile mode
            if not self.enter_edit_profile():
                print("❌ Could not enter Edit Profile mode")
                return results
            
            # Update each field if provided
            if name is not None:
                results['name'] = self.update_name(name)
                time.sleep(1)
            
            if username is not None:
                results['username'] = self.update_username(username)
                time.sleep(1)
            
            if bio is not None:
                results['bio'] = self.update_bio(bio)
                time.sleep(1)
            
            if link is not None:
                results['link'] = self.add_link(link)
                time.sleep(1)
            
            # Save all changes on Edit Profile screen
            print("💾 Saving all profile changes...")
            self._wait_and_click(AppiumBy.ID, self.SELECTORS['save_button'], timeout=5)
            time.sleep(2)
            
            # Check what succeeded
            successes = [v for v in [results['name'], results['username'], results['bio'], results['link']] if v is True]
            results['overall'] = len(successes) > 0
            
            status = "✅" if results['overall'] else "❌"
            print(f"{status} Profile update complete: {len(successes)} fields updated")
            
            return results
            
        except Exception as e:
            print(f"❌ Full profile update failed: {e}")
            return results


# Test function
if __name__ == "__main__":
    print("📱 Instagram Profile Editor Test")
    print("=" * 50)
    
    editor = InstagramProfileEditor()
    
    if editor.connect():
        print("\n1. Navigate to profile")
        editor.navigate_to_profile()
        
        print("\n2. Enter Edit Profile")
        editor.enter_edit_profile()
        
        # Interactive mode
        print("\n🔧 Interactive Mode")
        print("-" * 30)
        
        choice = input("Update (n)ame, (u)sername, (b)io, (l)ink, or (a)ll? ").lower()
        
        if choice == 'n':
            new_name = input("Enter new name: ")
            editor.update_name(new_name)
        elif choice == 'u':
            new_username = input("Enter new username: ")
            editor.update_username(new_username)
        elif choice == 'b':
            new_bio = input("Enter new bio: ")
            editor.update_bio(new_bio)
        elif choice == 'l':
            new_link = input("Enter new link URL: ")
            editor.add_link(new_link)
        elif choice == 'a':
            name = input("New name (or press Enter to skip): ")
            username = input("New username (or press Enter to skip): ")
            bio = input("New bio (or press Enter to skip): ")
            link = input("New link (or press Enter to skip): ")
            
            editor.update_full_profile(
                name=name if name else None,
                username=username if username else None,
                bio=bio if bio else None,
                link=link if link else None
            )
        
        editor.disconnect()
    else:
        print("❌ Could not connect to device")
