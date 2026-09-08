#!/usr/bin/env python3
"""
🔍 ACCOUNT VALIDATOR MODULE
Scans all profiles on the phone and validates/updates the account registry

Features:
- Iterate through all Graphene profiles
- Count Gmail and IG accounts per profile  
- Update account_registry.json with accurate state
- Flag overflow, stale, and missing accounts
"""

import subprocess
import time
import json
import os
from datetime import datetime


# Registry file path
REGISTRY_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "account_registry.json")


class AccountValidator:
    """
    Validates all accounts across all profiles on the phone.
    
    Usage:
        validator = AccountValidator(device_id='1A121FDF60082H')
        validator.validate_all_profiles()  # Full scan
        validator.print_full_report()       # Print summary
    """
    
    def __init__(self, device_id="1A121FDF60082H"):
        self.device_id = device_id
        self.registry = self._load_registry()
        self.scan_results = {}
        
    def log(self, level, message):
        """Log message with timestamp"""
        timestamp = datetime.now().strftime("%H:%M:%S")
        log_entry = f"[{timestamp}] [{level}] {message}"
        print(log_entry)
        
    def _run_adb(self, *args, timeout=30):
        """Run ADB command with device ID"""
        cmd = ["adb", "-s", self.device_id, "shell"] + list(args)
        try:
            result = subprocess.run(
                cmd, 
                capture_output=True, 
                text=True, 
                timeout=timeout,
                encoding='utf-8',
                errors='ignore'  # Ignore characters that can't be decoded
            )
            return result
        except subprocess.TimeoutExpired:
            self.log("ERROR", f"ADB command timed out: {' '.join(args)}")
            return None
        except Exception as e:
            self.log("ERROR", f"ADB error: {e}")
            return None
    
    def _load_registry(self):
        """Load account registry from JSON file."""
        try:
            if os.path.exists(REGISTRY_PATH):
                with open(REGISTRY_PATH, 'r') as f:
                    return json.load(f)
        except Exception as e:
            self.log("WARNING", f"Failed to load registry: {e}")
        return {"profiles": {}, "accounts": {}, "overflow_queue": [], "stale_accounts": []}
    
    def _save_registry(self):
        """Save account registry to JSON file."""
        try:
            os.makedirs(os.path.dirname(REGISTRY_PATH), exist_ok=True)
            with open(REGISTRY_PATH, 'w') as f:
                json.dump(self.registry, f, indent=2)
            self.log("SUCCESS", f"✅ Registry saved to {REGISTRY_PATH}")
        except Exception as e:
            self.log("ERROR", f"Failed to save registry: {e}")
    
    # ========== PROFILE MANAGEMENT ==========
    
    def get_all_profiles(self):
        """
        Get list of all user profiles on the device.
        
        Returns:
            list: [{"id": "0", "name": "Owner"}, {"id": "10", "name": "test"}, ...]
        """
        self.log("INFO", "📱 Getting all profiles on device...")
        
        result = self._run_adb("pm", "list", "users")
        if not result or not result.stdout:
            return []
        
        profiles = []
        for line in result.stdout.split('\n'):
            # Format: "UserInfo{10:test:c13} running"
            if 'UserInfo{' in line:
                import re
                match = re.search(r'UserInfo\{(\d+):([^:]+):', line)
                if match:
                    user_id = match.group(1)
                    user_name = match.group(2)
                    profiles.append({
                        "id": user_id,
                        "name": user_name
                    })
        
        self.log("INFO", f"📋 Found {len(profiles)} profiles")
        for p in profiles:
            self.log("INFO", f"   - {p['name']} (ID: {p['id']})")
        
        return profiles
    
    def get_current_user_id(self):
        """Get current active user ID"""
        result = self._run_adb("am", "get-current-user")
        if result and result.stdout:
            return result.stdout.strip()
        return None
    
    def switch_to_profile_secure(self, user_id):
        """
        Securely switch to profile with IP reset and VPN.
        
        Flow: Airplane ON → Wait → Switch → Wait → Airplane OFF → Wait → VPN Connect
        """
        self.log("INFO", f"🔄 Secure profile switch to ID: {user_id}")
        
        # 1. Enable airplane mode
        self.log("INFO", "✈️ Enabling airplane mode...")
        self._run_adb("cmd", "connectivity", "airplane-mode", "enable")
        time.sleep(5)  # Wait for airplane mode to take effect
        
        # 2. Switch profile
        self.log("INFO", f"👤 Switching to profile ID: {user_id}")
        self._run_adb("am", "switch-user", str(user_id))
        time.sleep(5)  # Initial wait for switch to start
        
        # 3. Wait for profile switch to complete (retry loop)
        self.log("INFO", "⏳ Waiting for profile switch...")
        for attempt in range(15):  # Max 15 attempts, 3s each = 45s max
            time.sleep(3)
            current = self.get_current_user_id()
            if current == str(user_id):
                self.log("SUCCESS", f"✅ Profile switch confirmed (attempt {attempt+1})")
                break
        else:
            self.log("ERROR", f"❌ Profile switch failed after 15 attempts")
            self._run_adb("cmd", "connectivity", "airplane-mode", "disable")
            time.sleep(5)
            return False
        
        # 4. ONLY NOW disable airplane mode (after switch confirmed)
        time.sleep(3)  # Small buffer after switch confirmed
        self.log("INFO", "🌐 Disabling airplane mode...")
        self._run_adb("cmd", "connectivity", "airplane-mode", "disable")
        time.sleep(8)  # Wait for network to come up
        
        # 5. Connect VPN
        self.log("INFO", "🔒 Connecting VPN...")
        try:
            from modules.protonvpn_module import ProtonVPNModule
            vpn = ProtonVPNModule(device_id=self.device_id)
            if vpn.ensure_connected():
                self.log("SUCCESS", "✅ VPN connected!")
            else:
                self.log("WARNING", "⚠️ VPN connection may have issues")
        except Exception as e:
            self.log("WARNING", f"⚠️ Could not connect VPN: {e}")
        
        return True
    
    def switch_to_profile(self, user_id):
        """Switch to specified profile by user ID (quick, no VPN)"""
        self.log("INFO", f"👤 Switching to profile ID: {user_id}")
        
        result = self._run_adb("am", "switch-user", str(user_id))
        time.sleep(5)  # Wait for switch
        
        # Verify switch
        current = self.get_current_user_id()
        if current == str(user_id):
            self.log("SUCCESS", f"✅ Switched to user {user_id}")
            return True
        
        self.log("ERROR", f"❌ Failed to switch to user {user_id}")
        return False
    
    # ========== ACCOUNT SCANNING ==========
    
    def get_gmail_accounts(self):
        """
        Get Gmail accounts on current profile.
        
        Returns:
            list: List of gmail addresses (empty if fresh profile with no accounts)
        """
        self.log("INFO", "📧 Scanning Gmail accounts...")
        
        # Launch Gmail via monkey (more reliable)
        self._run_adb("monkey", "-p", "com.google.android.gm", "1")
        time.sleep(6)  # Wait for Gmail to fully load
        
        # Dump screen to check what's showing (with retry)
        result = None
        for attempt in range(3):
            self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
            time.sleep(2)
            result = self._run_adb("cat", "/sdcard/ui.xml")
            if result and result.stdout and len(result.stdout) > 100:
                break
            self.log("INFO", f"   Retry dump {attempt+1}/3...")
            time.sleep(2)
        
        if not result or not result.stdout:
            self.log("WARNING", "⚠️ Could not dump Gmail UI after retries")
            self._run_adb("input", "keyevent", "3")
            return []
        
        screen = result.stdout
        screen_lower = screen.lower()
        import re
        
        # Check for fresh profile - "New in Gmail" with "GOT IT" button (case insensitive)
        if "got it" in screen_lower and ("new in gmail" in screen_lower or "set up email" in screen_lower or "welcome" in screen_lower):
            self.log("INFO", "📭 Fresh profile - no Gmail accounts set up (Got it screen)")
            self._run_adb("input", "keyevent", "3")
            return []
        
        # Handle "Allow" popup if shown
        if "Allow" in screen and "notification" in screen.lower():
            self.log("INFO", "📌 Handling 'Allow' popup...")
            match = re.search(r'text="Allow"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', screen)
            if match:
                x = (int(match.group(1)) + int(match.group(3))) // 2
                y = (int(match.group(2)) + int(match.group(4))) // 2
                self._run_adb("input", "tap", str(x), str(y))
                time.sleep(2)
                # Dump again
                self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
                time.sleep(1)
                result = self._run_adb("cat", "/sdcard/ui.xml")
                screen = result.stdout if result and result.stdout else ""
        
        # Try to find emails directly on current screen first
        email_pattern = r'text="([a-zA-Z0-9_.+-]+@gmail\.com)"'
        emails = list(set(re.findall(email_pattern, screen)))
        
        if emails:
            self.log("INFO", f"📧 Found {len(emails)} Gmail accounts on screen")
        else:
            # Click profile icon (top right) to show account picker
            self.log("INFO", "👤 Opening account picker...")
            self._run_adb("input", "tap", "980", "200")
            time.sleep(2)
            
            # Dump and search again
            self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
            time.sleep(1)
            result = self._run_adb("cat", "/sdcard/ui.xml")
            
            if result and result.stdout:
                screen = result.stdout
                emails = list(set(re.findall(email_pattern, screen)))
                
                # Also try "Manage accounts on this device"
                if "Manage accounts on this device" in screen:
                    match = re.search(r'text="Manage accounts on this device"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', screen)
                    if match:
                        x = (int(match.group(1)) + int(match.group(3))) // 2
                        y = (int(match.group(2)) + int(match.group(4))) // 2
                        self._run_adb("input", "tap", str(x), str(y))
                        time.sleep(2)
                        # Dump again
                        self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
                        time.sleep(1)
                        result = self._run_adb("cat", "/sdcard/ui.xml")
                        if result and result.stdout:
                            emails = list(set(re.findall(email_pattern, result.stdout)))
        
        # Close Gmail
        self._run_adb("input", "keyevent", "3")
        time.sleep(1)
        
        self.log("INFO", f"📧 Found {len(emails)} Gmail accounts")
        for e in emails:
            self.log("INFO", f"   - {e}")
        return emails
    
    def get_ig_accounts(self):
        """
        Get Instagram accounts on current profile.
        
        Returns:
            list: List of IG usernames
        """
        self.log("INFO", "📸 Scanning Instagram accounts...")
        
        # Open Instagram via monkey (the LAUNCHER activity is exported; ModalActivity is not → SecurityException)
        self._run_adb("monkey", "-p", "com.instagram.android", "-c", "android.intent.category.LAUNCHER", "1")
        time.sleep(3)
        
        # Check if logged in by looking for "Your story"
        self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
        time.sleep(1)
        result = self._run_adb("cat", "/sdcard/ui.xml")
        
        if not result or not result.stdout or "Your story" not in result.stdout:
            self.log("INFO", "📸 Not logged into Instagram on this profile")
            self._run_adb("input", "keyevent", "3")
            return []
        
        # Long-press profile tab to show accounts
        self._run_adb("input", "swipe", "972", "2274", "972", "2274", "1000")
        time.sleep(2)
        
        # Dump UI and extract usernames
        self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
        time.sleep(1)
        result = self._run_adb("cat", "/sdcard/ui.xml")
        
        usernames = []
        if result and result.stdout:
            import re
            # Find usernames (alphanumeric, underscore, dot - typical IG format)
            # Exclude common UI elements
            exclude = ['Add Instagram account', 'Create new account', 'Use another profile',
                      'Home', 'Search', 'Reels', 'Shop', 'Profile', 'notification',
                      'Go to Accounts Center', 'Settings']
            
            pattern = r'text="([a-z0-9_.]+)"'
            matches = re.findall(pattern, result.stdout)
            
            for m in matches:
                if len(m) > 2 and m not in [e.lower() for e in exclude]:
                    if not any(ex.lower() in m.lower() for ex in exclude):
                        usernames.append(m)
            
            # Remove duplicates and filter
            usernames = list(set(usernames))
            # Filter out numbers-only entries
            usernames = [u for u in usernames if not u.isdigit()]
        
        # Close account picker
        self._run_adb("input", "keyevent", "4")
        time.sleep(1)
        self._run_adb("input", "keyevent", "3")
        
        self.log("INFO", f"📸 Found {len(usernames)} Instagram accounts")
        return usernames
    
    # ========== VALIDATION ==========
    
    def validate_profile(self, profile_id, profile_name):
        """
        Validate a single profile - scan Gmail and IG accounts.
        
        Returns:
            dict: {"gmail": [...], "ig": [...], "overflow_gmail": [...], "overflow_ig": [...]}
        """
        self.log("INFO", "=" * 60)
        self.log("INFO", f"🔍 VALIDATING PROFILE: {profile_name} (ID: {profile_id})")
        self.log("INFO", "=" * 60)
        
        # Get accounts
        gmail_accounts = self.get_gmail_accounts()
        ig_accounts = self.get_ig_accounts()
        
        # Check for overflow (>5)
        overflow_gmail = gmail_accounts[5:] if len(gmail_accounts) > 5 else []
        overflow_ig = ig_accounts[5:] if len(ig_accounts) > 5 else []
        active_gmail = gmail_accounts[:5]
        active_ig = ig_accounts[:5]
        
        result = {
            "profile_id": profile_id,
            "profile_name": profile_name,
            "gmail": active_gmail,
            "ig": active_ig,
            "overflow_gmail": overflow_gmail,
            "overflow_ig": overflow_ig,
            "gmail_count": len(gmail_accounts),
            "ig_count": len(ig_accounts),
            "scanned_at": datetime.now().isoformat()
        }
        
        # Log summary
        self.log("INFO", f"📧 Gmail: {len(gmail_accounts)}/5 ({len(overflow_gmail)} overflow)")
        for g in active_gmail:
            self.log("INFO", f"   ✅ {g}")
        for g in overflow_gmail:
            self.log("WARNING", f"   📤 {g} (overflow)")
            
        self.log("INFO", f"📸 Instagram: {len(ig_accounts)}/5 ({len(overflow_ig)} overflow)")
        for u in active_ig:
            self.log("INFO", f"   ✅ @{u}")
        for u in overflow_ig:
            self.log("WARNING", f"   📤 @{u} (overflow)")
        
        return result
    
    def validate_all_profiles(self, secure=True):
        """
        Validate all profiles on the device.
        Switches to each profile and scans accounts.
        
        Args:
            secure: If True, use airplane mode + VPN for each switch
        
        Returns:
            dict: {profile_id: scan_result, ...}
        """
        self.log("INFO", "=" * 60)
        self.log("INFO", "🔍 ACCOUNT VALIDATOR - FULL SCAN")
        self.log("INFO", f"   Mode: {'SECURE (Airplane + VPN)' if secure else 'Quick (no VPN)'}")
        self.log("INFO", "=" * 60)
        
        # Save current profile to return to
        original_user = self.get_current_user_id()
        
        # Get all profiles
        profiles = self.get_all_profiles()
        
        if not profiles:
            self.log("ERROR", "❌ No profiles found!")
            return {}
        
        results = {}
        
        for i, profile in enumerate(profiles):
            profile_id = profile["id"]
            profile_name = profile["name"]
            
            self.log("INFO", f"\n📱 [{i+1}/{len(profiles)}] Processing: {profile_name}")
            
            # Skip Owner (user 0) - usually empty
            if profile_id == "0":
                self.log("INFO", "   ⏭️ Skipping Owner profile")
                continue
            
            # Switch to profile
            if str(profile_id) != str(self.get_current_user_id()):
                if secure:
                    if not self.switch_to_profile_secure(profile_id):
                        self.log("ERROR", f"❌ Could not switch to {profile_name}")
                        continue
                else:
                    if not self.switch_to_profile(profile_id):
                        self.log("ERROR", f"❌ Could not switch to {profile_name}")
                        continue
            
            # Validate profile
            result = self.validate_profile(profile_id, profile_name)
            results[profile_id] = result
            
            # Update registry and SAVE after each profile
            self._update_registry_for_profile(profile_id, profile_name, result)
            self._save_registry()
            self.log("SUCCESS", f"✅ Profile {profile_name} validated and saved!")
        
        # Switch back to original profile
        self.log("INFO", f"\n🔙 Returning to original profile: {original_user}")
        if str(original_user) != str(self.get_current_user_id()):
            if secure:
                self.switch_to_profile_secure(original_user)
            else:
                self.switch_to_profile(original_user)
        
        self.scan_results = results
        
        self.log("SUCCESS", "=" * 60)
        self.log("SUCCESS", f"✅ FULL SCAN COMPLETE - {len(results)} profiles validated")
        self.log("SUCCESS", "=" * 60)
        
        return results
    
    def _update_registry_for_profile(self, profile_id, profile_name, scan_result):
        """Update the registry with scan results for a profile."""
        
        # Initialize profile in registry
        if profile_name not in self.registry["profiles"]:
            self.registry["profiles"][profile_name] = {
                "gmail_accounts": [],
                "ig_accounts": [],
                "created_at": datetime.now().isoformat()
            }
        
        profile = self.registry["profiles"][profile_name]
        profile["gmail_accounts"] = scan_result["gmail"]
        profile["ig_accounts"] = scan_result["ig"]
        profile["updated_at"] = datetime.now().isoformat()
        profile["user_id"] = profile_id
        
        # Update individual accounts
        for email in scan_result["gmail"]:
            if email not in self.registry["accounts"]:
                self.registry["accounts"][email] = {}
            
            self.registry["accounts"][email].update({
                "email": email,
                "ig_username": email.split("@")[0],
                "profile_id": profile_name,
                "account_type": "gmail",
                "status": "active",
                "updated_at": datetime.now().isoformat()
            })
        
        for username in scan_result["ig"]:
            email = f"{username}@gmail.com"
            if email not in self.registry["accounts"]:
                self.registry["accounts"][email] = {}
            
            self.registry["accounts"][email].update({
                "email": email,
                "ig_username": username,
                "profile_id": profile_name,
                "account_type": "instagram",
                "status": "active",
                "updated_at": datetime.now().isoformat()
            })
        
        # Mark overflow
        for email in scan_result["overflow_gmail"]:
            if email in self.registry["accounts"]:
                self.registry["accounts"][email]["status"] = "overflow"
        
        for username in scan_result["overflow_ig"]:
            email = f"{username}@gmail.com"
            if email in self.registry["accounts"]:
                self.registry["accounts"][email]["status"] = "overflow"
    
    def validate_current_profile(self):
        """Validate only the current profile without switching."""
        current_user = self.get_current_user_id()
        
        # Get profile name
        profiles = self.get_all_profiles()
        profile_name = "unknown"
        for p in profiles:
            if str(p["id"]) == str(current_user):
                profile_name = p["name"]
                break
        
        result = self.validate_profile(current_user, profile_name)
        self._update_registry_for_profile(current_user, profile_name, result)
        self._save_registry()
        
        return result
    
    # ========== AIRTABLE SYNC ==========
    
    def sync_to_airtable(self):
        """
        Sync local registry to Airtable Accounts table.
        Updates Profile ID, Login Email, and other fields.
        """
        self.log("INFO", "🔗 Syncing to Airtable...")
        try:
            # Handle both module import and direct script execution
            try:
                from modules.airtable_sync import AirtableSync
            except ImportError:
                from airtable_sync import AirtableSync
            
            sync = AirtableSync()
            result = sync.sync_from_registry()
            if result:
                self.log("SUCCESS", f"✅ Airtable sync: {result['updated']} updated, {result['created']} created")
            return result
        except Exception as e:
            self.log("ERROR", f"❌ Airtable sync failed: {e}")
            return None
    
    # ========== REPORTING ==========
    
    def print_full_report(self):
        """Print a comprehensive report of all profiles and accounts."""
        
        print("\n" + "=" * 70)
        print("📊 ACCOUNT VALIDATOR - FULL REPORT")
        print("=" * 70)
        
        total_gmail = 0
        total_ig = 0
        total_overflow = 0
        
        for profile_name, profile_data in self.registry.get("profiles", {}).items():
            gmail_count = len(profile_data.get("gmail_accounts", []))
            ig_count = len(profile_data.get("ig_accounts", []))
            
            total_gmail += gmail_count
            total_ig += ig_count
            
            print(f"\n📱 PROFILE: {profile_name}")
            print("-" * 40)
            
            print(f"   📧 Gmail ({gmail_count}/5):")
            for email in profile_data.get("gmail_accounts", []):
                acc = self.registry["accounts"].get(email, {})
                status = acc.get("status", "unknown")
                icon = "✅" if status == "active" else "📤" if status == "overflow" else "❓"
                print(f"      {icon} {email}")
                if status == "overflow":
                    total_overflow += 1
            
            print(f"   📸 Instagram ({ig_count}/5):")
            for username in profile_data.get("ig_accounts", []):
                email = f"{username}@gmail.com"
                acc = self.registry["accounts"].get(email, {})
                status = acc.get("status", "unknown")
                icon = "✅" if status == "active" else "📤" if status == "overflow" else "❓"
                print(f"      {icon} @{username}")
                if status == "overflow":
                    total_overflow += 1
        
        # Summary
        print("\n" + "=" * 70)
        print("📈 SUMMARY")
        print("=" * 70)
        print(f"   Total Profiles: {len(self.registry.get('profiles', {}))}")
        print(f"   Total Gmail Accounts: {total_gmail}")
        print(f"   Total IG Accounts: {total_ig}")
        print(f"   Overflow Accounts: {total_overflow}")
        
        # Stale accounts
        stale = [e for e, a in self.registry.get("accounts", {}).items() 
                 if a.get("status") == "verification_needed"]
        if stale:
            print(f"\n   🔴 Stale/Cooked Accounts ({len(stale)}):")
            for email in stale:
                print(f"      ⚠️ {email}")
        
        print("\n" + "=" * 70)


# CLI
if __name__ == "__main__":
    import sys
    
    validator = AccountValidator(device_id="1A121FDF60082H")
    
    if len(sys.argv) > 1:
        cmd = sys.argv[1]
        if cmd == "full":
            # Full validation + sync
            validator.validate_all_profiles(secure=True)
            validator.print_full_report()
            validator.sync_to_airtable()
        elif cmd == "quick":
            # Full validation without VPN
            validator.validate_all_profiles(secure=False)
            validator.print_full_report()
        elif cmd == "sync":
            # Just sync registry to Airtable
            validator.sync_to_airtable()
        elif cmd == "report":
            # Just print report
            validator.print_full_report()
        else:
            print("Usage: python account_validator.py [full|quick|sync|report]")
            print("  full  - Full validation with VPN + Airtable sync")
            print("  quick - Full validation without VPN")
            print("  sync  - Sync current registry to Airtable")
            print("  report - Print current registry report")
    else:
        # Default: validate current profile
        result = validator.validate_current_profile()
        validator.print_full_report()
