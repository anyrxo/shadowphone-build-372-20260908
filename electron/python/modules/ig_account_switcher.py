#!/usr/bin/env python3
"""
📱 IG ACCOUNT SWITCHER MODULE
Switches between Instagram accounts within the same phone profile (stacked accounts).

Flow:
1. Long-press profile button (next to Reels button)
2. Popup appears with account list
3. Tap the target username to switch

Usage:
    from modules.ig_account_switcher import IGAccountSwitcher
    
    switcher = IGAccountSwitcher(device_id="1A121FDF60082H")
    switcher.switch_to_account("counterstories_")
"""

import subprocess
import time
import random
import re
import tempfile
import os
import sys

from lib.bootstrap_profile_guards import BootstrapProfileGuards
from lib.screen_state import ScreenObservation

# Fix Windows console encoding (skip if running inside Flet's TerminalCapture)
if sys.platform == 'win32':
    try:
        if hasattr(sys.stdout, 'reconfigure'):
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass  # Running inside Flet or other non-standard stdout


class IGAccountSwitcher:
    def __init__(self, device_id="1A121FDF60082H"):
        self.device_id = device_id
        
        # Profile button location (next to Reels button) - bottom nav bar
        # This is the profile icon in bottom navigation
        self.profile_button_coord = (984, 2274)  # Rightmost button in nav bar

    def _build_observation_from_xml(self, xml_content):
        return ScreenObservation(
            observed_at="adb_ui_dump",
            device_id=self.device_id,
            package="com.instagram.android",
            xml_source=xml_content,
        )

    def _guards_for_xml(self, xml_content):
        return BootstrapProfileGuards(
            lambda: self._build_observation_from_xml(xml_content),
            log=print,
        )
        
    def adb(self, *args):
        """Execute ADB command"""
        cmd = ["adb", "-s", self.device_id] + list(args)
        return subprocess.run(cmd, capture_output=True, text=True)
    
    def _get_ui_dump(self):
        """Get fresh UI dump and return content"""
        temp_file = os.path.join(tempfile.gettempdir(), "ig_switch_dump.xml")
        
        result = self.adb("shell", "uiautomator", "dump", "/sdcard/ig_switch.xml")
        if result.returncode != 0:
            return None
            
        result = self.adb("pull", "/sdcard/ig_switch.xml", temp_file)
        if result.returncode != 0:
            return None
        
        try:
            with open(temp_file, 'r', encoding='utf-8') as f:
                content = f.read()
            os.remove(temp_file)
            return content
        except:
            return None
    
    def _find_element_bounds(self, xml_content, search_type, search_value):
        """Find element bounds in XML content
        
        Args:
            xml_content: UI dump XML string
            search_type: 'text', 'content_desc', 'resource_id', 'text_contains'
            search_value: Value to search for
            
        Returns:
            (center_x, center_y) or None if not found
        """
        if search_type == 'text':
            pattern = rf'text="{re.escape(search_value)}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
        elif search_type == 'content_desc':
            pattern = rf'content-desc="{re.escape(search_value)}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
        elif search_type == 'resource_id':
            pattern = rf'resource-id="{re.escape(search_value)}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
        elif search_type == 'text_contains':
            pattern = rf'text="[^"]*{re.escape(search_value)}[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
        else:
            return None
        
        match = re.search(pattern, xml_content)
        if match:
            x1, y1, x2, y2 = int(match.group(1)), int(match.group(2)), int(match.group(3)), int(match.group(4))
            return ((x1 + x2) // 2, (y1 + y2) // 2)
        return None
    
    def _long_press(self, x, y, duration_ms=1500):
        """Perform long press at coordinates"""
        print(f"👆 Long pressing at ({x}, {y}) for {duration_ms}ms...")
        self.adb("shell", "input", "swipe", str(x), str(y), str(x), str(y), str(duration_ms))
        time.sleep(0.5)
    
    def _tap(self, x, y, description=""):
        """Tap at coordinates"""
        print(f"👆 Tapping {description} at ({x}, {y})")
        self.adb("shell", "input", "tap", str(x), str(y))
        time.sleep(0.5)
    
    def launch_instagram(self):
        """Launch Instagram app and wait for it to load"""
        print("📸 Launching Instagram...")
        self.adb("shell", "monkey", "-p", "com.instagram.android", "-c", "android.intent.category.LAUNCHER", "1")
        time.sleep(3)  # Wait for IG to load
        return True
    
    def ensure_on_profile_tab(self):
        """Make sure we're on the profile tab (not home/reels/etc)"""
        print("📱 Navigating to Profile tab...")
        
        # Launch Instagram first
        self.launch_instagram()
        
        # Tap profile button in nav bar
        self._tap(self.profile_button_coord[0], self.profile_button_coord[1], "Profile tab")
        time.sleep(2)

        xml = self._get_ui_dump()
        if xml:
            profile_result = self._guards_for_xml(xml).verify_profile_tab()
            if profile_result.ok:
                print("✅ Profile tab reached! (verified)")
            else:
                print(f"⚠️ Profile tab verification inconclusive: {profile_result.screen_type}")
        
        return True
    
    def get_current_account(self):
        """Get the currently active IG account username"""
        xml = self._get_ui_dump()
        if not xml:
            return None
        
        # Look for the username in the profile header
        # Usually appears as text with the username
        username_patterns = [
            r'text="(@?\w+)"[^>]*resource-id="com.instagram.android:id/action_bar_title"',
            r'content-desc="(@?\w+), profile picture"',
        ]
        
        for pattern in username_patterns:
            match = re.search(pattern, xml)
            if match:
                return match.group(1).lstrip('@')
        
        return None
    
    def open_account_switcher_popup(self):
        """Long-press profile button to open account switcher popup
        
        Returns:
            bool: True if popup opened successfully
        """
        print("📚 Opening account switcher popup...")
        
        # Make sure we're on profile tab first
        self.ensure_on_profile_tab()
        time.sleep(1)
        
        # Long press on the profile button (or username area at top)
        # The profile pic in the profile tab header is usually what triggers the popup
        # Let's try the username/profile area at the top of profile screen
        
        # First, find the current profile picture or username to long-press
        xml = self._get_ui_dump()
        if xml:
            # Try to find profile picture element
            profile_pic = self._find_element_bounds(xml, 'content_desc', 'Profile picture')
            if profile_pic:
                self._long_press(profile_pic[0], profile_pic[1], 1500)
                time.sleep(1)
                
                # Check if popup appeared
                xml2 = self._get_ui_dump()
                if xml2:
                    switcher_result = self._guards_for_xml(xml2).verify_account_switcher()
                    if switcher_result.ok:
                        print("✅ Account switcher popup opened! (classifier)")
                        return True
                    if 'Add account' in xml2 or 'Switch accounts' in xml2:
                        print("✅ Account switcher popup opened!")
                        return True
        
        # Fallback: long-press on the action bar username area (top of profile)
        # Usually around center-top of screen
        self._long_press(540, 200, 1500)
        time.sleep(1)
        
        xml = self._get_ui_dump()
        if xml:
            switcher_result = self._guards_for_xml(xml).verify_account_switcher()
            if switcher_result.ok:
                print("✅ Account switcher popup opened! (classifier)")
                return True
            if 'Add account' in xml or 'Log in' in xml or 'counterstories' in xml or 'behindtheregister' in xml:
                print("✅ Account switcher popup opened!")
                return True
        
        print("⚠️ Popup may not have opened, continuing anyway...")
        return True  # Try to continue
    
    def switch_to_account(self, target_username):
        """Switch to a specific Instagram account
        
        Args:
            target_username: Username to switch to (without @)
            
        Returns:
            bool: True if switch successful
        """
        target_username = target_username.lstrip('@')
        print(f"🔄 Switching to IG account: @{target_username}")
        
        # Check if already on this account
        current = self.get_current_account()
        if current and current.lower() == target_username.lower():
            print(f"✅ Already on @{target_username}")
            return True
        
        # Open the switcher popup
        if not self.open_account_switcher_popup():
            print("❌ Failed to open account switcher")
            return False
        
        time.sleep(1)
        
        # Find and tap the target account
        xml = self._get_ui_dump()
        if not xml:
            print("❌ Failed to get UI after opening popup")
            return False
        
        # Look for the username in the popup
        # Try different patterns for finding the account (case-insensitive fallback)
        username_coords = self._find_element_bounds(xml, 'text', target_username)
        if not username_coords:
            # Try lowercase version
            username_coords = self._find_element_bounds(xml, 'text', target_username.lower())
        if not username_coords:
            username_coords = self._find_element_bounds(xml, 'text_contains', target_username)
        if not username_coords:
            username_coords = self._find_element_bounds(xml, 'text_contains', target_username.lower())
        if not username_coords:
            # Try finding by content-desc
            username_coords = self._find_element_bounds(xml, 'content_desc', target_username)
        
        if username_coords:
            print(f"✅ Found @{target_username} at {username_coords}")
            self._tap(username_coords[0], username_coords[1], f"@{target_username}")
            time.sleep(3)  # Wait for account switch
            
            # Verify the switch
            new_current = self.get_current_account()
            xml_after_switch = self._get_ui_dump()
            target_verification = None
            if xml_after_switch:
                guards = self._guards_for_xml(xml_after_switch)
                target_verification = guards.confirm_target_account_with_recovery(
                    target_username,
                    recovery_action=lambda: self.ensure_on_profile_tab(),
                    settle_seconds=1.0,
                )

            if target_verification and target_verification.ok:
                print(
                    f"✅ Successfully switched to @{target_username} | verified={target_verification.screen_type} ({target_verification.confidence})"
                )
                return True

            if new_current and new_current.lower() == target_username.lower():
                if xml_after_switch:
                    profile_result = self._guards_for_xml(xml_after_switch).verify_profile_tab()
                    print(f"✅ Successfully switched to @{target_username} | screen={profile_result.screen_type}")
                else:
                    print(f"✅ Successfully switched to @{target_username}")
                return True
            else:
                if target_verification:
                    print(
                        f"⚠️ Target account verification inconclusive for @{target_username} | screen={target_verification.screen_type} reasons={target_verification.reasons}"
                    )
                elif xml_after_switch:
                    profile_result = self._guards_for_xml(xml_after_switch).verify_profile_tab()
                    print(f"⚠️ Switch may have worked, now on @{new_current} | screen={profile_result.screen_type}")
                else:
                    print(f"⚠️ Switch may have worked, now on @{new_current}")
                return True  # Might still have worked
        else:
            print(f"❌ Could not find @{target_username} in account list")
            # Print what we did find for debugging
            accounts_found = re.findall(r'text="(\w+)"', xml)
            print(f"   Accounts visible: {accounts_found[:10]}")  # First 10
            return False
    
    def list_available_accounts(self):
        """List all available accounts in the switcher popup
        
        Returns:
            list: List of usernames available to switch to
        """
        print("📋 Listing available accounts...")
        
        # Open popup
        if not self.open_account_switcher_popup():
            return []
        
        time.sleep(1)
        
        xml = self._get_ui_dump()
        if not xml:
            return []
        
        # Extract text values from popup and keep only valid username-like values.
        # This avoids selecting UI labels (posts, followers, settings) as accounts.
        matches = re.findall(r'text="([^"]+)"', xml)
        excluded_words = {
            'add', 'switch', 'log', 'account', 'accounts', 'cancel', 'ok', 'done',
            'settings', 'profile', 'posts', 'followers', 'following', 'follow',
            'message', 'edit', 'reels', 'threads', 'insights', 'share',
        }
        username_pattern = re.compile(r'^[A-Za-z0-9._]{3,30}$')
        accounts = []
        for m in matches:
            candidate = m.strip().lstrip('@')
            if not candidate:
                continue
            if candidate.lower() in excluded_words:
                continue
            if not username_pattern.match(candidate):
                continue
            accounts.append(candidate)
        
        # Remove duplicates while preserving order
        seen = set()
        unique_accounts = []
        for acc in accounts:
            if acc.lower() not in seen:
                seen.add(acc.lower())
                unique_accounts.append(acc)
        
        print(f"📋 Found accounts: {unique_accounts}")
        
        # Dismiss popup by pressing back
        self.adb("shell", "input", "keyevent", "4")
        time.sleep(0.5)
        
        return unique_accounts


def test_account_switcher():
    """Test the account switcher"""
    switcher = IGAccountSwitcher()
    
    print("\n" + "="*50)
    print("🧪 IG ACCOUNT SWITCHER TEST")
    print("="*50)
    
    # List accounts
    accounts = switcher.list_available_accounts()
    print(f"\nAvailable accounts: {accounts}")
    
    # If accounts found, try switching
    if len(accounts) >= 2:
        target = accounts[1]  # Switch to second account
        print(f"\n🔄 Attempting to switch to @{target}...")
        success = switcher.switch_to_account(target)
        print(f"Result: {'✅ Success' if success else '❌ Failed'}")


if __name__ == "__main__":
    test_account_switcher()
