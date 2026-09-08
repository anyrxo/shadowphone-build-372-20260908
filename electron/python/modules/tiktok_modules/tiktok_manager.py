#!/usr/bin/env python3
"""
🎵 TIKTOK MANAGER - Dashboard Integration
Unified TikTok automation for profile-based posting
Integrated with same Google Drive structure as Instagram/Twitter
"""

import subprocess
import time
import os
from typing import Optional, Tuple, Dict, Any

# Import the core TikTok modules
try:
    from .tiktok_launcher import TikTokLauncher
    from .tiktok_posting import TikTokPostingManager
except ImportError:
    # Fallback imports for standalone usage
    import sys
    sys.path.append(os.path.dirname(__file__))
    from tiktok_launcher import TikTokLauncher
    try:
        from tiktok_posting import TikTokPostingManager
    except ImportError:
        TikTokPostingManager = None


class TikTokManager:
    """Unified TikTok automation manager for dashboard integration"""
    
    def __init__(self, device_id="1A121FDF60082H", profile_data=None):
        self.device_id = device_id
        self.profile_data = profile_data or {}
        
        # Initialize core components
        self.launcher = TikTokLauncher(device_id=device_id)
        
        # Posting manager (may not exist yet)
        self.posting = None
        if TikTokPostingManager:
            self.posting = TikTokPostingManager()
            self.posting.device_id = device_id
        
        # Drive manager for content
        self.drive_manager = None
        
        print(f"🎵 TikTok Manager initialized for device {device_id}")
        if profile_data:
            print(f"📱 Profile: {profile_data.get('name', 'Unknown')} (ID: {profile_data.get('id', 'N/A')})")
    
    def connect(self) -> bool:
        """Connect to device via ADB"""
        return self.launcher.connect()
    
    def disconnect(self):
        """Disconnect from device"""
        if self.launcher:
            self.launcher.disconnect()
    
    def initialize_tiktok(self) -> bool:
        """Initialize TikTok app"""
        try:
            print("🔄 TIKTOK INITIALIZATION - ADB Mode")
            
            if not self.connect():
                print("❌ Failed to connect to device")
                return False
            
            return self.launcher.launch_tiktok()
            
        except Exception as e:
            print(f"❌ TikTok initialization failed: {e}")
            return False
    
    def setup_drive_manager(self, drive_url=None) -> bool:
        """Setup Google Drive manager for current profile"""
        try:
            # Import drive manager from twitter modules (shared)
            from modules.twitter_modules.google_drive_download import ImprovedDriveManager
            
            if not drive_url and self.profile_data:
                drive_url = self.profile_data.get('drive_url')
            
            if not drive_url:
                print("⚠️ No drive URL available - TikTok posting may require manual content")
                return False
            
            self.drive_manager = ImprovedDriveManager(
                device_id=self.device_id,
                drive_url=drive_url
            )
            
            # Use "TikTok" folder for TikTok content
            self.drive_manager.target_folders = ["TikTok", "tiktok"]
            
            print(f"📁 Drive manager setup for TikTok content")
            return True
            
        except Exception as e:
            print(f"❌ Drive manager setup failed: {e}")
            return False
    
    def download_content(self, content_type="video"):
        """Download content from Google Drive for TikTok posting"""
        try:
            if not self.drive_manager:
                if not self.setup_drive_manager():
                    print(f"❌ Failed to setup drive manager for TikTok content")
                    return False, None
            
            print(f"📥 Downloading {content_type} content from TikTok folder...")
            
            # Use the TikTok folder for content
            success = self.drive_manager.post_from_drive("TikTok")
            
            if success:
                print(f"✅ Downloaded {content_type} content for TikTok")
                return True, "downloaded_content"
            else:
                print(f"❌ Failed to download {content_type} content")
                return False, None
                
        except Exception as e:
            print(f"❌ Content download failed: {e}")
            return False, None
    
    def create_tiktok_post(self, caption: str, with_video: bool = True) -> bool:
        """Create a TikTok post (video)"""
        try:
            if not self.posting:
                print("❌ TikTok posting module not available yet")
                return False
            
            if with_video:
                print(f"🎵 Creating TikTok post with video: '{caption[:50]}...'")
                
                # Download content first
                success, filename = self.download_content("video")
                if not success:
                    print("❌ Failed to download video content")
                    return False
                
                # Initialize TikTok if needed
                if not self.initialize_tiktok():
                    print("❌ Failed to initialize TikTok")
                    return False
                
                # Create the post
                success = self.posting.create_post(caption)
                
                if success:
                    print("✅ TikTok post created successfully!")
                    return True
                else:
                    print("❌ Failed to create TikTok post")
                    return False
            else:
                print("❌ TikTok requires video content for posts")
                return False
                
        except Exception as e:
            print(f"❌ TikTok post creation failed: {e}")
            return False
    
    def engage_with_feed(self, like_count: int = 5, comment_count: int = 2) -> dict:
        """Engage with TikTok feed (like, comment)"""
        try:
            print(f"💝 TikTok Engagement: {like_count} likes, {comment_count} comments")
            
            if not self.initialize_tiktok():
                return {"success": False, "message": "Failed to initialize TikTok"}
            
            # TODO: Implement engagement logic
            # - Scroll through feed
            # - Double-tap to like
            # - Open comments and add comment
            
            print("⚠️ TikTok engagement module coming soon")
            return {
                "success": False, 
                "message": "TikTok engagement not yet implemented",
                "likes": 0,
                "comments": 0
            }
            
        except Exception as e:
            return {"success": False, "message": f"Engagement failed: {e}"}
    
    def get_tiktok_status(self) -> dict:
        """Check if TikTok is running"""
        try:
            if self.launcher and self.launcher.is_tiktok_running():
                return {"status": "running", "message": "TikTok app is active"}
            else:
                return {"status": "stopped", "message": "TikTok app is not running"}
        except Exception as e:
            return {"status": "error", "message": f"Status check failed: {e}"}
    
    def restart_tiktok(self) -> bool:
        """Restart TikTok app"""
        try:
            if self.launcher:
                return self.launcher.restart_tiktok()
            return False
        except Exception as e:
            print(f"❌ TikTok restart failed: {e}")
            return False
    
    def cleanup(self):
        """Clean up resources"""
        if self.launcher:
            self.launcher.cleanup()


# Factory function for dashboard integration
def create_tiktok_manager(device_id, profile_data=None):
    """Create a TikTok manager instance for dashboard use"""
    return TikTokManager(device_id=device_id, profile_data=profile_data)


# Test function
def test_tiktok_manager():
    """Test the TikTok manager functionality"""
    print("🧪 Testing TikTok Manager...")
    
    test_profile = {
        'id': 'test_profile',
        'name': 'Test Profile',
        'drive_url': 'https://drive.google.com/drive/folders/test'
    }
    
    manager = TikTokManager(profile_data=test_profile)
    
    if manager.connect():
        print("✅ Connection successful")
        
        status = manager.get_tiktok_status()
        print(f"📱 TikTok status: {status}")
        
        if manager.initialize_tiktok():
            print("✅ TikTok initialization successful")
        else:
            print("❌ TikTok initialization failed")
    else:
        print("❌ Connection failed")
    
    manager.cleanup()
    print("🧪 TikTok Manager test completed")


if __name__ == "__main__":
    test_tiktok_manager()
