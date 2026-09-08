#!/usr/bin/env python3
"""
🎵 TIKTOK POSTING MODULE v2.0
Fully implemented with actual UI selectors from XML dumps

POSTING FLOW:
1. Tap Create (+) button at center bottom
2. Select PHOTO or video mode
3. Select media from gallery
4. Tap Next
5. Add caption and hashtags
6. Tap Post

DISCOVERED UI ELEMENTS:
- Create button: content-desc="Create" at [432,2208][648,2337]
- PHOTO mode: text="PHOTO" at [439,1655][641,1742]
- Gallery images: resource-id="com.zhiliaoapp.musically:id/g3q"
- POST tab: text="POST" at [453,2115][628,2233]
"""

import subprocess
import time
import os
import random
from typing import Optional, List


class TikTokPoster:
    """Handles TikTok photo/video posting with actual UI selectors"""
    
    TIKTOK_PACKAGE = "com.zhiliaoapp.musically"
    
    # UI Bounds from XML dump (1080x2400 resolution) - VERIFIED
    # Bottom navigation
    CREATE_BUTTON = (540, 2273)           # [432,2208][648,2337] center
    
    # Create screen modes (y: 1655-1742)
    MODE_10M = (106, 1699)               # 10 min video
    MODE_60S = (245, 1699)               # 60 sec video
    MODE_15S = (376, 1699)               # 15 sec video
    MODE_PHOTO = (540, 1699)             # Photo mode - VERIFIED
    MODE_TEXT = (723, 1699)              # Text mode
    
    # Gallery picker on create screen (far right)
    GALLERY_PICKER = (875, 1897)         # [770,1792][980,2002] - Opens full gallery
    
    # Full gallery screen
    FULL_GALLERY_FIRST = (182, 556)      # [5,377][359,734] First image in full gallery
    FULL_GALLERY_NEXT = (799, 2237)      # [550,2179][1048,2295] Next button in gallery - VERIFIED
    
    # Edit screen
    EDIT_NEXT = (796, 2181)              # [749,2154][843,2207] Next button on edit screen - VERIFIED
    
    # Post screen (final) - FIXED: Post is on the far RIGHT, Drafts is in the middle
    CAPTION_TITLE = (540, 602)           # [42,576][1038,628] "Add a catchy title" - VERIFIED
    CAPTION_DESC = (540, 867)            # [42,682][1038,1051] Description field - VERIFIED
    DRAFTS_BUTTON = (300, 2242)          # Drafts button - LEFT/MIDDLE side (avoid this!)
    POST_BUTTON = (920, 2242)            # Post button - FAR RIGHT side (was 799, fixed to 920)

    
    # Right side controls
    FLIP_CAMERA = (1006, 262)            # Flip camera button
    ADD_SOUND = (540, 256)               # Add sound button center
    
    # Close/Back
    CLOSE_BUTTON = (90, 251)             # Close button [32,193][148,309]
    
    def __init__(self, device_id="1A121FDF60082H"):
        self.device_id = device_id
        self.captions = self._load_captions()
        print(f"🎵 TikTok Poster v2.0 initialized (device: {device_id})")
    
    def _load_captions(self) -> List[str]:
        """Load captions from file or use defaults"""
        captions_file = os.path.join(os.path.dirname(__file__), '..', 'defaults', 'tiktok_captions.txt')
        try:
            if os.path.exists(captions_file):
                with open(captions_file, 'r', encoding='utf-8') as f:
                    captions = [line.strip() for line in f if line.strip() and not line.startswith('#')]
                if captions:
                    print(f"📝 Loaded {len(captions)} TikTok captions from file")
                    return captions
        except Exception as e:
            print(f"⚠️ Could not load captions file: {e}")
        
        # Default captions
        return [
            "just vibes ✨",
            "this hit different 🔥",
            "iykyk",
            "living my best life",
            "no thoughts just posting",
            "the energy is immaculate",
            "ate and left no crumbs",
            "main character moment",
            "obsessed with this",
            "respectfully iconic"
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
    
    def open_create_screen(self) -> bool:
        """Open the create/post screen"""
        try:
            print("➕ Opening create screen...")
            self._tap(*self.CREATE_BUTTON)
            self._human_pause(2, 3)
            return True
        except Exception as e:
            print(f"❌ Failed to open create screen: {e}")
            return False
    
    def select_photo_mode(self) -> bool:
        """Select PHOTO mode for image posting"""
        try:
            print("📷 Selecting PHOTO mode...")
            self._tap(*self.MODE_PHOTO)
            self._human_pause(1, 2)
            return True
        except Exception as e:
            print(f"❌ Failed to select PHOTO mode: {e}")
            return False
    
    def select_video_mode_15s(self) -> bool:
        """Select 15s video mode"""
        try:
            print("📹 Selecting 15s video mode...")
            self._tap(*self.MODE_15S)
            self._human_pause(1, 2)
            return True
        except Exception as e:
            print(f"❌ Failed to select video mode: {e}")
            return False
    
    def open_gallery_picker(self) -> bool:
        """Open full gallery picker (far right button on create screen) - VERIFIED"""
        try:
            print("📂 Opening full gallery picker...")
            self._tap(*self.GALLERY_PICKER)
            self._human_pause(2, 3)
            return True
        except Exception as e:
            print(f"❌ Failed to open gallery picker: {e}")
            return False
    
    def select_first_gallery_image(self) -> bool:
        """Select the first image from full gallery - VERIFIED"""
        try:
            print("🖼️ Selecting first gallery image...")
            self._tap(*self.FULL_GALLERY_FIRST)
            self._human_pause(1, 2)
            return True
        except Exception as e:
            print(f"❌ Failed to select gallery image: {e}")
            return False
    
    def tap_gallery_next(self) -> bool:
        """Tap Next button in gallery screen - VERIFIED"""
        try:
            print("➡️ Tapping Next (gallery)...")
            self._tap(*self.FULL_GALLERY_NEXT)
            self._human_pause(2, 3)
            return True
        except Exception as e:
            print(f"❌ Failed to tap Next: {e}")
            return False
    
    def tap_edit_next(self) -> bool:
        """Tap Next button on edit screen - VERIFIED"""
        try:
            print("➡️ Tapping Next (edit screen)...")
            self._tap(*self.EDIT_NEXT)
            self._human_pause(2, 3)
            return True
        except Exception as e:
            print(f"❌ Failed to tap Next: {e}")
            return False
    
    def add_caption(self, caption: str = None) -> bool:
        """Add caption to the post - VERIFIED with actual selectors"""
        try:
            if caption is None:
                caption = random.choice(self.captions)
            
            print(f"📝 Adding caption: {caption[:50]}...")
            
            # Tap description field (larger area below title)
            # Verified bounds: [42,682][1038,1051] -> center at ~540, 867
            self._tap(*self.CAPTION_DESC)
            self._human_pause(0.8, 1.5)
            
            # Type caption - escape special characters for adb
            safe_caption = caption.replace("'", "").replace('"', '').replace(' ', '%s')
            self._adb(f'shell input text "{safe_caption}"')
            self._human_pause(1, 2)
            
            # Close keyboard
            self._adb('shell input keyevent KEYCODE_BACK')
            self._human_pause(0.5, 1)
            
            return True
        except Exception as e:
            print(f"❌ Failed to add caption: {e}")
            return False
    
    def tap_post_button(self) -> bool:
        """Tap the final Post button to publish - VERIFIED"""
        try:
            print("🚀 Tapping Post button...")
            # Verified bounds: [550,2179][1048,2305] -> center at 799, 2242
            self._tap(*self.POST_BUTTON)
            self._human_pause(4, 6)  # Wait for upload
            return True
        except Exception as e:
            print(f"❌ Failed to tap Post: {e}")
            return False
    
    def post_photo(self, caption: str = None) -> bool:
        """
        Complete flow to post a photo from gallery - VERIFIED
        
        Args:
            caption: Optional caption (random if not provided)
        """
        try:
            print("\n📷 Starting TikTok photo post flow...")
            
            # Step 1: Open create screen
            if not self.open_create_screen():
                return False
            
            # Step 2: Select PHOTO mode
            if not self.select_photo_mode():
                return False
            
            # Step 3: Open full gallery picker (far right button)
            if not self.open_gallery_picker():
                return False
            
            # Step 4: Select first image from full gallery
            if not self.select_first_gallery_image():
                return False
            
            # Step 5: Tap Next in gallery
            if not self.tap_gallery_next():
                return False
            
            # Step 6: Tap Next on edit screen
            if not self.tap_edit_next():
                return False
            
            # Step 7: Add caption
            if not self.add_caption(caption):
                print("⚠️ Caption may have failed, continuing...")
            
            # Step 8: Post
            if not self.tap_post_button():
                return False
            
            print("✅ TikTok photo posted successfully!")
            return True
            
        except Exception as e:
            print(f"❌ TikTok photo post failed: {e}")
            return False
    
    def post_video(self, caption: str = None) -> bool:
        """
        Complete flow to post a video from gallery
        
        Args:
            caption: Optional caption (random if not provided)
        """
        try:
            print("\n📹 Starting TikTok video post flow...")
            
            # Similar to photo but selects video mode
            if not self.open_create_screen():
                return False
            
            if not self.select_video_mode_15s():
                return False
            
            if not self.select_first_gallery_image():
                return False
            
            self._human_pause(1, 2)
            if not self.tap_next():
                self._tap(540, 897)
                self._human_pause(1, 2)
            
            if not self.add_caption(caption):
                print("⚠️ Caption may have failed, continuing...")
            
            if not self.tap_post_button():
                return False
            
            print("✅ TikTok video posted successfully!")
            return True
            
        except Exception as e:
            print(f"❌ TikTok video post failed: {e}")
            return False


if __name__ == "__main__":
    poster = TikTokPoster()
    poster.launch_tiktok()
    time.sleep(3)
    poster.post_photo("testing the new module 🔥")
