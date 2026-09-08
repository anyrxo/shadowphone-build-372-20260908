#!/usr/bin/env python3
"""
🎵 TIKTOK LAUNCHER MODULE
Handles TikTok app management and navigation
"""

import subprocess
import time
import os
from typing import Optional


class TikTokLauncher:
    """Handles TikTok app launching and basic navigation"""
    
    # TikTok package name
    TIKTOK_PACKAGE = "com.zhiliaoapp.musically"
    
    def __init__(self, device_id="1A121FDF60082H"):
        self.device_id = device_id
        print(f"🎵 TikTok Launcher initialized for device {device_id}")
    
    def connect(self) -> bool:
        """Connect to device via ADB"""
        try:
            result = subprocess.run(
                ['adb', '-s', self.device_id, 'shell', 'echo', 'connected'],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0 and 'connected' in result.stdout:
                print(f"✅ Device {self.device_id} connected")
                return True
            return False
        except Exception as e:
            print(f"❌ ADB connection failed: {e}")
            return False
    
    def disconnect(self):
        """Disconnect cleanup (if needed)"""
        pass
    
    def launch_tiktok(self) -> bool:
        """Launch TikTok app"""
        try:
            print("🎵 Launching TikTok...")
            
            # Force stop first
            subprocess.run(
                ['adb', '-s', self.device_id, 'shell', 'am', 'force-stop', self.TIKTOK_PACKAGE],
                capture_output=True, text=True, timeout=10
            )
            time.sleep(2)
            
            # Launch TikTok
            result = subprocess.run(
                ['adb', '-s', self.device_id, 'shell', 'monkey', '-p', self.TIKTOK_PACKAGE,
                 '-c', 'android.intent.category.LAUNCHER', '1'],
                capture_output=True, text=True, timeout=15
            )
            
            if result.returncode == 0:
                print("✅ TikTok launched")
                time.sleep(5)  # Wait for app to load
                return True
            else:
                print("❌ TikTok launch failed")
                return False
                
        except Exception as e:
            print(f"❌ TikTok launch error: {e}")
            return False
    
    def is_tiktok_running(self) -> bool:
        """Check if TikTok is running"""
        try:
            result = subprocess.run(
                ['adb', '-s', self.device_id, 'shell', 'dumpsys', 'window', 'windows'],
                capture_output=True, text=True, timeout=10
            )
            return self.TIKTOK_PACKAGE in result.stdout
        except:
            return False
    
    def force_stop_tiktok(self) -> bool:
        """Force stop TikTok app"""
        try:
            subprocess.run(
                ['adb', '-s', self.device_id, 'shell', 'am', 'force-stop', self.TIKTOK_PACKAGE],
                capture_output=True, text=True, timeout=10
            )
            print("🛑 TikTok force stopped")
            return True
        except:
            return False
    
    def restart_tiktok(self) -> bool:
        """Restart TikTok app"""
        self.force_stop_tiktok()
        time.sleep(2)
        return self.launch_tiktok()
    
    def go_to_home_feed(self) -> bool:
        """Navigate to TikTok home feed (For You page)"""
        try:
            # Press home tab - usually first tab in bottom nav
            # This would need proper selectors once we analyze the UI
            print("🏠 Navigating to TikTok home feed...")
            return True
        except:
            return False
    
    def go_to_upload(self) -> bool:
        """Navigate to upload/create page (+ button)"""
        try:
            print("📤 Navigating to TikTok upload screen...")
            # Center button in bottom nav is usually the + create button
            # Will need proper selectors
            return True
        except:
            return False
    
    def cleanup(self):
        """Cleanup resources"""
        pass


if __name__ == "__main__":
    launcher = TikTokLauncher()
    if launcher.connect():
        launcher.launch_tiktok()
        print(f"TikTok running: {launcher.is_tiktok_running()}")
