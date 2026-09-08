#!/usr/bin/env python3
"""
Twitter Retweet Module - XML Selector Based
Retweets and likes recent posts from accounts in retweet.txt
"""

import subprocess
import time
import random
import xml.etree.ElementTree as ET
import os
import re

class TwitterRetweetManager:
    def __init__(self):
        # Use local config directory within the dashboard project
        import os
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        self.accounts_file = os.path.join(project_root, "config", "twitter", "retweet.txt")
        
        # FIXED: Use Twitter-specific temp directory to avoid gallery contamination
        self.temp_dir = "/tmp/twitter_automation"
        os.makedirs(self.temp_dir, exist_ok=True)
        
    def run_adb_command(self, command):
        """Execute ADB command"""
        try:
            result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=30)
            return result.returncode == 0, result.stdout.strip()
        except subprocess.TimeoutExpired:
            print("⚠️ ADB command timed out")
            return False, ""
    
    def dump_ui_xml(self, filename="screen_dump.xml"):
        """Dump current UI to XML file - FIXED to avoid device storage buildup"""
        xml_path = f"{self.temp_dir}/{filename}"
        # CRITICAL FIX: Use /data/local/tmp instead of /sdcard to avoid device storage buildup
        device_temp_path = f"/data/local/tmp/{filename}"
        
        success, _ = self.run_adb_command(f"adb shell uiautomator dump {device_temp_path}")
        if success:
            pull_success, _ = self.run_adb_command(f"adb pull {device_temp_path} {xml_path}")
            # IMPORTANT: Clean up device temp file immediately
            self.run_adb_command(f"adb shell rm {device_temp_path}")
            if pull_success:
                return xml_path
        return None
    
    def parse_xml_for_element(self, xml_path, search_criteria):
        """Parse XML and find element matching criteria"""
        try:
            tree = ET.parse(xml_path)
            root = tree.getroot()
            
            for node in root.iter('node'):
                match = True
                for key, value in search_criteria.items():
                    if key == 'text' and node.get('text', '') != value:
                        match = False
                        break
                    elif key == 'content-desc' and node.get('content-desc', '') != value:
                        match = False
                        break
                    elif key == 'resource-id' and node.get('resource-id', '') != value:
                        match = False
                        break
                    elif key == 'contains_text' and value not in node.get('text', ''):
                        match = False
                        break
                    elif key == 'contains_desc' and value not in node.get('content-desc', ''):
                        match = False
                        break
                
                if match:
                    bounds = node.get('bounds', '')
                    if bounds:
                        # Extract coordinates from bounds [x1,y1][x2,y2]
                        coords = re.findall(r'\[(\d+),(\d+)\]', bounds)
                        if len(coords) == 2:
                            x1, y1 = int(coords[0][0]), int(coords[0][1])
                            x2, y2 = int(coords[1][0]), int(coords[1][1])
                            center_x, center_y = (x1 + x2) // 2, (y1 + y2) // 2
                            return center_x, center_y
            return None
        except Exception as e:
            print(f"❌ XML parsing error: {e}")
            return None
    
    def click_element(self, x, y):
        """Click element at coordinates"""
        success, _ = self.run_adb_command(f"adb shell input tap {x} {y}")
        time.sleep(2)
        return success
    
    def type_text(self, text):
        """Type text using ADB input"""
        # Clear any existing text first
        self.run_adb_command("adb shell input keyevent KEYCODE_CTRL_A")
        time.sleep(0.5)
        success, _ = self.run_adb_command(f'adb shell input text "{text}"')
        time.sleep(1)
        return success
    
    def scroll_down(self, duration=1000):
        """Scroll down on screen - Enhanced for more natural human-like scrolling"""
        # HUMAN-LIKE SCROLLING: Add randomization to make it more natural
        start_y = random.randint(1600, 1800)  # Vary starting position 
        scroll_distance = random.randint(1200, 1600)  # Vary scroll distance
        end_y = start_y - scroll_distance
        
        # Ensure we don't scroll too high
        if end_y < 400:
            end_y = 400
        
        # Add slight randomization to duration if not specified
        if duration == 1000:  # Default case
            duration = random.randint(800, 1200)  # Increased minimum for better hold-and-drag
        
        # IMPROVED: Ensure minimum duration for proper hold-and-drag gesture
        min_duration = max(duration, 1000)  # At least 1 second for proper scrolling
        
        success, _ = self.run_adb_command(f"adb shell input swipe 540 {start_y} 540 {end_y} {min_duration}")
        
        # Variable pause time - more human-like
        pause_time = random.uniform(1.5, 3.0)
        time.sleep(pause_time)
        return success
    
    def take_screenshot(self, filename):
        """Take screenshot"""
        screenshot_path = f"{self.temp_dir}/{filename}"
        success, _ = self.run_adb_command(f"adb shell screencap -p > {screenshot_path}")
        return success, screenshot_path
    
    def open_search(self):
        """Open Twitter search - Enhanced with footer reveal by scrolling up"""
        print("🔍 Opening search...")
        
        # Dump current screen
        xml_path = self.dump_ui_xml("retweet_search_open.xml")
        if not xml_path:
            return False
        
        # Method 1: Look for search box first (already on search)
        search_coords = self.parse_xml_for_element(xml_path, {
            'content-desc': 'Search X'
        })
        
        if search_coords:
            print(f"✅ Found search box at {search_coords}")
            return True  # Already on search screen
        
        # Method 2: Look for search tab at bottom (visible)
        search_tab = self.parse_xml_for_element(xml_path, {
            'content-desc': 'Search and Explore'
        })
        
        if search_tab:
            print(f"🔍 Found search tab at {search_tab}, clicking...")
            self.click_element(search_tab[0], search_tab[1])
            time.sleep(3)
            return True
        
        # Method 3: CRITICAL FIX - Scroll UP to reveal footer navigation (as user specified)
        print("🔍 Scrolling UP to reveal footer search button...")
        self.run_adb_command("adb shell input swipe 540 1800 540 2200 400")  # Scroll UP
        time.sleep(2)
        
        xml_path3 = self.dump_ui_xml("after_scroll_up_footer.xml")
        search_tab = self.parse_xml_for_element(xml_path3, {
            'content-desc': 'Search and Explore'
        })
        
        if search_tab:
            print(f"🔍 Found search tab after scrolling UP at {search_tab}")
            self.click_element(search_tab[0], search_tab[1])
            time.sleep(3)
            return True
        
        # Method 4: Try gentle upward swipe to show bottom nav
        print("🔍 Trying gentle upward swipe to show footer...")
        self.run_adb_command("adb shell input swipe 540 1900 540 2100 300")
        time.sleep(2)
        
        xml_path4 = self.dump_ui_xml("after_gentle_up_swipe.xml")
        search_tab = self.parse_xml_for_element(xml_path4, {
            'content-desc': 'Search and Explore'
        })
        
        if search_tab:
            print(f"🔍 Found search tab after gentle swipe at {search_tab}")
            self.click_element(search_tab[0], search_tab[1])
            time.sleep(3)
            return True
        
        # Method 4: Try to use navigation drawer (hamburger menu)
        print("🔍 Trying navigation drawer...")
        nav_button = self.parse_xml_for_element(xml_path, {
            'content-desc': 'Show navigation drawer'
        })
        
        if nav_button:
            print(f"🔍 Opening navigation drawer at {nav_button}")
            self.click_element(nav_button[0], nav_button[1])
            time.sleep(3)
            
            # Look for search in drawer
            drawer_xml = self.dump_ui_xml("nav_drawer_opened.xml")
            search_in_drawer = self.parse_xml_for_element(drawer_xml, {
                'contains_text': 'Search'
            })
            
            if search_in_drawer:
                print(f"🔍 Found search in drawer at {search_in_drawer}")
                self.click_element(search_in_drawer[0], search_in_drawer[1])
                time.sleep(3)
                return True
        
        # Method 5: Create search manually by using direct URL navigation
        print("🔍 Final attempt: Using direct search navigation...")
        # Try typing in a search area if available
        self.run_adb_command("adb shell input keyevent KEYCODE_SEARCH")
        time.sleep(2)
        
        xml_path4 = self.dump_ui_xml("after_search_key.xml")
        search_coords = self.parse_xml_for_element(xml_path4, {
            'content-desc': 'Search X'
        })
        
        if search_coords:
            print(f"✅ Search activated via search key at {search_coords}")
            return True
        
        print("❌ Could not find or access search functionality")
        return False
    
    def search_account(self, username):
        """Search for a specific account with EXACT username matching"""
        print(f"🔍 Searching for @{username} with exact matching...")
        
        # Make sure we click on the search box first
        xml_path = self.dump_ui_xml("before_search_type.xml")
        search_coords = self.parse_xml_for_element(xml_path, {
            'content-desc': 'Search X'
        })
        
        if search_coords:
            print(f"📱 Clicking search box at {search_coords}")
            self.click_element(search_coords[0], search_coords[1])
            time.sleep(2)
        
        # Clear any existing text and type the username
        self.run_adb_command("adb shell input keyevent KEYCODE_CTRL_A")
        time.sleep(1)
        if not self.type_text(username):
            return False
        
        # Take screenshot after typing
        self.take_screenshot(f"retweet_search_{username}.png")
        
        # Dump UI after typing
        xml_path = self.dump_ui_xml(f"retweet_search_{username}.xml")
        if not xml_path:
            return False
        
        # Look for the user in search results - wait for results to load
        time.sleep(3)  # Wait for search results
        
        # Update XML dump after results load
        xml_path = self.dump_ui_xml(f"retweet_results_{username}.xml")
        
        # CRITICAL: Find EXACT username match only - look for "Go to @username"
        exact_match_coords = self.find_exact_username_match(xml_path, username)
        
        if exact_match_coords:
            print(f"✅ Found EXACT match for @{username} at {exact_match_coords}, clicking...")
            return self.click_element(exact_match_coords[0], exact_match_coords[1])
        
        print(f"❌ Could not find EXACT match for @{username} in search results")
        return False
    
    def find_exact_username_match(self, xml_path, target_username):
        """Find exact username match in search results, not similar usernames"""
        try:
            tree = ET.parse(xml_path)
            root = tree.getroot()
            
            print(f"🎯 Looking for EXACT match: 'Go to @{target_username}' (not similar usernames)")
            
            for node in root.iter('node'):
                text = node.get('text', '').strip()
                
                # Look specifically for "Go to @username" text that exactly matches
                if text == f"Go to @{target_username}":
                    print(f"✅ EXACT MATCH FOUND: '{text}'")
                    bounds = node.get('bounds', '')
                    if bounds:
                        coords = re.findall(r'\[(\d+),(\d+)\]', bounds)
                        if len(coords) == 2:
                            x1, y1 = int(coords[0][0]), int(coords[0][1])
                            x2, y2 = int(coords[1][0]), int(coords[1][1])
                            center_x, center_y = (x1 + x2) // 2, (y1 + y2) // 2
                            return center_x, center_y
                
                # Also check for elements that contain the exact username pattern
                elif f"@{target_username}" in text:
                    # Additional validation to ensure it's the exact match, not similar
                    # Check if it's exactly "@username" or "Go to @username" 
                    if text == f"@{target_username}" or text.startswith(f"@{target_username}\n") or text.endswith(f"@{target_username}"):
                        print(f"✅ EXACT USERNAME MATCH FOUND: '{text}'")
                        bounds = node.get('bounds', '')
                        if bounds:
                            coords = re.findall(r'\[(\d+),(\d+)\]', bounds)
                            if len(coords) == 2:
                                x1, y1 = int(coords[0][0]), int(coords[0][1])
                                x2, y2 = int(coords[1][0]), int(coords[1][1])
                                center_x, center_y = (x1 + x2) // 2, (y1 + y2) // 2
                                return center_x, center_y
                    else:
                        print(f"⚠️ SIMILAR USERNAME DETECTED (SKIPPING): '{text}' - not exact match for @{target_username}")
            
            # If no exact match found, try scrolling to find more results
            print(f"🔍 No exact match visible, attempting scroll to find more results...")
            return self.scroll_and_find_exact_match(target_username)
            
        except Exception as e:
            print(f"❌ Error in exact username matching: {e}")
            return None
    
    def scroll_and_find_exact_match(self, target_username, max_scrolls=3):
        """Scroll search results to find exact username match - Enhanced natural scrolling"""
        for scroll_attempt in range(max_scrolls):
            print(f"📜 Scroll attempt {scroll_attempt + 1}/{max_scrolls} to find exact match...")
            
            # NATURAL SEARCH SCROLLING: More effective for finding users
            scroll_distance = random.randint(800, 1200)  # Variable scroll for search results
            scroll_duration = random.randint(400, 700)   # Natural speed variation
            start_y = random.randint(1400, 1600)
            end_y = start_y - scroll_distance
            
            # Ensure reasonable boundaries
            if end_y < 500:
                end_y = 500
            
            self.run_adb_command(f"adb shell input swipe 540 {start_y} 540 {end_y} {scroll_duration}")
            time.sleep(random.uniform(2.0, 3.0))  # Natural pause for content loading
            
            # Dump UI after scroll
            xml_path = self.dump_ui_xml(f"scroll_{scroll_attempt}_{target_username}.xml")
            if xml_path:
                exact_match = self.find_exact_username_match(xml_path, target_username)
                if exact_match:
                    return exact_match
        
        print(f"❌ Could not find exact match for @{target_username} after {max_scrolls} scrolls")
        return None
    
    def go_to_profile(self):
        """Navigate to user profile after search"""
        print("👤 Going to profile...")
        time.sleep(3)  # Wait for profile to load
        
        self.take_screenshot("retweet_profile_loaded.png")
        return True
    
    def find_and_interact_with_posts(self, username):
        """Find posts and retweet/like them with duplicate detection - Enhanced profile scrolling"""
        print(f"📝 Looking for posts from @{username}...")
        print(f"🎯 TARGET: Find and process 2-3 recent posts, scrolling down through profile")
        
        posts_interacted = 0
        max_posts = 5  # Process 5 recent posts total (initial + 2-3 more from scrolling)
        scroll_attempts = 0
        max_scrolls = 8  # More scrolls to ensure we find recent posts properly
        posts_found_this_scroll = 0
        
        print(f"🔍 Starting profile scan - will scroll down to find {max_posts} recent posts...")
        
        while posts_interacted < max_posts and scroll_attempts < max_scrolls:
            # Dump current screen
            xml_path = self.dump_ui_xml(f"retweet_posts_scan_{scroll_attempts}.xml")
            if not xml_path:
                break
            
            # Look for both retweet and like buttons in current view
            retweet_buttons = self.find_retweet_buttons(xml_path)
            like_buttons = self.find_like_buttons(xml_path)
            
            print(f"📊 Scroll {scroll_attempts + 1}: Found {len(retweet_buttons)} retweet buttons, {len(like_buttons)} like buttons")
            
            # Process buttons one by one
            buttons_processed_this_scroll = 0
            available_interactions = min(len(retweet_buttons), len(like_buttons))
            
            print(f"🎯 Processing {available_interactions} posts in current view (Total progress: {posts_interacted}/{max_posts})")
            
            for i in range(available_interactions):
                if posts_interacted >= max_posts:
                    break
                    
                print(f"\n🔄 Attempting interaction {posts_interacted + 1}/5...")
                
                # Check if this post is already retweeted/liked before attempting
                already_retweeted = self.check_if_already_retweeted(xml_path, i)
                already_liked = self.check_if_already_liked(xml_path, i)
                
                # CRITICAL: Skip both retweet AND like if already interacted with
                if already_retweeted and already_liked:
                    print(f"⏭️ Post {i+1} already fully interacted with - skipping entirely")
                    posts_interacted += 1
                    continue
                
                # ENHANCED ANTI-UNRETWEET PROTECTION - Multiple safety checks
                retweet_success = False
                if i < len(retweet_buttons) and not already_retweeted:
                    rt_coords = retweet_buttons[i]
                    print(f"🔄 SAFETY CHECK: Re-analyzing before clicking retweet button at {rt_coords}")
                    
                    # CRITICAL: Double-check retweet status right before clicking
                    fresh_xml = self.dump_ui_xml(f"pre_click_safety_{scroll_attempts}_{i}.xml")
                    if fresh_xml:
                        double_check_retweeted = self.check_if_already_retweeted(fresh_xml, i)
                        if double_check_retweeted:
                            print(f"🛡️ SAFETY ABORT: Post {i+1} detected as already retweeted in final check - SKIPPING to prevent unretweet")
                            retweet_success = True  # Skip to avoid unretweet
                        else:
                            print(f"✅ SAFETY CLEAR: Post {i+1} confirmed not retweeted - proceeding with retweet")
                            
                            if self.click_element(rt_coords[0], rt_coords[1]):
                                time.sleep(3)  # Wait for menu
                                
                                # Check for repost menu with enhanced detection
                                menu_xml = self.dump_ui_xml(f"retweet_menu_{scroll_attempts}_{i}.xml")
                                if menu_xml:
                                    print("🔍 Analyzing repost menu options...")
                                    
                                    # Enhanced detection for menu options
                                    repost_coords = None
                                    undo_coords = None
                                    
                                    # Method 1: Look for exact "Repost" text
                                    repost_coords = self.parse_xml_for_element(menu_xml, {'text': 'Repost'})
                                    if not repost_coords:
                                        repost_coords = self.parse_xml_for_element(menu_xml, {'contains_text': 'Repost'})
                                    
                                    # Method 2: Look for "Undo repost" or "Unretweet" text
                                    undo_coords = self.parse_xml_for_element(menu_xml, {'text': 'Undo repost'})
                                    if not undo_coords:
                                        undo_coords = self.parse_xml_for_element(menu_xml, {'contains_text': 'Undo repost'})
                                    if not undo_coords:
                                        undo_coords = self.parse_xml_for_element(menu_xml, {'contains_text': 'Unretweet'})
                                    
                                    print(f"   📋 Menu analysis: Repost={bool(repost_coords)}, Undo={bool(undo_coords)}")
                                    
                                    if repost_coords and not undo_coords:
                                        print(f"✅ Found 'Repost' option - post not retweeted yet, proceeding...")
                                        self.click_element(repost_coords[0], repost_coords[1])
                                        print(f"✅ Successfully retweeted post {i+1}")
                                        retweet_success = True
                                        time.sleep(3)
                                        
                                        # CRITICAL: Ensure we're still on profile after repost
                                        self.ensure_on_profile(username)
                                    elif undo_coords:
                                        print("🛡️ CRITICAL SAFETY: Found 'Undo repost' - post already retweeted! PRESSING BACK to avoid unretweet")
                                        self.run_adb_command("adb shell input keyevent KEYCODE_BACK")
                                        time.sleep(2)
                                        retweet_success = True  # Already retweeted, avoided unretweet
                                    else:
                                        print("⚠️ SAFETY: No clear menu options detected - pressing back to avoid issues")
                                        self.run_adb_command("adb shell input keyevent KEYCODE_BACK")
                                        time.sleep(2)
                                        retweet_success = True  # Better safe than sorry
                    else:
                        print("❌ Could not perform safety check - skipping to avoid issues")
                        retweet_success = True
                elif already_retweeted:
                    print(f"🛡️ PROTECTED: Post {i+1} already retweeted - completely skipping interaction to prevent unretweet")
                    retweet_success = True  # Count as success since already done
                
                # Try to like (only if not already liked)
                like_success = False  
                if i < len(like_buttons) and not already_liked:
                    like_coords = like_buttons[i]
                    print(f"❤️ Clicking like button at {like_coords}")
                    
                    if self.click_element(like_coords[0], like_coords[1]):
                        print(f"✅ Liked post")
                        like_success = True
                        time.sleep(2)
                        
                        # CRITICAL: Ensure we're still on profile after like
                        self.ensure_on_profile(username)
                elif already_liked:
                    print(f"⏭️ Post {i+1} already liked - skipping like")
                    like_success = True  # Count as success since already done
                
                # Skip unnecessary navigation checks - already on profile timeline
                
                # Count as successful if either action worked (including already done)
                if retweet_success or like_success:
                    posts_interacted += 1
                    buttons_processed_this_scroll += 1
                
                time.sleep(random.uniform(2, 4))  # Random delay between posts
            
            # ENHANCED HUMAN-LIKE PROFILE SCROLLING - Much more natural and effective
            if scroll_attempts < max_scrolls - 1:  # Don't scroll on last attempt
                if buttons_processed_this_scroll > 0:
                    print(f"📜 Scroll {scroll_attempts + 1}/{max_scrolls}: Found {buttons_processed_this_scroll} posts, scrolling naturally to find more posts...")
                    # HUMAN-LIKE SCROLLING: Vary scroll distances and speeds randomly
                    scroll_distance = random.randint(1200, 1800)  # Natural variation
                    scroll_duration = random.randint(400, 800)    # Variable scroll speed
                    self.run_adb_command(f"adb shell input swipe 540 1600 540 {1600 - scroll_distance} {scroll_duration}")
                    time.sleep(random.uniform(1.5, 3.0))  # Natural pause after scroll
                else:
                    print(f"📜 Scroll {scroll_attempts + 1}/{max_scrolls}: No posts found, performing stronger scroll to find content...")
                    # STRONGER SCROLLING: When no posts found, scroll more aggressively
                    scroll_distance = random.randint(1800, 2400)  # Larger scroll to move through content
                    scroll_duration = random.randint(300, 600)    # Faster scroll for exploration
                    self.run_adb_command(f"adb shell input swipe 540 1800 540 {1800 - scroll_distance} {scroll_duration}")
                    time.sleep(random.uniform(2.0, 4.0))  # Longer pause to let content load
                
                # After scrolling, take screenshot to see new content
                self.take_screenshot(f"profile_after_scroll_{scroll_attempts + 1}_{username}.png")
            else:
                print(f"📜 Reached max scrolls ({max_scrolls}) - completed profile scan")
            
            scroll_attempts += 1
            posts_found_this_scroll = buttons_processed_this_scroll
        
        print(f"\n✅ Completed interaction with {posts_interacted} posts from @{username}")
        return posts_interacted > 0
    
    def ensure_on_profile(self, username):
        """Ensure we're still on the user's profile, navigate back if needed"""
        try:
            # Check current screen
            xml_path = self.dump_ui_xml("profile_check.xml")
            if not xml_path:
                return
            
            # Look for profile indicators
            tree = ET.parse(xml_path)
            root = tree.getroot()
            
            # Check if we're on a profile (look for follow/following buttons or @username)
            on_profile = False
            for node in root.iter('node'):
                text = node.get('text', '').lower()
                content_desc = node.get('content-desc', '').lower()
                
                # Look for profile indicators
                if (f"@{username.lower()}" in text or 
                    "follow" in text or "following" in text or
                    "profile" in content_desc):
                    on_profile = True
                    break
            
            if not on_profile:
                print(f"🔄 Not on {username}'s profile - pressing back to return")
                # Press back 2-3 times to ensure we return to profile
                for _ in range(3):
                    self.run_adb_command("adb shell input keyevent KEYCODE_BACK")
                    time.sleep(1)
                print(f"✅ Returned to {username}'s profile")
            else:
                print(f"✅ Confirmed still on {username}'s profile")
                
        except Exception as e:
            print(f"⚠️ Profile check failed: {e} - continuing anyway")
    
    def check_if_already_retweeted(self, xml_path, post_index):
        """Check if a specific post has already been retweeted by analyzing tweet content"""
        try:
            tree = ET.parse(xml_path)
            root = tree.getroot()
            
            # Method 1: Check tweet row content descriptions for "You retweeted" or similar
            tweet_rows = []
            for node in root.iter('node'):
                resource_id = node.get('resource-id', '')
                content_desc = node.get('content-desc', '')
                
                if 'row' in resource_id and 'reposts' in content_desc:
                    tweet_rows.append(content_desc)
            
            # Check the specific post index
            if post_index < len(tweet_rows):
                tweet_desc = tweet_rows[post_index]
                if any(indicator in tweet_desc.lower() for indicator in [
                    'you retweeted', 'you reposted', 'you shared'
                ]):
                    print(f"   🟢 DETECTED: Post {post_index + 1} already retweeted via content description")
                    return True
            
            # Method 2: Check retweet button content-desc for "(reposted)" indicator
            retweet_buttons = []
            for node in root.iter('node'):
                resource_id = node.get('resource-id', '')
                if resource_id == 'com.twitter.android:id/inline_retweet':
                    selected = node.get('selected', 'false')
                    checked = node.get('checked', 'false')
                    content_desc = node.get('content-desc', '')
                    
                    retweet_buttons.append({
                        'selected': selected,
                        'checked': checked,
                        'content_desc': content_desc
                    })
            
            # Check the specific button state - KEY DETECTION: "(reposted)" in content-desc
            if post_index < len(retweet_buttons):
                button_info = retweet_buttons[post_index]
                content_desc = button_info['content_desc'].lower()
                
                if (button_info['selected'] == 'true' or 
                    button_info['checked'] == 'true' or
                    '(reposted)' in content_desc or
                    'repost (reposted)' in content_desc or
                    'retweeted' in content_desc):
                    print(f"   🟢 DETECTED: Post {post_index + 1} already retweeted via button state")
                    print(f"        Button content-desc: \"{button_info['content_desc']}\"")
                    return True
            
            print(f"   ⭕ Post {post_index + 1} not retweeted yet")
            return False
            
        except Exception as e:
            print(f"❌ Error checking retweet status: {e}")
            return False
    
    def check_if_already_liked(self, xml_path, post_index):
        """Check if a specific post has already been liked"""
        try:
            tree = ET.parse(xml_path)
            root = tree.getroot()
            
            # Method 1: Check tweet row content descriptions for "You liked" or similar
            tweet_rows = []
            for node in root.iter('node'):
                resource_id = node.get('resource-id', '')
                content_desc = node.get('content-desc', '')
                
                if 'row' in resource_id and 'likes' in content_desc:
                    tweet_rows.append(content_desc)
            
            # Check the specific post index
            if post_index < len(tweet_rows):
                tweet_desc = tweet_rows[post_index]
                if any(indicator in tweet_desc.lower() for indicator in [
                    'you liked', 'you favorited'
                ]):
                    print(f"   💖 DETECTED: Post {post_index + 1} already liked via content description")
                    return True
            
            # Method 2: Check like button states
            like_buttons = []
            for node in root.iter('node'):
                resource_id = node.get('resource-id', '')
                if resource_id == 'com.twitter.android:id/inline_like':
                    selected = node.get('selected', 'false')
                    checked = node.get('checked', 'false')
                    content_desc = node.get('content-desc', '')
                    
                    like_buttons.append({
                        'selected': selected,
                        'checked': checked,
                        'content_desc': content_desc
                    })
            
            # Check the specific button state
            if post_index < len(like_buttons):
                button_info = like_buttons[post_index]
                
                if (button_info['selected'] == 'true' or 
                    button_info['checked'] == 'true' or
                    'liked' in button_info['content_desc'].lower()):
                    print(f"   💖 DETECTED: Post {post_index + 1} already liked via button state")
                    return True
            
            print(f"   ⭕ Post {post_index + 1} not liked yet")
            return False
            
        except Exception as e:
            print(f"❌ Error checking like status: {e}")
            return False
    
    def find_retweet_buttons(self, xml_path):
        """Find all retweet buttons in current XML"""
        try:
            tree = ET.parse(xml_path)
            root = tree.getroot()
            
            retweet_buttons = []
            
            for node in root.iter('node'):
                # Look for retweet button indicators - be very specific
                resource_id = node.get('resource-id', '')
                
                # Only look for the exact inline_retweet resource ID
                if resource_id == 'com.twitter.android:id/inline_retweet':
                    bounds = node.get('bounds', '')
                    if bounds:
                        coords = re.findall(r'\[(\d+),(\d+)\]', bounds)
                        if len(coords) == 2:
                            x1, y1 = int(coords[0][0]), int(coords[0][1])
                            x2, y2 = int(coords[1][0]), int(coords[1][1])
                            center_x, center_y = (x1 + x2) // 2, (y1 + y2) // 2
                            retweet_buttons.append((center_x, center_y))
            
            print(f"🔍 Found {len(retweet_buttons)} retweet buttons")
            return retweet_buttons
            
        except Exception as e:
            print(f"❌ Error finding retweet buttons: {e}")
            return []
    
    def find_like_buttons(self, xml_path):
        """Find all like buttons in current XML"""
        try:
            tree = ET.parse(xml_path)
            root = tree.getroot()
            
            like_buttons = []
            
            for node in root.iter('node'):
                # Look for like button indicators - be very specific
                resource_id = node.get('resource-id', '')
                
                # Only look for the exact inline_like resource ID
                if resource_id == 'com.twitter.android:id/inline_like':
                    bounds = node.get('bounds', '')
                    if bounds:
                        coords = re.findall(r'\[(\d+),(\d+)\]', bounds)
                        if len(coords) == 2:
                            x1, y1 = int(coords[0][0]), int(coords[0][1])
                            x2, y2 = int(coords[1][0]), int(coords[1][1])
                            center_x, center_y = (x1 + x2) // 2, (y1 + y2) // 2
                            like_buttons.append((center_x, center_y))
            
            print(f"❤️ Found {len(like_buttons)} like buttons")
            return like_buttons
            
        except Exception as e:
            print(f"❌ Error finding like buttons: {e}")
            return []
    
    def like_current_post(self, xml_path, post_number):
        """Like the current post"""
        print(f"❤️ Trying to like post {post_number + 1}...")
        
        # Look for like button
        like_coords = self.parse_xml_for_element(xml_path, {
            'contains_desc': 'like'
        })
        
        if not like_coords:
            # Alternative search for like button
            like_coords = self.parse_xml_for_element(xml_path, {
                'contains_desc': 'Like'
            })
        
        if like_coords:
            self.click_element(like_coords[0], like_coords[1])
            print(f"✅ Liked post {post_number + 1}")
            return True
        
        print(f"❌ Could not find like button for post {post_number + 1}")
        return False
    
    def go_back_to_search_simple(self):
        """Go back to search screen with single back press"""
        print("🔙 Going back to search (single back press)...")
        
        # Press back button ONCE only
        self.run_adb_command("adb shell input keyevent KEYCODE_BACK")
        time.sleep(3)
        
        # Verify we're back on profile or search
        xml_path = self.dump_ui_xml("after_single_back.xml")
        if xml_path:
            print("✅ Back navigation completed")
            return True
        
        return True  # Assume success
    
    def go_back_to_search(self):
        """Go back to search screen (legacy method for account switching)"""
        print("🔙 Going back to search...")
        
        attempts = 0
        max_attempts = 5
        
        while attempts < max_attempts:
            # Press back button
            self.run_adb_command("adb shell input keyevent KEYCODE_BACK")
            time.sleep(3)
            
            # Check current screen
            xml_path = self.dump_ui_xml(f"back_navigation_{attempts}.xml")
            if xml_path:
                # Look for search box to confirm we're on search screen
                search_coords = self.parse_xml_for_element(xml_path, {
                    'content-desc': 'Search X'
                })
                
                if not search_coords:
                    search_coords = self.parse_xml_for_element(xml_path, {
                        'contains_text': 'Search'
                    })
                
                if search_coords:
                    print(f"✅ Successfully navigated back to search screen")
                    return True
                
                # Check if we're on main timeline - need to go to search tab
                search_tab = self.parse_xml_for_element(xml_path, {
                    'content-desc': 'Search and Explore'
                })
                
                if search_tab:
                    print("🔍 Found search tab, clicking it...")
                    self.click_element(search_tab[0], search_tab[1])
                    time.sleep(2)
                    return True
            
            attempts += 1
            print(f"🔙 Back attempt {attempts}/{max_attempts}")
        
        print("❌ Could not navigate back to search screen")
        return False
    
    def process_account(self, username):
        """Process a single account - search, go to profile, interact with posts"""
        print(f"\n{'='*50}")
        print(f"🎯 Processing account: @{username}")
        print(f"{'='*50}")
        
        # Open search
        if not self.open_search():
            print(f"❌ Failed to open search for @{username}")
            return False
        
        # Search for account
        if not self.search_account(username):
            print(f"❌ Failed to search for @{username}")
            return False
        
        # Go to profile
        if not self.go_to_profile():
            print(f"❌ Failed to go to profile for @{username}")
            return False
        
        # Find and interact with posts
        success = self.find_and_interact_with_posts(username)
        
        # Go back to search for next account (use proper search navigation)
        self.go_back_to_search()
        
        return success
    
    def standard_twitter_init(self):
        """Standard initialization: Back 4x → Launch → Scroll Up → Home Tab"""
        print("🔄 STANDARD TWITTER INITIALIZATION")
        print("📋 Sequence: Back 4x → Launch → Scroll Up → Home Tab → Ready")
        
        try:
            # Step 1: Back 4x to ensure clean state
            print("🔙 Step 1/4: Pressing back 4x to clear any menus/screens...")
            for i in range(4):
                print(f"   🔙 Back press {i+1}/4")
                self.run_adb_command("adb shell input keyevent KEYCODE_BACK")
                time.sleep(1)
            
            # Step 2: Launch Twitter fresh
            print("🚀 Step 2/4: Launching Twitter fresh...")
            self.run_adb_command("adb shell am force-stop com.twitter.android")
            time.sleep(2)
            self.run_adb_command("adb shell monkey -p com.twitter.android -c android.intent.category.LAUNCHER 1")
            time.sleep(5)
            print("✅ Twitter launched")
            
            # Step 3: Scroll up slightly to reveal navigation
            print("📜 Step 3/4: Scrolling up slightly to reveal navigation...")
            self.run_adb_command("adb shell input swipe 540 800 540 900 300")  # Gentle scroll up
            time.sleep(2)
            print("✅ Scrolled up to reveal navigation")
            
            # Step 4: Click home tab to ensure we're on home feed
            print("🏠 Step 4/4: Clicking home tab...")
            self.run_adb_command("adb shell input tap 150 2200")  # Home tab coordinates
            time.sleep(3)
            print("✅ On home feed")
            
            print("✅ STANDARD INITIALIZATION COMPLETE - Ready for retweet work!")
            return True
            
        except Exception as e:
            print(f"❌ Initialization failed: {e}")
            return False

    def initialize_module(self):
        """Initialize module: back 4x then launch Twitter"""
        print("🔄 Module initialization: Back 4x then launch Twitter...")
        
        # Press back 4 times to ensure clean state
        for i in range(4):
            print(f"   🔙 Back press {i+1}/4")
            self.run_adb_command("adb shell input keyevent KEYCODE_BACK")
            time.sleep(1)
        
        print("📱 Launching Twitter...")
        # Try multiple launch methods
        
        # Method 1: Direct package launch
        success1, _ = self.run_adb_command("adb shell monkey -p com.twitter.android -c android.intent.category.LAUNCHER 1")
        if success1:
            print("✅ Twitter launched via monkey command")
            time.sleep(5)
            return True
        
        # Method 2: Intent launch
        success2, _ = self.run_adb_command("adb shell am start -n com.twitter.android/.StartActivity")
        if success2:
            print("✅ Twitter launched via StartActivity")
            time.sleep(5)
            return True
            
        # Method 3: Generic intent
        success3, _ = self.run_adb_command("adb shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.twitter.android")
        if success3:
            print("✅ Twitter launched via generic intent")
            time.sleep(5)
            return True
        
        print("❌ Failed to launch Twitter with all methods")
        return False

    def run_retweet_module(self):
        """Main function to run the retweet module"""
        print("🚀 Starting Twitter Retweet Module")
        print("📱 Using XML selector-based automation with proper initialization")
        
        # CRITICAL: Standard initialization
        if not self.standard_twitter_init():
            print("❌ Failed to initialize Twitter")
            return False
        
        # Read accounts from file
        try:
            with open(self.accounts_file, 'r') as f:
                accounts = [line.strip() for line in f if line.strip()]
            
            print(f"📋 Found {len(accounts)} accounts to process:")
            for i, account in enumerate(accounts, 1):
                print(f"   {i}. @{account}")
            
        except FileNotFoundError:
            print(f"❌ Could not find {self.accounts_file}")
            return False
        
        # Process each account
        successful_accounts = 0
        
        for account in accounts:
            try:
                if self.process_account(account):
                    successful_accounts += 1
                    print(f"✅ Successfully processed @{account}")
                else:
                    print(f"❌ Failed to process @{account}")
                
                # Random delay between accounts
                time.sleep(random.uniform(10, 20))
                
            except KeyboardInterrupt:
                print("\n⏹️ Stopped by user")
                break
            except Exception as e:
                print(f"❌ Error processing @{account}: {e}")
                continue
        
        print(f"\n🎉 Retweet module completed!")
        print(f"✅ Successfully processed: {successful_accounts}/{len(accounts)} accounts")
        
        return successful_accounts > 0

def main():
    """Main function"""
    manager = TwitterRetweetManager()
    return manager.run_retweet_module()

if __name__ == "__main__":
    success = main()
    exit(0 if success else 1)