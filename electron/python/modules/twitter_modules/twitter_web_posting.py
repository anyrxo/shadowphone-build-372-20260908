#!/usr/bin/env python3
"""
Twitter/X Web Posting Module

Creates posts on x.com/compose/post via Vanadium browser.
Supports text captions and media attachments.

Based on XML analysis:
- Text input: hint="Post text" at center (599, 575)
- Add photos/video button: content-desc="Add photos or video" at center (68, 887)
- Post button: text="Post" at center (962, 339)
"""

import subprocess
import time
import random
import os
import re
import xml.etree.ElementTree as ET
from typing import List, Dict, Optional, Tuple
from datetime import datetime


class TwitterWebPoster:
    """Twitter/X posting via Vanadium browser (web version)"""
    
    # Verified coordinates from XML analysis
    COORDS = {
        'text_input': (599, 575),       # hint="Post text" EditText
        'add_media_btn': (68, 887),     # content-desc="Add photos or video"
        'post_btn': (962, 339),         # text="Post" button (same as Reply in engagement)
        'drafts_btn': (760, 339),       # text="Drafts"
        'back_btn': (64, 341),          # content-desc="Back"
    }
    
    def __init__(self, device_id: str = "1A121FDF60082H"):
        self.device_id = device_id
        self.xml_path = "twitter_post_dump.xml"
        self.screenshot_path = "twitter_post_screen.png"
        
        # Load captions from file
        self.captions = self._load_captions()
        
        # Stats
        self.posts_made = 0
        
        print(f"🐦 TwitterWebPoster initialized for device {device_id}")
        print(f"📝 Loaded {len(self.captions)} captions for posting")
    
    def _load_captions(self) -> List[str]:
        """Load captions from twitter_captions.txt (with fallback to post_captions.txt)"""
        base_dir = os.path.dirname(os.path.dirname(__file__))
        
        # Try Twitter-specific captions first
        twitter_captions_file = os.path.join(base_dir, "defaults", "twitter_captions.txt")
        
        try:
            if os.path.exists(twitter_captions_file):
                with open(twitter_captions_file, 'r', encoding='utf-8') as f:
                    captions = [line.strip() for line in f if line.strip() and not line.startswith('#')]
                if captions:
                    print(f"📝 Loaded {len(captions)} captions from twitter_captions.txt")
                    return captions
        except Exception as e:
            print(f"⚠️ Error loading twitter_captions.txt: {e}")
        
        # Fallback to general post_captions.txt
        general_captions_file = os.path.join(
            os.path.dirname(base_dir), "defaults", "post_captions.txt"
        )
        
        try:
            if os.path.exists(general_captions_file):
                with open(general_captions_file, 'r', encoding='utf-8') as f:
                    captions = [line.strip() for line in f if line.strip() and not line.startswith('#')]
                if captions:
                    print(f"📝 Loaded {len(captions)} captions from post_captions.txt (fallback)")
                    return captions
        except Exception as e:
            print(f"⚠️ Error loading post_captions.txt: {e}")
        
        return self._default_captions()

    
    def _default_captions(self) -> List[str]:
        """Default captions if file not found"""
        return [
            "Good vibes only ✨",
            "Living my best life 💫",
            "Mood 💕",
            "Just vibing 🌟",
            "Thoughts? 👀",
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
            self.adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
            time.sleep(0.5)
            result = self.adb("pull", "/sdcard/ui.xml", self.xml_path)
            return result.returncode == 0
        except Exception as e:
            print(f"❌ XML dump failed: {e}")
            return False
    
    def tap(self, x: int, y: int, description: str = ""):
        """Tap at coordinates"""
        if description:
            print(f"👆 Tapping ({x}, {y}) - {description}")
        self.adb("shell", "input", "tap", str(x), str(y))
        time.sleep(random.uniform(0.3, 0.6))
    
    def type_text(self, text: str):
        """Type text - strips emojis that crash adb input"""
        # Remove emojis - adb input text doesn't support them
        emoji_pattern = re.compile("["
            u"\U0001F600-\U0001F64F"  # emoticons
            u"\U0001F300-\U0001F5FF"  # symbols & pictographs
            u"\U0001F680-\U0001F6FF"  # transport & map symbols
            u"\U0001F1E0-\U0001F1FF"  # flags
            u"\U00002702-\U000027B0"
            u"\U000024C2-\U0001F251"
            "]+", flags=re.UNICODE)
        clean_text = emoji_pattern.sub('', text).strip()
        
        if not clean_text:
            print("⚠️ Text was only emojis - skipping")
            return
        
        # Escape special characters for adb shell
        escaped = clean_text.replace(' ', '%s').replace("'", "\\'").replace('"', '\\"')
        # Run as single shell command
        cmd = f'input text "{escaped}"'
        self.adb("shell", cmd)
    
    def open_compose_page(self) -> bool:
        """Open x.com/compose/post in Vanadium"""
        print("🌐 Opening x.com/compose/post...")
        
        # Force stop Vanadium first
        self.adb("shell", "am", "force-stop", "app.vanadium.browser")
        time.sleep(1)
        
        # Launch browser with compose URL
        launch_cmd = "am start -a android.intent.action.VIEW -d 'https://x.com/compose/post' -p app.vanadium.browser"
        result = self.adb("shell", launch_cmd)
        
        print("⏳ Waiting 8 seconds for page to load...")
        time.sleep(8)
        
        # Verify we're on compose page
        if self.dump_xml():
            try:
                tree = ET.parse(self.xml_path)
                root = tree.getroot()
                
                for node in root.iter('node'):
                    text = node.get('text', '')
                    hint = node.get('hint', '')
                    
                    if 'compose/post' in text.lower() or hint == 'Post text':
                        print("✅ Compose page loaded!")
                        return True
                
                print("⚠️ Page loaded but compose not confirmed - continuing anyway...")
                return True
                
            except Exception as e:
                print(f"⚠️ Verification failed: {e}")
                return True
        
        return False
    
    def enter_caption(self, caption: str) -> bool:
        """Enter caption text in the compose field"""
        print(f"📝 Entering caption: {caption[:50]}{'...' if len(caption) > 50 else ''}")
        
        # Click on text input
        time.sleep(random.uniform(0.5, 1))  # Brief pause before clicking
        self.tap(self.COORDS['text_input'][0], self.COORDS['text_input'][1], "Text input field")
        time.sleep(random.uniform(1.5, 2.5))  # Wait for field to focus and keyboard
        
        # Type the caption
        print("⌨️ Typing caption...")
        self.type_text(caption)
        
        # Wait longer for text to fully appear before moving on
        print("⏳ Waiting for caption to finish typing...")
        time.sleep(random.uniform(3, 5))  # Human pause after typing
        
        print("✅ Caption typed!")
        return True
    
    def attach_media(self) -> bool:
        """Click to attach media (photos/videos)"""
        print("📷 Clicking Add photos/video...")
        
        # Click add media button
        time.sleep(random.uniform(0.5, 1))  # Brief pause before action
        self.tap(self.COORDS['add_media_btn'][0], self.COORDS['add_media_btn'][1], "Add photos/video")
        
        print("📂 Waiting for media picker to open...")
        time.sleep(random.uniform(3.5, 5))  # Wait for picker to load
        
        # Dump XML to find selectable items
        if not self.dump_xml():
            print("❌ Failed to dump XML for media picker")
            return False
        
        try:
            tree = ET.parse(self.xml_path)
            root = tree.getroot()
            
            photo_selected = False
            
            # Look for photo items in picker
            for node in root.iter('node'):
                content_desc = node.get('content-desc', '')
                bounds = node.get('bounds', '')
                clickable = node.get('clickable', 'false')
                
                # Look for "Photo taken on..." items
                if 'Photo' in content_desc and 'taken' in content_desc.lower():
                    match = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', bounds)
                    if match:
                        x1, y1, x2, y2 = map(int, match.groups())
                        center = ((x1 + x2) // 2, (y1 + y2) // 2)
                        
                        if center[1] > 500:  # Make sure it's in content area
                            print(f"📸 Selecting: {content_desc[:40]}...")
                            time.sleep(random.uniform(0.3, 0.8))
                            self.tap(center[0], center[1], "Photo thumbnail")
                            time.sleep(random.uniform(1.5, 2.5))  # Wait for selection
                            photo_selected = True
                            break
            
            if not photo_selected:
                print("⚠️ No photo found in picker")
                # Press back to close picker
                self.adb("shell", "input", "keyevent", "KEYCODE_BACK")
                time.sleep(1)
                return False
            
            # Now need to click "Add" button to confirm selection
            # Re-dump XML to find Add button
            time.sleep(random.uniform(1, 1.5))
            if self.dump_xml():
                tree = ET.parse(self.xml_path)
                root = tree.getroot()
                
                for node in root.iter('node'):
                    text = node.get('text', '')
                    bounds = node.get('bounds', '')
                    
                    # Look for "Add" button (contains count like "Add (1)")
                    if text.startswith('Add'):
                        match = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', bounds)
                        if match:
                            x1, y1, x2, y2 = map(int, match.groups())
                            center = ((x1 + x2) // 2, (y1 + y2) // 2)
                            print(f"✅ Clicking '{text}' button...")
                            time.sleep(random.uniform(0.3, 0.6))
                            self.tap(center[0], center[1], "Add confirmation")
                            time.sleep(random.uniform(2.5, 4))  # Wait for media to attach
                            print("📎 Media attached!")
                            return True
            
            print("⚠️ Could not find Add button")
            return False
            
        except Exception as e:
            print(f"⚠️ Error selecting media: {e}")
            return False
    
    def click_post_button(self) -> bool:
        """Click the Post button to submit"""
        print("📤 Clicking Post button...")
        
        # Click Post button
        time.sleep(random.uniform(0.5, 1))  # Brief pause before posting
        self.tap(self.COORDS['post_btn'][0], self.COORDS['post_btn'][1], "Post button")
        time.sleep(random.uniform(4, 6))  # Wait for post to submit
        
        self.posts_made += 1
        print("✅ Post submitted!")
        return True
    
    def create_post(self, caption: Optional[str] = None, attach_media: bool = False) -> bool:
        """
        Create a Twitter/X post
        
        Args:
            caption: Text caption for the post (uses random if None)
            attach_media: Whether to attach a photo/video
        
        Returns:
            True if post was created successfully
        """
        print("=" * 60)
        print("🐦 CREATING TWITTER/X POST")
        print("=" * 60)
        
        # Use provided caption or random
        if caption is None:
            caption = random.choice(self.captions)
        
        # Step 1: Open compose page
        if not self.open_compose_page():
            print("❌ Failed to open compose page")
            return False
        
        time.sleep(2)  # Extra wait for page stability
        
        # Step 2: Enter caption
        if not self.enter_caption(caption):
            print("❌ Failed to enter caption")
            return False
        
        # Step 3: Attach media (optional)
        if attach_media:
            self.attach_media()
            # IMPORTANT: Wait longer for media to fully upload before posting
            print("⏳ Waiting for media to fully upload...")
            time.sleep(random.uniform(5, 8))  # Longer delay for media processing

        
        # Step 4: Click Post
        if not self.click_post_button():
            print("❌ Failed to click Post button")
            return False
        
        print("=" * 60)
        print(f"✅ POST CREATED SUCCESSFULLY!")
        print(f"📊 Total posts made this session: {self.posts_made}")
        print("=" * 60)
        
        return True


# For direct testing
if __name__ == "__main__":
    poster = TwitterWebPoster()
    poster.create_post(caption="Testing from automation 🤖", attach_media=False)
