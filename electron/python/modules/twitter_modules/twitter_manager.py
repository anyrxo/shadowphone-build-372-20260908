#!/usr/bin/env python3
"""
🐦 TWITTER MANAGER - Dashboard Integration
Unified Twitter automation for profile-based posting
Integrated with same Google Drive structure as Instagram
"""

import subprocess
import time
import os
from typing import Optional, Tuple, Dict, Any

# Import the core Twitter modules
try:
    from .twitter_launcher import TwitterLauncher
    from .twitter_posting import TwitterPostingManager  
    from .google_drive_download import ImprovedDriveManager
except ImportError:
    # Fallback imports for standalone usage
    import sys
    sys.path.append(os.path.dirname(__file__))
    from twitter_launcher import TwitterLauncher
    from twitter_posting import TwitterPostingManager
    from google_drive_download import ImprovedDriveManager

class TwitterManager:
    """Unified Twitter automation manager for dashboard integration"""
    
    def __init__(self, device_id="1A121FDF60082H", profile_data=None):
        self.device_id = device_id
        self.profile_data = profile_data or {}
        
        # Initialize core components
        self.launcher = TwitterLauncher(device_id=device_id)
        self.posting = TwitterPostingManager()
        self.posting.device_id = device_id  # Set device ID for posting module
        
        # Drive manager will be initialized per profile
        self.drive_manager = None
        
        print(f"🐦 Twitter Manager initialized for device {device_id}")
        if profile_data:
            print(f"📱 Profile: {profile_data.get('name', 'Unknown')} (ID: {profile_data.get('id', 'N/A')})")
            
            # Setup drive manager immediately if profile data has drive URL
            if 'drive_url' in profile_data:
                print(f"🔧 Setting up Twitter drive manager with profile drive URL...")
                self.setup_drive_manager(profile_data['drive_url'])
    
    def connect(self):
        """Connect to device via ADB (same as Instagram modules)"""
        try:
            # Use ADB approach like Instagram modules instead of Appium
            print(f"📱 Connecting to device {self.device_id} via ADB...")
            
            # Simple ADB validation - same as Instagram modules
            result = subprocess.run([
                'adb', '-s', self.device_id, 'shell', 'echo', 'device_connected'
            ], capture_output=True, text=True, timeout=10)
            
            if result.returncode == 0 and 'device_connected' in result.stdout:
                print(f"✅ Device {self.device_id} connected via ADB")
                return True
            else:
                print(f"❌ Device {self.device_id} not responding")
                return False
                
        except Exception as e:
            print(f"❌ ADB connection failed: {e}")
            return False
    
    def disconnect(self):
        """Disconnect from device"""
        if self.launcher:
            self.launcher.disconnect()
    
    def initialize_twitter(self):
        """Initialize Twitter app using ADB commands (like Instagram modules)"""
        try:
            print("🔄 TWITTER INITIALIZATION - ADB Mode")
            
            if not self.connect():
                print("❌ Failed to connect to device")
                return False
            
            # Use ADB commands directly like Instagram modules
            print("🐦 Launching Twitter via ADB...")
            
            # Force stop and restart Twitter
            subprocess.run([
                'adb', '-s', self.device_id, 'shell', 'am', 'force-stop', 'com.twitter.android'
            ], capture_output=True, text=True, timeout=10)
            time.sleep(2)
            
            # Launch Twitter
            result = subprocess.run([
                'adb', '-s', self.device_id, 'shell', 'monkey', '-p', 'com.twitter.android', 
                '-c', 'android.intent.category.LAUNCHER', '1'
            ], capture_output=True, text=True, timeout=15)
            
            if result.returncode == 0:
                print("✅ Twitter launched via ADB")
                time.sleep(5)  # Wait for app to load
                return True
            else:
                print("❌ Twitter launch failed")
                return False
            
        except Exception as e:
            print(f"❌ Twitter initialization failed: {e}")
            return False
    
    def setup_drive_manager(self, drive_url=None):
        """Setup Google Drive manager for current profile"""
        try:
            # Use profile-specific drive URL if available
            if not drive_url and self.profile_data:
                # First try to get from profile_data (if provided)
                drive_url = self.profile_data.get('drive_url')
                
                # If not in profile_data, use the same method as Instagram modules
                # This requires access to the dashboard's get_profile_drive_url method
                if not drive_url:
                    profile_id = self.profile_data.get('id', '0')
                    print(f"📁 Getting drive URL for profile {profile_id} using dashboard method")
                    # Note: This would need to be passed from dashboard or implemented differently
                    # For now, we'll rely on the drive_url being passed explicitly
            
            if not drive_url:
                print("⚠️ No drive URL available - Twitter posting may require manual content")
                return False
            
            self.drive_manager = ImprovedDriveManager(
                device_id=self.device_id,
                drive_url=drive_url
            )
            
            # Override target folders for Twitter (use "X" folder)
            self.drive_manager.target_folders = ["X"]
            
            print(f"📁 Drive manager setup for Twitter content using URL: {drive_url[:50]}...")
            return True
            
        except Exception as e:
            print(f"❌ Drive manager setup failed: {e}")
            return False
    
    def download_content(self, content_type="post"):
        """Download content from Google Drive for Twitter posting"""
        try:
            if not self.drive_manager:
                if not self.setup_drive_manager():
                    print(f"❌ Failed to setup drive manager for Twitter content")
                    return False, None
            
            print(f"📥 Downloading {content_type} content from X folder...")
            
            # Use the X folder for Twitter content
            success = self.drive_manager.post_from_drive("X")
            
            if success:
                print(f"✅ Downloaded {content_type} content for Twitter")
                return True, "downloaded_content"  # Generic filename
            else:
                print(f"❌ Failed to download {content_type} content")
                return False, None
                
        except Exception as e:
            print(f"❌ Content download failed: {e}")
            return False, None
    
    def create_twitter_post(self, caption, with_media=True):
        """Create a Twitter post with optional media"""
        try:
            if with_media:
                print(f"🐦 Creating Twitter post with media: '{caption}'")
                # Download content first
                success, filename = self.download_content("post")
                if not success:
                    print("❌ Failed to download media content - creating text-only post instead")
                    return self.create_text_only_post(caption)
                
                # Initialize Twitter if needed
                if not self.initialize_twitter():
                    print("❌ Failed to initialize Twitter")
                    return False
                
                # Create the post using the posting module with media
                success = self.posting.create_post_with_image(caption)
            else:
                print(f"🐦 Creating text-only Twitter post: '{caption}'")
                return self.create_text_only_post(caption)
            
            if success:
                print(f"✅ Twitter post created successfully!")
                return True
            else:
                print("❌ Failed to create Twitter post")
                return False
                
        except Exception as e:
            print(f"❌ Twitter post creation failed: {e}")
            return False
    
    def create_text_only_post(self, caption):
        """Create a text-only Twitter post (no media)"""
        try:
            print(f"🐦 Creating text-only Twitter post: '{caption}'")
            
            # Initialize Twitter if needed
            if not self.initialize_twitter():
                print("❌ Failed to initialize Twitter")
                return False
            
            # Use the posting module but skip media download
            # The posting module should handle text-only posts
            try:
                success = self.posting.create_text_post(caption)
                if success:
                    print(f"✅ Text-only Twitter post created successfully!")
                    return True
                else:
                    print("❌ Text-only posting module failed")
                    return False
            except AttributeError:
                # If create_text_post method doesn't exist, fall back to regular posting
                print("⚠️ Text-only method not available, using regular posting without media")
                success = self.posting.create_post_with_image(caption)
                if success:
                    print(f"✅ Twitter post created (may have attempted media attachment)")
                    return True
                else:
                    print("❌ Twitter post creation failed")
                    return False
            
        except Exception as e:
            print(f"❌ Text-only post creation failed: {e}")
            return False
    
    def get_twitter_status(self):
        """Check if Twitter is running and accessible"""
        try:
            if self.launcher and self.launcher.is_twitter_running():
                return {"status": "running", "message": "Twitter app is active"}
            else:
                return {"status": "stopped", "message": "Twitter app is not running"}
        except Exception as e:
            return {"status": "error", "message": f"Status check failed: {e}"}
    
    def restart_twitter(self):
        """Restart Twitter app"""
        try:
            if self.launcher:
                return self.launcher.restart_twitter()
            return False
        except Exception as e:
            print(f"❌ Twitter restart failed: {e}")
            return False
    
    def cleanup(self):
        """Clean up resources"""
        if self.launcher:
            self.launcher.cleanup()
        if self.drive_manager:
            pass  # Drive manager doesn't need cleanup
    
    def __del__(self):
        """Destructor"""
        try:
            self.cleanup()
        except:
            pass

# Factory function for dashboard integration
def create_twitter_manager(device_id, profile_data=None):
    """Create a Twitter manager instance for dashboard use"""
    return TwitterManager(device_id=device_id, profile_data=profile_data)

# Test function
def test_twitter_manager():
    """Test the Twitter manager functionality"""
    print("🧪 Testing Twitter Manager...")
    
    # Test profile data
    test_profile = {
        'id': 'test_profile',
        'name': 'Test Profile',
        'drive_url': 'https://drive.google.com/drive/folders/test'
    }
    
    manager = TwitterManager(profile_data=test_profile)
    
    # Test connection
    if manager.connect():
        print("✅ Connection successful")
        
        # Test Twitter status
        status = manager.get_twitter_status()
        print(f"📱 Twitter status: {status}")
        
        # Test initialization
        if manager.initialize_twitter():
            print("✅ Twitter initialization successful")
        else:
            print("❌ Twitter initialization failed")
            
    else:
        print("❌ Connection failed")
    
    manager.cleanup()
    print("🧪 Twitter Manager test completed")

if __name__ == "__main__":
    test_twitter_manager()