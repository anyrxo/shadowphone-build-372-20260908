#!/usr/bin/env python3
"""
🐦 TWITTER/X WEB ENGAGEMENT MODULE
Engagement automation via Vanadium browser at x.com/home
Uses XML dumps for reliable element detection - no coordinates needed!

Key Features:
- Opens x.com/home in Vanadium browser
- Scrolls feed with human-like behavior
- Likes visible posts (filters out off-screen elements)
- Comments on posts with random selection from comments.txt
- Uses content-desc selectors (stable across screen positions)
"""

import subprocess
import time
import random
import re
import os
import xml.etree.ElementTree as ET
from typing import List, Dict, Tuple, Optional
from datetime import datetime


class TwitterWebEngager:
    """Twitter/X engagement via Vanadium browser (web version)"""
    
    # Verified coordinates from XML dump
    COORDS = {
        'reply_text_input': (599, 835),    # hint="Post text" EditText
        'reply_submit_btn': (952, 339),    # Reply button (verified from XML: bounds=[863,298][1042,380])
        'home_tab': (108, 2272),           # Bottom nav Home
    }
    
    # Human behavior energy levels by hour (0-23)
    ENERGY_LEVELS = {
        0: 0.2, 1: 0.1, 2: 0.1, 3: 0.1, 4: 0.1, 5: 0.2,  # Night (low)
        6: 0.4, 7: 0.6, 8: 0.8, 9: 0.9, 10: 1.0, 11: 0.95,  # Morning (rising)
        12: 0.85, 13: 0.7, 14: 0.75, 15: 0.8, 16: 0.85, 17: 0.9,  # Afternoon
        18: 0.95, 19: 1.0, 20: 0.9, 21: 0.7, 22: 0.5, 23: 0.3  # Evening (peak then decline)
    }
    
    def __init__(self, device_id="1A121FDF60082H"):
        self.device_id = device_id
        self.xml_path = "twitter_engagement_dump.xml"
        self.screenshot_path = "twitter_engagement_screen.png"
        
        # Engagement settings
        self.like_probability = 0.7  # 70% chance to like a visible post
        self.comment_probability = 0.3  # 30% chance to comment
        self.scroll_count = 0
        self.likes_given = 0
        self.comments_made = 0
        self.posts_seen = 0
        
        # Human behavior tracking
        self.last_break_time = datetime.now()
        self.actions_since_break = 0
        self.break_threshold = random.randint(8, 15)  # Actions before mini-break
        
        # Load comments from file
        self.comments = self._load_comments()
        
        # Session tracking
        self.session_start = datetime.now()
        self.engaged_posts = set()  # Track posts we've already engaged with
        
        print(f"🐦 TwitterWebEngager initialized for device {device_id}")
        print(f"📝 Loaded {len(self.comments)} comments for engagement")
        print(f"🧠 Human behavior: Energy level {self._get_energy_level()*100:.0f}%")
    
    def _load_comments(self) -> List[str]:
        """Load comments from comments.txt file"""
        comments_file = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
            "defaults", "comments.txt"
        )
        
        try:
            if os.path.exists(comments_file):
                with open(comments_file, 'r', encoding='utf-8') as f:
                    comments = [line.strip() for line in f if line.strip() and not line.startswith('#')]
                return comments if comments else self._default_comments()
            else:
                print(f"⚠️ Comments file not found: {comments_file}")
                return self._default_comments()
        except Exception as e:
            print(f"⚠️ Error loading comments: {e}")
            return self._default_comments()
    
    def _default_comments(self) -> List[str]:
        """Default comments if file not found"""
        return [
            "🔥🔥🔥",
            "Love this! 💕",
            "Amazing! ✨",
            "So true! 💯",
            "This is everything! 🙌",
            "Yesss! 👏",
            "Facts! 💪",
            "Obsessed with this! 😍",
            "Queen! 👑",
            "This made my day! 🌟"
        ]
    
    def adb(self, *args) -> subprocess.CompletedProcess:
        """Execute ADB command"""
        cmd = ["adb", "-s", self.device_id] + list(args)
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            return result
        except subprocess.TimeoutExpired:
            print("⚠️ ADB command timed out")
            return subprocess.CompletedProcess(cmd, 1, "", "Timeout")
    
    def dump_xml(self) -> bool:
        """Dump current UI to XML file"""
        try:
            # Dump on device
            self.adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
            time.sleep(0.5)
            
            # Pull to local
            result = self.adb("pull", "/sdcard/ui.xml", self.xml_path)
            return result.returncode == 0
        except Exception as e:
            print(f"❌ XML dump failed: {e}")
            return False
    
    def take_screenshot(self) -> bool:
        """Take screenshot for debugging"""
        try:
            self.adb("shell", "screencap", "-p", "/sdcard/screen.png")
            time.sleep(0.3)
            self.adb("pull", "/sdcard/screen.png", self.screenshot_path)
            return True
        except:
            return False
    
    def tap(self, x: int, y: int, description: str = ""):
        """Tap at coordinates"""
        print(f"👆 Tapping ({x}, {y}) - {description}")
        self.adb("shell", "input", "tap", str(x), str(y))
        time.sleep(0.5)
    
    def type_text(self, text: str):
        """Type text using ADB (handles spaces)"""
        # Escape special characters for shell
        escaped = text.replace(' ', '%s').replace("'", "\\'").replace('"', '\\"')
        self.adb("shell", "input", "text", escaped)
    
    def scroll_feed(self, direction: str = "down"):
        """Scroll the feed with human-like variance"""
        # Human-like scroll patterns - varied distances
        scroll_patterns = [
            (200, 350, "tiny"),     # Quick peek scroll
            (350, 500, "small"),    # Small scroll
            (500, 700, "medium"),   # Normal scroll  
            (700, 900, "large"),    # Bigger scroll
        ]
        
        # Weight the patterns - medium most common
        weights = [0.15, 0.30, 0.40, 0.15]
        pattern = random.choices(scroll_patterns, weights=weights)[0]
        min_dist, max_dist, pattern_name = pattern
        
        scroll_distance = random.randint(min_dist, max_dist)
        
        # Vary scroll duration based on distance (faster for small, slower for large)
        base_duration = int(scroll_distance * 0.5)  # roughly 0.5ms per pixel
        duration_variance = random.randint(-50, 100)
        scroll_duration = max(200, base_duration + duration_variance)
        
        start_x = random.randint(480, 600)  # Slight horizontal variance
        
        if direction == "down":
            start_y = random.randint(1400, 1600)  # Varied start point
            end_y = start_y - scroll_distance
        else:  # up
            start_y = random.randint(700, 900)
            end_y = start_y + scroll_distance
        
        print(f"📜 Scrolling {direction} ({pattern_name}: {scroll_distance}px)...")
        self.adb("shell", "input", "swipe", 
                 str(start_x), str(start_y), 
                 str(start_x), str(end_y), 
                 str(scroll_duration))
        
        self.scroll_count += 1
        
        # Human-like pause - varies based on scroll type
        if pattern_name == "large":
            pause = random.uniform(2.0, 4.0)  # Longer pause to "read"
        elif pattern_name == "tiny":
            pause = random.uniform(0.8, 1.5)  # Quick glance
        else:
            pause = random.uniform(1.2, 2.5)  # Normal
        
        time.sleep(pause)
    
    def parse_bounds(self, bounds_str: str) -> Optional[Tuple[int, int, int, int]]:
        """Parse bounds string to coordinates"""
        match = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', bounds_str)
        if match:
            return tuple(map(int, match.groups()))
        return None
    
    def get_center(self, bounds_str: str) -> Optional[Tuple[int, int]]:
        """Get center point from bounds string"""
        bounds = self.parse_bounds(bounds_str)
        if bounds:
            x1, y1, x2, y2 = bounds
            return ((x1 + x2) // 2, (y1 + y2) // 2)
        return None
    
    def is_visible(self, bounds_str: str) -> bool:
        """Check if element is visible on screen (not [0,0][0,0])"""
        bounds = self.parse_bounds(bounds_str)
        if bounds:
            x1, y1, x2, y2 = bounds
            # Check if bounds are valid (not zero and within screen)
            if x1 == 0 and y1 == 0 and x2 == 0 and y2 == 0:
                return False
            # Check if within reasonable screen bounds
            if y2 > 128 and y2 < 2200 and x2 > 0:  # Below browser toolbar, above nav
                return True
        return False
    
    def find_visible_elements_by_content_desc(self, pattern: str) -> List[Dict]:
        """Find all visible elements matching content-desc pattern"""
        elements = []
        
        try:
            tree = ET.parse(self.xml_path)
            root = tree.getroot()
            
            for node in root.iter('node'):
                content_desc = node.get('content-desc', '')
                bounds = node.get('bounds', '')
                node_class = node.get('class', '')
                text = node.get('text', '')
                
                if pattern.lower() in content_desc.lower():
                    if self.is_visible(bounds):
                        center = self.get_center(bounds)
                        if center:
                            elements.append({
                                'content_desc': content_desc,
                                'text': text,
                                'class': node_class,
                                'bounds': bounds,
                                'center': center
                            })
        except Exception as e:
            print(f"❌ XML parsing error: {e}")
        
        # Sort by Y coordinate (top to bottom)
        elements.sort(key=lambda e: e['center'][1])
        return elements
    
    def find_visible_elements_by_text(self, pattern: str) -> List[Dict]:
        """Find all visible elements matching text pattern"""
        elements = []
        
        try:
            tree = ET.parse(self.xml_path)
            root = tree.getroot()
            
            for node in root.iter('node'):
                text = node.get('text', '')
                bounds = node.get('bounds', '')
                node_class = node.get('class', '')
                content_desc = node.get('content-desc', '')
                
                if pattern.lower() in text.lower():
                    if self.is_visible(bounds):
                        center = self.get_center(bounds)
                        if center:
                            elements.append({
                                'content_desc': content_desc,
                                'text': text,
                                'class': node_class,
                                'bounds': bounds,
                                'center': center
                            })
        except Exception as e:
            print(f"❌ XML parsing error: {e}")
        
        elements.sort(key=lambda e: e['center'][1])
        return elements
    
    def find_like_buttons(self) -> List[Dict]:
        """Find all visible Like buttons"""
        return self.find_visible_elements_by_content_desc("Likes. Like")
    
    def find_reply_buttons(self) -> List[Dict]:
        """Find all visible Reply buttons"""
        return self.find_visible_elements_by_content_desc("Replies. Reply")
    
    def find_repost_buttons(self) -> List[Dict]:
        """Find all visible Repost buttons (by text)"""
        return self.find_visible_elements_by_text("reposts. Repost")
    
    def open_vanadium_to_twitter(self) -> bool:
        """Open Vanadium browser and navigate to x.com/home"""
        print("🌐 Opening Vanadium browser to x.com/home...")
        
        # Force stop Vanadium first for clean state
        self.adb("shell", "am", "force-stop", "app.vanadium.browser")
        time.sleep(1)
        
        # Launch browser with x.com/home URL
        # Using shell command with quotes to handle URL properly
        launch_cmd = "am start -a android.intent.action.VIEW -d 'https://x.com/home' -p app.vanadium.browser"
        result = self.adb("shell", launch_cmd)
        
        print("⏳ Waiting 8 seconds for page to fully load...")
        time.sleep(8)  # Wait 8 seconds for full page load
        
        # Verify we're on Twitter
        if self.dump_xml():
            try:
                tree = ET.parse(self.xml_path)
                root = tree.getroot()
                
                # Check for Twitter indicators
                for node in root.iter('node'):
                    text = node.get('text', '')
                    content_desc = node.get('content-desc', '')
                    
                    if 'x.com' in text.lower() or 'Home / X' in text or 'Home timeline' in text:
                        print("✅ Successfully loaded x.com/home!")
                        return True
                    if content_desc == 'Home' or content_desc == 'Compose a post':
                        print("✅ Twitter home detected!")
                        return True
                
                print("⚠️ Page loaded but Twitter not confirmed - continuing anyway...")
                return True
                
            except Exception as e:
                print(f"⚠️ Verification failed: {e}")
                return True  # Continue anyway
        
        return False
    
    def click_home_tab(self) -> bool:
        """Click Home tab to ensure we're on home feed"""
        print("🏠 Clicking Home tab...")
        
        if not self.dump_xml():
            return False
        
        # Find Home button
        home_buttons = self.find_visible_elements_by_content_desc("Home")
        if home_buttons:
            btn = home_buttons[0]
            self.tap(btn['center'][0], btn['center'][1], "Home tab")
            time.sleep(2)
            return True
        
        # Fallback: tap known home location
        self.tap(108, 2272, "Home tab (fallback)")
        time.sleep(2)
        return True
    
    def like_post(self, like_button: Dict) -> bool:
        """Like a post by clicking its Like button"""
        post_id = like_button['content_desc']  # Use content_desc as unique ID
        
        if post_id in self.engaged_posts:
            print(f"⏭️ Already engaged with this post, skipping...")
            return False
        
        # Check if already liked (content_desc would be different, like "Liked" instead of "Like")
        if 'Liked' in like_button.get('text', '') or 'Liked' in like_button.get('content_desc', ''):
            print(f"⏭️ Post already liked, skipping...")
            return False
        
        center = like_button['center']
        print(f"❤️ Liking post: {post_id[:50]}...")
        
        self.tap(center[0], center[1], "Like button")
        self.likes_given += 1
        self.engaged_posts.add(post_id)
        
        # Human-like pause after liking
        time.sleep(random.uniform(0.5, 1.5))
        return True
    
    def comment_on_post(self, reply_button: Dict) -> bool:
        """Comment on a post using verified coordinates"""
        post_id = reply_button['content_desc']
        
        # Don't comment on same post twice
        comment_key = f"comment_{post_id}"
        if comment_key in self.engaged_posts:
            return False
        
        center = reply_button['center']
        print(f"💬 Clicking reply on post...")
        
        # Click reply button to open compose screen
        self.tap(center[0], center[1], "Reply button on feed")
        time.sleep(2.5)  # Wait for compose screen to load
        
        # Click the text input field (verified: hint="Post text")
        text_input = self.COORDS['reply_text_input']
        print(f"📝 Clicking text input at {text_input}...")
        self.tap(text_input[0], text_input[1], "Reply text field")
        time.sleep(1)
        
        # Type random comment with human-like typing
        comment = random.choice(self.comments)
        print(f"⌨️ Typing comment: {comment}")
        self.type_text(comment)
        time.sleep(1.5)  # Wait for text to appear
        
        # Click Reply/Post button (verified: top-right corner)
        reply_btn = self.COORDS['reply_submit_btn']
        print(f"📤 Clicking Reply button at {reply_btn}...")
        self.tap(reply_btn[0], reply_btn[1], "Post reply button")
        time.sleep(3)  # Wait for post to submit and modal to close automatically
        
        # Modal closes automatically after posting - no back button needed
        
        self.comments_made += 1
        self.engaged_posts.add(comment_key)
        self.actions_since_break += 1
        
        print(f"✅ Comment posted!")
        return True
    
    def _get_energy_level(self) -> float:
        """Get current energy level based on time of day"""
        current_hour = datetime.now().hour
        return self.ENERGY_LEVELS.get(current_hour, 0.5)
    
    def _should_take_break(self) -> bool:
        """Determine if we should take a human-like break"""
        # More breaks when energy is low
        energy = self._get_energy_level()
        adjusted_threshold = int(self.break_threshold * energy)
        
        return self.actions_since_break >= max(3, adjusted_threshold)
    
    def _take_human_break(self):
        """Take a human-like break with variable duration"""
        energy = self._get_energy_level()
        
        # Longer breaks when tired (low energy)
        if energy < 0.4:
            pause = random.uniform(8, 15)  # Tired: longer breaks
        elif energy < 0.7:
            pause = random.uniform(4, 8)   # Medium energy
        else:
            pause = random.uniform(2, 5)   # High energy: shorter breaks
        
        print(f"⏸️ Taking a {pause:.1f}s break (energy: {energy*100:.0f}%)...")
        time.sleep(pause)
        
        # Reset break tracking
        self.last_break_time = datetime.now()
        self.actions_since_break = 0
        self.break_threshold = random.randint(6, 12)  # Randomize next threshold
    
    def _get_human_delay(self) -> float:
        """Get a human-like delay between actions based on energy"""
        energy = self._get_energy_level()
        
        # Base delay range
        if energy > 0.8:
            return random.uniform(0.3, 1.0)   # High energy: faster
        elif energy > 0.5:
            return random.uniform(0.5, 2.0)   # Medium: normal
        else:
            return random.uniform(1.0, 3.0)   # Low energy: slower
    
    def engage_with_visible_posts(self):
        """Engage with currently visible posts using human-like behavior"""
        if not self.dump_xml():
            print("❌ Failed to dump XML")
            return
        
        # Check for break first
        if self._should_take_break():
            self._take_human_break()
        
        # Find visible Like buttons
        like_buttons = self.find_like_buttons()
        energy = self._get_energy_level()
        print(f"📊 Found {len(like_buttons)} visible posts (energy: {energy*100:.0f}%)")
        
        # Adjust probabilities based on energy level
        adjusted_like_prob = self.like_probability * energy
        adjusted_comment_prob = self.comment_probability * energy
        
        for like_btn in like_buttons:
            self.posts_seen += 1
            
            # Random decision to like (energy-adjusted)
            if random.random() < adjusted_like_prob:
                self.like_post(like_btn)
                self.actions_since_break += 1
            
            # Random decision to comment (less frequent, energy-adjusted)
            if random.random() < adjusted_comment_prob:
                # Find corresponding reply button
                reply_buttons = self.find_reply_buttons()
                if reply_buttons:
                    # Find reply button closest to this like button
                    like_y = like_btn['center'][1]
                    closest_reply = min(reply_buttons, 
                                       key=lambda r: abs(r['center'][1] - like_y))
                    self.comment_on_post(closest_reply)
            
            # Human-like delay between engagements (energy-adjusted)
            time.sleep(self._get_human_delay())
    
    def run_engagement_session(self, 
                               duration_minutes: int = 10,
                               scroll_sessions: int = 15,
                               like_probability: float = 0.7,
                               comment_probability: float = 0.2):
        """
        Run a complete engagement session
        
        Args:
            duration_minutes: Maximum session duration
            scroll_sessions: Number of scroll+engage cycles
            like_probability: Chance to like each visible post (0.0-1.0)
            comment_probability: Chance to comment on each post (0.0-1.0)
        """
        self.like_probability = like_probability
        self.comment_probability = comment_probability
        
        print("=" * 60)
        print("🐦 TWITTER/X WEB ENGAGEMENT SESSION")
        print("=" * 60)
        print(f"⚙️ Settings:")
        print(f"   📍 Duration: {duration_minutes} minutes max")
        print(f"   📜 Scroll sessions: {scroll_sessions}")
        print(f"   ❤️ Like probability: {like_probability*100:.0f}%")
        print(f"   💬 Comment probability: {comment_probability*100:.0f}%")
        print("=" * 60)
        
        # Step 1: Open Twitter in Vanadium
        if not self.open_vanadium_to_twitter():
            print("❌ Failed to open Twitter - aborting")
            return False
        
        # Already on home feed since we loaded x.com/home directly
        # No need to click home tab - just wait for feed to fully load
        print("⏳ Feed loaded, waiting 3 more seconds before engaging...")
        time.sleep(3)
        
        # Step 3: Scroll and engage loop
        session_end = datetime.now().timestamp() + (duration_minutes * 60)
        
        for session in range(scroll_sessions):
            # Check time limit
            if datetime.now().timestamp() > session_end:
                print(f"⏰ Time limit reached ({duration_minutes} minutes)")
                break
            
            print(f"\n📱 Session {session + 1}/{scroll_sessions}")
            
            # Engage with visible posts
            self.engage_with_visible_posts()
            
            # Scroll to see new posts
            self.scroll_feed("down")
            
            # Random longer pause occasionally
            if random.random() < 0.2:
                pause = random.uniform(3, 6)
                print(f"⏸️ Taking a {pause:.1f}s pause (human behavior)...")
                time.sleep(pause)
        
        # Print summary
        self.print_session_summary()
        
        return True
    
    def print_session_summary(self):
        """Print engagement session summary"""
        duration = (datetime.now() - self.session_start).total_seconds() / 60
        
        print("\n" + "=" * 60)
        print("📊 ENGAGEMENT SESSION SUMMARY")
        print("=" * 60)
        print(f"⏱️ Duration: {duration:.1f} minutes")
        print(f"📜 Scrolls: {self.scroll_count}")
        print(f"👀 Posts seen: {self.posts_seen}")
        print(f"❤️ Likes given: {self.likes_given}")
        print(f"💬 Comments made: {self.comments_made}")
        print(f"📈 Engagement rate: {(self.likes_given / max(1, self.posts_seen)) * 100:.1f}%")
        print("=" * 60)


def test_twitter_web_engagement():
    """Test the Twitter web engagement module"""
    print("🧪 Testing Twitter Web Engagement Module...")
    
    engager = TwitterWebEngager()
    
    # Run a short test session
    engager.run_engagement_session(
        duration_minutes=5,
        scroll_sessions=5,
        like_probability=0.5,  # 50% for testing
        comment_probability=0.0  # No comments for initial test
    )


if __name__ == "__main__":
    test_twitter_web_engagement()
