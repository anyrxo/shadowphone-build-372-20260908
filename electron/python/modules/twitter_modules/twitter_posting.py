#!/usr/bin/env python3
"""
Twitter/X Posting Module - Complete Workflow
Systematically discovered through XML dumping and coordinate analysis
"""

import subprocess
import time
import os
from typing import Optional, Tuple, Dict, Any

class TwitterPostingManager:
    def __init__(self):
        self.device_id = None
        self.xml_dump_count = 0
    
    def standard_twitter_init(self):
        """Standard initialization: Back 4x → Launch → Scroll Up → Home Tab"""
        print("🔄 STANDARD TWITTER INITIALIZATION")
        print("📋 Sequence: Back 4x → Launch → Scroll Up → Home Tab → Ready")
        
        try:
            # Step 1: Back 4x to ensure clean state
            print("🔙 Step 1/4: Pressing back 4x to clear any menus/screens...")
            for i in range(4):
                print(f"   🔙 Back press {i+1}/4")
                self.adb("shell", "input", "keyevent", "KEYCODE_BACK")
                time.sleep(1)
            
            # Step 2: Launch Twitter fresh
            print("🚀 Step 2/4: Launching Twitter fresh...")
            self.adb("shell", "am", "force-stop", "com.twitter.android")
            time.sleep(2)
            self.adb("shell", "monkey", "-p", "com.twitter.android", "-c", "android.intent.category.LAUNCHER", "1")
            time.sleep(5)
            print("✅ Twitter launched")
            
            # Step 3: Scroll up slightly to reveal navigation
            print("📜 Step 3/4: Scrolling up slightly to reveal navigation...")
            self.adb("shell", "input", "swipe", "540", "800", "540", "900", "300")  # Gentle scroll up
            time.sleep(2)
            print("✅ Scrolled up to reveal navigation")
            
            # Step 4: Click home tab to ensure we're on home feed
            print("🏠 Step 4/4: Clicking home tab...")
            self.adb("shell", "input", "tap", "150", "2200")  # Home tab coordinates
            time.sleep(3)
            print("✅ On home feed")
            
            print("✅ STANDARD INITIALIZATION COMPLETE - Ready for posting work!")
            return True
            
        except Exception as e:
            print(f"❌ Initialization failed: {e}")
            return False
        
    def adb(self, *args) -> subprocess.CompletedProcess:
        """Execute ADB command"""
        cmd = ["adb"] + list(args)
        if self.device_id:
            cmd.insert(1, "-s")
            cmd.insert(2, self.device_id)
        
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            return result
        except subprocess.TimeoutExpired:
            print("⚠️ ADB command timed out")
            return subprocess.CompletedProcess(cmd, 1, "", "Timeout")
    
    def take_xml_dump_and_screenshot(self, step_name: str) -> Tuple[str, str]:
        """Take XML dump and screenshot for systematic analysis (disabled for production)"""
        # Disabled XML dumps and screenshots for production use
        return "", ""
    
    def wait_and_tap(self, x: int, y: int, wait_time: float = 1.0, description: str = "") -> bool:
        """Wait and tap with description"""
        time.sleep(wait_time)
        print(f"🔘 Tapping ({x}, {y}) - {description}")
        result = self.adb("shell", "input", "tap", str(x), str(y))
        return result.returncode == 0
    
    def input_text(self, text: str, description: str = "") -> bool:
        """Input text with description (handles spaces properly)"""
        print(f"⌨️ Typing text: '{text}' - {description}")
        
        # Replace spaces with %s for ADB input (required for multi-word text)
        escaped_text = text.replace(' ', '%s')
        result = self.adb("shell", "input", "text", escaped_text)
        
        return result.returncode == 0
    
    def press_key(self, keycode: int, description: str = "") -> bool:
        """Press key with description"""
        print(f"🔑 Pressing key {keycode} - {description}")
        result = self.adb("shell", "input", "keyevent", str(keycode))
        return result.returncode == 0
    
    def open_twitter_app(self) -> bool:
        """Step 1: Open Twitter/X app"""
        print("🚀 STEP 1: Opening Twitter/X app...")
        self.take_xml_dump_and_screenshot("initial_state")
        
        # Launch X app
        result = self.adb("shell", "am", "start", "-n", "com.twitter.android/.StartActivity")
        if result.returncode != 0:
            print("❌ Failed to launch Twitter app")
            return False
            
        time.sleep(3)
        self.take_xml_dump_and_screenshot("app_opened")
        print("✅ Twitter app opened successfully")
        return True
    
    def click_compose_button(self) -> bool:
        """Step 2: Scroll up and click compose button (FAB) to access Post"""
        print("🚀 STEP 2: Preparing to click compose button (FAB)...")
        
        # First scroll up a little to reveal the FAB and Post button (as user mentioned)
        print("📜 Scrolling up slightly to reveal FAB and Post button...")
        self.adb("shell", "input", "swipe", "540", "800", "540", "900", "300")
        time.sleep(1)
        
        self.take_xml_dump_and_screenshot("after_scroll_up")
        
        # Compose button coordinates: updated coordinates
        compose_x, compose_y = 964, 2074  # FAB coordinates
        
        if not self.wait_and_tap(compose_x, compose_y, 2.0, "Compose FAB"):
            return False
            
        self.take_xml_dump_and_screenshot("fab_clicked")
        
        # Click Post button twice as instructed
        print("🔘 Clicking Post button (first click)...")
        if not self.wait_and_tap(compose_x, compose_y, 1.0, "Post button - first click"):
            return False
        
        time.sleep(0.5)
        
        print("🔘 Clicking Post button (second click)...")  
        if not self.wait_and_tap(compose_x, compose_y, 1.0, "Post button - second click"):
            return False
            
        time.sleep(2)
        self.take_xml_dump_and_screenshot("post_compose_opened")
        print("✅ Post compose screen opened successfully")
        return True
    
    def enter_caption_text(self, caption: str) -> bool:
        """Step 3: Enter caption text"""
        print(f"🚀 STEP 3: Entering caption text: '{caption}'...")
        
        # Text input coordinates: resource-id="com.twitter.android:id/tweet_text" bounds="[152,314][1048,411]"
        text_input_x, text_input_y = 600, 362  # Center coordinates
        
        # Click on text input field
        if not self.wait_and_tap(text_input_x, text_input_y, 1.0, "Text input field"):
            return False
        
        # Input the text
        if not self.input_text(caption, "Caption text"):
            return False
            
        time.sleep(1)
        self.take_xml_dump_and_screenshot("text_entered")
        print("✅ Caption text entered successfully")
        return True
    
    def attach_image_from_gallery(self) -> bool:
        """Step 4: Click Photos button and attach image from gallery"""
        print("🚀 STEP 4: Clicking Photos button and attaching image from gallery...")
        
        # FIRST: Click Photos button in footer toolbar
        # Photos button coordinates: resource-id="com.twitter.android:id/gallery" bounds="[0,1363][126,1489]"
        photos_button_x, photos_button_y = 63, 1426  # Center coordinates
        
        print("📸 Clicking Photos button in toolbar...")
        if not self.wait_and_tap(photos_button_x, photos_button_y, 1.0, "Photos button"):
            return False
            
        time.sleep(3)  # Wait for gallery to load
        self.take_xml_dump_and_screenshot("gallery_opened")
        
        # SECOND: Select first image from gallery
        # Select first image: bounds="[362,276][720,634]" 
        image_x, image_y = 541, 455  # Center coordinates
        
        print("🖼️ Selecting first image from gallery...")
        if not self.wait_and_tap(image_x, image_y, 1.0, "First image in gallery"):
            return False
            
        time.sleep(2)
        self.take_xml_dump_and_screenshot("image_selected")
        
        # THIRD: Confirm selection with "Done" button if needed
        # Look for Done button: bounds="[921,138][1080,264]"
        done_x, done_y = 1000, 201  # Center coordinates
        
        print("✅ Confirming image selection...")
        if not self.wait_and_tap(done_x, done_y, 1.0, "Done button"):
            # If Done button not found, that's okay - continue anyway
            print("⚠️ Done button not found, continuing...")
            
        time.sleep(1)
        self.take_xml_dump_and_screenshot("image_attached")
        print("✅ Image attached successfully from gallery")
        return True
    
    def publish_post(self) -> bool:
        """Step 5: Publish the post"""
        print("🚀 STEP 5: Publishing post...")
        
        # Post button coordinates: resource-id="com.twitter.android:id/button_tweet" bounds="[876,159][1048,243]"
        post_button_x, post_button_y = 962, 201  # Center coordinates
        
        if not self.wait_and_tap(post_button_x, post_button_y, 1.0, "Post button"):
            return False
            
        time.sleep(4)  # Wait for posting to complete
        self.take_xml_dump_and_screenshot("post_published")
        print("✅ Post published successfully!")
        return True
    
    def create_post_with_image(self, caption: str) -> bool:
        """Complete workflow: Create a Twitter post with image"""
        print("=" * 60)
        print("🐦 TWITTER POSTING MODULE - COMPLETE WORKFLOW")
        print("=" * 60)
        
        try:
            # Step 1: Standard initialization
            if not self.standard_twitter_init():
                raise Exception("Failed to initialize Twitter")
            
            # Step 2: Click compose button
            if not self.click_compose_button():
                raise Exception("Failed to open compose screen")
            
            # Step 3: Enter caption text
            if not self.enter_caption_text(caption):
                raise Exception("Failed to enter caption text")
            
            # Step 4: Attach image from gallery
            if not self.attach_image_from_gallery():
                raise Exception("Failed to attach image")
            
            # Step 5: Publish post
            if not self.publish_post():
                raise Exception("Failed to publish post")
            
            print("=" * 60)
            print("🎉 SUCCESS! Twitter post created successfully!")
            print(f"📝 Caption: '{caption}'")
            print(f"🖼️ Image: Attached from gallery")
            print(f"📱 Platform: Twitter/X Android App")
            print("=" * 60)
            return True
            
        except Exception as e:
            print(f"❌ ERROR: {str(e)}")
            self.take_xml_dump_and_screenshot("error_state")
            return False

# Key Coordinates and Selectors Reference
TWITTER_SELECTORS = {
    "compose_button": {
        "coordinates": (964, 2074),
        "bounds": "[891,2001][1038,2148]",
        "description": "Main compose FAB button"
    },
    "post_option_menu": {
        "coordinates": (869, 2043),
        "description": "Post option in compose menu"
    },
    "text_input": {
        "resource_id": "com.twitter.android:id/tweet_text",
        "coordinates": (600, 362),
        "bounds": "[152,314][1048,411]",
        "hint": "What's happening?"
    },
    "gallery_button": {
        "resource_id": "com.twitter.android:id/gallery",
        "coordinates": (63, 1426),
        "bounds": "[0,1363][126,1489]",
        "content_desc": "Photos"
    },
    "first_image": {
        "coordinates": (541, 455),
        "bounds": "[362,276][720,634]",
        "content_desc": "Image"
    },
    "post_button": {
        "resource_id": "com.twitter.android:id/button_tweet",
        "coordinates": (962, 201),
        "bounds": "[876,159][1048,243]",
        "text": "POST"
    }
}

if __name__ == "__main__":
    # Example usage
    twitter = TwitterPostingManager()
    
    # Test caption
    test_caption = "Test post with image from automation"
    
    # Create post with image
    success = twitter.create_post_with_image(test_caption)
    
    if success:
        print("🎯 Twitter posting module test completed successfully!")
    else:
        print("❌ Twitter posting module test failed!")