#!/usr/bin/env python3
"""
🔍👥 TWITTER SEARCH & FOLLOW MODULE
Complete search functionality with user following automation
Discovered selector: com.twitter.android:id/query
"""

from appium import webdriver
from appium.options.android import UiAutomator2Options
from appium.webdriver.common.appiumby import AppiumBy
import time
import random

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

class TwitterSearchFollow:
    def __init__(self, device_id="1A121FDF60082H"):
        self.device_id = device_id
        self.driver = None
        
        # 🔍 SEARCH INPUT SELECTORS (Updated & Tested)
        self.SEARCH_SELECTORS = {
            'PRIMARY': 'com.twitter.android:id/query_view',      # Updated Resource ID (most reliable)
            'HINT_BASED': "//*[@hint='Search X']",               # Hint text fallback  
            'CONTENT_DESC': "//*[@content-desc='Search X']",     # Content-desc fallback
            'XPATH_GENERIC': "//android.widget.EditText"        # Generic EditText fallback
        }
        
        # 🏠 NAVIGATION SELECTORS (ENHANCED with multiple fallbacks)
        self.NAV_SELECTORS = {
            'SEARCH_TAB': [
                "//*[contains(@content-desc, 'Search')]",
                "//*[contains(@content-desc, 'Explore')]", 
                "//*[contains(@text, 'Search')]",
                "//*[contains(@text, 'Explore')]"
            ],
            'HOME_TAB': [
                "//*[contains(@content-desc, 'Home')]",
                "//*[contains(@text, 'Home')]"
            ]
        }
        
        # 👥 FOLLOW SELECTORS
        self.FOLLOW_SELECTORS = {
            'FOLLOW_BUTTON': "//*[@text='Follow']",
            'FOLLOWING_BUTTON': "//*[@text='Following']",
            'FOLLOW_BUTTON_ALT': "//android.widget.Button[@text='Follow']"
        }
        
        # 🔍 SEARCH RESULT SELECTORS
        self.RESULT_SELECTORS = {
            'USER_PROFILE': "//*[@resource-id='com.twitter.android:id/user_item']",
            'USER_NAME': "//*[@resource-id='com.twitter.android:id/name']",
            'USER_HANDLE': "//*[@resource-id='com.twitter.android:id/screen_name']",
            'PROFILE_IMAGE': "//*[@resource-id='com.twitter.android:id/profile_image']"
        }

    def connect(self):
        """Connect to Twitter app"""
        try:
            print("🔍 Connecting to Twitter for search & follow...")
            
            # USE CENTRALIZED DRIVER MANAGER if available
            if DRIVER_MANAGER_AVAILABLE:
                self.driver = get_shared_driver(self.device_id)
                if self.driver:
                    print("✅ Connected to Twitter via driver manager")
                    return True
            
            # FALLBACK: Direct connection
            options = UiAutomator2Options()
            options.platform_name = "Android"
            options.device_name = self.device_id
            options.automation_name = "UIAutomator2"
            options.no_reset = True
            options.full_reset = False
            options.new_command_timeout = 300
            
            self.driver = webdriver.Remote("http://127.0.0.1:4723", options=options)
            time.sleep(2)
            
            print("✅ Connected to Twitter")
            return True
            
        except Exception as e:
            print(f"❌ Connection failed: {e}")
            return False
    
    def navigate_to_search(self):
        """Navigate to search screen with enhanced selector fallbacks"""
        try:
            print("🔍 Navigating to Search & Explore...")
            
            # Try all search tab selectors
            search_tab_found = False
            for i, selector in enumerate(self.NAV_SELECTORS['SEARCH_TAB']):
                try:
                    print(f"   Trying search selector {i+1}/{len(self.NAV_SELECTORS['SEARCH_TAB'])}...")
                    search_tab = self.driver.find_element(AppiumBy.XPATH, selector)
                    if search_tab.is_displayed():
                        search_tab.click()
                        time.sleep(3)
                        print(f"✅ Search tab clicked with selector {i+1}")
                        search_tab_found = True
                        break
                except Exception as e:
                    print(f"   Selector {i+1} failed: {e}")
                    continue
            
            if not search_tab_found:
                # Fallback: Use coordinate tap for search tab
                print("   Using coordinate fallback for search tab...")
                self.driver.tap([(810, 2200)])  # Search tab coordinates
                time.sleep(3)
                print("✅ Search tab via coordinate tap")
            
            print("✅ On Search & Explore screen")
            return True
            
        except Exception as e:
            print(f"❌ Navigation to search failed: {e}")
            return False
    
    def click_search_input(self):
        """Click the search input field"""
        try:
            print("📝 Clicking search input...")
            
            # Try all selectors in priority order
            search_selectors_to_try = [
                ('PRIMARY', AppiumBy.ID, self.SEARCH_SELECTORS['PRIMARY']),
                ('HINT_BASED', AppiumBy.XPATH, self.SEARCH_SELECTORS['HINT_BASED']),
                ('CONTENT_DESC', AppiumBy.XPATH, self.SEARCH_SELECTORS['CONTENT_DESC']),
                ('XPATH_GENERIC', AppiumBy.XPATH, self.SEARCH_SELECTORS['XPATH_GENERIC']),
                # Additional fallback selectors
                ('RESOURCE_ID_ALT', AppiumBy.ID, 'com.twitter.android:id/query'),
                ('TEXT_SEARCH', AppiumBy.XPATH, "//*[@text='Search X']"),
                ('CLICKABLE_SEARCH', AppiumBy.XPATH, "//*[@clickable='true' and contains(@content-desc, 'Search')]")
            ]
            
            for selector_name, method, selector in search_selectors_to_try:
                try:
                    search_input = self.driver.find_element(method, selector)
                    if search_input.is_displayed():
                        search_input.click()
                        time.sleep(2)  # Wait longer for UI to stabilize
                        print(f"✅ Clicked search input [{selector_name}]")
                        return True  # Return success instead of stale element
                except Exception as e:
                    if selector_name == 'PRIMARY':
                        print(f"⚠️ Primary selector failed: {e}")
                    continue
            
            print("❌ Could not find search input")
            return None
            
        except Exception as e:
            print(f"❌ Error clicking search input: {e}")
            return None
    
    def search_user(self, username):
        """Search for a specific user"""
        try:
            print(f"🔍 Searching for user: {username}")
            
            # Navigate to search if not already there
            if not self.navigate_to_search():
                return False
            
            # Click search input
            if not self.click_search_input():
                return False
            
            # Find search input fresh to avoid stale element reference
            search_input = None
            for selector_name, method, selector in [
                ('PRIMARY', AppiumBy.ID, self.SEARCH_SELECTORS['PRIMARY']),
                ('HINT_BASED', AppiumBy.XPATH, self.SEARCH_SELECTORS['HINT_BASED']),
                ('CONTENT_DESC', AppiumBy.XPATH, self.SEARCH_SELECTORS['CONTENT_DESC']),
                ('XPATH_GENERIC', AppiumBy.XPATH, self.SEARCH_SELECTORS['XPATH_GENERIC']),
            ]:
                try:
                    search_input = self.driver.find_element(method, selector)
                    if search_input.is_displayed():
                        break
                except:
                    continue
            
            if not search_input:
                print("❌ Could not find search input for typing")
                return False
            
            # Clear any existing text
            try:
                search_input.clear()
                time.sleep(0.5)
            except:
                pass
            
            # Type username
            search_input.send_keys(username)
            time.sleep(2)
            print(f"✅ Typed username: {username}")
            
            # Wait for dropdown results, but press enter if no dropdown appears
            time.sleep(3)  # Wait for search suggestions to load
            print("✅ Waiting for search suggestions to appear...")
            
            # Check if dropdown suggestions appeared
            try:
                dropdown_elements = self.driver.find_elements(AppiumBy.ID, "com.twitter.android:id/screenname_item")
                if dropdown_elements and any(el.is_displayed() for el in dropdown_elements):
                    print("✅ Dropdown suggestions found - will use dropdown matching")
                    return True
                else:
                    print("⚠️ No dropdown suggestions found - pressing Enter to search")
                    self.driver.press_keycode(66)  # Enter key
                    time.sleep(3)
                    print("✅ Pressed Enter to search")
                    return True
            except Exception as e:
                print(f"⚠️ Error checking dropdown, pressing Enter as fallback: {e}")
                self.driver.press_keycode(66)  # Enter key
                time.sleep(3)
                print("✅ Pressed Enter to search")
                return True
            
        except Exception as e:
            print(f"❌ User search failed: {e}")
            return False
    
    def find_user_in_dropdown(self, username):
        """Find specific user in search dropdown/suggestions (IMPROVED)"""
        try:
            print(f"👤 Looking for @{username} in dropdown suggestions...")
            
            # Wait a bit more for dropdown to fully load
            time.sleep(2)
            
            # Method 1: Look for exact handle match in screenname_item
            try:
                print(f"   🎯 Looking for exact handle: @{username}")
                handle_elements = self.driver.find_elements(AppiumBy.ID, "com.twitter.android:id/screenname_item")
                for element in handle_elements:
                    if element.is_displayed():
                        handle_text = element.get_attribute('text') or ''
                        print(f"   Found handle: '{handle_text}'")
                        
                        # Check for exact match (with or without @)
                        if handle_text.lower() in [f"@{username.lower()}", username.lower()]:
                            print(f"✅ EXACT MATCH found: '{handle_text}' for @{username}")
                            
                            # Find the parent profile card to click
                            try:
                                # Get all profile cards and find which one contains this exact handle
                                profile_cards = self.driver.find_elements(AppiumBy.ID, "com.twitter.android:id/profile_card")
                                print(f"   Found {len(profile_cards)} profile cards to check")
                                
                                for i, card in enumerate(profile_cards):
                                    if card.is_displayed():
                                        try:
                                            # Get all screenname elements within this card
                                            card_handles = card.find_elements(AppiumBy.ID, "com.twitter.android:id/screenname_item")
                                            for card_handle in card_handles:
                                                card_handle_text = card_handle.get_attribute('text') or ''
                                                if card_handle_text.lower() == handle_text.lower():
                                                    print(f"✅ Found matching profile card {i+1} for @{username}")
                                                    return card
                                        except Exception as e:
                                            print(f"   Error checking card {i+1}: {e}")
                                            continue
                                
                                print(f"   No profile card found containing exact handle, using handle element")
                                return element
                                
                            except Exception as e:
                                print(f"   Error finding profile card: {e}")
                                print("   Using handle element as fallback")
                                return element
                            
            except Exception as e:
                print(f"   ⚠️ Handle search failed: {e}")
            
            # Method 2: Look for display name match
            try:
                print(f"   🎯 Looking for display name containing: {username}")
                name_elements = self.driver.find_elements(AppiumBy.ID, "com.twitter.android:id/name_item")
                for element in name_elements:
                    if element.is_displayed():
                        name_text = element.get_attribute('text') or ''
                        print(f"   Found name: '{name_text}'")
                        
                        # Check if username is part of display name
                        if username.lower() in name_text.lower():
                            print(f"✅ NAME MATCH found: '{name_text}' contains {username}")
                            
                            # Find the profile card
                            try:
                                profile_cards = self.driver.find_elements(AppiumBy.ID, "com.twitter.android:id/profile_card")
                                for card in profile_cards:
                                    if card.is_displayed():
                                        card_text = card.get_attribute('text') or ''
                                        if username.lower() in card_text.lower():
                                            print(f"✅ Found matching profile card via name for {username}")
                                            return card
                            except:
                                return element
                                
            except Exception as e:
                print(f"   ⚠️ Name search failed: {e}")
            
            # Method 3: Direct profile card search with text matching  
            try:
                print(f"   🎯 Searching all profile cards for: {username}")
                profile_cards = self.driver.find_elements(AppiumBy.ID, "com.twitter.android:id/profile_card")
                for i, card in enumerate(profile_cards):
                    if card.is_displayed():
                        try:
                            # Get all text from this profile card
                            card_elements = card.find_elements(AppiumBy.XPATH, ".//*[@text]")
                            card_texts = []
                            for elem in card_elements:
                                text = elem.get_attribute('text') or ''
                                if text:
                                    card_texts.append(text.lower())
                            
                            card_combined = ' '.join(card_texts)
                            print(f"   Profile card {i+1}: {card_combined[:100]}...")
                            
                            # Check if this card contains our username
                            if f"@{username.lower()}" in card_combined or username.lower() in card_combined:
                                print(f"✅ PROFILE CARD MATCH found for @{username}")
                                return card
                                
                        except Exception as e:
                            print(f"   Error reading card {i+1}: {e}")
                            continue
                            
            except Exception as e:
                print(f"   ⚠️ Profile card search failed: {e}")
            
            print(f"❌ Could not find @{username} in dropdown suggestions")
            return None
            
        except Exception as e:
            print(f"❌ Error finding user in dropdown: {e}")
            return None
    
    def find_user_in_search_results(self, username):
        """Find specific user in search results page (fallback method)"""
        try:
            print(f"👤 Looking for @{username} in search results page...")
            
            # Wait for search results to load
            time.sleep(2)
            
            # Method 1: Look for exact username text
            try:
                user_elements = self.driver.find_elements(AppiumBy.XPATH, f"//*[contains(@text, '{username}')]")
                for element in user_elements:
                    if element.is_displayed():
                        element_text = element.get_attribute('text') or ''
                        print(f"✅ Found user element: '{element_text}'")
                        return element
            except Exception as e:
                print(f"   ⚠️ Text search failed: {e}")
            
            # Method 2: Look for @username handle
            try:
                handle_elements = self.driver.find_elements(AppiumBy.XPATH, f"//*[contains(@text, '@{username}')]")
                for element in handle_elements:
                    if element.is_displayed():
                        element_text = element.get_attribute('text') or ''
                        print(f"✅ Found handle element: '{element_text}'")
                        return element
            except Exception as e:
                print(f"   ⚠️ Handle search failed: {e}")
            
            # Method 3: Case-insensitive search
            try:
                partial_elements = self.driver.find_elements(AppiumBy.XPATH, 
                    f"//*[contains(translate(@text, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '{username.lower()}')]")
                for element in partial_elements:
                    if element.is_displayed():
                        element_text = element.get_attribute('text') or ''
                        print(f"✅ Found case-insensitive match: '{element_text}'")
                        return element
            except Exception as e:
                print(f"   ⚠️ Case-insensitive search failed: {e}")
            
            print(f"❌ Could not find @{username} in search results")
            return None
            
        except Exception as e:
            print(f"❌ Error finding user in search results: {e}")
            return None
    
    def reset_search_context(self):
        """Reset search context to ensure clean search state"""
        try:
            print("🔄 Resetting search context for clean search...")
            
            # Step 1: Press back 4x to ensure we're out of any search/profile screens
            print("   🔙 Pressing back 4x to clear any open screens...")
            for i in range(4):
                try:
                    self.driver.back()
                    time.sleep(0.8)
                    print(f"      🔙 Back press {i+1}/4")
                except Exception as e:
                    print(f"      ⚠️ Back press {i+1}/4 failed: {e}")
                    pass
            
            # Step 2: Navigate to home tab first to ensure clean state
            print("   🏠 Navigating to home tab...")
            home_tab_found = False
            for i, selector in enumerate(self.NAV_SELECTORS['HOME_TAB']):
                try:
                    print(f"      Trying home selector {i+1}/{len(self.NAV_SELECTORS['HOME_TAB'])}...")
                    home_tab = self.driver.find_element(AppiumBy.XPATH, selector)
                    if home_tab.is_displayed():
                        home_tab.click()
                        time.sleep(2)
                        print(f"   ✅ Home tab clicked with selector {i+1}")
                        home_tab_found = True
                        break
                except Exception as e:
                    print(f"      Home selector {i+1} failed: {e}")
                    continue
            
            if not home_tab_found:
                print("   Using coordinate fallback for home tab...")
                self.driver.tap([(150, 2200)])  # Home tab coordinates
                time.sleep(2)
                print("   ✅ Home tab via coordinate tap")
            
            # Step 3: Wait a moment for UI to stabilize
            time.sleep(1)
            print("✅ Search context reset complete")
            return True
            
        except Exception as e:
            print(f"❌ Search context reset failed: {e}")
            return False
    
    def follow_user_from_search(self, username):
        """Follow a user from search results with proper search context reset"""
        try:
            print(f"👥 Following user: {username}")
            
            # CRITICAL: Reset search context first to ensure clean search
            if not self.reset_search_context():
                print("⚠️ Search context reset failed, continuing anyway...")
            
            # Search for the user
            if not self.search_user(username):
                return False
            
            # Try dropdown first, then fallback to search results
            print("🔍 Attempting to find user...")
            user_element = None
            
            # Check if dropdown suggestions are present
            try:
                dropdown_elements = self.driver.find_elements(AppiumBy.ID, "com.twitter.android:id/screenname_item")
                if dropdown_elements and any(el.is_displayed() for el in dropdown_elements):
                    print("📋 Using dropdown suggestions")
                    user_element = self.find_user_in_dropdown(username)
                else:
                    print("📄 Using search results page")
                    user_element = self.find_user_in_search_results(username)
            except:
                print("📄 Fallback to search results")
                user_element = self.find_user_in_search_results(username)
            
            if not user_element:
                print("❌ User not found in dropdown or search results")
                return False
            
            # Click on user to go to their profile
            try:
                user_element.click()
                time.sleep(3)
                print("✅ Opened user profile")
            except Exception as e:
                print(f"⚠️ Could not click user element: {e}")
                # Try clicking in the general area
                try:
                    location = user_element.location
                    size = user_element.size
                    x = location['x'] + size['width'] // 2
                    y = location['y'] + size['height'] // 2
                    self.driver.tap([(x, y)])
                    time.sleep(3)
                    print("✅ Opened profile via coordinate tap")
                except Exception as e2:
                    print(f"❌ Profile tap failed: {e2}")
                    return False
            
            # Look for follow button
            follow_success = self.click_follow_button()
            
            if follow_success:
                print(f"🎉 Successfully followed: {username}")
                return True
            else:
                print(f"❌ Failed to follow: {username}")
                return False
                
        except Exception as e:
            print(f"❌ Follow process failed: {e}")
            return False
    
    def click_follow_button(self):
        """Click the follow button on a profile - USING DISCOVERED COORDINATES"""
        try:
            print("👥 Looking for Follow button...")
            
            # Method 1: Try to find by resource-id (most reliable)
            try:
                follow_button = self.driver.find_element(AppiumBy.ID, "com.twitter.android:id/button_bar_follow")
                if follow_button.is_displayed():
                    follow_button.click()
                    print("✅ Follow button clicked via resource-id!")
                    time.sleep(3)
                    return True
            except Exception as e:
                print(f"   ⚠️ Resource-id method failed: {e}")
            
            # Method 2: Use discovered coordinates as backup
            follow_locations = [
                (910, 562, "Follow button (discovered coordinates)"),
                (900, 550, "Follow button (slight adjustment)"),
                (920, 570, "Follow button (alternative)"),
            ]
            
            for x, y, desc in follow_locations:
                try:
                    print(f"   Trying {desc}...")
                    self.driver.tap([(x, y)])
                    time.sleep(3)
                    print(f"✅ Follow attempted at {desc}")
                    return True
                except:
                    continue
            
            print("❌ Could not find Follow button")
            return False
            
        except Exception as e:
            print(f"❌ Error clicking follow button: {e}")
            return False
    
    def read_usernames_from_file(self, file_path=None):
        """Read usernames from usernames.txt file"""
        if file_path is None:
            # Use local config directory within the dashboard project
            import os
            project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            file_path = os.path.join(project_root, "config", "twitter", "usernames.txt")
        try:
            print(f"📖 Reading usernames from: {file_path}")
            with open(file_path, 'r', encoding='utf-8') as f:
                usernames = [line.strip() for line in f.readlines() if line.strip()]
            print(f"✅ Found {len(usernames)} users in file:")
            for i, username in enumerate(usernames, 1):
                print(f"   {i}. @{username}")
            return usernames
        except Exception as e:
            print(f"❌ Error reading usernames file: {e}")
            return []

    def standard_twitter_init(self):
        """Standard initialization: Back 4x → Launch → Scroll Up → Home Tab"""
        print("🔄 STANDARD TWITTER INITIALIZATION")
        print("📋 Sequence: Back 4x → Launch → Scroll Up → Home Tab → Ready")
        
        try:
            # Step 1: Establish Appium connection first
            print("📱 Establishing Appium connection...")
            
            # USE CENTRALIZED DRIVER MANAGER if available
            if DRIVER_MANAGER_AVAILABLE:
                self.driver = get_shared_driver(self.device_id)
                if self.driver:
                    print("✅ Appium connection established via driver manager!")
                else:
                    print("⚠️ Driver manager failed, using direct connection...")
                    options = UiAutomator2Options()
                    options.platform_name = "Android"
                    options.device_name = self.device_id
                    options.automation_name = "UIAutomator2"
                    options.no_reset = True
                    options.full_reset = False
                    options.new_command_timeout = 300
                    
                    self.driver = webdriver.Remote("http://127.0.0.1:4723", options=options)
                    time.sleep(2)
            else:
                options = UiAutomator2Options()
                options.platform_name = "Android"
                options.device_name = self.device_id
                options.automation_name = "UIAutomator2"
                options.no_reset = True
                options.full_reset = False
                options.new_command_timeout = 300
                
                self.driver = webdriver.Remote("http://127.0.0.1:4723", options=options)
                time.sleep(2)
            print("✅ Appium connection established!")
            
            # Step 2: Back 4x to ensure clean state
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
            import subprocess
            result = subprocess.run([
                'adb', '-s', self.device_id, 'shell', 'am', 'force-stop', 'com.twitter.android'
            ], capture_output=True, text=True, timeout=10)
            time.sleep(2)
            
            result = subprocess.run([
                'adb', '-s', self.device_id, 'shell', 'monkey', '-p', 'com.twitter.android', 
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
            
            print("✅ STANDARD INITIALIZATION COMPLETE - Ready for search & follow work!")
            return True
            
        except Exception as e:
            print(f"❌ Initialization failed: {e}")
            return False

    def bulk_follow_users(self, usernames, delay_range=(3, 8)):
        """Follow multiple users with human-like delays"""
        try:
            print(f"👥 Starting bulk follow for {len(usernames)} users...")
            
            # Standard initialization first
            if not self.standard_twitter_init():
                print("❌ Failed to initialize Twitter")
                return None
            
            successful_follows = []
            failed_follows = []
            
            for i, username in enumerate(usernames):
                print(f"\n[{i+1}/{len(usernames)}] Processing: {username}")
                
                # CRITICAL: For users after the first one, ensure search context is completely reset
                if i > 0:
                    print(f"🔄 User #{i+1}: Ensuring clean search context...")
                    if not self.reset_search_context():
                        print("⚠️ Search context reset failed, continuing anyway...")
                
                success = self.follow_user_from_search(username)
                
                if success:
                    successful_follows.append(username)
                    print(f"✅ {username} followed successfully")
                else:
                    failed_follows.append(username)
                    print(f"❌ {username} follow failed")
                
                # Human-like delay between follows
                if i < len(usernames) - 1:  # Don't delay after last user
                    delay = random.randint(delay_range[0], delay_range[1])
                    print(f"⏱️ Waiting {delay}s before next follow...")
                    time.sleep(delay)
                
                # Go back to home occasionally to seem more natural
                if (i + 1) % 5 == 0:
                    try:
                        # Try home tab selectors
                        home_visited = False
                        for selector in self.NAV_SELECTORS['HOME_TAB']:
                            try:
                                home_tab = self.driver.find_element(AppiumBy.XPATH, selector)
                                if home_tab.is_displayed():
                                    home_tab.click()
                                    time.sleep(2)
                                    print("🏠 Briefly visited home feed")
                                    home_visited = True
                                    break
                            except:
                                continue
                        
                        if not home_visited:
                            # Coordinate fallback
                            self.driver.tap([(150, 2200)])
                            time.sleep(2)
                            print("🏠 Home visit via coordinate")
                    except:
                        pass
            
            # Summary
            print(f"\n📊 BULK FOLLOW SUMMARY:")
            print(f"✅ Successful: {len(successful_follows)}/{len(usernames)}")
            print(f"❌ Failed: {len(failed_follows)}/{len(usernames)}")
            
            if successful_follows:
                print(f"✅ Successfully followed: {', '.join(successful_follows)}")
            
            if failed_follows:
                print(f"❌ Failed to follow: {', '.join(failed_follows)}")
            
            return {
                'total': len(usernames),
                'successful': successful_follows,
                'failed': failed_follows,
                'success_rate': len(successful_follows) / len(usernames) * 100
            }
            
        except Exception as e:
            print(f"❌ Bulk follow failed: {e}")
            return None
    
    def disconnect(self):
        """Clean up connection"""
        if self.driver:
            try:
                self.driver.quit()
                print("🔄 Disconnected from Twitter")
            except:
                pass

# Test function
def test_search_follow():
    """Test search and follow functionality"""
    search_follow = TwitterSearchFollow()
    
    try:
        # Use standard initialization instead of connect
        if not search_follow.standard_twitter_init():
            return
        
        # Test bulk follow using usernames.txt file
        print("🧪 Testing bulk follow from usernames.txt...")
        
        # Read usernames from file
        usernames = search_follow.read_usernames_from_file()
        
        if usernames:
            print(f"🚀 Starting bulk follow for {len(usernames)} users...")
            results = search_follow.bulk_follow_users(usernames)
            
            if results:
                print(f"\n📊 BULK FOLLOW RESULTS:")
                print(f"✅ Successfully followed: {results['success_rate']:.1f}% ({len(results['successful'])}/{results['total']})")
                
                if results['successful']:
                    print(f"✅ Successful follows:")
                    for username in results['successful']:
                        print(f"   • @{username}")
                
                if results['failed']:
                    print(f"❌ Failed follows:")
                    for username in results['failed']:
                        print(f"   • @{username}")
            else:
                print("❌ Bulk follow process failed")
        else:
            print("❌ No usernames found in file")
        
    except Exception as e:
        print(f"❌ Test failed: {e}")
    
    finally:
        search_follow.disconnect()

if __name__ == "__main__":
    test_search_follow()