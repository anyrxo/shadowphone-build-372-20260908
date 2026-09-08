#!/usr/bin/env python3
"""
🔄 INSTAGRAM REPOST MODULE
Repost content from your other accounts to cross-promote

This module searches for specified usernames, visits their profiles,
and likes/reposts their latest posts.
"""

import subprocess
import time
import random
import os

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

class InstagramReposter:
    """Handles reposting content from other accounts"""
    
    # ✅ VERIFIED COORDINATES (Dec 29, 2024)
    COORDS = {
        # Navigation
        'home_tab': (108, 2274),
        'search_tab': (756, 2274),
        'search_box': (540, 199),
        
        # Search results (first result row)
        'first_result': (540, 503),
        
        # Profile grid - Row 1 posts
        'post_row1_col1': (178, 1245),
        'post_row1_col2': (540, 1245),
        'post_row1_col3': (902, 1245),
        
        # Post action buttons (on post view)
        'like_button': (64, 1913),
        'comment_button': (192, 1913),
        'repost_button': (303, 1913),  # Between comment and send
        'send_button': (415, 1913),
        'save_button': (1017, 1907),
    }
    
    def __init__(self, device_id="1A121FDF60082H", profile_id=None, current_account=None):
        self.device_id = device_id
        self.profile_id = profile_id
        
        # Profile ID to username mapping - CORRECT Instagram usernames
        self.profile_username_map = {
            "10": "itsjocelynchenz",
            "13": "alitealivia",
            "14": "klarkaaxo",
            "15": "bbyjocelynxo",
            "16": "anniixluv",
            "19": "onlylulubaby",
            "20": "jiaxzee",
            "21": "aixiash",
            "22": "danniibelle_",
            "23": "ralistaxo",
            "24": "realjocelynxo",
            "25": "jocelynxofans",
            "26": "jocelynchenxo",
            "31": "telari.lovee",
        }
        
        # Default accounts to repost from (Jocelyn accounts only - main cross-promo)
        self.default_accounts = [
            "itsjocelynchenz",
            "bbyjocelynxo",
            "realjocelynxo",
            "jocelynxofans",
            "jocelynchenxo",
        ]
        
        # Auto-determine current account from profile_id if not provided
        if current_account:
            self.current_account = current_account
        elif profile_id:
            self.current_account = self.profile_username_map.get(str(profile_id))
            if self.current_account:
                print(f"🔄 Auto-detected current account: @{self.current_account} (profile {profile_id})")
        else:
            self.current_account = None
    
    def get_other_accounts(self):
        """Get list of accounts excluding the current one"""
        if self.current_account:
            others = [acc for acc in self.default_accounts if acc.lower() != self.current_account.lower()]
            print(f"📋 Reposting from {len(others)} accounts (excluding @{self.current_account})")
            return others
        return self.default_accounts
    
    def _human_pause(self, min_sec=0.5, max_sec=1.5):
        """Human-like random pause"""
        time.sleep(random.uniform(min_sec, max_sec))
    
    def _tap(self, x, y, description=""):
        """Tap at coordinates using ADB"""
        # Add slight randomness for human-like behavior
        x = x + random.randint(-5, 5)
        y = y + random.randint(-5, 5)
        
        print(f"🎯 Tapping: {description} at ({x}, {y})")
        result = subprocess.run(
            ["adb", "-s", self.device_id, "shell", "input", "tap", str(x), str(y)],
            capture_output=True, timeout=10
        )
        self._human_pause(0.3, 0.7)
        return result.returncode == 0
    
    def _type_text(self, text, char_by_char=True):
        """Type text using ADB - character by character to prevent dropped chars"""
        # Escape special characters for shell
        safe_text = text.replace("'", "").replace('"', '').replace('`', '')
        safe_text = safe_text.replace('&', 'and').replace(';', ',').replace('|', ' ')
        safe_text = safe_text.replace('\\', '').replace('$', '').replace('(', '').replace(')', '')
        
        print(f"⌨️ Typing: {safe_text}")
        
        if char_by_char:
            # Type each character individually with small delay to prevent dropped chars
            print(f"   📝 Typing {len(safe_text)} chars: ", end="", flush=True)
            for i, char in enumerate(safe_text):
                # Skip spaces - use keyevent instead
                if char == ' ':
                    subprocess.run(
                        ["adb", "-s", self.device_id, "shell", "input", "keyevent", "KEYCODE_SPACE"],
                        capture_output=True, timeout=5
                    )
                    print("_", end="", flush=True)  # Visual for space
                else:
                    subprocess.run(
                        ["adb", "-s", self.device_id, "shell", "input", "text", char],
                        capture_output=True, timeout=5
                    )
                    print(char, end="", flush=True)  # Show each char as typed
                time.sleep(0.05)  # 50ms delay between chars
            print(f" ✓ ({len(safe_text)} chars done)")  # Finish line
            self._human_pause(0.3, 0.5)
            return True
        else:
            # Original fast method (may drop chars on slow devices)
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "text", safe_text],
                capture_output=True, timeout=10
            )
            self._human_pause(0.5, 1.0)
            return result.returncode == 0
    
    def _press_back(self):
        """Press back button"""
        subprocess.run(
            ["adb", "-s", self.device_id, "shell", "input", "keyevent", "KEYCODE_BACK"],
            capture_output=True, timeout=5
        )
        self._human_pause(0.5, 1.0)
    
    def launch_instagram(self):
        """Launch Instagram app - REQUIRED before reposting"""
        print("📱 Launching Instagram...")
        try:
            # Press back 3x first to clear any stuck state
            print("🔙 Clearing any stuck screens (3x back)...")
            for _ in range(3):
                subprocess.run(
                    ["adb", "-s", self.device_id, "shell", "input", "keyevent", "KEYCODE_BACK"],
                    capture_output=True, timeout=5
                )
                time.sleep(0.5)
            time.sleep(1)
            
            # Use monkey to launch Instagram
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "monkey", "-p", "com.instagram.android", 
                 "-c", "android.intent.category.LAUNCHER", "1"],
                capture_output=True, timeout=15
            )
            time.sleep(4)  # Wait for app to fully load
            print("✅ Instagram launched!")
            return True
        except Exception as e:
            print(f"⚠️ Instagram launch warning: {e}")
            return True  # Continue anyway

    
    def go_to_search(self):
        """Navigate to search/explore tab"""
        print("🔍 Opening search tab...")
        return self._tap(*self.COORDS['search_tab'], "Search tab")

    
    def search_user(self, username):
        """Search for a username"""
        print(f"🔎 Searching for @{username}...")
        print(f"   ℹ️ Full username to type: '{username}' ({len(username)} chars)")
        
        # Click search box
        self._tap(*self.COORDS['search_box'], "Search box")
        time.sleep(1.5)
        
        # Clear existing text thoroughly
        subprocess.run(
            ["adb", "-s", self.device_id, "shell", "input", "keyevent", "KEYCODE_MOVE_END"],
            capture_output=True, timeout=5
        )
        # Select all and delete (clear field) - more iterations
        for _ in range(30):  # Clear existing text (30 chars max)
            subprocess.run(
                ["adb", "-s", self.device_id, "shell", "input", "keyevent", "KEYCODE_DEL"],
                capture_output=True, timeout=5
            )
        
        time.sleep(0.5)  # Let field clear
        
        # Type username character by character (prevents dropped chars)
        print(f"   ⌨️ Typing '{username}' char-by-char...")
        self._type_text(username, char_by_char=True)
        
        # CRITICAL: Wait for autocomplete to populate with our FULL text
        # Instagram needs time to search with the complete username
        print(f"   ⏳ Waiting 3s for search results...")
        time.sleep(3)  # Increased from 2s
        
        return True
    
    def _find_username_in_ui(self, username):
        """Find exact username match in current UI using XML dump
        
        Returns:
            tuple: (x, y) center coordinates if found, None otherwise
        """
        import re
        import tempfile
        import os
        
        target_username = username.lower().lstrip('@')
        print(f"🔍 Looking for exact match: @{target_username}")
        
        try:
            temp_file = os.path.join(tempfile.gettempdir(), "repost_ui.xml")
            
            # Dump UI
            result = subprocess.run(
                ["adb", "-s", self.device_id, "shell", "uiautomator", "dump", "/sdcard/repost_ui.xml"],
                capture_output=True, timeout=10
            )
            if result.returncode != 0:
                print("⚠️ UI dump failed")
                return None
            
            # Pull file
            result = subprocess.run(
                ["adb", "-s", self.device_id, "pull", "/sdcard/repost_ui.xml", temp_file],
                capture_output=True, timeout=10
            )
            if result.returncode != 0:
                print("⚠️ UI pull failed")
                return None
            
            with open(temp_file, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Look for exact username match in text attribute
            # Pattern: text="username" ... bounds="[x1,y1][x2,y2]"
            pattern = rf'text="({re.escape(target_username)})"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
            match = re.search(pattern, content, re.IGNORECASE)
            
            if match:
                found_text = match.group(1)
                x1, y1, x2, y2 = int(match.group(2)), int(match.group(3)), int(match.group(4)), int(match.group(5))
                center_x = (x1 + x2) // 2
                center_y = (y1 + y2) // 2
                print(f"✅ Found EXACT match '{found_text}' at ({center_x}, {center_y})")
                
                try:
                    os.remove(temp_file)
                except:
                    pass
                return (center_x, center_y)
            
            # Fallback: look for username in content-desc
            pattern2 = rf'content-desc="[^"]*{re.escape(target_username)}[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
            match2 = re.search(pattern2, content, re.IGNORECASE)
            
            if match2:
                x1, y1, x2, y2 = int(match2.group(1)), int(match2.group(2)), int(match2.group(3)), int(match2.group(4))
                center_x = (x1 + x2) // 2
                center_y = (y1 + y2) // 2
                print(f"✅ Found via content-desc at ({center_x}, {center_y})")
                
                try:
                    os.remove(temp_file)
                except:
                    pass
                return (center_x, center_y)
            
            print(f"⚠️ Could not find exact match for @{target_username}")
            
            try:
                os.remove(temp_file)
            except:
                pass
            return None
            
        except Exception as e:
            print(f"⚠️ Username search error: {e}")
            return None
    
    def click_first_result(self, target_username=None):
        """Click the search result matching target_username, or first result as fallback
        
        Args:
            target_username: The exact username to find and click
        """
        if target_username:
            # Try to find exact match
            coords = self._find_username_in_ui(target_username)
            if coords:
                print(f"👤 Clicking exact match for @{target_username}...")
                self._tap(coords[0], coords[1], f"@{target_username}")
                time.sleep(2.5)  # Wait for profile to load
                return True
            else:
                print(f"⚠️ Exact match not found, using first result fallback")
        
        # Fallback to first result
        print("👤 Clicking first search result...")
        self._tap(*self.COORDS['first_result'], "First result")
        time.sleep(2.5)  # Wait for profile to load
        return True
    
    def click_post(self, position=1):
        """Click a post from the profile grid
        
        Args:
            position: 1, 2, or 3 for columns in first row
        """
        post_coords = {
            1: self.COORDS['post_row1_col1'],
            2: self.COORDS['post_row1_col2'],
            3: self.COORDS['post_row1_col3'],
        }
        
        coord = post_coords.get(position, post_coords[1])
        print(f"📸 Clicking post at position {position}...")
        self._tap(*coord, f"Post {position}")
        time.sleep(2)  # Wait for post to load
        return True
    
    def like_post(self):
        """Like the current post"""
        print("❤️ Liking post...")
        self._tap(*self.COORDS['like_button'], "Like button")
        self._human_pause(0.5, 1.0)
        return True
    
    def repost_post(self):
        """Repost the current post - single click, no confirmation needed"""
        print("🔄 Reposting...")
        self._tap(*self.COORDS['repost_button'], "Repost button")
        self._human_pause(1.0, 2.0)  # Wait for repost to register
        return True
    
    def save_post(self):
        """Save the current post"""
        print("💾 Saving post...")
        self._tap(*self.COORDS['save_button'], "Save button")
        self._human_pause(0.5, 1.0)
        return True
    
    def go_home(self):
        """Return to home feed"""
        print("🏠 Going home...")
        self._tap(*self.COORDS['home_tab'], "Home tab")
        time.sleep(2)
        return True
    
    def repost_from_account(self, username, num_posts=1):
        """Full flow: search user, visit profile, like and repost their posts
        
        Args:
            username: Instagram username to repost from
            num_posts: Number of recent posts to repost (1 or 2)
        """
        print(f"\n{'='*50}")
        print(f"🔄 REPOSTING FROM @{username}")
        print(f"{'='*50}")
        
        try:
            # Step 0: Launch Instagram first!
            self.launch_instagram()
            
            # Step 1: Go to search/explore
            self.go_to_search()
            time.sleep(2)

            
            # Step 2: Search for user
            self.search_user(username)
            
            # Step 3: Click the EXACT user result (not just first result)
            self.click_first_result(target_username=username)
            
            # Step 4: Process posts
            for post_num in range(1, min(num_posts + 1, 4)):  # Max 3 posts
                print(f"\n📸 Processing post {post_num}...")
                
                # Click post
                self.click_post(position=post_num)
                time.sleep(1)
                
                # Like it
                self.like_post()
                time.sleep(0.5)
                
                # Repost it
                self.repost_post()
                time.sleep(0.5)
                
                # Save it
                self.save_post()
                
                # Go back to profile for next post
                if post_num < num_posts:
                    print("🔙 Back to profile...")
                    self._press_back()
                    time.sleep(1.5)
                
                # Human-like delay between posts
                self._human_pause(1, 2)
            
            # Step 5: ROBUST RESET - Go back to search/explore with multiple backs + force tap search tab
            print("🔙 Returning to search page (robust reset)...")
            # Press back 5 times to ensure we're fully out
            for i in range(5):
                self._press_back()
                time.sleep(0.5)
            time.sleep(1)
            
            # Force tap search tab to ensure we're on explore page
            print("🔍 Force tapping Search tab...")
            self._tap(*self.COORDS['search_tab'], "Search tab (force)")
            time.sleep(2)
            
            print(f"✅ Finished reposting from @{username}")
            return True
            
        except Exception as e:
            print(f"❌ Error reposting from @{username}: {e}")
            return False
    
    def repost_from_all_accounts(self, accounts=None, posts_per_account=1):
        """Repost from multiple accounts
        
        Args:
            accounts: List of usernames, or None to use defaults
            posts_per_account: Number of posts to repost from each account
        """
        if accounts is None:
            accounts = self.default_accounts
        
        print(f"\n{'='*60}")
        print(f"🔄 STARTING REPOST SESSION")
        print(f"   Accounts: {len(accounts)}")
        print(f"   Posts per account: {posts_per_account}")
        print(f"{'='*60}")
        
        results = {'success': 0, 'failed': 0}
        
        for i, username in enumerate(accounts, 1):
            print(f"\n📊 Progress: {i}/{len(accounts)}")
            
            if self.repost_from_account(username, posts_per_account):
                results['success'] += 1
            else:
                results['failed'] += 1
            
            # Delay between accounts
            if i < len(accounts):
                delay = random.uniform(5, 10)
                print(f"⏳ Waiting {delay:.1f}s before next account...")
                time.sleep(delay)
        
        # Return home at end
        self.go_home()
        
        print(f"\n{'='*60}")
        print(f"✅ REPOST SESSION COMPLETE")
        print(f"   Success: {results['success']}")
        print(f"   Failed: {results['failed']}")
        print(f"{'='*60}")
        
        # Discord notification
        if DISCORD_AVAILABLE:
            get_notifier().success("🔄 Repost Complete", f"Success: {results['success']} | Failed: {results['failed']}")
        
        return results['success'] > 0
    
    def load_accounts_from_file(self, filename="repost_accounts.txt"):
        """Load accounts to repost from a file
        
        File format: one username per line
        Lines starting with # are ignored
        """
        try:
            # Check multiple locations
            paths_to_try = [
                filename,
                os.path.join("defaults", filename),
                os.path.join("modules", "defaults", filename),
                os.path.join(os.path.dirname(__file__), "defaults", filename),
            ]
            
            for path in paths_to_try:
                if os.path.exists(path):
                    with open(path, 'r', encoding='utf-8') as f:
                        accounts = [
                            line.strip() 
                            for line in f 
                            if line.strip() and not line.startswith('#')
                        ]
                    
                    if accounts:
                        print(f"📋 Loaded {len(accounts)} accounts from {path}")
                        return accounts
            
            print(f"⚠️ No repost accounts file found, using defaults")
            return self.default_accounts
            
        except Exception as e:
            print(f"❌ Error loading accounts: {e}")
            return self.default_accounts


# Quick test
if __name__ == "__main__":
    print("🔄 Instagram Repost Module Test")
    print("="*50)
    
    reposter = InstagramReposter()
    
    # Test with one account
    test_account = "jocelynbunz"
    print(f"\nTesting repost from @{test_account}...")
    
    reposter.repost_from_account(test_account, num_posts=1)
