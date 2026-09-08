#!/usr/bin/env python3
"""
🔧 DRIVER MANAGER MODULE
Centralized WebDriver session management to prevent UiAutomator2 crashes.

The main cause of UiAutomator2 crashes is:
1. Too many orphaned WebDriver sessions
2. Not properly quitting drivers after use
3. Memory pressure on the device

This module provides:
- Single shared driver instance
- Automatic cleanup of orphaned sessions
- Proactive session health checks
- Auto-recovery from crashes
"""

from appium import webdriver
from appium.options.android import UiAutomator2Options
import subprocess
import time
import threading
import requests

class DriverManager:
    """Singleton driver manager to prevent session buildup"""
    
    _instance = None
    _lock = threading.Lock()
    
    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        
        self.driver = None
        self.device_id = None
        self.session_created_at = None
        self.session_count = 0
        self.max_session_age_seconds = 60 * 30
        self._initialized = True
        print("🔧 DriverManager initialized (singleton)")
    
    def _kill_orphan_sessions(self):
        """Kill any orphaned Appium sessions via REST API"""
        try:
            # Get all sessions from Appium
            response = requests.get("http://127.0.0.1:4723/sessions", timeout=5)
            if response.status_code == 200:
                data = response.json()
                sessions = data.get('value', [])
                
                if len(sessions) > 0:
                    print(f"🧹 Found {len(sessions)} existing session(s), cleaning up...")
                    
                    for session in sessions:
                        session_id = session.get('id')
                        if session_id:
                            try:
                                # Delete session via REST
                                requests.delete(f"http://127.0.0.1:4723/session/{session_id}", timeout=5)
                                print(f"   ✅ Killed orphan session: {session_id[:8]}...")
                            except:
                                pass
                    
                    time.sleep(1)  # Give Appium time to clean up
        except Exception as e:
            print(f"⚠️ Could not check for orphan sessions: {e}")
    
    def _restart_uiautomator2(self, device_id):
        """Force restart UiAutomator2 on device to fix crashes"""
        try:
            print("🔄 Force restarting UiAutomator2 on device...")
            
            # Kill any running automation processes
            subprocess.run([
                "adb", "-s", device_id, "shell", 
                "am", "force-stop", "io.appium.uiautomator2.server"
            ], capture_output=True, timeout=5)
            
            subprocess.run([
                "adb", "-s", device_id, "shell", 
                "am", "force-stop", "io.appium.uiautomator2.server.test"
            ], capture_output=True, timeout=5)
            
            # Clear UiAutomator2 data (helps with memory issues)
            subprocess.run([
                "adb", "-s", device_id, "shell", 
                "pm", "clear", "io.appium.uiautomator2.server"
            ], capture_output=True, timeout=10)
            
            time.sleep(2)
            print("✅ UiAutomator2 restarted on device")
            return True
            
        except Exception as e:
            print(f"⚠️ UiAutomator2 restart failed: {e}")
            return False
    
    def _session_age_seconds(self):
        if not self.session_created_at:
            return None
        try:
            return max(0, time.time() - self.session_created_at)
        except Exception:
            return None

    def _assess_driver_health(self, driver=None, expected_device_id=None):
        driver = driver or self.driver
        if not driver:
            return False, "missing_driver"
        try:
            session_id = getattr(driver, 'session_id', None)
            if not session_id:
                return False, 'missing_session_id'

            age_seconds = self._session_age_seconds()
            if age_seconds is not None and age_seconds > self.max_session_age_seconds:
                return False, f'session_too_old:{int(age_seconds)}s'

            _ = driver.current_package
            _ = driver.current_activity
            if expected_device_id and self.device_id and expected_device_id != self.device_id:
                return False, f'device_mismatch:{self.device_id}->{expected_device_id}'
            return True, 'healthy'
        except Exception as e:
            return False, f'unhealthy:{e}'

    def _dispose_unhealthy_driver(self, reason='unhealthy'):
        if self.driver:
            try:
                print(f"🧹 Disposing shared driver ({reason})")
                self.driver.quit()
            except Exception:
                pass
        self.driver = None
        self.session_created_at = None

    def get_driver(self, device_id, force_new=False):
        """
        Get a WebDriver instance. Reuses existing if healthy.
        
        Args:
            device_id: The ADB device ID
            force_new: Force create a new session even if one exists
            
        Returns:
            WebDriver instance or None if failed
        """
        previous_device_id = self.device_id
        self.device_id = device_id
        
        # Check if existing driver is still healthy
        if self.driver and not force_new:
            healthy, reason = self._assess_driver_health(self.driver, expected_device_id=device_id)
            if healthy:
                session_id = getattr(self.driver, 'session_id', '')
                age_seconds = self._session_age_seconds()
                age_label = f", age={int(age_seconds)}s" if age_seconds is not None else ''
                print(f"♻️ Reusing healthy driver session: {session_id[:8]}...{age_label}")
                return self.driver

            if reason.startswith('unhealthy:') or reason.startswith('missing_') or reason.startswith('session_too_old') or reason.startswith('device_mismatch'):
                print(f"⚠️ Shared driver not reusable: {reason}")
                self._dispose_unhealthy_driver(reason)
            else:
                print(f"⚠️ Shared driver health inconclusive: {reason}")
                self._dispose_unhealthy_driver(reason)
        
        # Clean up orphan sessions first
        self._kill_orphan_sessions()
        
        recreate_reason = 'force_new' if force_new else 'health_recovery_or_first_create'
        print(f"📱 Creating new WebDriver session ({recreate_reason})...")

        # If this is a force_new or we've had many sessions, restart UiAutomator2
        if force_new or (self.session_count > 0 and self.session_count % 5 == 0):
            self._restart_uiautomator2(device_id)
        
        for attempt in range(3):
            try:
                options = UiAutomator2Options()
                options.platform_name = "Android"
                options.device_name = device_id
                options.automation_name = "UIAutomator2"
                options.no_reset = True
                options.full_reset = False
                options.new_command_timeout = 600  # 10 minutes - longer timeout
                
                # These help prevent crashes
                options.set_capability("skipServerInstallation", False)
                options.set_capability("skipDeviceInitialization", False)
                options.set_capability("disableWindowAnimation", True)  # Faster, less stress
                
                self.driver = webdriver.Remote("http://127.0.0.1:4723", options=options)
                self.session_created_at = time.time()
                self.session_count += 1
                
                # Verify session works
                healthy, reason = self._assess_driver_health(self.driver, expected_device_id=device_id)
                session_id = getattr(self.driver, 'session_id', None)
                if healthy and session_id:
                    print(f"✅ New driver session created and verified healthy: {session_id[:8]}...")
                    return self.driver

                print(f"⚠️ New session failed health verification: {reason}")
                self._dispose_unhealthy_driver(reason)
                    
            except Exception as e:
                print(f"❌ Session creation attempt {attempt + 1}/3 failed: {e}")
                
                if attempt < 2:
                    # On failure, restart UiAutomator2 and try again
                    self._restart_uiautomator2(device_id)
                    time.sleep(2)
        
        print("❌ Failed to create driver session after 3 attempts")
        return None
    
    def quit_driver(self):
        """Properly quit the current driver session"""
        if self.driver:
            try:
                self.driver.quit()
                print("🔄 Driver session closed")
            except:
                pass
            self.driver = None
    
    def recover_from_crash(self):
        """Recover from a UiAutomator2 crash"""
        print("🚨 Recovering from UiAutomator2 crash...")
        
        # Kill any existing session
        self._dispose_unhealthy_driver('crash_recovery')
        
        # Kill orphans
        self._kill_orphan_sessions()
        
        # Restart UiAutomator2
        if self.device_id:
            self._restart_uiautomator2(self.device_id)
        
        # Get new driver
        return self.get_driver(self.device_id, force_new=True)
    
    def is_crash_error(self, error):
        """Check if an error indicates UiAutomator2 crash"""
        error_str = str(error).lower()
        crash_indicators = [
            "instrumentation process is not running",
            "probably crashed",
            "uiautomator2 server",
            "session not created",
            "session deleted",
            "cannot proxy"
        ]
        return any(indicator in error_str for indicator in crash_indicators)


# Global singleton instance
_driver_manager = None

def get_driver_manager():
    """Get the global DriverManager instance"""
    global _driver_manager
    if _driver_manager is None:
        _driver_manager = DriverManager()
    return _driver_manager


# Convenience functions
def get_shared_driver(device_id, force_new=False):
    """Get a shared driver instance"""
    return get_driver_manager().get_driver(device_id, force_new)

def quit_shared_driver():
    """Quit the shared driver"""
    get_driver_manager().quit_driver()

def recover_driver():
    """Recover from a crash"""
    return get_driver_manager().recover_from_crash()

def is_crash_error(error):
    """Check if error is a UiAutomator2 crash"""
    return get_driver_manager().is_crash_error(error)
