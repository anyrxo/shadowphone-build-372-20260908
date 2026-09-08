#!/usr/bin/env python3
"""
🔧 APPIUM CRASH RECOVERY MODULE
Handles UiAutomator2 server crashes and connection issues
"""

import subprocess
import time
import logging
from typing import Optional

class AppiumCrashRecovery:
    def __init__(self, device_id: str = "1A121FDF60082H"):
        self.device_id = device_id
        self.logger = logging.getLogger(__name__)
        
    def detect_uiautomator_crash(self, error_message: str) -> bool:
        """Detect if error is caused by UiAutomator2 crash or session termination"""
        crash_indicators = [
            "instrumentation process is not running",
            "probably crashed",
            "cannot be proxied to UiAutomator2 server",
            "socket hang up",
            "Could not proxy command to the remote server",
            "A session is either terminated or not started",  # Added session termination
            "NoSuchDriverError",  # Added driver error
            "session is either terminated or not started"  # Alternative phrasing
        ]
        
        return any(indicator in error_message for indicator in crash_indicators)
    
    def recover_uiautomator_session(self) -> bool:
        """Recover from UiAutomator2 server crash"""
        try:
            print("🔄 Detecting UiAutomator2 crash - starting recovery...")
            
            # Step 1: Force stop UiAutomator2 processes
            print("1️⃣ Stopping crashed UiAutomator2 processes...")
            subprocess.run([
                'adb', '-s', self.device_id, 'shell', 
                'am', 'force-stop', 'io.appium.uiautomator2.server'
            ], capture_output=True, timeout=10)
            
            subprocess.run([
                'adb', '-s', self.device_id, 'shell', 
                'am', 'force-stop', 'io.appium.uiautomator2.server.test'
            ], capture_output=True, timeout=10)
            
            time.sleep(2)
            
            # Step 2: Clear UiAutomator2 cache
            print("2️⃣ Clearing UiAutomator2 cache...")
            subprocess.run([
                'adb', '-s', self.device_id, 'shell', 
                'pm', 'clear', 'io.appium.uiautomator2.server'
            ], capture_output=True, timeout=10)
            
            time.sleep(1)
            
            # Step 3: Restart ADB if needed
            print("3️⃣ Checking ADB connection...")
            result = subprocess.run(['adb', 'devices'], capture_output=True, text=True, timeout=10)
            
            if self.device_id not in result.stdout:
                print("   🔄 Restarting ADB server...")
                subprocess.run(['adb', 'kill-server'], capture_output=True, timeout=5)
                time.sleep(2)
                subprocess.run(['adb', 'start-server'], capture_output=True, timeout=10)
                time.sleep(3)
            
            # Step 4: Verify device connection
            result = subprocess.run(['adb', 'devices'], capture_output=True, text=True, timeout=10)
            if self.device_id in result.stdout:
                print("✅ UiAutomator2 crash recovery completed - device reconnected")
                return True
            else:
                print("❌ Device not found after recovery attempt")
                return False
                
        except Exception as e:
            print(f"❌ Recovery failed: {e}")
            return False
    
    def create_new_appium_session(self, capabilities: dict) -> Optional[object]:
        """Create new Appium session after crash recovery"""
        try:
            from appium import webdriver
            
            print("🔄 Creating new Appium session...")
            
            # Add crash prevention capabilities
            enhanced_caps = capabilities.copy()
            enhanced_caps.update({
                'newCommandTimeout': 300,  # 5 minutes
                'uiautomator2ServerInstallTimeout': 60000,
                'uiautomator2ServerLaunchTimeout': 60000,
                'autoGrantPermissions': True,
                'noReset': True,
                'fullReset': False
            })
            
            driver = webdriver.Remote(
                'http://127.0.0.1:4723',
                options=enhanced_caps
            )
            
            print("✅ New Appium session created successfully")
            return driver
            
        except Exception as e:
            print(f"❌ Failed to create new session: {e}")
            return None
    
    def handle_automation_error(self, error: Exception, driver=None) -> tuple[bool, Optional[object]]:
        """
        Handle automation errors with automatic recovery
        Returns: (recovery_successful, new_driver_if_needed)
        """
        error_message = str(error)
        
        if self.detect_uiautomator_crash(error_message):
            print("🚨 UiAutomator2 crash detected - attempting automatic recovery...")
            
            # Close existing session if available
            if driver:
                try:
                    driver.quit()
                except:
                    pass
            
            # Attempt recovery
            if self.recover_uiautomator_session():
                print("✅ Recovery successful - automation can continue with new session")
                return True, None
            else:
                print("❌ Recovery failed - manual intervention required")
                return False, None
        else:
            print(f"⚠️ Non-crash error detected: {error_message}")
            return False, None

# Convenience function for modules to use
def auto_recover_from_crash(error: Exception, device_id: str = "1A121FDF60082H", driver=None):
    """Automatically recover from UiAutomator2 crashes"""
    recovery = AppiumCrashRecovery(device_id)
    success, new_driver = recovery.handle_automation_error(error, driver)
    
    if success:
        print("🎉 Automatic crash recovery completed - ready to continue")
    else:
        print("⚠️ Manual restart required - close and restart your automation")
    
    return success, new_driver

if __name__ == "__main__":
    # Test recovery functionality
    recovery = AppiumCrashRecovery()
    
    # Simulate crash recovery
    print("🧪 Testing crash recovery...")
    success = recovery.recover_uiautomator_session()
    
    if success:
        print("✅ Recovery test successful")
    else:
        print("❌ Recovery test failed")