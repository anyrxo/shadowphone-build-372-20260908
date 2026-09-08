#!/usr/bin/env python3
"""
🧵 THREADS ENGAGEMENT MODULE
Automated liking and commenting on Threads (com.instagram.barcelona)

PLATFORM: Threads (Native Android App)
ACTIONS: Launch, scroll feed, like posts, comment on posts

HUMAN BEHAVIOR FEATURES:
- Energy-based engagement probabilities (time of day affects activity)
- Varied scroll patterns (tiny, small, medium, large, micro-adjustment)
- Random breaks based on action count
- Session mood affects all behaviors
- Anti-pattern detection (varied timing, no repetitive behavior)
"""

import subprocess
import time
import random
import re
import os
import xml.etree.ElementTree as ET
from datetime import datetime

# Import human behavior if available
try:
    from human_behavior import get_human_behavior
    HB_AVAILABLE = True
except ImportError:
    try:
        from modules.human_behavior import get_human_behavior
        HB_AVAILABLE = True
    except ImportError:
        HB_AVAILABLE = False
        print("⚠️ Human behavior module not available")


class ThreadsEngager:
    """Threads engagement automation with human-like behavior"""
    
    # App constants
    PACKAGE_NAME = "com.instagram.barcelona"
    
    # Bottom navigation coordinates
    NAV_FEED = (142, 2263)
    NAV_SEARCH = (341, 2263)
    NAV_CREATE = (541, 2263)
    NAV_ACTIVITY = (739, 2263)
    NAV_PROFILE = (938, 2263)
    
    # Selectors
    SELECTORS = {
        'like_button': 'feed_post_ufi_like_button',
        'reply_button': 'feed_post_ufi_reply_button',
        'repost_button': 'feed_post_ufi_repost_button',
        'share_button': 'feed_post_ufi_share_button',
        'post_row': 'FeedPostRow',
        'post_text': 'feed_post_text',
        'feed_column': 'IgLazyColumn',
        'main_feed_screen': 'MainFeedScreen',
    }
    
    # Scroll patterns with human-like variation
    SCROLL_PATTERNS = {
        'micro': {'range': (80, 150), 'weight': 0.1, 'pause': (0.3, 0.6)},
        'tiny': {'range': (150, 280), 'weight': 0.15, 'pause': (0.4, 0.8)},
        'small': {'range': (280, 450), 'weight': 0.35, 'pause': (0.6, 1.2)},
        'medium': {'range': (450, 650), 'weight': 0.25, 'pause': (0.8, 1.5)},
        'large': {'range': (650, 900), 'weight': 0.12, 'pause': (1.0, 2.0)},
        'big': {'range': (900, 1200), 'weight': 0.03, 'pause': (1.5, 3.0)},
    }
    
    def __init__(self, device_id="1A121FDF60082H"):
        self.device_id = device_id
        
        # Stats tracking
        self.posts_seen = 0
        self.likes_given = 0
        self.comments_made = 0
        self.scrolls_performed = 0
        self.actions_since_break = 0
        
        # Load comments from file
        self.comments = self._load_comments()
        
        # Human behavior
        self.hb = get_human_behavior() if HB_AVAILABLE else None
        
        # Energy level affects all probabilities
        self.energy_level = self._get_current_energy()
        
        print(f"🧵 ThreadsEngager initialized for device {device_id}")
        print(f"📝 Loaded {len(self.comments)} comments for engagement")
        print(f"🧠 Human behavior: Energy level {self.energy_level:.0%}")
    
    def _get_current_energy(self):
        """Get energy level based on time of day (humans are less active at certain times)"""
        if self.hb:
            return self.hb.get_energy_level()[0]
        
        # Fallback: Calculate based on time
        hour = datetime.now().hour
        
        # Energy curve: Low at night, peaks mid-day
        if 6 <= hour < 9:      # Morning ramp-up
            return random.uniform(0.5, 0.7)
        elif 9 <= hour < 12:   # Late morning peak
            return random.uniform(0.75, 0.9)
        elif 12 <= hour < 14:  # Lunch dip
            return random.uniform(0.6, 0.75)
        elif 14 <= hour < 18:  # Afternoon active
            return random.uniform(0.7, 0.85)
        elif 18 <= hour < 21:  # Evening browse
            return random.uniform(0.65, 0.8)
        elif 21 <= hour < 24:  # Night wind-down
            return random.uniform(0.4, 0.6)
        else:                  # Late night/early morning
            return random.uniform(0.3, 0.5)
    
    def _adjust_probability_by_energy(self, base_prob):
        """Adjust a probability based on current energy level"""
        # Higher energy = more likely to engage
        adjusted = base_prob * (0.5 + self.energy_level * 0.6)
        return min(0.95, max(0.05, adjusted))  # Clamp between 5% and 95%
    
    def _load_comments(self):
        """Load comments from comments.txt file"""
        comments = []
        
        # Try multiple locations
        possible_paths = [
            os.path.join(os.path.dirname(__file__), '..', 'defaults', 'comments.txt'),
            os.path.join(os.path.dirname(__file__), 'defaults', 'comments.txt'),
            'defaults/comments.txt',
            '../defaults/comments.txt',
        ]
        
        for path in possible_paths:
            if os.path.exists(path):
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        comments = [line.strip() for line in f if line.strip() and not line.startswith('#')]
                    if comments:
                        return comments
                except Exception as e:
                    print(f"⚠️ Error loading comments from {path}: {e}")
        
        # Fallback comments if file not found
        comments = [
            "love this 🔥",
            "so true",
            "facts 💯",
            "this is everything",
            "real talk",
            "yesss 🙌",
            "couldn't agree more",
            "honestly same",
            "period.",
            "this!!!",
        ]
        print(f"⚠️ Using {len(comments)} fallback comments")
        return comments
    
    def adb(self, *args):
        """Execute ADB command"""
        cmd = ['adb', '-s', self.device_id] + list(args)
        result = subprocess.run(cmd, capture_output=True, text=True)
        return result
    
    def tap(self, x, y, description=""):
        """Tap at coordinates with human-like timing"""
        if description:
            print(f"👆 Tapping ({x}, {y}) - {description}")
        
        # Human variation in tap position (slight miss)
        x_offset = random.randint(-3, 3)
        y_offset = random.randint(-3, 3)
        
        self.adb('shell', 'input', 'tap', str(x + x_offset), str(y + y_offset))
        
        # Human-like delay after tap
        time.sleep(random.uniform(0.2, 0.5))
    
    def swipe(self, start_x, start_y, end_x, end_y, duration_ms=300):
        """Swipe gesture with variation"""
        # Add slight variation to make it more human
        start_x += random.randint(-10, 10)
        end_x += random.randint(-10, 10)
        
        self.adb('shell', 'input', 'swipe', 
                str(start_x), str(start_y), str(end_x), str(end_y), str(duration_ms))
    
    def type_text(self, text):
        """Type text using ADB - strips emojis and special chars"""
        # Remove emojis and non-ASCII that ADB can't handle
        clean_text = ''.join(char for char in text if ord(char) < 128 and ord(char) >= 32)
        if not clean_text.strip():
            clean_text = "love this"
        
        # Escape for shell
        escaped = clean_text.replace(' ', '%s').replace("'", "\\'").replace('"', '\\"')
        escaped = escaped.replace('&', '\\&').replace('(', '\\(').replace(')', '\\)')
        print(f"⌨️ Typing: {clean_text}")
        self.adb('shell', 'input', 'text', escaped)
    
    def get_ui_dump(self):
        """Get UI hierarchy as XML ElementTree"""
        dump_file = '/sdcard/threads_dump.xml'
        local_file = os.path.join(os.path.dirname(__file__), 'threads_dump.xml')
        
        # Dump UI to device
        result = self.adb('shell', 'uiautomator', 'dump', dump_file)
        if result.returncode != 0:
            return None
        
        # Pull to local
        result = self.adb('pull', dump_file, local_file)
        if result.returncode != 0:
            return None
        
        # Parse XML
        try:
            tree = ET.parse(local_file)
            return tree.getroot()
        except Exception as e:
            return None
        finally:
            # Cleanup
            try:
                os.remove(local_file)
                self.adb('shell', 'rm', dump_file)
            except:
                pass
    
    def parse_bounds(self, bounds_str):
        """Parse bounds string like '[21,464][1059,611]' to center coordinates"""
        try:
            numbers = re.findall(r'\d+', bounds_str)
            if len(numbers) >= 4:
                x1, y1, x2, y2 = map(int, numbers[:4])
                center_x = (x1 + x2) // 2
                center_y = (y1 + y2) // 2
                return center_x, center_y
        except:
            pass
        return None, None
    
    def launch_threads(self):
        """Launch Threads app"""
        print("📱 Launching Threads...")
        
        # Force stop first for clean state
        self.adb('shell', 'am', 'force-stop', self.PACKAGE_NAME)
        time.sleep(1)
        
        # Launch via monkey (reliable launcher)
        result = self.adb('shell', 'monkey', '-p', self.PACKAGE_NAME, 
                         '-c', 'android.intent.category.LAUNCHER', '1')
        
        if result.returncode == 0:
            print("✅ Threads launched!")
            time.sleep(random.uniform(3.5, 5.0))  # Varied wait for app load
            return True
        else:
            print(f"❌ Launch failed: {result.stderr}")
            return False
    
    def go_to_feed(self):
        """Navigate to home feed"""
        print("🏠 Going to home feed...")
        self.tap(*self.NAV_FEED, "Feed tab")
        time.sleep(random.uniform(1.5, 2.5))
        return True
    
    def _get_scroll_pattern(self):
        """Get a random scroll pattern based on weights"""
        patterns = list(self.SCROLL_PATTERNS.keys())
        weights = [self.SCROLL_PATTERNS[p]['weight'] for p in patterns]
        return random.choices(patterns, weights=weights)[0]
    
    def scroll_feed(self, direction='down'):
        """Scroll the feed with human-like variation"""
        pattern = self._get_scroll_pattern()
        pattern_config = self.SCROLL_PATTERNS[pattern]
        
        distance = random.randint(*pattern_config['range'])
        print(f"📜 Scrolling {direction} ({pattern}: {distance}px)...")
        
        start_x = 540 + random.randint(-30, 30)  # Slight horizontal variation
        start_y = 1200 + random.randint(-50, 50)
        
        if direction == 'down':
            end_y = start_y - distance
        else:
            end_y = start_y + distance
        
        # Human-like scroll duration (varies with distance)
        base_duration = 200 + int(distance * 0.3)
        duration = base_duration + random.randint(-50, 100)
        
        self.swipe(start_x, start_y, start_x, end_y, duration)
        self.scrolls_performed += 1
        self.actions_since_break += 1
        
        # Pause after scroll based on pattern
        pause_min, pause_max = pattern_config['pause']
        pause_time = random.uniform(pause_min, pause_max)
        
        # Energy affects pause (tired = longer pauses)
        pause_time *= (1.5 - self.energy_level * 0.5)
        time.sleep(pause_time)
        
        return True
    
    def find_posts_in_feed(self):
        """Find all visible posts in the feed"""
        ui_root = self.get_ui_dump()
        if not ui_root:
            return []
        
        posts = []
        
        # Find all FeedPostRow elements with like buttons
        for node in ui_root.iter('node'):
            resource_id = node.get('resource-id', '')
            
            if resource_id == self.SELECTORS['like_button']:
                content_desc = node.get('content-desc', '')
                bounds = node.get('bounds', '')
                x, y = self.parse_bounds(bounds)
                
                if x and y:
                    # Check if already liked
                    already_liked = 'Liked' in content_desc or content_desc.startswith('Unlike')
                    
                    posts.append({
                        'like_button': (x, y),
                        'content_desc': content_desc,
                        'already_liked': already_liked,
                        'bounds': bounds,
                    })
        
        return posts
    
    def like_post(self, post_info):
        """Like a post with human behavior"""
        if post_info.get('already_liked'):
            print("⏭️ Post already liked, skipping...")
            return False
        
        x, y = post_info['like_button']
        content_desc = post_info.get('content_desc', 'unknown')
        
        print(f"❤️ Liking post: {content_desc}")
        self.tap(x, y, "Like button")
        self.likes_given += 1
        self.actions_since_break += 1
        
        # Human-like pause after liking (varies with energy)
        base_pause = random.uniform(0.4, 1.0)
        pause = base_pause * (1.3 - self.energy_level * 0.3)
        time.sleep(pause)
        
        return True
    
    def find_reply_button_for_post(self, post_info):
        """Find the reply button near a like button"""
        like_x, like_y = post_info['like_button']
        # Reply button is approximately 140-180px to the right
        reply_x = like_x + random.randint(140, 180)
        reply_y = like_y
        return reply_x, reply_y
    
    def comment_on_post(self, post_info, comment_text=None):
        """Comment on a post using the inline reply composer"""
        if comment_text is None:
            comment_text = random.choice(self.comments)
        
        # First tap the Reply button to open the thread detail
        reply_x, reply_y = self.find_reply_button_for_post(post_info)
        
        print(f"💬 Opening thread for reply...")
        self.tap(reply_x, reply_y, "Reply button")
        time.sleep(random.uniform(1.5, 2.5))  # Wait for permalink screen
        
        # Now tap the inline composer field (bottom of screen)
        # Based on UI dump: permalink_inline_composer at around [148,2180][742,2306]
        # When in thread view with keyboard: [53,1342][785,1468]
        composer_x = 400
        composer_y = 1400  # Adjust based on screen position
        
        print(f"📝 Tapping composer field...")
        self.tap(composer_x, composer_y, "Composer field")
        time.sleep(random.uniform(0.8, 1.2))
        
        # Type comment
        print(f"⌨️ Typing comment: {comment_text}")
        self.type_text(comment_text)
        time.sleep(random.uniform(0.5, 0.8))
        
        # Click Post button (resource-id: permalink_inline_composer_post_button)
        # Position: [933,1341][1059,1467] center = (996, 1404)
        post_x = 996
        post_y = 1404
        
        print(f"📤 Clicking Post button...")
        self.tap(post_x, post_y, "Post button")
        
        self.comments_made += 1
        self.actions_since_break += 2  # Comments count as 2 actions
        
        # Wait for post to complete then fully relaunch Threads for clean state
        time.sleep(random.uniform(1.5, 2.5))
        print("🔄 Relaunching Threads after comment for clean state...")
        
        # Press back 2x to exit any stuck state
        for _ in range(2):
            self.adb('shell', 'input', 'keyevent', '4')
            time.sleep(0.5)
        
        # Relaunch Threads fresh
        self.launch_threads()
        self.go_to_feed()
        
        return True

    
    def _should_take_break(self):
        """Determine if we should take a break (human-like behavior)"""
        # Base: break every 8-15 actions
        break_threshold = random.randint(8, 15)
        
        # Lower energy = more frequent breaks
        if self.energy_level < 0.5:
            break_threshold = random.randint(5, 10)
        
        return self.actions_since_break >= break_threshold
    
    def _take_break(self):
        """Take a human-like break"""
        # Break duration based on energy
        if self.energy_level > 0.7:
            break_time = random.uniform(2, 5)
        elif self.energy_level > 0.5:
            break_time = random.uniform(4, 8)
        else:
            break_time = random.uniform(6, 12)
        
        print(f"⏸️ Taking a {break_time:.1f}s break (human behavior)...")
        time.sleep(break_time)
        self.actions_since_break = 0
    
    def run_engagement_session(self, 
                               duration_minutes=5, 
                               scroll_sessions=5,
                               like_probability=0.6, 
                               comment_probability=0.1):
        """
        Run a full engagement session on Threads with human-like behavior
        
        Args:
            duration_minutes: Max duration (default 5 minutes)
            scroll_sessions: Number of scroll-and-engage cycles
            like_probability: Base chance to like (adjusted by energy)
            comment_probability: Base chance to comment (adjusted by energy)
        """
        # Adjust probabilities based on energy
        adj_like_prob = self._adjust_probability_by_energy(like_probability)
        adj_comment_prob = self._adjust_probability_by_energy(comment_probability)
        
        print("=" * 60)
        print("🧵 THREADS ENGAGEMENT SESSION")
        print("=" * 60)
        print(f"⚙️ Settings:")
        print(f"   📍 Duration: {duration_minutes} minutes max")
        print(f"   📜 Scroll sessions: {scroll_sessions}")
        print(f"   ❤️ Like probability: {adj_like_prob:.0%} (base: {like_probability:.0%})")
        print(f"   💬 Comment probability: {adj_comment_prob:.0%} (base: {comment_probability:.0%})")
        print(f"   🧠 Energy level: {self.energy_level:.0%}")
        print("=" * 60)
        
        # Launch and go to feed
        if not self.launch_threads():
            print("❌ Failed to launch Threads")
            return False
        
        self.go_to_feed()
        time.sleep(random.uniform(1.5, 3.0))
        
        start_time = time.time()
        end_time = start_time + (duration_minutes * 60)
        
        for session in range(1, scroll_sessions + 1):
            if time.time() >= end_time:
                print("⏰ Time limit reached")
                break
            
            print(f"\n📱 Session {session}/{scroll_sessions}")
            
            # Find posts
            posts = self.find_posts_in_feed()
            print(f"📊 Found {len(posts)} posts (energy: {self.energy_level:.0%})")
            
            # Process visible posts
            for post in posts:
                if time.time() >= end_time:
                    break
                
                self.posts_seen += 1
                content = post.get('content_desc', 'post')
                
                # Skip already liked
                if post.get('already_liked'):
                    print(f"⏭️ Already liked: {content}")
                    continue
                
                # Roll dice for like decision
                like_roll = random.random()
                print(f"🎲 Like roll: {like_roll:.2f} vs {adj_like_prob:.2f} threshold")
                
                if like_roll < adj_like_prob:
                    self.like_post(post)
                    
                    # Roll dice for comment decision (independent of like)
                    comment_roll = random.random()
                    print(f"🎲 Comment roll: {comment_roll:.2f} vs {adj_comment_prob:.2f} threshold")
                    
                    if comment_roll < adj_comment_prob:
                        self.comment_on_post(post)
                    else:
                        print(f"⏭️ Skipping comment (roll too high)")
                else:
                    print(f"⏭️ Skipping like (roll too high): {content[:30]}...")
                
                # Human pause between posts
                time.sleep(random.uniform(0.5, 1.5))
                
                # FIXED: Scroll between posts to avoid liking same posts!
                # Scroll after every 1-2 likes to get new content
                if self.likes_given > 0 and self.likes_given % random.randint(1, 2) == 0:
                    print("📜 Scrolling to see fresh posts...")
                    self.scroll_feed('down')
                    time.sleep(random.uniform(0.5, 1.0))
                
                # Check for break
                if self._should_take_break():
                    self._take_break()
            
            # Always scroll at end of session to prepare for next round
            self.scroll_feed('down')
            
            # Extra scrolls to get truly new content (2-4 scrolls)
            extra_scrolls = random.randint(2, 4)
            for _ in range(extra_scrolls):
                time.sleep(random.uniform(0.3, 0.6))
                self.scroll_feed('down')

        
        # Session summary
        elapsed = (time.time() - start_time) / 60
        engagement_rate = (self.likes_given / max(1, self.posts_seen)) * 100
        
        print("\n" + "=" * 60)
        print("📊 THREADS ENGAGEMENT SUMMARY")
        print("=" * 60)
        print(f"⏱️ Duration: {elapsed:.1f} minutes")
        print(f"📜 Scrolls: {self.scrolls_performed}")
        print(f"👀 Posts seen: {self.posts_seen}")
        print(f"❤️ Likes given: {self.likes_given}")
        print(f"💬 Comments made: {self.comments_made}")
        print(f"📈 Engagement rate: {engagement_rate:.1f}%")
        print("=" * 60)
        
        return True
    
    def close_app(self):
        """Close Threads app"""
        print("📱 Closing Threads...")
        self.adb('shell', 'am', 'force-stop', self.PACKAGE_NAME)
        return True


# Quick test function
def test_threads_engagement():
    """Quick test of Threads engagement"""
    engager = ThreadsEngager()
    engager.run_engagement_session(
        duration_minutes=2,
        scroll_sessions=4,
        like_probability=0.5,
        comment_probability=0.1
    )


if __name__ == "__main__":
    test_threads_engagement()
