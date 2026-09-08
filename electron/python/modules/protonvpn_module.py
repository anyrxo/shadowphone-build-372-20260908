#!/usr/bin/env python3
"""
🔒 PROTON VPN MODULE
Handles ProtonVPN login and connection

Features:
- Check if already logged in
- Login with credentials if not
- Connect to Streaming US profile
"""

import subprocess
import time
from datetime import datetime


class ProtonVPNModule:
    """
    Handles ProtonVPN automation for secure connections.
    
    Usage:
        vpn = ProtonVPNModule(device_id='1A121FDF60082H')
        vpn.ensure_connected()  # Full flow: login if needed, connect to Streaming US
    """
    
    PACKAGE = "ch.protonvpn.android"
    EMAIL = "sirencyteam@gmail.com"
    PASSWORD = "SirenxMedia1738!"
    
    def __init__(self, device_id="1A121FDF60082H"):
        self.device_id = device_id
        
    def log(self, level, message):
        """Log message with timestamp"""
        timestamp = datetime.now().strftime("%H:%M:%S")
        log_entry = f"[{timestamp}] [{level}] {message}"
        print(log_entry)
        
    def _run_adb(self, *args, timeout=30):
        """Run ADB command with device ID"""
        cmd = ["adb", "-s", self.device_id, "shell"] + list(args)
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            return result
        except subprocess.TimeoutExpired:
            self.log("ERROR", f"ADB command timed out: {' '.join(args)}")
            return None
        except Exception as e:
            self.log("ERROR", f"ADB error: {e}")
            return None
    
    def _get_screen_text(self):
        """Get all text on current screen"""
        self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
        time.sleep(1)
        result = self._run_adb("cat", "/sdcard/ui.xml")
        return result.stdout if result and result.stdout else ""
    
    def _find_and_click(self, text_to_find):
        """Find element by text and click it"""
        import re
        
        self.log("INFO", f"🔍 Looking for '{text_to_find}'...")
        
        self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
        time.sleep(1)
        result = self._run_adb("cat", "/sdcard/ui.xml")
        
        if not result or not result.stdout:
            self.log("WARNING", f"⚠️ Could not dump UI")
            return False
        
        # Search for exact match first
        pattern = rf'text="{re.escape(text_to_find)}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
        match = re.search(pattern, result.stdout, re.IGNORECASE)
        
        if not match:
            # Try partial match
            pattern = rf'text="[^"]*{re.escape(text_to_find)}[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
            match = re.search(pattern, result.stdout, re.IGNORECASE)
        
        if match:
            x1, y1, x2, y2 = int(match.group(1)), int(match.group(2)), int(match.group(3)), int(match.group(4))
            
            center_x = (x1 + x2) // 2
            center_y = (y1 + y2) // 2
            
            self.log("INFO", f"📍 Found '{text_to_find}' at ({center_x}, {center_y})")
            self._run_adb("input", "tap", str(center_x), str(center_y))
            time.sleep(0.5)
            self.log("SUCCESS", f"✅ Clicked '{text_to_find}'!")
            return True
        
        self.log("WARNING", f"⚠️ '{text_to_find}' not found on screen")
        return False
    
    def _type_text(self, text):
        """Type text using ADB"""
        # Check for special characters
        special_chars = set('!@#$%^&*()_+-=[]{}|;:\'",.<>?/\\`~')
        has_special = any(c in special_chars for c in text)
        
        if has_special:
            self.log("INFO", f"📝 Using char-by-char method for special chars...")
            for char in text:
                if char == ' ':
                    self._run_adb("input", "text", "%s")
                elif char in special_chars:
                    # Use keyevent for special chars
                    self._run_adb("input", "text", char)
                else:
                    self._run_adb("input", "text", char)
                time.sleep(0.05)
        else:
            self._run_adb("input", "text", text.replace(" ", "%s"))
        
        self.log("SUCCESS", f"✅ Text entered")
    
    def launch(self):
        """Launch ProtonVPN app"""
        self.log("INFO", "🚀 Launching ProtonVPN...")
        self._run_adb("monkey", "-p", self.PACKAGE, "1")
        time.sleep(3)
        return True
    
    def is_logged_in(self):
        """
        Check if ProtonVPN is logged in.
        
        Returns:
            bool: True if logged in, False if on welcome/login screen
        """
        self.launch()
        time.sleep(2)
        
        screen = self._get_screen_text()
        
        # Check for logged-in indicators
        logged_in_indicators = [
            "You are unprotected",
            "You are protected",
            "Connected",
            "Countries",
            "Profiles",
            "Settings",
            "Connect"
        ]
        
        # Check for not logged in indicators  
        not_logged_in = [
            "Welcome to Proton VPN",
            "Sign in",
            "Continue as guest",
            "Create an account"
        ]
        
        for indicator in not_logged_in:
            if indicator in screen:
                self.log("INFO", "🔓 Not logged in - showing welcome screen")
                return False
        
        for indicator in logged_in_indicators:
            if indicator in screen:
                self.log("INFO", "🔐 Already logged in")
                return True
        
        self.log("WARNING", "⚠️ Could not determine login state")
        return False
    
    def login(self, email=None, password=None):
        """
        Login to ProtonVPN.
        
        Args:
            email: Proton email (default: sirencyteam@gmail.com)
            password: Proton password (default: SirenxMedia1738!)
            
        Returns:
            bool: True if login successful
        """
        email = email or self.EMAIL
        password = password or self.PASSWORD
        
        self.log("INFO", f"🔑 Logging into ProtonVPN with {email}...")
        
        # Click Sign in
        if not self._find_and_click("Sign in"):
            self.log("ERROR", "❌ Could not find Sign in button")
            return False
        time.sleep(2)
        
        # Enter email
        self._find_and_click("Username or email")
        time.sleep(0.5)
        self._type_text(email)
        time.sleep(1)
        
        # Click Continue
        self._find_and_click("Continue")
        time.sleep(3)
        
        # Enter password
        self._find_and_click("Enter your password")
        time.sleep(0.5)
        self._type_text(password)
        time.sleep(1)
        
        # Click Continue
        self._find_and_click("Continue")
        time.sleep(5)
        
        # Verify login success
        screen = self._get_screen_text()
        if "You are unprotected" in screen or "Connect" in screen:
            self.log("SUCCESS", "✅ Login successful!")
            return True
        
        self.log("ERROR", "❌ Login may have failed")
        return False
    
    def connect_streaming_us(self):
        """
        Connect to Streaming US profile.
        
        Flow: Click Profiles → Click "Got it" if shown → Click "Streaming US"
        
        Returns:
            bool: True if connected successfully
        """
        self.log("INFO", "📺 Connecting to Streaming US profile...")
        
        # Click Profiles tab
        if not self._find_and_click("Profiles"):
            self.log("ERROR", "❌ Could not find Profiles tab")
            return False
        time.sleep(2)
        
        # Handle "Got it" popup if shown
        screen = self._get_screen_text()
        if "Got it" in screen:
            self.log("INFO", "📌 Handling 'Got it' popup...")
            self._find_and_click("Got it")
            time.sleep(2)
        
        # Click Streaming US
        if not self._find_and_click("Streaming US"):
            # Try scrolling to find it
            self.log("INFO", "📜 Scrolling to find Streaming US...")
            self._run_adb("input", "swipe", "540", "1500", "540", "800", "300")
            time.sleep(1)
            if not self._find_and_click("Streaming US"):
                self.log("ERROR", "❌ Could not find Streaming US profile")
                return False
        time.sleep(3)
        
        # Handle VPN permission popup if shown
        screen = self._get_screen_text()
        if "Connection request" in screen or "OK" in screen:
            self.log("INFO", "🔐 Handling VPN permission...")
            self._find_and_click("OK")
            time.sleep(3)
        
        # Handle notifications popup
        screen = self._get_screen_text()
        if "Enable notifications" in screen or "No thanks" in screen:
            self.log("INFO", "🔔 Handling notifications popup...")
            self._find_and_click("No thanks")
            time.sleep(2)
        
        # Verify connection
        time.sleep(3)
        screen = self._get_screen_text()
        if "You are protected" in screen or "Connected" in screen:
            self.log("SUCCESS", "✅ Connected to Streaming US!")
            return True
        
        self.log("INFO", "⏳ Connection may still be in progress...")
        return True
    
    def disconnect(self):
        """Disconnect from VPN"""
        self.log("INFO", "🔌 Disconnecting VPN...")
        
        screen = self._get_screen_text()
        if "Disconnect" in screen:
            self._find_and_click("Disconnect")
            time.sleep(2)
            self.log("SUCCESS", "✅ Disconnected")
            return True
        
        self.log("INFO", "Already disconnected or not connected")
        return True
    
    def ensure_connected(self):
        """
        Full flow: Ensure ProtonVPN is logged in and connected to Streaming US.
        
        Returns:
            bool: True if successfully connected
        """
        self.log("INFO", "=" * 60)
        self.log("INFO", "🔒 PROTON VPN - ENSURE CONNECTED")
        self.log("INFO", "=" * 60)
        
        # Check if logged in
        if not self.is_logged_in():
            # Need to login first
            if not self.login():
                return False
        
        # Connect to Streaming US
        return self.connect_streaming_us()
    
    def get_connection_status(self):
        """
        Get current VPN connection status.
        
        Returns:
            dict: {"connected": bool, "server": str, "ip": str}
        """
        self.launch()
        time.sleep(2)
        
        screen = self._get_screen_text()
        
        connected = "You are protected" in screen or "Protected" in screen
        
        # Try to extract IP
        import re
        ip_match = re.search(r'(\d+\.\d+\.\d+\.\d+)', screen)
        ip = ip_match.group(1) if ip_match else "Unknown"
        
        # Try to extract server location
        if "United States" in screen:
            server = "United States"
        elif "Australia" in screen:
            server = "Australia"
        else:
            server = "Unknown"
        
        return {
            "connected": connected,
            "server": server,
            "ip": ip
        }


# Quick test
if __name__ == "__main__":
    vpn = ProtonVPNModule(device_id="1A121FDF60082H")
    vpn.ensure_connected()
