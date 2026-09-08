#!/usr/bin/env python3
"""
🎵 TIKTOK ENGAGEMENT MODULE v2.0
Fully implemented with actual UI selectors from XML dumps

DISCOVERED UI ELEMENTS:
- Like button: content-desc="Like video. XXX likes"
- Comments button: content-desc="Read or add comments. XXX comments"
- Follow button: content-desc="Follow {username}"
- Share button: content-desc="Share video. XXX shares"
- Favorites button: content-desc="Add or remove this video from Favorites."
- Profile icon: content-desc="{username} profile"
"""

import subprocess
import time
import os
import random
from typing import Optional, Dict, Any, List


class TikTokEngagement:
    """Handles TikTok engagement actions with actual UI selectors"""
    
    TIKTOK_PACKAGE = "com.zhiliaoapp.musically"
    
    # UI Bounds from VERIFIED XML dump Dec 28, 2024 (1080x2400 resolution)
    # Right side engagement panel - ORDER: Like → Comment → Favorites → Share
    LIKE_BUTTON_CENTER = (996, 1493)      # [912,1414][1080,1572] - "Like video. X likes"
    COMMENT_BUTTON_CENTER = (996, 1651)   # [912,1572][1080,1730] - "Read or add comments"
    FAVORITES_BUTTON_CENTER = (996, 1809) # [912,1730][1080,1888] - "Add or remove from Favorites"
    SHARE_BUTTON_CENTER = (996, 1967)     # [912,1888][1080,2046] - "Share video"
    
    # Profile/Follow area
    PROFILE_AVATAR_CENTER = (1001, 1313)  # [942,1254][1059,1371] center
    FOLLOW_BUTTON_CENTER = (1001, 1370)   # [921,1325][1080,1414] center
    
    # Navigation
    HOME_TAB = (108, 2273)                # [0,2208][216,2337] center
    CREATE_TAB = (540, 2273)              # [432,2208][648,2337] center
    INBOX_TAB = (756, 2273)               # [648,2208][864,2337] center
    PROFILE_TAB = (972, 2273)             # [864,2208][1080,2337] center
    
    # Video area for double-tap like
    VIDEO_CENTER = (540, 1100)            # Center of video viewing area
    
    def __init__(self, device_id="1A121FDF60082H"):
        self.device_id = device_id
        self.comments = self._load_comments()
        print(f"💝 TikTok Engagement v2.0 initialized (device: {device_id})")
    
    def _load_comments(self) -> List[str]:
        """Load comments from file or use defaults"""
        comments_file = os.path.join(os.path.dirname(__file__), '..', 'defaults', 'tiktok_comments.txt')
        try:
            if os.path.exists(comments_file):
                with open(comments_file, 'r', encoding='utf-8') as f:
                    comments = [line.strip() for line in f if line.strip() and not line.startswith('#')]
                if comments:
                    print(f"📝 Loaded {len(comments)} TikTok comments from file")
                    return comments
        except Exception as e:
            print(f"⚠️ Could not load comments file: {e}")
        
        # Default comments
        return [
            "🔥", "💯", "❤️", "this is fire", "love this",
            "so good", "amazing", "yesss", "iconic", "obsessed",
            "facts", "real", "mood", "vibes", "ate that"
        ]
    
    def _adb(self, command: str, timeout: int = 15) -> str:
        """Execute ADB command and return output"""
        try:
            full_cmd = f'adb -s {self.device_id} {command}'
            result = subprocess.run(
                full_cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout
            )
            return result.stdout + result.stderr
        except subprocess.TimeoutExpired:
            print(f"⚠️ ADB command timed out: {command}")
            return ""
        except Exception as e:
            print(f"❌ ADB error: {e}")
            return ""
    
    def _tap(self, x: int, y: int) -> bool:
        """Tap at coordinates"""
        try:
            self._adb(f'shell input tap {x} {y}')
            return True
        except:
            return False
    
    def _human_pause(self, min_sec: float = 0.5, max_sec: float = 2.0):
        """Add human-like pause"""
        time.sleep(random.uniform(min_sec, max_sec))
    
    def launch_tiktok(self) -> bool:
        """Launch TikTok app"""
        try:
            print("🎵 Launching TikTok...")
            self._adb(f'shell monkey -p {self.TIKTOK_PACKAGE} -c android.intent.category.LAUNCHER 1')
            time.sleep(4)  # Wait for app to load
            return True
        except Exception as e:
            print(f"❌ Failed to launch TikTok: {e}")
            return False
    
    def go_home(self) -> bool:
        """Navigate to Home/For You feed"""
        try:
            print("🏠 Going to Home feed...")
            self._tap(*self.HOME_TAB)
            self._human_pause(1, 2)
            return True
        except:
            return False
    
    def double_tap_like(self) -> bool:
        """Like video with double-tap (the viral way)"""
        try:
            print("❤️ Double-tap liking video...")
            x, y = self.VIDEO_CENTER
            self._tap(x, y)
            time.sleep(0.1)  # Quick double tap
            self._tap(x, y)
            self._human_pause(0.5, 1.5)
            return True
        except Exception as e:
            print(f"❌ Double-tap like failed: {e}")
            return False
    
    def tap_like_button(self) -> bool:
        """Like video by tapping heart button"""
        try:
            print("❤️ Tapping like button...")
            self._tap(*self.LIKE_BUTTON_CENTER)
            self._human_pause(0.5, 1.5)
            return True
        except Exception as e:
            print(f"❌ Like button failed: {e}")
            return False
    
    def scroll_to_next(self) -> bool:
        """Scroll to next video with human-like swipe"""
        try:
            print("📜 Scrolling to next video...")
            # Swipe up with slight variation
            start_x = random.randint(400, 600)
            start_y = random.randint(1600, 1800)
            end_y = random.randint(400, 600)
            duration = random.randint(200, 400)
            
            self._adb(f'shell input swipe {start_x} {start_y} {start_x} {end_y} {duration}')
            self._human_pause(2, 4)  # Let video load
            return True
        except Exception as e:
            print(f"❌ Scroll failed: {e}")
            return False
    
    def open_comments(self) -> bool:
        """Open comments section - VERIFIED coords from XML dump Dec 28"""
        try:
            print("💬 Opening comments...")
            self._tap(*self.COMMENT_BUTTON_CENTER)  # (996, 1651) - verified
            self._human_pause(2, 3)  # Wait for sheet to open
            return True
        except Exception as e:
            print(f"❌ Open comments failed: {e}")
            return False
    
    def add_comment(self, comment: str = None) -> bool:
        """Add a comment - VERIFIED coords from XML dump Dec 28
        
        Comment input: [189,1198][1011,1338] -> center ~(600, 1268)
        Send button: [911,1393][1048,1477] -> center (980, 1435)
        """
        try:
            if comment is None:
                comment = random.choice(self.comments)
            
            print(f"💬 Adding comment: {comment[:30]}...")
            
            # Tap comment input field (center of input area when keyboard visible)
            self._tap(600, 1268)
            self._human_pause(1, 1.5)
            
            # Clean and type the comment
            clean_comment = ''.join(char for char in comment if ord(char) < 128 and ord(char) >= 32)
            if not clean_comment.strip():
                clean_comment = "love this"
            
            safe_comment = clean_comment.replace(' ', '%s').replace("'", "").replace('"', '')
            self._adb(f'shell input text "{safe_comment}"')
            self._human_pause(0.8, 1.2)
            
            # Tap send button - verified at (980, 1435)
            self._tap(980, 1435)
            self._human_pause(1.5, 2.5)
            
            # Close keyboard and comments with back presses
            self._adb('shell input keyevent KEYCODE_BACK')
            self._human_pause(0.5, 1)
            self._adb('shell input keyevent KEYCODE_BACK')
            self._human_pause(0.5, 1)
            
            return True
        except Exception as e:
            print(f"❌ Comment failed: {e}")
            return False
    
    def follow_creator(self) -> bool:
        """Follow the creator of current video"""
        try:
            print("➕ Following creator...")
            self._tap(*self.FOLLOW_BUTTON_CENTER)
            self._human_pause(1, 2)
            return True
        except Exception as e:
            print(f"❌ Follow failed: {e}")
            return False
    
    def add_to_favorites(self) -> bool:
        """Add video to favorites"""
        try:
            print("⭐ Adding to favorites...")
            self._tap(*self.FAVORITES_BUTTON_CENTER)
            self._human_pause(0.5, 1.5)
            return True
        except Exception as e:
            print(f"❌ Add to favorites failed: {e}")
            return False
    
    def engage_with_feed(
        self,
        duration_minutes: int = 5,
        like_probability: float = 0.7,
        comment_probability: float = 0.15,
        follow_probability: float = 0.05,
        max_posts: int = 15
    ) -> Dict[str, Any]:
        """
        Engage with multiple videos in feed
        
        Args:
            duration_minutes: How long to engage (minutes)
            like_probability: Chance to like each video (0-1)
            comment_probability: Chance to comment (0-1)
            follow_probability: Chance to follow creator (0-1)
            max_posts: Maximum posts to interact with
        """
        print(f"🎵 Starting TikTok engagement session...")
        print(f"   Duration: {duration_minutes}min | Max posts: {max_posts}")
        print(f"   Like: {like_probability*100:.0f}% | Comment: {comment_probability*100:.0f}% | Follow: {follow_probability*100:.0f}%")
        
        start_time = time.time()
        end_time = start_time + (duration_minutes * 60)
        
        stats = {
            "likes": 0,
            "comments": 0,
            "follows": 0,
            "posts_viewed": 0
        }
        
        try:
            # Make sure we're in the feed
            self.go_home()
            self._human_pause(2, 3)
            
            while time.time() < end_time and stats["posts_viewed"] < max_posts:
                stats["posts_viewed"] += 1
                print(f"\n📱 Post {stats['posts_viewed']}/{max_posts}")
                
                # Watch video for random duration (simulating watching)
                watch_time = random.uniform(3, 10)
                print(f"   👀 Watching for {watch_time:.1f}s...")
                time.sleep(watch_time)
                
                # Decide actions
                if random.random() < like_probability:
                    # Randomly use double-tap or button
                    if random.random() < 0.6:
                        self.double_tap_like()
                    else:
                        self.tap_like_button()
                    stats["likes"] += 1
                    print(f"   ❤️ Liked (total: {stats['likes']})")
                
                if random.random() < comment_probability:
                    self.open_comments()
                    self.add_comment()
                    stats["comments"] += 1
                    print(f"   💬 Commented (total: {stats['comments']})")
                
                if random.random() < follow_probability:
                    self.follow_creator()
                    stats["follows"] += 1
                    print(f"   ➕ Followed (total: {stats['follows']})")
                
                # Scroll to next
                self.scroll_to_next()
            
            elapsed = (time.time() - start_time) / 60
            print(f"\n✅ TikTok engagement complete!")
            print(f"   Duration: {elapsed:.1f}min")
            print(f"   Posts: {stats['posts_viewed']} | Likes: {stats['likes']} | Comments: {stats['comments']} | Follows: {stats['follows']}")
            
            return {
                "success": True,
                **stats,
                "duration_minutes": elapsed
            }
            
        except Exception as e:
            print(f"❌ Engagement error: {e}")
            return {
                "success": False,
                "error": str(e),
                **stats
            }
    
    def run_engagement_session(
        self,
        duration_minutes: int = 5,
        max_posts: int = 10
    ) -> Dict[str, Any]:
        """Simplified engagement session for AUTO mode"""
        return self.engage_with_feed(
            duration_minutes=duration_minutes,
            like_probability=0.7,
            comment_probability=0.1,
            follow_probability=0.02,
            max_posts=max_posts
        )


if __name__ == "__main__":
    engager = TikTokEngagement()
    engager.launch_tiktok()
    time.sleep(3)
    result = engager.engage_with_feed(duration_minutes=2, max_posts=5)
    print(f"Result: {result}")
