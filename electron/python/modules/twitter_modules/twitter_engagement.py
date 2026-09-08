#!/usr/bin/env python3
"""
❤️ TWITTER/X ENGAGEMENT MODULE - ROBUST IMPLEMENTATION  
Advanced Twitter engagement with coordinate-based tapping and crash recovery
Based on proven Instagram engagement patterns with Twitter-specific adaptations
"""

from appium import webdriver
from appium.options.android import UiAutomator2Options
from appium.webdriver.common.appiumby import AppiumBy
import time
import random
import subprocess

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

# Import Twitter launcher - adjusted for dashboard integration
try:
    from .twitter_launcher import TwitterLauncher
except ImportError:
    try:
        from twitter_launcher import TwitterLauncher
    except ImportError:
        print("⚠️ Twitter launcher module not available")
        TwitterLauncher = None

class TwitterEngager:
    def __init__(self, device_id="1A121FDF60082H", **kwargs):
        self.device_id = device_id
        self.driver = None
        
        # Ignore any extra parameters (like profile_id) for compatibility
        if kwargs:
            print(f"⚠️ Ignoring extra parameters: {list(kwargs.keys())}")
        
        # 🎯 TWITTER ENGAGEMENT SELECTORS (from comprehensive element analysis)
        self.SELECTORS = {
            'REPLY': "com.twitter.android:id/inline_reply",
            'RETWEET': "com.twitter.android:id/inline_retweet", 
            'LIKE': "com.twitter.android:id/inline_like",
            'SHARE': "com.twitter.android:id/inline_twitter_share",
            'BOOKMARK': "com.twitter.android:id/inline_bookmark"
        }
        
        # 📍 FALLBACK COORDINATES (actual centers from UI analysis)
        self.FALLBACK_COORDS = {
            'REPLY': (241, 1079),        # Actual center from inspection
            'RETWEET': (411, 1079),      # Actual center from inspection
            'LIKE': (594, 1079),         # Actual center from inspection
            'SHARE': (1002, 1079),       # Actual center from inspection
            'BOOKMARK': (913, 1079),     # Actual center from inspection
            'FOLLOW': (950, 800),        # Follow button (estimated)
            'TWEET_COMPOSE': (950, 2200) # Tweet compose button (estimated)
        }
        
        # 🔄 SCROLL PARAMETERS  
        self.SCROLL_PARAMS = {
            'start_x': 540,              # Center X
            'start_y': 1800,             # Start Y (bottom)
            'end_y': 600,                # End Y (top)
            'duration': 800              # Swipe duration
        }
        
        # 🔄 RECOVERY SETTINGS
        self.max_retries = 3
        self.recovery_delay = 2
        
        # ⏱️ HUMAN-LIKE VIEWING TIMES
        self.viewing_times = {
            'quick_scroll': (0.3, 0.8),      # Quick scroll past (70% chance)
            'brief_view': (1.5, 3.0),        # Brief pause (20% chance) 
            'engaged_view': (3.0, 5.5),      # Reading content (8% chance)
            'deep_view': (5.0, 8.0),         # Very interested (2% chance)
            'random_pause': (0.5, 2.0)       # Random micro-pauses
        }
        
        # 🎯 ENGAGEMENT RATES (Realistic human percentages)
        self.engagement_rates = {
            'like_chance_min': 0.12,    # 12% minimum like rate
            'like_chance_max': 0.18,    # 18% maximum like rate
            'comment_chance_min': 0.08, # 8% minimum comment rate
            'comment_chance_max': 0.13, # 13% maximum comment rate
            'pause_chance': 0.35,       # 35% chance for random pause
            'micro_pause': 0.65,        # 65% chance for tiny hesitation
            'heavy_scroll_chance': 0.25, # 25% chance for heavy/fast scrolling
            'light_scroll_chance': 0.20  # 20% chance for light/slow scrolling
        }
        
        # 📜 SCROLL BEHAVIOR PATTERNS (More human variety)
        self.scroll_patterns = {
            'normal_scroll': (600, 1200),     # Normal scroll distance (55% chance)
            'small_scroll': (300, 600),       # Small peek ahead (20% chance) 
            'big_scroll': (1200, 1800),       # Skip past content (10% chance)
            'heavy_scroll': (1800, 2400),     # Heavy fast scroll (25% when heavy mode)
            'light_scroll': (200, 500),       # Light slow scroll (20% when light mode)
            'back_scroll': (200, 400),        # Scroll back up slightly (5% chance)
            'micro_scroll': (100, 300)        # Tiny adjustment scroll
        }
        
        # 🎯 SCROLL SPEED VARIATIONS (More realistic human behavior)
        self.scroll_speeds = {
            'very_slow': (800, 1200),      # Slow reading scroll
            'slow': (600, 800),            # Careful scroll  
            'normal': (400, 600),          # Normal speed
            'fast': (250, 400),            # Quick scroll
            'very_fast': (150, 300)        # Speed scroll
        }
        
        # 💬 REPLY TEMPLATES - Load from comments.txt file
        self.reply_templates = self.load_comments_from_file()
        if not self.reply_templates:
            # Fallback templates if file loading fails
            self.reply_templates = [
                "This! 🎯",
                "Great point! 👏", 
                "So true! 💯",
                "Thanks for sharing! 🙏",
                "Exactly! ✨"
            ]
    
    def load_comments_from_file(self, file_path=None):
        """📝 Load custom comments from comments.txt file"""
        if file_path is None:
            # Use local config directory within the dashboard project
            import os
            project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            file_path = os.path.join(project_root, "config", "twitter", "comments.txt")
        try:
            print(f"📖 Loading comments from: {file_path}")
            with open(file_path, 'r', encoding='utf-8') as f:
                comments = [line.strip() for line in f.readlines() if line.strip()]
            
            if comments:
                print(f"✅ Loaded {len(comments)} custom comments from file")
                print(f"📝 Sample comments: {comments[:3] if len(comments) >= 3 else comments}")
                return comments
            else:
                print("⚠️ Comments file is empty, using fallback templates")
                return []
                
        except FileNotFoundError:
            print(f"❌ Comments file not found at {file_path}, using fallback templates")
            return []
        except Exception as e:
            print(f"❌ Error loading comments file: {e}, using fallback templates")
            return []
        
    def _improved_scroll(self, start_x, start_y, end_x, end_y, duration):
        """📜 Improved scrolling with proper hold-and-drag using ADB commands"""
        try:
            # Ensure minimum duration for proper drag gesture
            min_duration = max(duration, 1000)  # At least 1 second for proper hold-and-drag
            
            # Use ADB input swipe with proper duration for hold-and-drag
            device_id = getattr(self, 'device_id', '1A121FDF60082H')
            cmd = [
                'adb', '-s', device_id, 'shell', 'input', 'swipe', 
                str(start_x), str(start_y), str(end_x), str(end_y), str(min_duration)
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            
            if result.returncode == 0:
                return True
            else:
                print(f"⚠️ Scroll command failed: {result.stderr}")
                # Fallback to driver swipe if available
                if hasattr(self, 'driver') and self.driver:
                    self.driver.swipe(start_x, start_y, end_x, end_y, min_duration)
                return False
                
        except Exception as e:
            print(f"❌ Improved scroll failed: {e}")
            # Final fallback to driver swipe
            try:
                if hasattr(self, 'driver') and self.driver:
                    self.driver.swipe(start_x, start_y, end_x, end_y, duration)
                return True
            except:
                return False
    
    def _handle_appium_error(self, error, operation_name="operation"):
        """Handle Appium errors with automatic crash recovery"""
        if CRASH_RECOVERY_AVAILABLE:
            print(f"🚨 Error during {operation_name}: {error}")
            print("🔄 Attempting automatic crash recovery...")
            
            # First, close the old session if it exists
            if hasattr(self, 'driver') and self.driver:
                try:
                    self.driver.quit()
                except:
                    pass
                self.driver = None
            
            success, _ = auto_recover_from_crash(error, self.device_id, None)
            if success:
                print(f"✅ Crash recovery successful for {operation_name}")
                # Try to reconnect with new session
                if hasattr(self, 'connect'):
                    return self.connect()
            else:
                print(f"❌ Crash recovery failed for {operation_name}")
        
        return False

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
            print("✅ Appium connection ready!")
            
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
            
            # Step 3: Launch Twitter fresh
            print("🚀 Step 2/4: Launching Twitter fresh...")
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
            
            # Step 4: Scroll up slightly to reveal navigation
            print("📜 Step 3/4: Scrolling up slightly to reveal navigation...")
            self.driver.swipe(540, 800, 540, 900, 300)  # Gentle scroll up
            time.sleep(2)
            print("✅ Scrolled up to reveal navigation")
            
            # Step 5: Click home tab to ensure we're on home feed
            print("🏠 Step 4/4: Clicking home tab...")
            self.driver.tap([(150, 2200)])  # Home tab coordinates
            time.sleep(3)
            print("✅ On home feed")
            
            print("✅ STANDARD INITIALIZATION COMPLETE - Ready for engagement work!")
            return True
            
        except Exception as e:
            print(f"❌ Initialization failed: {e}")
            return False

    def connect(self):
        """Connect to Twitter and navigate to Following feed for engagement"""
        try:
            print("📱 Connecting to Twitter for Following feed engagement...")
            
            # Standard initialization
            if not self.standard_twitter_init():
                print("❌ Failed to initialize Twitter")
                return False
            
            # Navigate to Following feed (your preferred tab)
            print("👥 Navigating to Following feed...")
            time.sleep(2)  # Additional wait for UI to stabilize
            
            if self._click_following_tab():
                print("✅ Successfully switched to Following feed!")
                time.sleep(3)  # Wait for Following feed to load
                print("🎯 Ready for engagement with your proven selectors!")
                return True
            else:
                print("❌ Failed to switch to Following feed")
                return False
                
        except Exception as e:
            print(f"❌ Connection failed: {e}")
            # Try crash recovery
            if self._handle_appium_error(e, "connect"):
                return True
            return False
    
    def _click_following_tab(self):
        """Click the Following tab to switch from For You feed"""
        try:
            # From TWITTER_SELECTORS_MASTER.md - proven selector
            following_selectors = [
                "//*[@content-desc='Following']",          # Primary selector
                "//*[@text='Following']",                  # Text fallback  
                "//*[contains(@content-desc, 'Following')]" # Partial match
            ]
            
            for selector in following_selectors:
                try:
                    following_tab = self.driver.find_element(AppiumBy.XPATH, selector)
                    if following_tab.is_displayed():
                        following_tab.click()
                        print("✅ Clicked Following tab")
                        return True
                except:
                    continue
            
            # Coordinate fallback (from master selectors: 799, 338)
            print("⚠️ Using coordinate fallback for Following tab")
            self.driver.tap([(799, 338)])
            return True
            
        except Exception as e:
            print(f"❌ Failed to click Following tab: {e}")
            return False
    
    def disconnect(self):
        """Disconnect from Twitter"""
        if self.driver:
            self.driver.quit()
            print("🔄 Disconnected")
    
    def _find_engagement_buttons(self):
        """🎯 Find engagement buttons using reliable resource IDs"""
        try:
            buttons = {}
            
            for action, resource_id in self.SELECTORS.items():
                try:
                    # Try resource ID selector first (most reliable)
                    elements = self.driver.find_elements(AppiumBy.ID, resource_id)
                    if elements and elements[0].is_displayed():
                        buttons[action] = elements[0]
                        continue
                    
                    # Fallback to XPath with resource-id
                    xpath = f"//*[@resource-id='{resource_id}']"
                    elements = self.driver.find_elements(AppiumBy.XPATH, xpath)
                    if elements and elements[0].is_displayed():
                        buttons[action] = elements[0]
                        
                except Exception as e:
                    print(f"⚠️ Could not find {action} button: {e}")
                    continue
                    
            print(f"✅ Found {len(buttons)} engagement buttons: {list(buttons.keys())}")
            return buttons
            
        except Exception as e:
            print(f"❌ Error finding engagement buttons: {e}")
            return {}
    
    def _click_engagement_button(self, action_name):
        """🎯 Click engagement button using reliable selectors with coordinate fallback"""
        try:
            # Try reliable resource ID selectors first
            buttons = self._find_engagement_buttons()
            if action_name in buttons:
                try:
                    buttons[action_name].click()
                    print(f"✅ Clicked {action_name} button [element selector]")
                    return True
                except Exception as e:
                    print(f"⚠️ Element click failed for {action_name}, trying coordinate: {e}")
            
            # Fallback to coordinate tapping with actual positions
            return self._tap_coordinate_fallback(action_name)
            
        except Exception as e:
            print(f"❌ {action_name} click failed: {e}")
            return False
    
    def _tap_coordinate_fallback(self, action_name):
        """📍 Tap engagement button by coordinate (fallback method)"""
        try:
            if action_name in self.FALLBACK_COORDS:
                x, y = self.FALLBACK_COORDS[action_name]
                self.driver.tap([(x, y)])
                print(f"✅ Tapped {action_name} at ({x}, {y}) [coordinate fallback]")
                return True
            return False
        except Exception as e:
            print(f"❌ Coordinate tap failed for {action_name}: {e}")
            return False
    
    def _robust_action(self, action_name, action_type='click', retries=None):
        """🔄 Perform action with auto-recovery on UiAutomator2 crashes"""
        if retries is None:
            retries = self.max_retries
                
        for attempt in range(retries):
            try:
                if action_type == 'click':
                    success = self._click_engagement_button(action_name)
                    if success:
                        return True
                    
            except Exception as e:
                print(f"⚠️ {action_name} attempt {attempt + 1}/{retries} failed: {e}")
                # Try crash recovery on last attempt
                if attempt == retries - 1:
                    if self._handle_appium_error(e, action_name):
                        # Retry once more after recovery
                        try:
                            return self._click_engagement_button(action_name)
                        except:
                            pass
                else:
                    time.sleep(self.recovery_delay)
                    
        return False
    
    def detect_ad(self):
        """🚫 Fast ad detection - max 1 second"""
        scan_start = time.time()
        
        try:
            # Method 1: Check for "Promoted" text (Twitter ads)
            self.driver.find_element(AppiumBy.XPATH, "//*[@text='Promoted']")
            print(f"🚫 AD DETECTED: Promoted content (scan: {time.time() - scan_start:.2f}s)")
            return True
            
        except:
            pass
            
        try:
            # Method 2: Check for "Ad" text
            self.driver.find_element(AppiumBy.XPATH, "//*[@text='Ad']")
            print(f"🚫 AD DETECTED: Ad content (scan: {time.time() - scan_start:.2f}s)")
            return True
            
        except:
            pass
            
        try:
            # Method 3: Check for promoted tweet indicators
            self.driver.find_element(AppiumBy.XPATH, "//*[contains(@content-desc, 'Promoted')]")
            print(f"🚫 AD DETECTED: Promoted in desc (scan: {time.time() - scan_start:.2f}s)")
            return True
            
        except:
            pass
        
        # No ad detected
        if time.time() - scan_start > 0.5:
            print(f"⚠️ Ad scan took {time.time() - scan_start:.2f}s (should be <0.5s)")
        
        return False
    
    def skip_ad(self):
        """🚫 Skip advertisement by scrolling"""
        print("🚫 Skipping Twitter ad...")
        self._scroll_feed()
        time.sleep(0.5)
        return True
    
    def _scroll_feed(self):
        """📱 Scroll Twitter feed down"""
        try:
            params = self.SCROLL_PARAMS
            self.driver.swipe(
                params['start_x'], 
                params['start_y'], 
                params['start_x'], 
                params['end_y'], 
                params['duration']
            )
            return True
        except Exception as e:
            print(f"❌ Scroll failed: {e}")
            return False
    
    def _choose_viewing_time(self):
        """⏱️ Choose human-like viewing time"""
        # Realistic percentages: 70% quick scroll, 20% brief, 8% engaged, 2% deep
        rand = random.random()
        if rand < 0.70:
            view_type = 'quick_scroll'
        elif rand < 0.90:
            view_type = 'brief_view'  
        elif rand < 0.98:
            view_type = 'engaged_view'
        else:
            view_type = 'deep_view'
            
        min_time, max_time = self.viewing_times[view_type]
        return random.uniform(min_time, max_time), view_type
    
    def _should_engage(self):
        """🎯 Decide if we should engage with current tweet - Dynamic rates"""
        # Dynamic engagement rates that vary per session
        current_like_rate = random.uniform(
            self.engagement_rates['like_chance_min'], 
            self.engagement_rates['like_chance_max']
        )
        current_comment_rate = random.uniform(
            self.engagement_rates['comment_chance_min'], 
            self.engagement_rates['comment_chance_max']
        )
        
        # Calculate scroll-only rate (remaining percentage)
        scroll_only_rate = 1.0 - (current_like_rate + current_comment_rate)
        
        rand = random.random()
        
        if rand < scroll_only_rate:
            return None  # Just scroll past
        elif rand < (scroll_only_rate + current_like_rate):
            return 'like'
        elif rand < (scroll_only_rate + current_like_rate + current_comment_rate):
            return 'comment'
        else:
            return None  # Fallback to scroll
    
    def _human_scroll_behavior(self):
        """📜 Advanced human-like scrolling with varied patterns and speeds"""
        # Determine scroll intensity mode first
        intensity_rand = random.random()
        
        if intensity_rand < self.engagement_rates['heavy_scroll_chance']:
            # Heavy/fast scrolling mode (25% chance)
            scroll_options = ['heavy_scroll', 'big_scroll', 'normal_scroll']
            speed_options = ['fast', 'very_fast']
            intensity_mode = 'heavy'
        elif intensity_rand < (self.engagement_rates['heavy_scroll_chance'] + self.engagement_rates['light_scroll_chance']):
            # Light/slow scrolling mode (20% chance) 
            scroll_options = ['light_scroll', 'small_scroll', 'micro_scroll']
            speed_options = ['slow', 'very_slow']
            intensity_mode = 'light'
        else:
            # Normal scrolling mode (55% chance)
            scroll_options = ['normal_scroll', 'small_scroll', 'big_scroll']
            speed_options = ['normal', 'slow', 'fast']
            intensity_mode = 'normal'
        
        # Choose specific scroll pattern based on mode
        scroll_pattern_rand = random.random()
        
        if scroll_pattern_rand < 0.65:
            # Primary scroll pattern for this mode
            scroll_pattern = scroll_options[0]
        elif scroll_pattern_rand < 0.85:
            # Secondary scroll pattern
            scroll_pattern = scroll_options[1] if len(scroll_options) > 1 else scroll_options[0]
        elif scroll_pattern_rand < 0.95:
            # Tertiary scroll pattern or big skip
            if len(scroll_options) > 2:
                scroll_pattern = scroll_options[2]
            else:
                scroll_pattern = 'big_scroll'
        else:
            # Back scroll (5% chance) - human curiosity
            scroll_distance = -random.randint(*self.scroll_patterns['back_scroll'])
            scroll_type = 'back'
            speed_type = 'normal'
            duration = random.randint(*self.scroll_speeds['normal'])
            
            start_y = 1400
            end_y = start_y - scroll_distance
            
            try:
                # Use improved hold-and-drag for back scroll too
                self._improved_scroll(540, start_y, 540, end_y, duration)
                print(f"📜 {intensity_mode} {scroll_type}: {scroll_distance}px in {duration}ms")
            except Exception as e:
                print(f"❌ Back scroll failed: {e}")
            return
        
        # Get scroll distance and speed
        scroll_distance = random.randint(*self.scroll_patterns[scroll_pattern])
        speed_type = random.choice(speed_options)
        duration = random.randint(*self.scroll_speeds[speed_type])
        
        # Execute scroll
        start_y = 1400  # Middle of screen
        end_y = start_y - scroll_distance
        
        try:
            # Use improved hold-and-drag scrolling instead of quick swipe
            self._improved_scroll(540, start_y, 540, end_y, duration)
            print(f"📜 {intensity_mode} {scroll_pattern}: {scroll_distance}px in {duration}ms ({speed_type} speed)")
            
            # Micro-pause based on intensity (varied chances)
            micro_pause_chance = {
                'heavy': 0.35,    # Less pauses when heavy scrolling
                'light': 0.80,    # More pauses when light scrolling  
                'normal': 0.65    # Normal pause frequency
            }
            
            if random.random() < micro_pause_chance[intensity_mode]:
                # Varied micro-pause durations based on intensity
                if intensity_mode == 'heavy':
                    micro_pause = random.uniform(0.1, 0.3)  # Shorter pauses
                elif intensity_mode == 'light':
                    micro_pause = random.uniform(0.3, 0.8)  # Longer pauses
                else:
                    micro_pause = random.uniform(0.1, 0.5)  # Normal pauses
                    
                time.sleep(micro_pause)
                print(f"   ⏸️ {intensity_mode} micro-pause: {micro_pause:.1f}s")
                
        except Exception as e:
            print(f"❌ Scroll failed: {e}")
    
    def _random_pause_behavior(self):
        """⏸️ Random human pauses while scrolling"""
        if random.random() < self.engagement_rates['pause_chance']:
            pause_time = random.uniform(*self.viewing_times['random_pause'])
            print(f"⏸️ Random pause: {pause_time:.1f}s")
            time.sleep(pause_time)
    
    def _choose_engagement_action(self, focus_on_replies=False):
        """🎯 Choose engagement action type"""
        if focus_on_replies:
            # 50% reply, 40% like, 10% retweet
            rand = random.random()
            if rand < 0.5:
                return "reply"
            elif rand < 0.9:
                return "like"
            else:
                return "retweet"
        else:
            # Normal distribution: 60% like, 25% reply, 15% retweet
            rand = random.random()
            if rand < 0.6:
                return "like"
            elif rand < 0.85:
                return "reply"
            else:
                return "retweet"
    
    def engage_with_feed(self, scroll_sessions=15, session_duration=(300, 600)):
        """🎯 Human-like Following feed browsing with random engagement"""
        try:
            print(f"👥 Starting human-like Following feed browsing...")
            print("🚀 Workflow: Back 4x → Launch Twitter → Following tab → Natural Browsing")
            print(f"📊 Dynamic engagement rates: 12-18% likes, 8-13% comments, 70-80% scroll-only")
            
            if not self.driver:
                if not self.connect():
                    return False
            
            likes_made = 0
            comments_made = 0
            scrolls_made = 0
            total_session_time = random.randint(*session_duration)
            
            print(f"📱 Starting {scroll_sessions} scroll actions over ~{total_session_time}s session...")
            
            session_start = time.time()
            
            for scroll_num in range(scroll_sessions):
                current_time = time.time() - session_start
                print(f"\n📜 [{scroll_num+1}/{scroll_sessions}] Session time: {current_time:.0f}s/{total_session_time}s")
                
                # Check if we should stop the session
                if current_time >= total_session_time:
                    print(f"⏰ Session time limit reached ({total_session_time}s)")
                    break
                
                # Check for ads
                if self.detect_ad():
                    print("🚫 Ad detected - scrolling past...")
                    self._human_scroll_behavior()
                    continue
                
                # Human viewing behavior
                view_time, view_type = self._choose_viewing_time()
                print(f"👀 {view_type}: viewing for {view_time:.1f}s")
                time.sleep(view_time)
                
                # Decide on engagement
                engagement_action = self._should_engage()
                
                if engagement_action == 'like':
                    print("❤️ Attempting to like tweet...")
                    if self._like_tweet():
                        likes_made += 1
                        print(f"✅ Like successful! ({likes_made} total likes)")
                        # Longer pause after engagement 
                        pause = random.uniform(2.0, 4.5)
                        print(f"⏱️ Post-engagement pause: {pause:.1f}s")
                        time.sleep(pause)
                    else:
                        print("❌ Like failed")
                        # SIMPLE TWITTER RELAUNCH
                        print("🔄 Relaunching Twitter after failure...")
                        subprocess.run(['adb', '-s', self.device_id, 'shell', 'am', 'force-stop', 'com.twitter.android'], capture_output=True)
                        time.sleep(1)
                        subprocess.run(['adb', '-s', self.device_id, 'shell', 'monkey', '-p', 'com.twitter.android', '-c', 'android.intent.category.LAUNCHER', '1'], capture_output=True)
                        time.sleep(3)
                        print("✅ Twitter relaunched, continuing...")
                        
                elif engagement_action == 'comment':
                    print("💬 Attempting to comment...")
                    if self._reply_to_tweet():
                        comments_made += 1
                        print(f"✅ Comment successful! ({comments_made} total comments)")
                        # Longer pause after comment
                        pause = random.uniform(4.0, 8.0)
                        print(f"⏱️ Post-comment pause: {pause:.1f}s")
                        time.sleep(pause)
                    else:
                        print("❌ Comment failed")
                        # SIMPLE TWITTER RELAUNCH
                        print("🔄 Relaunching Twitter after failure...")
                        subprocess.run(['adb', '-s', self.device_id, 'shell', 'am', 'force-stop', 'com.twitter.android'], capture_output=True)
                        time.sleep(1)
                        subprocess.run(['adb', '-s', self.device_id, 'shell', 'monkey', '-p', 'com.twitter.android', '-c', 'android.intent.category.LAUNCHER', '1'], capture_output=True)
                        time.sleep(3)
                        print("✅ Twitter relaunched, continuing...")
                        
                else:
                    print("📜 Just scrolling past...")
                
                # Random pause before scrolling
                self._random_pause_behavior()
                
                # Human-like scrolling
                self._human_scroll_behavior()
                scrolls_made += 1
                
                # Random delay between actions (human pacing)
                action_delay = random.uniform(0.5, 2.0)
                time.sleep(action_delay)
            
            # Final session summary
            total_time = time.time() - session_start
            engagement_rate = ((likes_made + comments_made) / scroll_sessions) * 100 if scroll_sessions > 0 else 0
            
            print(f"\n📊 HUMAN BROWSING SESSION SUMMARY:")
            print(f"⏰ Total time: {total_time:.0f}s")
            print(f"📜 Scrolls made: {scrolls_made}")
            print(f"❤️ Likes made: {likes_made}")
            print(f"💬 Comments made: {comments_made}")
            print(f"🎯 Engagement rate: {engagement_rate:.1f}%")
            print(f"👥 Feed: Following tab (natural human behavior)")
            
            return True
            
        except Exception as e:
            print(f"❌ Human browsing session failed: {e}")
            return self._handle_appium_error(e, "engage_with_feed")
    
    def _like_all_visible_tweets(self):
        """❤️ Like ALL visible tweets on timeline using resource-IDs (skip already liked)"""
        try:
            print("❤️ Finding ALL visible like buttons...")
            
            # Find all visible like buttons using resource-ID
            like_elements = self.driver.find_elements(AppiumBy.ID, 'com.twitter.android:id/inline_like')
            visible_likes = [elem for elem in like_elements if elem.is_displayed()]
            
            if not visible_likes:
                print("❌ No visible like buttons found")
                return 0
            
            print(f"🎯 Found {len(visible_likes)} posts to analyze for liking")
            likes_made = 0
            already_liked = 0
            skipped = 0
            
            # Check each post and decide whether to like
            for i, like_button in enumerate(visible_likes):
                try:
                    # Check if already liked (selected="true" means already liked)
                    is_already_liked = like_button.get_attribute('selected') == 'true'
                    
                    if is_already_liked:
                        already_liked += 1
                        print(f"   🔴 Post {i+1}/{len(visible_likes)} already liked - skipping")
                        continue
                    
                    # 30-60% chance to like each unlikes visible post
                    if random.random() < random.uniform(0.3, 0.6):
                        like_button.click()
                        likes_made += 1
                        print(f"   ✅ Liked post {i+1}/{len(visible_likes)} [RESOURCE_ID]")
                        
                        # Human-like pause between likes
                        pause = random.uniform(0.5, 1.5)
                        time.sleep(pause)
                        
                    else:
                        skipped += 1
                        print(f"   👀 Skipped post {i+1}/{len(visible_likes)} (random choice)")
                        
                except Exception as e:
                    print(f"   ⚠️ Failed to process post {i+1}: {e}")
                    continue
            
            print(f"✅ Engagement summary: {likes_made} liked, {already_liked} already liked, {skipped} skipped")
            return likes_made
            
        except Exception as e:
            print(f"❌ Like all tweets failed: {e}")
            return 0

    def _retweet_all_visible_tweets(self):
        """🔄 Retweet ALL visible tweets on timeline using resource-IDs (skip already retweeted)"""
        try:
            print("🔄 Finding ALL visible retweet buttons...")
            
            # Find all visible retweet buttons using resource-ID
            retweet_elements = self.driver.find_elements(AppiumBy.ID, 'com.twitter.android:id/inline_retweet')
            visible_retweets = [elem for elem in retweet_elements if elem.is_displayed()]
            
            if not visible_retweets:
                print("❌ No visible retweet buttons found")
                return 0
            
            print(f"🎯 Found {len(visible_retweets)} posts to analyze for retweeting")
            retweets_made = 0
            already_retweeted = 0
            skipped = 0
            
            # Check each post and decide whether to retweet
            for i, retweet_button in enumerate(visible_retweets):
                try:
                    # Check if already retweeted (selected="true" means already retweeted)
                    is_already_retweeted = retweet_button.get_attribute('selected') == 'true'
                    
                    if is_already_retweeted:
                        already_retweeted += 1
                        print(f"   🔴 Post {i+1}/{len(visible_retweets)} already retweeted - skipping")
                        continue
                    
                    # 10-30% chance to retweet each non-retweeted visible post (more selective)
                    if random.random() < random.uniform(0.1, 0.3):
                        retweet_button.click()
                        time.sleep(1)
                        
                        # Handle retweet confirmation popup if needed
                        try:
                            confirm_button = self.driver.find_element(AppiumBy.XPATH, "//*[@text='Repost']")
                            confirm_button.click()
                            retweets_made += 1
                            print(f"   ✅ Retweeted post {i+1}/{len(visible_retweets)} [CONFIRMED]")
                        except:
                            # Maybe direct retweet without confirmation
                            retweets_made += 1
                            print(f"   ✅ Retweeted post {i+1}/{len(visible_retweets)} [DIRECT]")
                        
                        # Human-like pause between retweets
                        pause = random.uniform(1.0, 2.5)
                        time.sleep(pause)
                        
                    else:
                        skipped += 1
                        print(f"   👀 Skipped retweet {i+1}/{len(visible_retweets)} (random choice)")
                        
                except Exception as e:
                    print(f"   ⚠️ Failed to process post {i+1}: {e}")
                    continue
            
            print(f"✅ Retweet summary: {retweets_made} retweeted, {already_retweeted} already retweeted, {skipped} skipped")
            return retweets_made
            
        except Exception as e:
            print(f"❌ Retweet all tweets failed: {e}")
            return 0

    def _like_tweet(self):
        """❤️ Like tweets - legacy method for compatibility"""
        return self._like_all_visible_tweets() > 0
    
    def _reply_to_tweet(self):
        """💬 Reply to current tweet - YOUR SPECIFIC WORKFLOW"""
        try:
            print("💬 Starting reply process...")
            
            # Step 1: Click the comment/reply selector (same as REPLY button)
            print("   🎯 Clicking comment selector...")
            if not self._robust_action('REPLY'):
                print("❌ Could not click comment selector")
                return False
            
            # Step 2: Wait for reply interface to load (increased timing)
            print("   ⏳ Waiting for comment interface to fully load...")
            time.sleep(4.0)  # Increased from 1.5s to 4.0s for full interface loading
            
            # Step 3: Start typing immediately after clicking (as per your instruction)
            print("   ✍️ Typing reply immediately...")
            reply_text = random.choice(self.reply_templates)
            
            # Find text input and type immediately
            text_input_found = False
            text_selectors = [
                '//android.widget.EditText',                    # Generic EditText (most common)
                '//*[contains(@hint, "Tweet your reply")]',     # Twitter reply hint
                '//*[contains(@hint, "Post your reply")]',      # Alternative hint
                '//*[contains(@content-desc, "compose")]'       # Compose content-desc
            ]
            
            for selector in text_selectors:
                try:
                    text_input = self.driver.find_element(AppiumBy.XPATH, selector)
                    if text_input.is_displayed():
                        text_input.click()  # Make sure it's focused
                        time.sleep(0.5)
                        text_input.send_keys(reply_text)
                        text_input_found = True
                        print(f"   ✅ Typed: {reply_text}")
                        break
                except:
                    continue
            
            if not text_input_found:
                print("❌ Could not find text input after clicking comment")
                self._go_back()
                return False
            
            # Step 4: Click the 'Reply' button (as per your instruction)
            print("   📤 Looking for Reply button...")
            print("   ⏳ Waiting for Reply button to appear after typing...")
            time.sleep(3.0)  # Increased from 1s to 3s for Reply button to appear
            
            # Look for Reply button specifically - CORRECT SELECTORS DISCOVERED
            reply_button_selectors = [
                ('RESOURCE_ID', AppiumBy.ID, 'com.twitter.android:id/button_tweet'),  # ✅ CORRECT - discovered selector
                ('TEXT', AppiumBy.XPATH, "//android.widget.Button[@text='REPLY']"),   # ✅ CORRECT - uppercase REPLY
                ('COORDINATE', None, (951, 201))  # ✅ CORRECT - discovered coordinates
            ]
            
            reply_sent = False
            for selector_name, method, selector in reply_button_selectors:
                try:
                    if method:
                        reply_button = self.driver.find_element(method, selector)
                        if reply_button.is_displayed() and reply_button.is_enabled():
                            reply_button.click()
                            print(f"   ✅ Clicked Reply button [{selector_name}]: {reply_text}")
                            time.sleep(3)  # Wait for reply to be sent
                            reply_sent = True
                            break
                    else:
                        # Coordinate tap
                        self.driver.tap([selector])
                        print(f"   ✅ Tapped Reply button [COORDINATE]: {reply_text}")
                        time.sleep(3)
                        reply_sent = True
                        break
                except Exception as e:
                    print(f"   ⚠️ {selector_name} failed: {e}")
                    continue
            
            if not reply_sent:
                print("❌ Could not find Reply button")
                self._go_back()
                return False
            
            print(f"💬 Reply sent successfully: {reply_text}")
            return True
            
        except Exception as e:
            print(f"❌ Reply failed: {e}")
            self._go_back()
            return False
    
    def _retweet_tweet(self):
        """🔄 Retweet current tweet"""
        try:
            # Click retweet button
            if not self._robust_action('RETWEET'):
                return False
            
            time.sleep(1.5)
            
            # Handle retweet confirmation if it appears
            confirmation_selectors = [
                '//android.widget.Button[contains(@text, "Repost")]',
                '//android.widget.Button[contains(@text, "Retweet")]',
                '//*[contains(@content-desc, "Repost") and contains(@content-desc, "button")]'
            ]
            
            for selector in confirmation_selectors:
                try:
                    confirm_button = self.driver.find_element(AppiumBy.XPATH, selector)
                    confirm_button.click()
                    print("🔄 Tweet retweeted")
                    time.sleep(1)
                    return True
                except:
                    continue
            
            # If no confirmation dialog, retweet might have succeeded
            print("🔄 Retweet action completed (no confirmation needed)")
            return True
            
        except Exception as e:
            print(f"❌ Retweet failed: {e}")
            return False
    
    def perform_retweets(self, retweet_count):
        """🔄 Perform specified number of retweets"""
        try:
            print(f"🔄 Starting {retweet_count} retweets...")
            
            if not self.driver:
                if not self.connect():
                    return False
            
            successful_retweets = 0
            total_attempts = 0
            max_attempts = retweet_count * 3
            
            while successful_retweets < retweet_count and total_attempts < max_attempts:
                total_attempts += 1
                
                # Check for ad
                if self.detect_ad():
                    self.skip_ad()
                    continue
                
                # View the tweet briefly
                view_time = random.uniform(1.5, 3.0)
                time.sleep(view_time)
                
                # Attempt retweet
                if self._retweet_tweet():
                    successful_retweets += 1
                    print(f"✅ Retweet {successful_retweets}/{retweet_count} completed")
                    
                    # Longer delay after retweet
                    delay = random.uniform(4, 7)
                    time.sleep(delay)
                
                # Scroll to next tweet
                self._scroll_feed()
                time.sleep(random.uniform(1.5, 2.5))
            
            success_rate = (successful_retweets / total_attempts) * 100 if total_attempts > 0 else 0
            print(f"✅ Retweets completed: {successful_retweets}/{retweet_count} ({success_rate:.1f}% rate)")
            return successful_retweets > 0
            
        except Exception as e:
            print(f"❌ Retweets failed: {e}")
            return self._handle_appium_error(e, "perform_retweets")
    
    def _go_back(self):
        """⬅️ Press back button"""
        try:
            self.driver.back()
            time.sleep(1)
        except:
            pass
    
    def _auto_recover_twitter(self):
        """🔄 Auto-recovery: Relaunch Twitter when engagement fails"""
        try:
            print("🔄 AUTO-RECOVERY: Attempting to relaunch Twitter after failure...")
            
            # Step 1: Force close Twitter
            subprocess.run([
                'adb', '-s', self.device_id, 'shell', 'am', 'force-stop', 'com.twitter.android'
            ], capture_output=True, text=True, timeout=10)
            time.sleep(2)
            
            # Step 2: Launch Twitter fresh
            result = subprocess.run([
                'adb', '-s', self.device_id, 'shell', 'monkey', '-p', 'com.twitter.android', 
                '-c', 'android.intent.category.LAUNCHER', '1'
            ], capture_output=True, text=True, timeout=15)
            
            if result.returncode == 0:
                print("✅ Twitter relaunched successfully")
                time.sleep(5)  # Wait for app to load
                return True
            else:
                print("❌ Twitter relaunch failed")
                return False
                
        except Exception as e:
            print(f"❌ Auto-recovery failed: {e}")
            return False
    
    def cleanup(self):
        """Clean up resources"""
        try:
            if self.driver:
                self.driver.quit()
                self.driver = None
        except:
            pass
    
    def __del__(self):
        """Destructor to ensure cleanup"""
        try:
            self.cleanup()
        except:
            pass


# Test function
def test_twitter_engagement():
    """Test Twitter engagement functionality"""
    import sys
    
    if len(sys.argv) > 1:
        device_id = sys.argv[1]
    else:
        result = subprocess.run(['adb', 'devices'], capture_output=True, text=True)
        devices = [line.split('\t')[0] for line in result.stdout.split('\n')[1:] if '\tdevice' in line]
        device_id = devices[0] if devices else None
    
    if not device_id:
        print("❌ No device connected")
        return
    
    engager = TwitterEngager(device_id)
    
    print(f"🔍 Testing engagement with device: {device_id}")
    
    # Test connection using your specific workflow
    if engager.connect():
        print("✅ Connected to Following feed")
        
        print("\n🧪 Testing your specific engagement workflow:")
        print("   ✅ Back 4x → Launch Twitter → Following tab → Engage")
        
        # Test human-like engagement on Following feed 
        print("🎯 Testing human-like browsing with random engagement...")
        if engager.engage_with_feed(scroll_sessions=15, session_duration=(300, 600)):
            print("✅ Human-like Following feed engagement successful!")
        else:
            print("❌ Following feed engagement failed")
        
    else:
        print("❌ Connection to Following feed failed")
    
    engager.cleanup()


if __name__ == "__main__":
    test_twitter_engagement()