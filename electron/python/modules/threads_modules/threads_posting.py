"""
Threads Posting Module
Posts images with captions to Threads (com.instagram.barcelona)
"""

import subprocess
import time
import random
import os


class ThreadsPoster:
    """Posts content to Threads using UI automation"""
    
    # UI element coordinates from XML dumps
    COORDS = {
        'create_tab': (541, 2263),          # barcelona_tab_create
        'composer': (598, 413),              # new_thread_screen_composer
        'gallery_button': (171, 494),        # new_thread_screen_gallery_button
        'first_image': (540, 544),          # First image in gallery
        'gallery_done': (984, 202),          # Done button in gallery
        'post_button': (966, 1415),          # new_thread_screen_post_button
        'cancel_button': (79, 202),          # navigation_bar_back_button
    }
    
    PACKAGE = 'com.instagram.barcelona'
    
    def __init__(self, device_id=None):
        self.device_id = device_id or self._get_device_id()
        self.captions = self._load_captions()
        print(f"🧵 ThreadsPoster initialized for device {self.device_id}")
    
    def _get_device_id(self):
        """Get the connected device ID"""
        result = subprocess.run(
            ['adb', 'devices'],
            capture_output=True, text=True
        )
        lines = result.stdout.strip().split('\n')
        for line in lines[1:]:
            if '\tdevice' in line:
                return line.split('\t')[0]
        return None
    
    def _load_captions(self):
        """Load captions from threads_captions.txt"""
        captions = []
        
        possible_paths = [
            os.path.join(os.path.dirname(__file__), '..', 'defaults', 'threads_captions.txt'),
            os.path.join(os.path.dirname(__file__), 'defaults', 'threads_captions.txt'),
            'modules/defaults/threads_captions.txt',
        ]
        
        for path in possible_paths:
            if os.path.exists(path):
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        captions = [line.strip() for line in f if line.strip() and not line.startswith('#')]
                    if captions:
                        print(f"📝 Loaded {len(captions)} captions from {path}")
                        return captions
                except Exception as e:
                    print(f"⚠️ Error loading captions from {path}: {e}")
        
        # Fallback captions
        return [
            "this hit different 💭",
            "no thoughts just vibes ✨",
            "living for this moment",
            "the energy today 🔥",
        ]
    
    def adb(self, *args):
        """Run an adb command"""
        cmd = ['adb']
        if self.device_id:
            cmd.extend(['-s', self.device_id])
        cmd.extend(args)
        result = subprocess.run(cmd, capture_output=True, text=True)
        return result.stdout.strip()
    
    def tap(self, x, y, description=""):
        """Tap at coordinates"""
        self.adb('shell', 'input', 'tap', str(x), str(y))
        if description:
            print(f"👆 Tapped ({x}, {y}) - {description}")
    
    def type_text(self, text):
        """Type text using adb - handles special characters and emojis"""
        import re
        
        # Remove emojis and non-ASCII characters that ADB can't handle
        # Keep only ASCII printable characters (letters, numbers, punctuation, spaces)
        clean_text = ''.join(char for char in text if ord(char) < 128 and ord(char) >= 32)
        
        if not clean_text.strip():
            # If text was all emojis, use a fallback
            clean_text = "vibes"
        
        # Replace spaces with %s for ADB
        escaped = clean_text.replace(' ', '%s')
        # Escape other shell-special characters
        escaped = escaped.replace("'", "\\'").replace('"', '\\"').replace('&', '\\&')
        escaped = escaped.replace('(', '\\(').replace(')', '\\)').replace('!', '\\!')
        
        print(f"⌨️ Typing: {clean_text}")
        self.adb('shell', 'input', 'text', escaped)
    
    def launch_threads(self):
        """Launch the Threads app"""
        self.adb('shell', 'monkey', '-p', self.PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1')
        time.sleep(random.uniform(3.5, 5))  # Human-like wait for app to load
        print("✅ Threads launched")
    
    def open_create_screen(self):
        """Open the create new thread screen"""
        time.sleep(random.uniform(0.8, 1.5))  # Brief pause before action
        self.tap(*self.COORDS['create_tab'], "Create tab")
        time.sleep(random.uniform(2.5, 4))  # Wait for create screen to load
        print("📝 Create screen opened")
    
    def select_first_gallery_image(self):
        """Select the first image from gallery"""
        # 1. Tap gallery button
        time.sleep(random.uniform(0.5, 1))
        self.tap(*self.COORDS['gallery_button'], "Gallery button")
        time.sleep(random.uniform(2.5, 4))  # Wait for gallery to load
        
        # 2. Tap first image
        time.sleep(random.uniform(0.3, 0.8))
        self.tap(*self.COORDS['first_image'], "First image")
        time.sleep(random.uniform(1.5, 2.5))  # Wait for selection animation
        
        # 3. Tap Done
        time.sleep(random.uniform(0.3, 0.6))
        self.tap(*self.COORDS['gallery_done'], "Done")
        time.sleep(random.uniform(2.5, 4))  # Wait for image to attach
        
        print("🖼️ Image selected")
        return True
    
    def type_caption(self, caption=None):
        """Type the caption"""
        if caption is None:
            caption = random.choice(self.captions)
        
        # Tap composer to focus
        time.sleep(random.uniform(0.5, 1))
        self.tap(*self.COORDS['composer'], "Composer field")
        time.sleep(random.uniform(1, 1.8))  # Wait for keyboard to appear
        
        # Type caption
        self.type_text(caption)
        time.sleep(random.uniform(1, 2))  # Wait for text to appear
        
        print(f"📝 Caption: {caption}")
        return caption
    
    def click_post(self):
        """Click the Post button"""
        time.sleep(random.uniform(0.5, 1))  # Brief pause before posting
        self.tap(*self.COORDS['post_button'], "Post button")
        print("📤 Post submitted!")
        time.sleep(random.uniform(4, 6))  # Wait for upload to complete
    
    def post_image(self, caption=None, image_index=0):
        """
        Complete flow to post an image to Threads
        
        Args:
            caption: Optional caption (uses random from defaults if None)
            image_index: Which gallery image to use (0 = first/most recent)
        
        Returns:
            bool: True if post was successful
        """
        try:
            print("\n" + "="*50)
            print("🧵 POSTING TO THREADS")
            print("="*50)
            
            # 1. Open create screen
            self.open_create_screen()
            
            # 2. Select image from gallery
            self.select_first_gallery_image()
            
            # 3. Type caption
            used_caption = self.type_caption(caption)
            
            # 4. Post it
            self.click_post()
            
            print("="*50)
            print("✅ THREADS POST COMPLETE!")
            print(f"   Caption: {used_caption}")
            print("="*50 + "\n")
            
            return True
            
        except Exception as e:
            print(f"❌ Error posting to Threads: {e}")
            return False
    
    def post_text_only(self, text):
        """Post text-only thread (no image)"""
        try:
            print("\n🧵 Posting text-only thread...")
            
            # 1. Open create screen
            self.open_create_screen()
            
            # 2. Type text (composer is already focused)
            self.tap(*self.COORDS['composer'], "Composer")
            time.sleep(0.5)
            self.type_text(text)
            time.sleep(0.5)
            
            # 3. Post
            self.click_post()
            
            print(f"✅ Posted: {text}")
            return True
            
        except Exception as e:
            print(f"❌ Error: {e}")
            return False


# Quick test
if __name__ == "__main__":
    poster = ThreadsPoster()
    poster.launch_threads()
    time.sleep(2)
    poster.post_image()  # Uses random caption and first gallery image
