#!/usr/bin/env python3
"""
🚀 ACCOUNT CREATION MODULE
Automated account setup workflow for new profiles

Step 1: Airplane ON → Switch to Profile → Airplane OFF (IP Reset)
Step 2: Gmail account creation/login (TODO)
Step 3: Instagram account creation (TODO)
Step 4: VPN connection (TODO)

Account Status Flags:
- active: Currently logged in and working
- verification_needed: Account flagged for captcha/video selfie (stale/cooked)
- needs_creation: No IG account exists for this Gmail - needs to be created
- overflow: Account exceeds profile limit (5 max) - needs to move to another profile
- inactive: Logged out / not on this profile
- removed: Account was removed from device
- pending_login: Claimed from overflow queue, waiting to be logged in
"""

import subprocess
import time
import json
import os
from datetime import datetime

# Registry file path
REGISTRY_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "account_registry.json")

class AccountCreationModule:
    """
    Handles complete account creation workflow for new user profiles.
    
    Workflow:
    1. Enable airplane mode (reset IP/network state)
    2. Switch to target profile
    3. Disable airplane mode (get fresh IP)
    4. Create/login Gmail account
    5. Create Instagram account using Gmail
    6. Connect VPN for security
    
    Account Registry:
    - Tracks accounts per Graphene profile (profile_id)
    - Max 5 Gmail and 5 IG accounts per profile
    - Overflow accounts flagged for migration to other profiles
    """
    
    def __init__(self, device_id="1A121FDF60082H", profile_id="test"):
        self.device_id = device_id
        self.profile_id = profile_id  # Graphene OS profile name
        self.current_step = 0
        self.total_steps = 6
        self.log_messages = []
        self.registry = self._load_registry()
        
    def log(self, level, message):
        """Log message with timestamp"""
        timestamp = datetime.now().strftime("%H:%M:%S")
        log_entry = f"[{timestamp}] [{level}] {message}"
        self.log_messages.append(log_entry)
        print(log_entry)
    
    # ========== ACCOUNT REGISTRY METHODS ==========
    
    def _load_registry(self):
        """Load account registry from JSON file."""
        try:
            if os.path.exists(REGISTRY_PATH):
                with open(REGISTRY_PATH, 'r') as f:
                    return json.load(f)
        except Exception as e:
            self.log("WARNING", f"Failed to load registry: {e}")
        return {"profiles": {}, "accounts": {}, "overflow_queue": []}
    
    def _save_registry(self):
        """Save account registry to JSON file."""
        try:
            os.makedirs(os.path.dirname(REGISTRY_PATH), exist_ok=True)
            with open(REGISTRY_PATH, 'w') as f:
                json.dump(self.registry, f, indent=2)
        except Exception as e:
            self.log("ERROR", f"Failed to save registry: {e}")
    
    def register_account(self, email, account_type="gmail", ig_username=None, status="active"):
        """
        Register an account in the registry.
        
        Args:
            email: Gmail address
            account_type: 'gmail' or 'instagram'
            ig_username: Instagram username (if IG account)
            status: 'active', 'verification_needed', 'overflow', 'inactive'
        """
        account_key = email
        
        # Initialize profile in registry if needed
        if self.profile_id not in self.registry["profiles"]:
            self.registry["profiles"][self.profile_id] = {
                "gmail_accounts": [],
                "ig_accounts": [],
                "created_at": datetime.now().isoformat()
            }
        
        profile = self.registry["profiles"][self.profile_id]
        
        # Add account to registry
        self.registry["accounts"][account_key] = {
            "email": email,
            "ig_username": ig_username or email.split("@")[0],
            "profile_id": self.profile_id,
            "account_type": account_type,
            "status": status,
            "updated_at": datetime.now().isoformat()
        }
        
        # Track in profile
        if account_type == "gmail" and email not in profile["gmail_accounts"]:
            profile["gmail_accounts"].append(email)
        if account_type == "instagram" or ig_username:
            username = ig_username or email.split("@")[0]
            if username not in profile["ig_accounts"]:
                profile["ig_accounts"].append(username)
        
        self._save_registry()
        self.log("INFO", f"📝 Registered {account_type}: {email} on profile {self.profile_id} ({status})")
    
    def update_account_status(self, email, status):
        """Update status of an account."""
        if email in self.registry["accounts"]:
            self.registry["accounts"][email]["status"] = status
            self.registry["accounts"][email]["updated_at"] = datetime.now().isoformat()
            self._save_registry()
            self.log("INFO", f"🔄 Updated {email} status to: {status}")
    
    def get_profile_accounts(self):
        """Get all accounts for current profile with status."""
        if self.profile_id not in self.registry["profiles"]:
            return {"gmail": [], "instagram": [], "overflow": []}
        
        profile = self.registry["profiles"][self.profile_id]
        
        result = {
            "gmail": [],
            "instagram": [],
            "overflow": []
        }
        
        for email in profile.get("gmail_accounts", []):
            acc = self.registry["accounts"].get(email, {})
            status = acc.get("status", "unknown")
            if status == "overflow":
                result["overflow"].append({"email": email, "type": "gmail"})
            else:
                result["gmail"].append({"email": email, "status": status})
        
        for username in profile.get("ig_accounts", []):
            # Find by username
            for email, acc in self.registry["accounts"].items():
                if acc.get("ig_username") == username:
                    status = acc.get("status", "unknown")
                    if status == "overflow":
                        result["overflow"].append({"username": username, "email": email, "type": "instagram"})
                    else:
                        result["instagram"].append({"username": username, "email": email, "status": status})
                    break
        
        return result
    
    def check_and_handle_overflow(self):
        """
        Check for overflow accounts (>5 Gmail or >5 IG) and flag them.
        Returns list of accounts that need to be logged out and moved.
        """
        gmail_on_phone = self.get_gmail_count()
        ig_on_phone = self.get_ig_count()
        
        overflow_accounts = []
        
        # Handle Gmail overflow (>5)
        if len(gmail_on_phone) > 5:
            excess = gmail_on_phone[5:]  # Accounts beyond the 5th
            for email in excess:
                self.log("WARNING", f"⚠️ Gmail overflow: {email} - flagging for migration")
                self.register_account(email, "gmail", status="overflow")
                overflow_accounts.append({"email": email, "type": "gmail"})
                
                # Add to overflow queue
                if email not in self.registry["overflow_queue"]:
                    self.registry["overflow_queue"].append({
                        "email": email,
                        "type": "gmail",
                        "from_profile": self.profile_id,
                        "added_at": datetime.now().isoformat()
                    })
        
        # Handle IG overflow (>5)
        if len(ig_on_phone) > 5:
            excess = ig_on_phone[5:]  # Accounts beyond the 5th
            for username in excess:
                # Find email for this username
                email = f"{username}@gmail.com"  # Assuming email matches username
                self.log("WARNING", f"⚠️ IG overflow: {username} - flagging for migration")
                self.update_account_status(email, "overflow")
                overflow_accounts.append({"username": username, "email": email, "type": "instagram"})
                
                if email not in [o.get("email") for o in self.registry["overflow_queue"]]:
                    self.registry["overflow_queue"].append({
                        "email": email,
                        "username": username,
                        "type": "instagram",
                        "from_profile": self.profile_id,
                        "added_at": datetime.now().isoformat()
                    })
        
        self._save_registry()
        
        if overflow_accounts:
            self.log("INFO", f"📋 {len(overflow_accounts)} overflow accounts flagged for migration")
        
        return overflow_accounts
    
    def get_overflow_queue(self):
        """Get list of overflow accounts waiting to be moved to other profiles."""
        return self.registry.get("overflow_queue", [])
    
    def claim_overflow_account(self, email, new_profile_id):
        """Move an overflow account to a new profile."""
        queue = self.registry.get("overflow_queue", [])
        for item in queue:
            if item.get("email") == email:
                queue.remove(item)
                if email in self.registry["accounts"]:
                    self.registry["accounts"][email]["profile_id"] = new_profile_id
                    self.registry["accounts"][email]["status"] = "pending_login"
                self._save_registry()
                self.log("SUCCESS", f"✅ Claimed {email} for profile {new_profile_id}")
                return True
        return False
    
    def print_profile_summary(self):
        """Print a summary of accounts on current profile."""
        accounts = self.get_profile_accounts()
        
        def get_status_icon(status):
            icons = {
                "active": "✅",
                "verification_needed": "🔴",
                "needs_creation": "🆕",
                "overflow": "📤",
                "inactive": "⬜",
                "removed": "🗑️",
                "pending_login": "⏳"
            }
            return icons.get(status, "❓")
        
        print(f"\n{'='*60}")
        print(f"📱 PROFILE: {self.profile_id}")
        print(f"{'='*60}")
        
        print(f"\n📧 GMAIL ({len(accounts['gmail'])}/5):")
        for acc in accounts['gmail']:
            icon = get_status_icon(acc['status'])
            print(f"   {icon} {acc['email']} [{acc['status']}]")
        
        print(f"\n📸 INSTAGRAM ({len(accounts['instagram'])}/5):")
        for acc in accounts['instagram']:
            icon = get_status_icon(acc['status'])
            print(f"   {icon} @{acc['username']} ({acc['email']}) [{acc['status']}]")
        
        if accounts['overflow']:
            print(f"\n📤 OVERFLOW (need migration):")
            for acc in accounts['overflow']:
                print(f"   ➡️ {acc.get('email', acc.get('username'))} [{acc['type']}]")
        
        # Show verification needed (stale)
        stale_accounts = [
            (email, acc) for email, acc in self.registry.get("accounts", {}).items()
            if acc.get("status") == "verification_needed" and acc.get("profile_id") == self.profile_id
        ]
        if stale_accounts:
            print(f"\n🔴 STALE/COOKED (verification needed):")
            for email, acc in stale_accounts:
                print(f"   ⚠️ {email} - @{acc.get('ig_username', 'N/A')}")
        
        # Show needs creation
        needs_creation = [
            (email, acc) for email, acc in self.registry.get("accounts", {}).items()
            if acc.get("status") == "needs_creation" and acc.get("profile_id") == self.profile_id
        ]
        if needs_creation:
            print(f"\n🆕 NEEDS IG CREATION:")
            for email, acc in needs_creation:
                print(f"   📝 {email}")
        
        print(f"\n{'='*60}\n")
        
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

    # =========================================================================
    # SCREEN-DETECTION HELPERS (added 2026-05-17)
    # Replaces blind sequential find_and_click_text with a state machine so
    # "screen may or may not appear" flows do not blow up, and so we don't pay
    # uiautomator-dump latency 3x per tap. Each dump ~500ms; cache for 400ms.
    # =========================================================================

    _xml_cache_xml = None
    _xml_cache_at = 0.0

    def _dump_xml(self, force=False, ttl=0.4):
        """Dump current UI XML to /sdcard/ui.xml and return its contents.
        Cached for `ttl` seconds; pass force=True to bypass cache."""
        import time as _t
        if not force and self._xml_cache_xml is not None and (_t.monotonic() - self._xml_cache_at) < ttl:
            return self._xml_cache_xml
        self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
        res = self._run_adb("cat", "/sdcard/ui.xml")
        xml = res.stdout if (res and res.stdout) else ""
        self._xml_cache_xml = xml
        # Use the timestamp AFTER the dump finishes so the TTL window starts
        # when the data is actually fresh — not when the dump was launched.
        # Without this, a ~2.5s dump-cat round-trip means the cache is
        # already 2.5s stale by the time we set it, and the next call within
        # the 400ms TTL misses every time.
        self._xml_cache_at = _t.monotonic()
        return xml

    def _invalidate_xml(self):
        self._xml_cache_xml = None
        self._xml_cache_at = 0.0

    def _find_in_xml(self, xml, *, text=None, content_desc=None, resource_id=None, exact=True, case_insensitive=False):
        """Find a UI node in xml matching the given selector(s).
        Returns (cx, cy) center or None. Resource-id is preferred when given.
        """
        import re
        if not xml:
            return None
        flags = re.IGNORECASE if case_insensitive else 0

        def search(pat):
            m = re.search(pat, xml, flags)
            if not m:
                return None
            x1, y1, x2, y2 = map(int, m.groups()[-4:])
            return ((x1 + x2) // 2, (y1 + y2) // 2)

        if resource_id:
            esc = re.escape(resource_id)
            pos = search(rf'resource-id="{esc}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
            if pos:
                return pos
            pos = search(rf'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*resource-id="{esc}"')
            if pos:
                return pos
        if text:
            esc = re.escape(text)
            if exact:
                pos = search(rf'text="{esc}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
                if pos:
                    return pos
            pos = search(rf'text="[^"]*{esc}[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
            if pos:
                return pos
        if content_desc:
            esc = re.escape(content_desc)
            if exact:
                pos = search(rf'content-desc="{esc}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
                if pos:
                    return pos
            pos = search(rf'content-desc="[^"]*{esc}[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
            if pos:
                return pos
        return None

    def wait_for(self, *, text=None, content_desc=None, resource_id=None,
                 exact=True, case_insensitive=False, timeout=10, poll=0.4):
        """Poll the current UI until the given selector is found.
        Returns (cx, cy) or None on timeout."""
        import time as _t
        deadline = _t.monotonic() + timeout
        while True:
            xml = self._dump_xml(force=True, ttl=0)
            pos = self._find_in_xml(xml, text=text, content_desc=content_desc,
                                    resource_id=resource_id, exact=exact,
                                    case_insensitive=case_insensitive)
            if pos:
                return pos
            if _t.monotonic() >= deadline:
                return None
            _t.sleep(poll)

    def wait_for_screen(self, signatures, timeout=10, poll=0.4):
        """Wait for one of several screen signatures to appear.
        `signatures` is a list of (name, selector_kwargs) tuples.
        Returns (name, (cx, cy)) for the first matching screen, or (None, None).
        """
        import time as _t
        deadline = _t.monotonic() + timeout
        while True:
            xml = self._dump_xml(force=True, ttl=0)
            for name, kwargs in signatures:
                pos = self._find_in_xml(xml, **kwargs)
                if pos:
                    return name, pos
            if _t.monotonic() >= deadline:
                return None, None
            _t.sleep(poll)

    def tap_xy(self, x, y):
        """Tap without the implicit sleep that find_and_click_text adds."""
        self._run_adb("input", "tap", str(x), str(y))
        self._invalidate_xml()

    def tap_and_wait(self, x, y, *, then, timeout=8):
        """Tap at (x,y) and poll for the next screen signature."""
        self.tap_xy(x, y)
        return self.wait_for(**then, timeout=timeout)

    def dismiss_permission_dialog(self, *, timeout=3):
        """Tap "Don't allow" on a runtime permission dialog. Handles the curly
        apostrophe variant and uses resource-id when available."""
        # First try the stable resource-id (works across locales / apostrophe variants)
        pos = self.wait_for(resource_id="com.android.permissioncontroller:id/permission_deny_button",
                            timeout=timeout, poll=0.25)
        if pos:
            self.tap_xy(*pos)
            return True
        # Fallback: try both straight and curly apostrophes
        xml = self._dump_xml(force=True, ttl=0)
        for needle in ("Don’t allow", "Don't allow", "Dont allow", "Don’t Allow", "Don't Allow"):
            pos = self._find_in_xml(xml, text=needle, exact=True)
            if pos:
                self.tap_xy(*pos)
                return True
        return False

    def _launch_ig(self, wait_seconds=0):
        """Launch Instagram safely via `monkey` — NEVER `am start -n .../ModalActivity`
        which throws SecurityException on modern IG builds. The launcher
        activity is exported; the inner ModalActivity is not."""
        self._run_adb("monkey", "-p", "com.instagram.android",
                      "-c", "android.intent.category.LAUNCHER", "1")
        self._invalidate_xml()
        if wait_seconds:
            time.sleep(wait_seconds)

    def _launch_gmail(self, wait_seconds=0):
        """Launch Gmail via monkey (avoids any non-exported activity issues)."""
        self._run_adb("monkey", "-p", "com.google.android.gm",
                      "-c", "android.intent.category.LAUNCHER", "1")
        self._invalidate_xml()
        if wait_seconds:
            time.sleep(wait_seconds)

    # ----- preflight: ensure required packages are installed for current user -----

    REQUIRED_PACKAGES_FOR_ACCOUNTS = [
        "com.google.android.gms",   # Play Services (Gmail dies without this)
        "com.android.vending",      # Play Store
        "com.google.android.gm",    # Gmail
        "com.instagram.android",    # Instagram
    ]

    def _current_foreground_user(self):
        """Read the current foreground Android user id, or None if unknown."""
        res = self._run_adb("am", "get-current-user")
        if not res or not res.stdout:
            return None
        out = res.stdout.strip()
        return out if out.isdigit() else None

    def _packages_for_user(self, user_id):
        """Return the set of package names installed for the given user."""
        res = self._run_adb("pm", "list", "packages", "--user", str(user_id))
        if not res or not res.stdout:
            return set()
        pkgs = set()
        for line in res.stdout.splitlines():
            line = line.strip()
            if line.startswith("package:"):
                pkgs.add(line.split(":", 1)[1].strip())
        return pkgs

    def install_existing_preflight(self, user_id=None, required=None):
        """Make sure GMS / Play / Gmail / IG are present on the current user.
        Fresh GrapheneOS profiles boot with NONE of these — Gmail will then
        say "Device not compatible" and the whole flow dead-ends."""
        if user_id is None:
            user_id = self._current_foreground_user()
        if user_id is None:
            self.log("WARNING", "⚠️ Could not detect current user; skipping preflight")
            return True
        required = required or self.REQUIRED_PACKAGES_FOR_ACCOUNTS
        installed = self._packages_for_user(user_id)
        missing = [p for p in required if p not in installed]
        if not missing:
            return True
        self.log("INFO", f"📦 Preflight: installing {len(missing)} missing pkg(s) for user {user_id}: {missing}")
        ok = True
        for pkg in missing:
            res = self._run_adb("cmd", "package", "install-existing", "--user", str(user_id), pkg)
            stdout = (res.stdout or "") if res else ""
            stderr = (res.stderr or "") if res else ""
            if not res or "Package " not in stdout or "installed for user" not in stdout:
                # Newer Android returns "Package X installed for user: N", older just non-zero.
                if "Unknown" in stdout or "Unknown" in stderr or "Failure" in stdout or "Failure" in stderr:
                    self.log("WARNING", f"⚠️ install-existing failed for {pkg}: {stdout.strip() or stderr.strip()}")
                    ok = False
                else:
                    self.log("INFO", f"✅ install-existing {pkg} → {stdout.strip()[:80] or 'ok'}")
            else:
                self.log("INFO", f"✅ install-existing {pkg}")
        return ok

    def get_gmail_count(self):
        """
        Count Gmail accounts on the phone by opening account picker.
        Returns list of gmail addresses found.
        """
        import re
        
        # Go home first to ensure clean state
        self._run_adb("input", "keyevent", "3")
        time.sleep(1)
        
        # Open Gmail
        self._run_adb("monkey", "-p", "com.google.android.gm", "-c", "android.intent.category.LAUNCHER", "1")
        time.sleep(3)

        # Click profile icon (top right) to show account list
        self._run_adb("input", "tap", "980", "200")
        time.sleep(2)
        
        # Dump UI and find all gmail addresses
        self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
        time.sleep(1)
        result = self._run_adb("cat", "/sdcard/ui.xml")
        
        gmail_accounts = []
        if result and result.stdout:
            # Find all email addresses
            matches = re.findall(r'text="([a-zA-Z0-9_.+-]+@gmail\.com)"', result.stdout)
            gmail_accounts = list(set(matches))  # Remove duplicates
        
        # Close the popup
        self._run_adb("input", "keyevent", "4")
        time.sleep(1)
        
        self.log("INFO", f"📧 Found {len(gmail_accounts)} Gmail accounts on phone")
        return gmail_accounts
    
    def get_ig_count(self):
        """
        Count Instagram accounts by long-pressing profile tab.
        Returns list of IG usernames found.
        """
        import re
        
        # Go home first to ensure clean state
        self._run_adb("input", "keyevent", "3")
        time.sleep(1)
        
        # Open Instagram
        self._launch_ig(wait_seconds=3)  # monkey -p (am start on ModalActivity = SecurityException)
        
        # Check if logged in first
        self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
        time.sleep(1)
        result = self._run_adb("cat", "/sdcard/ui.xml")
        
        if not result or not result.stdout or "Your story" not in result.stdout:
            self.log("INFO", "📸 Not logged into Instagram - 0 accounts")
            return []
        
        # Long-press profile tab (972, 2274) to show account switcher
        self._run_adb("input", "swipe", "972", "2274", "972", "2274", "1000")
        time.sleep(2)
        
        # Dump UI
        self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
        time.sleep(1)
        result = self._run_adb("cat", "/sdcard/ui.xml")
        
        ig_accounts = []
        if result and result.stdout:
            # Get all text elements, filter out non-usernames
            all_texts = re.findall(r'text="([^"]+)"', result.stdout)
            for text in all_texts:
                # Skip known non-username texts
                if text in ["Add Instagram account", "Go to Accounts Center", ""]:
                    continue
                # IG usernames: lowercase, numbers, underscores, periods
                if re.match(r'^[a-z0-9_.]+$', text) and len(text) >= 3:
                    ig_accounts.append(text)
        
        # Close popup
        self._run_adb("input", "keyevent", "4")
        time.sleep(1)
        
        self.log("INFO", f"📸 Found {len(ig_accounts)} Instagram accounts on phone")
        return ig_accounts
    
    def verify_account_parity(self, accounts_file="new_accounts.txt"):
        """
        Check Gmail vs IG account parity.
        Returns dict with status and any missing IG accounts.
        
        Args:
            accounts_file: Path to accounts.txt with gmail:password:recovery format
        """
        import os
        
        self.log("INFO", "🔍 Checking account parity...")
        
        # Get accounts on phone
        gmail_on_phone = self.get_gmail_count()
        ig_on_phone = self.get_ig_count()
        
        # Read expected accounts from file
        expected_gmails = []
        if os.path.exists(accounts_file):
            with open(accounts_file, 'r') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#'):
                        parts = line.split(':')
                        if parts:
                            expected_gmails.append(parts[0])
        
        # Find Gmail accounts that don't have matching IG
        # (IG usernames often derived from Gmail prefix)
        missing_ig = []
        for gmail in gmail_on_phone:
            gmail_prefix = gmail.split('@')[0].lower()
            has_ig = False
            for ig in ig_on_phone:
                if gmail_prefix in ig.lower() or ig.lower() in gmail_prefix:
                    has_ig = True
                    break
            if not has_ig:
                missing_ig.append(gmail)
        
        result = {
            "gmail_count": len(gmail_on_phone),
            "ig_count": len(ig_on_phone),
            "gmail_accounts": gmail_on_phone,
            "ig_accounts": ig_on_phone,
            "missing_ig_for_gmail": missing_ig,
            "max_gmail": 5,
            "max_ig": 5,
            "gmail_slots_left": max(0, 5 - len(gmail_on_phone)),
            "ig_slots_left": max(0, 5 - len(ig_on_phone))
        }
        
        self.log("INFO", f"📊 Gmail: {result['gmail_count']}/5 | IG: {result['ig_count']}/5")
        if missing_ig:
            self.log("WARNING", f"⚠️ Missing IG accounts for: {missing_ig}")
        
        return result
    
    def instagram_login_existing(self, email, password="SirenxMedia1738!"):
        """
        Log into an existing Instagram account via long-press profile → Add account.
        
        If captcha/verification is required, logs out and flags account.
        
        Args:
            email: Gmail/email for the IG account
            password: Password for the IG account
            
        Returns:
            dict: {"success": bool, "verification_needed": bool, "username": str}
        """
        self.log("INFO", f"📸 Logging into IG: {email}")
        
        # Go home first
        self._run_adb("input", "keyevent", "3")
        time.sleep(1)
        
        # Open Instagram
        self._launch_ig(wait_seconds=3)  # monkey -p (am start on ModalActivity = SecurityException)
        
        # Long-press profile tab to show account switcher
        self._run_adb("input", "swipe", "972", "2274", "972", "2274", "1000")
        time.sleep(2)
        
        # Click Add Instagram account
        self.find_and_click_text("Add Instagram account")
        time.sleep(2)
        
        # Click Log into existing account
        self.find_and_click_text("Log into existing account")
        time.sleep(2)
        
        # Check for "Use another profile" or direct login form
        self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
        time.sleep(1)
        result = self._run_adb("cat", "/sdcard/ui.xml")
        
        if result and result.stdout and "Use another profile" in result.stdout:
            self.find_and_click_text("Use another profile")
            time.sleep(2)
        
        # Clear email field and enter email
        self.find_and_click_text("Username, email or mobile number")
        time.sleep(0.5)
        # Select all (Ctrl+A) and delete - more reliable than backspaces
        self._run_adb("input", "keyevent", "29", "--longpress")  # Long press A doesn't work, use different approach
        time.sleep(0.2)
        # Triple-tap to select all text
        self._run_adb("input", "tap", "540", "1060")
        time.sleep(0.1)
        self._run_adb("input", "tap", "540", "1060")
        time.sleep(0.1)
        self._run_adb("input", "tap", "540", "1060")
        time.sleep(0.3)
        # Delete selected text
        self._run_adb("input", "keyevent", "67")
        time.sleep(0.3)
        # Also do 40 backspaces as fallback
        for _ in range(40):
            self._run_adb("input", "keyevent", "67")
        time.sleep(0.3)
        self.type_text(email)
        time.sleep(1)
        
        # Click password field and enter password
        self.find_and_click_text("Password")
        time.sleep(0.5)
        self.type_text(password)
        time.sleep(1)
        
        # Click Log in
        self.find_and_click_text("Log in")
        time.sleep(5)
        
        # Handle Save login popup
        self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
        time.sleep(1)
        result = self._run_adb("cat", "/sdcard/ui.xml")
        
        if result and result.stdout:
            if "Save your login" in result.stdout:
                self.find_and_click_text("Save")
                time.sleep(3)
                # Re-check screen
                self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
                time.sleep(1)
                result = self._run_adb("cat", "/sdcard/ui.xml")
        
        # Check for captcha/verification screens
        if result and result.stdout:
            if "Confirm you're human" in result.stdout or "Enter the code from the image" in result.stdout:
                self.log("WARNING", f"⚠️ Account {email} requires captcha verification - flagging as cooked")
                self._logout_cooked_account(email)
                return {"success": False, "verification_needed": True, "account_not_found": False, "username": None, "email": email}
            
            if "video selfie" in result.stdout.lower() or "confirm you're a real person" in result.stdout.lower():
                self.log("WARNING", f"⚠️ Account {email} requires video selfie - flagging as cooked")
                self._logout_cooked_account(email)
                return {"success": False, "verification_needed": True, "account_not_found": False, "username": None, "email": email}
            
            if "Is this your account" in result.stdout or "couldn't find an account" in result.stdout.lower():
                self.log("WARNING", f"⚠️ No IG account found for {email} - needs creation")
                # Back out
                self._run_adb("input", "keyevent", "4")
                time.sleep(1)
                self._run_adb("input", "keyevent", "4")
                return {"success": False, "verification_needed": False, "account_not_found": True, "username": None, "email": email}
            
            if "Your story" in result.stdout:
                self.log("SUCCESS", f"✅ Logged in to {email}")
                # Extract username from email prefix
                username = email.split("@")[0]
                return {"success": True, "verification_needed": False, "account_not_found": False, "username": username, "email": email}
        
        self.log("INFO", f"🔄 Login status unclear for {email}")
        return {"success": False, "verification_needed": False, "account_not_found": False, "username": None, "email": email}
    
    def _logout_cooked_account(self, email):
        """Logout a cooked account that needs verification via hamburger menu."""
        self.log("INFO", f"🚪 Logging out cooked account: {email}")
        
        # Click hamburger menu (top right)
        self._run_adb("input", "tap", "1000", "200")
        time.sleep(2)
        
        # Look for Log out with account name
        email_prefix = email.split("@")[0]
        if not self.find_and_click_text(f"Log out {email_prefix}"):
            # Try generic Log out
            self.find_and_click_text("Log out")
        time.sleep(2)
        
        # Confirm logout
        self.find_and_click_text("Log out")
        time.sleep(3)
        
        self.log("SUCCESS", f"✅ Logged out cooked account: {email}")
    
    def gmail_logout_account(self, email):
        """
        Remove a Gmail account from the device.
        Flow: Profile icon → Manage accounts on this device → scroll → click account → Remove account
        
        Args:
            email: Gmail address to remove
        """
        self.log("INFO", f"📧 Removing Gmail account: {email}")
        
        # Go home first
        self._run_adb("input", "keyevent", "3")
        time.sleep(1)
        
        # Open Gmail
        self._run_adb("monkey", "-p", "com.google.android.gm", "-c", "android.intent.category.LAUNCHER", "1")
        time.sleep(3)

        # Click profile icon (top right)
        self._run_adb("input", "tap", "980", "200")
        time.sleep(2)
        
        # Click "Manage accounts on this device"
        if not self.find_and_click_text("Manage accounts on this device"):
            self.log("WARNING", "Could not find 'Manage accounts on this device'")
            return False
        time.sleep(2)
        
        # Scroll down to find the account
        for _ in range(3):
            # Try to click the email
            if self.find_and_click_text(email):
                time.sleep(2)
                
                # Click "Remove account"
                if self.find_and_click_text("Remove account"):
                    time.sleep(2)
                    # Confirm removal
                    self.find_and_click_text("Remove account")
                    time.sleep(2)
                    
                    self.log("SUCCESS", f"✅ Removed Gmail account: {email}")
                    self.update_account_status(email, "removed")
                    return True
            
            # Scroll down
            self._run_adb("input", "swipe", "540", "1800", "540", "1000", "300")
            time.sleep(1)
        
        self.log("WARNING", f"⚠️ Could not find {email} to remove")
        return False
    
    def logout_overflow_accounts(self):
        """
        Log out all overflow accounts (both Gmail and IG).
        """
        overflow = self.check_and_handle_overflow()
        
        for acc in overflow:
            if acc.get("type") == "gmail":
                self.gmail_logout_account(acc["email"])
            elif acc.get("type") == "instagram":
                # For IG, use long-press profile → account → log out
                self._logout_ig_account(acc.get("username", acc["email"].split("@")[0]))
        
        return overflow
    
    def _logout_ig_account(self, username):
        """Log out a specific IG account by username."""
        self.log("INFO", f"📸 Logging out IG account: @{username}")
        
        # Go home first
        self._run_adb("input", "keyevent", "3")
        time.sleep(1)
        
        # Open Instagram
        self._launch_ig(wait_seconds=3)  # monkey -p (am start on ModalActivity = SecurityException)
        
        # Long-press profile tab
        self._run_adb("input", "swipe", "972", "2274", "972", "2274", "1000")
        time.sleep(2)
        
        # Click the username to switch to it
        if self.find_and_click_text(username):
            time.sleep(3)
            
            # Now on that account, click profile tab, options menu, log out
            self._run_adb("input", "tap", "972", "2274")
            time.sleep(2)
            self._run_adb("input", "tap", "996", "202")
            time.sleep(2)
            
            # Scroll to Log out
            for _ in range(4):
                self._run_adb("input", "swipe", "540", "1800", "540", "600", "500")
                time.sleep(0.5)
            
            if self.find_and_click_text(f"Log out {username}"):
                time.sleep(2)
                self.find_and_click_text("Log out")
                time.sleep(3)
                self.log("SUCCESS", f"✅ Logged out IG: @{username}")
                return True
        
        self.log("WARNING", f"⚠️ Could not log out @{username}")
        return False
    
    def get_sms_code_daisysms(self, api_key, service="ig", max_price=1.0, timeout=120):
        """
        Rent a number from DaisySMS and wait for SMS code.
        
        NOTE: This is kept as a utility but not used for cooked accounts.
        Only use for fresh account creation that requires phone verification.
        
        Args:
            api_key: DaisySMS API key
            service: Service code (ig for Instagram)
            max_price: Maximum price in dollars
            timeout: Max seconds to wait for SMS
            
        Returns:
            dict: {"phone": str, "code": str, "rental_id": str} or None
        """
        import urllib.request
        import json
        
        base_url = "https://daisysms.com/stubs/handler_api.php"
        
        # Rent number
        rent_url = f"{base_url}?api_key={api_key}&action=getNumber&service={service}&max_price={max_price}"
        try:
            with urllib.request.urlopen(rent_url, timeout=30) as response:
                result = response.read().decode()
        except Exception as e:
            self.log("ERROR", f"DaisySMS rent failed: {e}")
            return None
        
        if not result.startswith("ACCESS_NUMBER"):
            self.log("ERROR", f"DaisySMS: {result}")
            return None
        
        parts = result.split(":")
        rental_id = parts[1]
        phone = parts[2]
        
        self.log("INFO", f"📱 DaisySMS: Got number +{phone} (ID: {rental_id})")
        
        # Poll for code
        start_time = time.time()
        while time.time() - start_time < timeout:
            status_url = f"{base_url}?api_key={api_key}&action=getStatus&id={rental_id}"
            try:
                with urllib.request.urlopen(status_url, timeout=30) as response:
                    status = response.read().decode()
            except:
                time.sleep(5)
                continue
            
            if status.startswith("STATUS_OK:"):
                code = status.split(":")[1]
                self.log("SUCCESS", f"📲 DaisySMS: Got code {code}")
                return {"phone": phone, "code": code, "rental_id": rental_id}
            elif status == "STATUS_CANCEL":
                self.log("ERROR", "DaisySMS: Rental cancelled")
                return None
            
            time.sleep(5)
        
        self.log("ERROR", f"DaisySMS: Timeout waiting for code")
        return None
    
    def tap_input_field(self, retries=2):
        """Find and tap the first EditText input field on screen"""
        import re
        
        self.log("INFO", "📝 Looking for input field...")
        
        # Dump UI once
        self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
        time.sleep(1)
        
        result = self._run_adb("cat", "/sdcard/ui.xml")
        if not result or not result.stdout:
            # No UI dump - try hardcoded Google coords as fallback
            self.log("INFO", "📍 Using hardcoded coords (539, 978)")
            self._run_adb("input", "tap", "539", "978")
            time.sleep(0.5)
            return True
        
        # PRIMARY: If Google sign-in page, use hardcoded coords immediately
        # Check for any Google sign-in indicators
        google_indicators = ["Sign in", "Forgot email", "Google Account", "accounts.google", "Create account"]
        if any(indicator in result.stdout for indicator in google_indicators):
            self.log("INFO", "📍 Google sign-in detected - using coords (539, 978)")
            self._run_adb("input", "tap", "539", "978")
            time.sleep(0.5)
            return True
        
        # For other screens: Find EditText bounds
        match = re.search(r'class="android.widget.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', result.stdout)
        if match:
            x1, y1, x2, y2 = map(int, match.groups())
            center_x = (x1 + x2) // 2
            center_y = (y1 + y2) // 2
            
            self.log("INFO", f"📍 Found input at ({center_x}, {center_y})")
            self._run_adb("input", "tap", str(center_x), str(center_y))
            time.sleep(0.5)
            return True
        
        # Fallback: Use Google sign-in coords (works for most input fields)
        self.log("INFO", "📍 Using fallback coords (539, 978)")
        self._run_adb("input", "tap", "539", "978")
        time.sleep(0.5)
        return True
    
    def type_text(self, text):
        """Type text with bulletproof special character handling using base64"""
        import base64
        
        self.log("INFO", f"⌨️ Typing: {text[:20]}..." if len(text) > 20 else f"⌨️ Typing: {text}")
        
        # Method 1: Try simple text first (for strings without special chars)
        simple_chars = set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@._-')
        if all(c in simple_chars for c in text):
            result = subprocess.run(
                ['adb', '-s', self.device_id, 'shell', 'input', 'text', text],
                capture_output=True, text=True, timeout=30
            )
            if result.returncode == 0:
                self.log("SUCCESS", "✅ Text entered (simple)")
                return True
        
        # Method 2: For special chars, type char by char with proper escaping
        self.log("INFO", "📝 Using char-by-char method for special chars...")
        
        for char in text:
            if char in simple_chars:
                # Simple char - just type it
                subprocess.run(
                    ['adb', '-s', self.device_id, 'shell', 'input', 'text', char],
                    capture_output=True, text=True, timeout=10
                )
            else:
                # Special char - escape with backslash
                escaped = '\\' + char
                subprocess.run(
                    ['adb', '-s', self.device_id, 'shell', 'input', 'text', escaped],
                    capture_output=True, text=True, timeout=10
                )
            time.sleep(0.05)  # Small delay between chars
        
        self.log("SUCCESS", "✅ Text entered (char-by-char)")
        return True
    
    # =========================================================================
    # STEP 1: AIRPLANE MODE + PROFILE SWITCH (IP RESET)
    # =========================================================================
    
    def enable_airplane_mode(self):
        """Enable airplane mode to reset network state"""
        self.log("INFO", "✈️ Enabling airplane mode...")
        
        # Method 1: Direct settings
        result = self._run_adb("settings", "put", "global", "airplane_mode_on", "1")
        
        if result and result.returncode == 0:
            # Broadcast the change
            self._run_adb("am", "broadcast", "-a", "android.intent.action.AIRPLANE_MODE", 
                         "--ez", "state", "true")
            time.sleep(2)
            self.log("SUCCESS", "✅ Airplane mode ENABLED")
            return True
        
        # Method 2: Connectivity command
        result = self._run_adb("cmd", "connectivity", "airplane-mode", "enable")
        if result and result.returncode == 0:
            time.sleep(2)
            self.log("SUCCESS", "✅ Airplane mode ENABLED (via connectivity)")
            return True
            
        self.log("ERROR", "❌ Failed to enable airplane mode")
        return False
    
    def disable_airplane_mode(self):
        """Disable airplane mode to get fresh IP"""
        self.log("INFO", "📶 Disabling airplane mode...")
        
        # Method 1: Direct settings
        result = self._run_adb("settings", "put", "global", "airplane_mode_on", "0")
        
        if result and result.returncode == 0:
            # Broadcast the change
            self._run_adb("am", "broadcast", "-a", "android.intent.action.AIRPLANE_MODE",
                         "--ez", "state", "false")
            time.sleep(3)
            self.log("SUCCESS", "✅ Airplane mode DISABLED - Fresh IP acquired")
            return True
        
        # Method 2: Connectivity command
        result = self._run_adb("cmd", "connectivity", "airplane-mode", "disable")
        if result and result.returncode == 0:
            time.sleep(3)
            self.log("SUCCESS", "✅ Airplane mode DISABLED (via connectivity)")
            return True
            
        self.log("ERROR", "❌ Failed to disable airplane mode")
        return False
    
    def get_current_user_id(self):
        """Get current active user ID"""
        result = self._run_adb("am", "get-current-user")
        if result and result.returncode == 0:
            user_id = result.stdout.strip()
            self.log("INFO", f"📱 Current user ID: {user_id}")
            return user_id
        return None
    
    def get_user_id_by_name(self, profile_name):
        """Get user ID by profile name"""
        result = self._run_adb("pm", "list", "users")
        if not result or result.returncode != 0:
            return None
            
        for line in result.stdout.split('\n'):
            if 'UserInfo{' in line:
                # Parse UserInfo{id:name:flags}
                start = line.find('UserInfo{') + 9
                end = line.find('}', start)
                if end > start:
                    info = line[start:end]
                    parts = info.split(':')
                    if len(parts) >= 2:
                        uid = parts[0]
                        name = parts[1]
                        if name.lower().strip() == profile_name.lower().strip():
                            self.log("INFO", f"📋 Found profile '{profile_name}' → User ID: {uid}")
                            return uid
        return None
    
    def switch_to_profile(self, profile_name_or_id):
        """Switch to specified profile by name or ID"""
        self.log("INFO", f"🔄 Switching to profile: {profile_name_or_id}")
        
        # Determine user ID
        if profile_name_or_id.isdigit():
            user_id = profile_name_or_id
        else:
            user_id = self.get_user_id_by_name(profile_name_or_id)
            if not user_id:
                self.log("ERROR", f"❌ Profile '{profile_name_or_id}' not found")
                return False
        
        # Check if already on this profile
        current = self.get_current_user_id()
        if current == user_id:
            self.log("INFO", f"✅ Already on profile {profile_name_or_id} (User ID: {user_id})")
            return True
        
        # Start the user first
        self._run_adb("am", "start-user", user_id)
        time.sleep(2)
        
        # Switch to user
        result = self._run_adb("am", "switch-user", user_id)
        if not (result and result.returncode == 0):
            self.log("ERROR", f"❌ Failed to switch profile (am switch-user nonzero)")
            return False

        # GrapheneOS profile transitions can take 5-15s. Poll for completion
        # instead of a fixed 8s sleep + return-True-anyway. The previous
        # implementation lied: it returned True even when the verify check
        # failed, causing downstream Gmail/IG flows to run on the WRONG
        # GrapheneOS user. That's also a privacy leak — credentials get
        # entered on Owner instead of the target profile.
        self.log("INFO", "⏳ Polling for profile switch to complete...")
        deadline = time.monotonic() + 20.0
        new_user = None
        while time.monotonic() < deadline:
            new_user = self.get_current_user_id()
            if new_user == user_id:
                self.log("SUCCESS", f"✅ Switched to profile (User ID: {user_id})")
                return True
            time.sleep(0.5)

        self.log("ERROR", f"❌ Profile switch did NOT complete within 20s. Current: {new_user}, Expected: {user_id}")
        return False
    
    def step1_profile_switch_with_ip_reset(self, profile_name_or_id):
        """
        STEP 1: Secure profile switch with IP reset
        
        Workflow:
        1. Enable airplane mode (kills all network connections)
        2. Switch to target profile
        3. Disable airplane mode (gets fresh IP for new profile)
        
        Args:
            profile_name_or_id: Profile name (e.g. "test") or user ID (e.g. "12")
            
        Returns:
            bool: True if successful
        """
        self.log("INFO", "=" * 60)
        self.log("INFO", "🚀 STEP 1: PROFILE SWITCH WITH IP RESET")
        self.log("INFO", f"   Target: {profile_name_or_id}")
        self.log("INFO", "=" * 60)
        
        # 1. Enable airplane mode (1s settle — the radios react within ~600ms)
        self.log("INFO", "📡 Phase 1/3: Enabling airplane mode...")
        if not self.enable_airplane_mode():
            self.log("ERROR", "❌ Step 1 FAILED: Could not enable airplane mode")
            return False
        time.sleep(1)

        # 2. Switch profile (switch_to_profile now polls for completion internally)
        self.log("INFO", "👤 Phase 2/3: Switching profile...")
        if not self.switch_to_profile(profile_name_or_id):
            self.log("ERROR", "❌ Step 1 FAILED: Could not switch profile")
            self.disable_airplane_mode()
            return False
        time.sleep(0.5)

        # 3. Disable airplane mode
        self.log("INFO", "🌐 Phase 3/4: Disabling airplane mode (acquiring fresh IP)...")
        if not self.disable_airplane_mode():
            self.log("ERROR", "❌ Step 1 FAILED: Could not disable airplane mode")
            return False

        # Poll for network rather than a fixed 5s sleep. Cellular usually
        # reattaches in 1-2s on Pixel 6; we cap at 6s so genuinely-slow nets
        # don't hang us forever.
        self.log("INFO", "⏳ Polling for network reattachment...")
        deadline = time.monotonic() + 6.0
        while time.monotonic() < deadline:
            r = self._run_adb("settings", "get", "global", "airplane_mode_on")
            if r and (r.stdout or "").strip() == "0":
                break
            time.sleep(0.3)
        
        # 4. Connect to VPN
        self.log("INFO", "🔒 Phase 4/4: Connecting to ProtonVPN...")
        try:
            from modules.protonvpn_module import ProtonVPNModule
            vpn = ProtonVPNModule(device_id=self.device_id)
            if vpn.ensure_connected():
                self.log("SUCCESS", "✅ VPN connected to Streaming US!")
            else:
                self.log("WARNING", "⚠️ VPN connection may have issues")
        except Exception as e:
            self.log("WARNING", f"⚠️ Could not connect VPN: {e}")
        
        self.log("SUCCESS", "=" * 60)
        self.log("SUCCESS", "✅ STEP 1 COMPLETE: Profile switched with fresh IP + VPN!")
        self.log("SUCCESS", f"   Now on profile: {profile_name_or_id}")
        self.log("SUCCESS", "=" * 60)
        
        return True
    
    # =========================================================================
    # STEP 2: GMAIL SETUP
    # =========================================================================
    
    def step2_open_gmail(self):
        """
        STEP 2: Open Gmail app
        
        Opens Gmail app which will prompt for account setup on fresh profile.
        
        Returns:
            bool: True if Gmail opened successfully
        """
        self.log("INFO", "=" * 60)
        self.log("INFO", "📧 STEP 2: OPENING GMAIL")
        self.log("INFO", "=" * 60)
        
        # Launch Gmail app
        self.log("INFO", "📱 Launching Gmail app...")
        
        # Launch via monkey (activity-agnostic, works on all Gmail versions)
        result = self._run_adb(
            "monkey", "-p", "com.google.android.gm",
            "-c", "android.intent.category.LAUNCHER", "1"
        )

        if result and result.returncode == 0:
            self.log("SUCCESS", "✅ Gmail app launched!")
            time.sleep(3)
            return True
        
        self.log("ERROR", "❌ Failed to open Gmail")
        return False
    
    def step2b_click_got_it(self):
        """
        STEP 2B: Click 'Got it' button in Gmail welcome screen
        
        Uses ADB to find and tap the button directly.
        
        Returns:
            bool: True if clicked successfully
        """
        import re
        
        self.log("INFO", "=" * 60)
        self.log("INFO", "👆 STEP 2B: CLICKING 'GOT IT' BUTTON")
        self.log("INFO", "=" * 60)
        
        try:
            # Dump UI and find "GOT IT" button
            self.log("INFO", "🔍 Searching for 'Got it' button...")
            
            # Dump UI hierarchy
            self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
            time.sleep(1)
            
            # Read the dump
            result = self._run_adb("cat", "/sdcard/ui.xml")
            if not result or not result.stdout:
                self.log("ERROR", "❌ Could not read UI dump")
                return False
            
            ui_xml = result.stdout
            
            # Find "GOT IT" or "Got it" button bounds
            patterns = [
                r'text="GOT IT"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                r'text="Got it"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                r'resource-id="[^"]*got_it[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            ]
            
            for pattern in patterns:
                match = re.search(pattern, ui_xml, re.IGNORECASE)
                if match:
                    x1, y1, x2, y2 = map(int, match.groups())
                    center_x = (x1 + x2) // 2
                    center_y = (y1 + y2) // 2
                    
                    self.log("INFO", f"📍 Found button at ({center_x}, {center_y})")
                    
                    # Tap the button
                    self._run_adb("input", "tap", str(center_x), str(center_y))
                    time.sleep(2)
                    
                    self.log("SUCCESS", "✅ Clicked 'Got it' button!")
                    return True
            
            self.log("WARNING", "⚠️ 'Got it' button not found - may already be dismissed")
            return False
            
        except Exception as e:
            self.log("ERROR", f"❌ Error clicking 'Got it': {e}")
            return False
    
    def step2c_click_add_email(self):
        """
        STEP 2C: Click 'Add an email address' button
        
        Uses ADB to find and tap the button directly.
        
        Returns:
            bool: True if clicked successfully
        """
        import re
        
        self.log("INFO", "=" * 60)
        self.log("INFO", "📧 STEP 2C: CLICKING 'ADD AN EMAIL ADDRESS'")
        self.log("INFO", "=" * 60)
        
        try:
            # Dump UI and find button
            self.log("INFO", "🔍 Searching for 'Add an email address' button...")
            
            # Dump UI hierarchy
            self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
            time.sleep(1)
            
            # Read the dump
            result = self._run_adb("cat", "/sdcard/ui.xml")
            if not result or not result.stdout:
                self.log("ERROR", "❌ Could not read UI dump")
                return False
            
            ui_xml = result.stdout
            
            # Find "Add an email address" button bounds
            patterns = [
                r'text="Add an email address"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                r'text="ADD AN EMAIL ADDRESS"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                r'text="Add email"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                r'content-desc="Add an email address"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            ]
            
            for pattern in patterns:
                match = re.search(pattern, ui_xml, re.IGNORECASE)
                if match:
                    x1, y1, x2, y2 = map(int, match.groups())
                    center_x = (x1 + x2) // 2
                    center_y = (y1 + y2) // 2
                    
                    self.log("INFO", f"📍 Found 'Add an email address' at ({center_x}, {center_y})")
                    
                    # Tap the button
                    self._run_adb("input", "tap", str(center_x), str(center_y))
                    time.sleep(2)
                    
                    self.log("SUCCESS", "✅ Clicked 'Add an email address' button!")
                    return True
            
            self.log("WARNING", "⚠️ 'Add an email address' not found on screen")
            return False
            
        except Exception as e:
            self.log("ERROR", f"❌ Error clicking 'Add an email address': {e}")
            return False
    
    def find_and_click_text(self, text_to_find):
        """Find element by text or content-desc and click it.

        Speed notes:
        * Uses the cached _dump_xml (TTL ~400ms) so back-to-back calls within
          the same screen do ONE ADB roundtrip instead of N.
        * No post-dump sleep — uiautomator dump is synchronous.
        * Post-tap sleep dropped from 2.0s to 0.4s. The CALLER is responsible
          for waiting for the next screen to appear (via wait_for / wait_for_screen);
          a generic helper has no business padding 2 seconds onto every tap.
        With ~25-30 calls in a happy-path account-creation run the old
        sleep(1) + sleep(2) = 3s/call meant 75-90s of wall-time was spent
        purely on artificial waits. New cost: ~12s aggregate.
        """
        import re

        self.log("INFO", f"🔍 Looking for '{text_to_find}'...")

        try:
            ui_xml = self._dump_xml(force=False, ttl=0.4)
            if not ui_xml:
                return False

            escaped_text = re.escape(text_to_find)
            patterns = [
                rf'text="{escaped_text}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                rf'text="[^"]*{escaped_text}[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                rf'content-desc="{escaped_text}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            ]

            for pattern in patterns:
                match = re.search(pattern, ui_xml, re.IGNORECASE)
                if match:
                    x1, y1, x2, y2 = map(int, match.groups())
                    center_x = (x1 + x2) // 2
                    center_y = (y1 + y2) // 2

                    self.log("INFO", f"📍 Found '{text_to_find}' at ({center_x}, {center_y})")
                    self._run_adb("input", "tap", str(center_x), str(center_y))
                    self._invalidate_xml()
                    # Short settle for tap propagation. Caller should follow with
                    # wait_for / wait_for_screen when the next screen matters.
                    time.sleep(0.4)

                    self.log("SUCCESS", f"✅ Clicked '{text_to_find}'!")
                    return True

            self.log("WARNING", f"⚠️ '{text_to_find}' not found on screen")
            return False

        except Exception as e:
            self.log("ERROR", f"❌ Error: {e}")
            return False
    
    # =========================================================================
    # GMAIL LOGIN / ADD ACCOUNT
    # =========================================================================
    
    def switch_app(self, app_name):
        """Switch to app via recents"""
        self.log("INFO", f"🔄 Switching to {app_name}...")
        self._run_adb("input", "keyevent", "KEYCODE_APP_SWITCH")
        time.sleep(1)
        self.find_and_click_text(app_name)
        time.sleep(2)
        return True
    
    def get_current_gmail_account(self):
        """Get currently signed in Gmail account from content-desc"""
        import re
        self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
        time.sleep(1)
        result = self._run_adb("cat", "/sdcard/ui.xml")
        if result and result.stdout:
            match = re.search(r'Signed in as[^"]*?([a-zA-Z0-9._%+-]+@gmail\.com)', result.stdout)
            if match:
                return match.group(1)
        return None
    
    def gmail_login(self, email, password, recovery_email=None):
        """Full Gmail login flow — screen-detection driven.

        Args:
            email: Gmail address
            password: Password
            recovery_email: Recovery email for verification (optional). May or
                may not be prompted depending on Google's risk score.
        """
        self.log("INFO", "=" * 60)
        self.log("INFO", f"📧 GMAIL LOGIN: {email}")
        self.log("INFO", "=" * 60)

        # Preflight (idempotent — no-op if everything is already installed).
        # Without this, fresh GrapheneOS profiles hit "Device not compatible".
        self.install_existing_preflight()

        self._launch_gmail(wait_seconds=2)

        # Already signed in?
        current = self.get_current_gmail_account()
        if current == email:
            self.log("SUCCESS", f"✅ Already logged in as {email}")
            return True

        # Welcome tour "GOT IT" (resource-id welcome_tour_got_it)
        pos = self.wait_for(resource_id="com.google.android.gm:id/welcome_tour_got_it", timeout=3, poll=0.3) \
              or self.wait_for(text="GOT IT", timeout=1, case_insensitive=True)
        if pos:
            self.tap_xy(*pos)

        # Add email address — id `setup_addresses_add_another` or text variants
        pos = self.wait_for(resource_id="com.google.android.gm:id/setup_addresses_add_another", timeout=5, poll=0.3) \
              or self.wait_for(text="Add an email address", timeout=2) \
              or self.wait_for(text="Add another email address", timeout=2)
        if pos:
            self.tap_xy(*pos)

        # Provider list — Google
        pos = self.wait_for(text="Google", timeout=5)
        if pos:
            self.tap_xy(*pos)

        # MinuteMaid email field — resource-id "identifierId"
        pos = self.wait_for(resource_id="identifierId", timeout=8) \
              or self.wait_for(content_desc="Email or phone", timeout=2)
        if pos:
            self.tap_xy(*pos)
        else:
            self.tap_input_field()
        self.type_text(email)
        pos = self.wait_for(text="Next", timeout=3)
        if pos:
            self.tap_xy(*pos)

        # Password field — poll for any password EditText instead of fixed sleep.
        # MinuteMaid renders password input as class=android.widget.EditText with
        # password="true". Cap at 5s to avoid hanging on slow logins.
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            xml = self._dump_xml(force=True, ttl=0)
            if 'password="true"' in (xml or ''):
                break
            time.sleep(0.3)
        self.tap_input_field()
        self.type_text(password)
        pos = self.wait_for(text="Next", timeout=4)
        if pos:
            self.tap_xy(*pos)

        # Recovery email — CONDITIONAL screen. Only handle if it actually appears.
        if recovery_email:
            pos = self.wait_for(text="Confirm your recovery email", timeout=3) \
                  or self.wait_for(text="Recovery email", timeout=1)
            if pos:
                self.tap_xy(*pos)
                self.tap_input_field()
                self.type_text(recovery_email)
                self.wait_for(text="Next", timeout=2)
                if self.find_and_click_text("Next"):
                    pass

        # Home address — CONDITIONAL. Skip is content-desc only (no text label).
        # Only tap Skip if the screen header is actually present.
        pos = self.wait_for(text="Add your home address", timeout=2)
        if pos:
            skip_pos = self.wait_for(content_desc="Skip", timeout=2)
            if skip_pos:
                self.tap_xy(*skip_pos)

        # ToS — "I agree"
        pos = self.wait_for(text="I agree", timeout=8)
        if pos:
            self.tap_xy(*pos)

        # Welcome to Gmail — "TAKE ME TO GMAIL" (id action_done)
        pos = self.wait_for(resource_id="com.google.android.gm:id/action_done", timeout=8) \
              or self.wait_for(text="TAKE ME TO GMAIL", timeout=2, case_insensitive=True)
        if pos:
            self.tap_xy(*pos)

        # Notif perm — uses the system permission_deny_button id (locale-stable
        # AND handles the curly-apostrophe variant of Don't allow).
        self.dismiss_permission_dialog(timeout=4)

        # Google Meet tour "Got it" — conditional
        pos = self.wait_for(resource_id="com.google.android.gm:id/next_button", timeout=3, poll=0.3) \
              or self.wait_for(text="Got it", timeout=1)
        if pos:
            self.tap_xy(*pos)

        # Stray Dismiss button (rare)
        if self.find_and_click_text("Dismiss"):
            pass

        self.log("SUCCESS", f"✅ Gmail login complete: {email}")
        return True
    
    def gmail_add_account(self, email, password, recovery_email=None):
        """Add another Gmail account (when already logged in)"""
        self.log("INFO", f"📧 Adding Gmail account: {email}")
        
        # Open Gmail
        self._run_adb("monkey", "-p", "com.google.android.gm", "-c", "android.intent.category.LAUNCHER", "1")
        time.sleep(3)

        # Check if this is a new profile (no accounts yet) - "Got it" or "Add an email address" visible
        self._run_adb("uiautomator", "dump", "/sdcard/ui.xml")
        time.sleep(1)
        result = self._run_adb("cat", "/sdcard/ui.xml")
        
        if result and result.stdout:
            # New profile detection (check both cases)
            stdout_upper = result.stdout.upper()
            if "GOT IT" in stdout_upper or "ADD AN EMAIL ADDRESS" in stdout_upper:
                self.log("INFO", "📧 New profile detected - using gmail_login flow instead")
                return self.gmail_login(email, password, recovery_email)
        
        # Existing accounts - tap profile icon (top right)
        self._run_adb("input", "tap", "1000", "200")
        time.sleep(2)
        
        # Click Add another account
        self.find_and_click_text("Add another account")
        time.sleep(2)
        
        # Continue with standard flow
        self.find_and_click_text("Google")
        time.sleep(3)
        
        self.tap_input_field()
        self.type_text(email)
        self.find_and_click_text("Next")
        time.sleep(4)
        
        self.tap_input_field()
        self.type_text(password)
        self.find_and_click_text("Next")
        time.sleep(4)
        
        if recovery_email:
            if self.find_and_click_text("Confirm your recovery email"):
                time.sleep(2)
                self.type_text(recovery_email)
                self.find_and_click_text("Next")
                time.sleep(3)
        
        self._run_adb("input", "swipe", "540", "1800", "540", "800", "500")
        time.sleep(1)
        self.find_and_click_text("Skip")
        time.sleep(2)
        
        self.find_and_click_text("I agree")
        time.sleep(3)
        
        # Handle notifications popup - click Don't allow
        if not self.find_and_click_text("Don't allow"):
            self.find_and_click_text("Don\'t allow")  # Try unicode apostrophe
        time.sleep(1)
        
        # Handle other popups
        self.find_and_click_text("Got it")
        time.sleep(1)
        self.find_and_click_text("Dismiss")
        time.sleep(1)
        
        self.log("SUCCESS", f"✅ Gmail account added: {email}")
        return True
    
    # =========================================================================
    # INSTAGRAM ACCOUNT CREATION
    # =========================================================================
    
    def instagram_get_code_from_gmail(self, target_email):
        """
        Switch to Gmail, verify correct account, get Instagram verification code
        
        Args:
            target_email: The Gmail account to check for the code
            
        Returns:
            str: The 6-digit code or None if not found
        """
        import re
        
        self.log("INFO", f"📧 Getting IG code from Gmail ({target_email})...")
        
        # Switch to Gmail via monkey (faster + more reliable than recents
        # which can be empty after a fresh-profile cold boot).
        self._launch_gmail(wait_seconds=0)
        # Poll for the Gmail UI to settle (inbox row visible) rather than
        # a fixed 3s sleep — typically 800ms on warm boot.
        self.wait_for(text="Primary", timeout=4, poll=0.3) or self.wait_for(text="Inbox", timeout=2, poll=0.3)

        # Verify we're on correct account
        current = self.get_current_gmail_account()
        if current and current != target_email:
            self.log("WARNING", f"⚠️ Wrong Gmail account: {current}, switching to {target_email}...")
            self._run_adb("input", "tap", "1000", "200")  # profile icon top-right
            self._invalidate_xml()
            # Wait for the account picker to render (any @gmail.com row)
            self.wait_for(text="@gmail.com", exact=False, timeout=3, poll=0.25)
            if not self.find_and_click_text(target_email):
                self._run_adb("input", "swipe", "540", "1200", "540", "600", "300")
                self._invalidate_xml()
                self.find_and_click_text(target_email)
            self.log("SUCCESS", f"✅ Switched to {target_email}")
        
        # Fast polling loop: code typically lands in <10s. Was 5× 20s = 100s of
        # blind sleep; now 2s ticks for ≤30s before we even consider resending.
        def _scan_for_code(xml):
            if not xml:
                return None
            m = re.search(r'(\d{6}) is your Instagram code', xml)
            return m.group(1) if m else None

        def _poll_for_code(budget_s=30, tick=2.0):
            deadline = time.monotonic() + budget_s
            checked_social = False
            while True:
                xml = self._dump_xml(force=True, ttl=0)
                code = _scan_for_code(xml)
                if code:
                    return code
                # First miss only: peek into the Social/Updates tab if Gmail
                # auto-routed the verification email there.
                if not checked_social and "Social" in xml:
                    checked_social = True
                    self.log("INFO", "📂 Peeking at Social tab...")
                    if self.find_and_click_text("Social"):
                        time.sleep(0.5)
                        xml = self._dump_xml(force=True, ttl=0)
                        code = _scan_for_code(xml)
                        if code:
                            return code
                if time.monotonic() >= deadline:
                    return None
                # Pull-to-refresh halfway through the budget
                if (deadline - time.monotonic()) < (budget_s / 2):
                    self._run_adb("input", "swipe", "540", "500", "540", "1200", "300")
                time.sleep(tick)

        code = _poll_for_code(budget_s=30, tick=2.0)
        if code:
            self.log("SUCCESS", f"✅ Found Instagram code: {code}")
            return code

        # Resend path
        self.log("INFO", "📧 Code not landed in 30s — requesting resend...")
        self._launch_ig(wait_seconds=1)
        if self.find_and_click_text("get the code"):
            self.log("SUCCESS", "✅ Tapped 'get the code'")
            if self.find_and_click_text("Resend confirmation code"):
                self.log("SUCCESS", "✅ Tapped 'Resend confirmation code'")
        time.sleep(2)
        self._launch_gmail(wait_seconds=2)

        code = _poll_for_code(budget_s=45, tick=2.0)
        if code:
            self.log("SUCCESS", f"✅ Found Instagram code (resend): {code}")
            return code

        self.log("ERROR", "❌ Could not find Instagram code after resend")
        return None
    
    def instagram_create_account(self, email, password="SirenxMedia1738!", name="Jocelyn Chen", username=None):
        """Full Instagram account creation flow — screen-detection state machine.

        Live walkthrough on Pixel 6 GrapheneOS confirmed ~30 distinct screens,
        a handful of which are conditional (recovery email, home address,
        notif perm, contacts perm). Blind sequential taps break on any of
        those: if the screen is absent, the "Next"/"Skip" lands on whatever
        the NEXT screen happens to show. So every step here waits for a
        positive screen signature (resource-id or text) before tapping.
        """
        import re

        self.log("INFO", "=" * 60)
        self.log("INFO", f"📸 INSTAGRAM ACCOUNT CREATION")
        self.log("INFO", f"   Email: {email}")
        self.log("INFO", f"   Name: {name}")
        self.log("INFO", "=" * 60)

        # Preflight: GMS/Play/Gmail/IG must be present on the current user, or
        # IG/Gmail will throw "Device not compatible" on a fresh profile.
        self.install_existing_preflight()

        # Launch Instagram (monkey -p; am start on ModalActivity = SecurityException)
        self._launch_ig(wait_seconds=2)

        # Dismiss any leftover notification permission dialog from a prior run
        self.dismiss_permission_dialog(timeout=2)

        # 2.16.60: when already logged in, DON'T log out (destroys the
        # existing account). Use IG's native "Add Instagram account" flow:
        # long-press the profile tab → bottom sheet → Add Instagram account
        # → Create new account. Preserves the existing logged-in account so
        # we can switch back to it after the new signup.
        xml = self._dump_xml(force=True, ttl=0)
        if "Your story" in xml or "story_avatar" in xml:
            self.log("INFO", "⚠️ Already logged in — using Add Instagram account flow (preserves existing)")
            # Land on profile tab first so the long-press hits the right target
            self._run_adb("input", "tap", "972", "2274")
            self.wait_for(text="Edit profile", timeout=5) or self.wait_for(content_desc="Options", timeout=3)
            time.sleep(0.4)
            # Long-press via swipe-in-place — IG's account switcher
            # opens after ~600ms hold. 800ms duration gives comfortable margin.
            self._run_adb("input", "swipe", "972", "2274", "972", "2274", "800")
            # Wait for the bottom sheet (Add Instagram account row)
            pos = self.wait_for(content_desc="Add Instagram account", timeout=6) \
                  or self.wait_for(text="Add Instagram account", timeout=2)
            if not pos:
                self.log("WARN", "Long-press didn't open account switcher — falling back to logout flow")
                # Fallback: original logout path
                self._run_adb("input", "tap", "996", "202")
                time.sleep(0.6)
                for _ in range(4):
                    self._run_adb("input", "swipe", "540", "1800", "540", "600", "400")
                    time.sleep(0.25)
                if self.find_and_click_text("Log out all accounts") or self.find_and_click_text("Log out"):
                    logout_pos = self.wait_for(text="Log out", timeout=3)
                    if logout_pos:
                        self.tap_xy(*logout_pos)
                    self.wait_for(text="Create new account", timeout=8) or self.wait_for(text="Sign up", timeout=4)
                self.log("SUCCESS", "✅ Logged out (fallback)")
            else:
                self.tap_xy(*pos)
                # Now on the "Add account" screen — Create new account or Log into existing
                create_pos = self.wait_for(content_desc="Create new account", timeout=6) \
                             or self.wait_for(text="Create new account", timeout=2)
                if create_pos:
                    self.tap_xy(*create_pos)
                    self.log("SUCCESS", "✅ Tapped Create new account from Add Instagram account flow")
                else:
                    self.log("WARN", "Create new account button not found on Add screen")

        # Welcome / Create-new-account
        pos = self.wait_for(text="Create new account", timeout=8)
        if not pos:
            # Sometimes the welcome screen needs a scroll
            self._run_adb("input", "swipe", "540", "1800", "540", "1200", "250")
            pos = self.wait_for(text="Create new account", timeout=4)
        if pos:
            self.tap_xy(*pos)

        # Default lands on mobile signup — switch to email
        pos = self.wait_for(text="Sign up with email", timeout=6)
        if pos:
            self.tap_xy(*pos)

        # Email input
        pos = self.wait_for(content_desc="Email,", timeout=6) or self.wait_for(text="Email", timeout=2)
        if pos:
            self.tap_xy(*pos)
        else:
            self.tap_input_field()
        self.type_text(email)
        pos = self.wait_for(text="Next", timeout=3)
        if pos:
            self.tap_xy(*pos)

        # Fetch code from Gmail (this function now polls fast; ~10s typical)
        code = self.instagram_get_code_from_gmail(email)
        if not code:
            self.log("ERROR", "❌ Failed to get verification code")
            return None

        # Back to Instagram — use monkey rather than recents (recents can be empty
        # on fresh profiles or after the system kills IG to free memory).
        self._launch_ig(wait_seconds=1)

        # Code entry (content-desc "Code input entry field")
        pos = self.wait_for(content_desc="Code input entry field", timeout=6) \
              or self.wait_for(text="Confirmation code", timeout=2)
        if pos:
            self.tap_xy(*pos)
        else:
            self.tap_input_field()
        self.type_text(code)
        pos = self.wait_for(text="Next", timeout=4)
        if pos:
            self.tap_xy(*pos)

        # Password
        pos = self.wait_for(content_desc="Password,", timeout=8) or self.wait_for(text="Password", timeout=2)
        if pos:
            self.tap_xy(*pos)
        else:
            self.tap_input_field()
        self.type_text(password)
        pos = self.wait_for(text="Next", timeout=3)
        if pos:
            self.tap_xy(*pos)

        # "Save your login info" popup may appear here — Save or Not now both fine
        save_screen, _ = self.wait_for_screen([
            ("save", dict(text="Save your login info")),
            ("not_now", dict(text="Not now")),
            ("birthday", dict(text="Birthday")),
        ], timeout=4)
        if save_screen in ("save", "not_now"):
            pos = self._find_in_xml(self._dump_xml(force=True, ttl=0), text="Not now") \
                  or self._find_in_xml(self._dump_xml(), text="Save")
            if pos:
                self.tap_xy(*pos)

        # Native Android date picker
        self._set_random_birthday()
        # Confirm birthday card
        pos = self.wait_for(text="Next", timeout=6)
        if pos:
            self.tap_xy(*pos)

        # Full name
        pos = self.wait_for(content_desc="Full name,", timeout=6) or self.wait_for(text="Full name", timeout=2)
        if pos:
            self.tap_xy(*pos)
        else:
            self.tap_input_field()
        self.type_text(name)
        pos = self.wait_for(text="Next", timeout=3)
        if pos:
            self.tap_xy(*pos)

        # Username — accept suggestion or override
        if username:
            self._run_adb("input", "keyevent", "123")  # MOVE_END
            for _ in range(40):
                self._run_adb("input", "keyevent", "67")  # backspace
            self.type_text(username)

        final_username = None
        xml = self._dump_xml(force=True, ttl=0)
        m = re.search(r'text="([a-z0-9_.]+)"[^>]*class="android.widget.EditText"', xml)
        if m:
            final_username = m.group(1)

        pos = self.wait_for(text="Next", timeout=3)
        if pos:
            self.tap_xy(*pos)

        # Terms screen
        pos = self.wait_for(text="I agree", timeout=8)
        if pos:
            self.tap_xy(*pos)

        # Post-terms onboarding — drive by screen detection, NOT fixed sleeps.
        # The order varies; some screens are skipped. Loop with a budget.
        onboarding_signatures = [
            ("profile_photo", dict(text="Add profile photo")),
            ("profile_photo_skip", dict(resource_id="com.instagram.android:id/skip_button")),
            ("bio", dict(text="Add bio")),
            ("contacts_sync", dict(text="Sync contacts")),
            ("contacts_perm", dict(resource_id="com.android.permissioncontroller:id/permission_deny_button")),
            ("turn_on_notifs", dict(text="Turn on notifications")),
            ("follow_people", dict(text="Follow 5 people")),
            ("home", dict(text="Your story")),
            ("home2", dict(content_desc="Your story")),
            ("got_it", dict(text="Got it")),
            ("not_now", dict(text="Not now")),
            ("skip_text", dict(text="Skip")),
        ]
        end_time = time.monotonic() + 60  # hard cap to avoid infinite loop on edge UI
        while time.monotonic() < end_time:
            name_match, pos = self.wait_for_screen(onboarding_signatures, timeout=6, poll=0.4)
            if name_match in ("home", "home2"):
                break
            if name_match == "contacts_perm":
                self.dismiss_permission_dialog(timeout=2)
                continue
            if name_match in ("profile_photo_skip", "skip_text", "not_now"):
                if pos:
                    self.tap_xy(*pos)
                continue
            if name_match == "got_it":
                if pos:
                    self.tap_xy(*pos)
                continue
            if name_match == "turn_on_notifs":
                # The flow asks Next → system perm dialog → Don't allow
                pos_next = self._find_in_xml(self._dump_xml(force=True, ttl=0), text="Next")
                if pos_next:
                    self.tap_xy(*pos_next)
                self.dismiss_permission_dialog(timeout=4)
                continue
            if name_match in ("profile_photo", "bio", "contacts_sync", "follow_people"):
                # All of these have a Skip action — find it on the current screen
                pos_skip = self._find_in_xml(self._dump_xml(force=True, ttl=0),
                                             resource_id="com.instagram.android:id/skip_button") \
                           or self._find_in_xml(self._dump_xml(), text="Skip")
                if pos_skip:
                    self.tap_xy(*pos_skip)
                continue
            if name_match is None:
                # Nothing recognized — try a generic Skip then bail
                if not self.find_and_click_text("Skip"):
                    break
        
        self.log("SUCCESS", "=" * 60)
        self.log("SUCCESS", f"✅ INSTAGRAM ACCOUNT CREATED!")
        self.log("SUCCESS", f"   Email: {email}")
        self.log("SUCCESS", f"   Username: {final_username}")
        self.log("SUCCESS", f"   Password: {password}")
        self.log("SUCCESS", "=" * 60)
        
        return {
            "email": email,
            "username": final_username,
            "password": password,
            "name": name
        }
    
    def _set_random_birthday(self, year_min=2003, year_max=2007):
        """Set a random birthday via Android's native NumberPicker date dialog.

        The dialog has three `android:id/numberpicker_input` EditTexts (month,
        day, year). We type the year directly into the year EditText after
        clearing it with KEYCODE_DEL, then confirm with the dialog's
        `android:id/button1` (the SET button). This is far more reliable than
        blind input-swipe on hardcoded x-coords (which silently set garbage on
        any device that doesn't have the exact DPI we hardcoded for).
        """
        import random
        import re

        target_year = random.randint(year_min, year_max)
        target_month = random.randint(1, 12)
        target_day = random.randint(1, 28)  # safe across all months
        self.log("INFO", f"📅 Setting birthday: {target_year}-{target_month:02d}-{target_day:02d}")

        # Wait for the native dialog to appear. The button1 id is the most
        # stable signal — text="SET" or "OK" or "Done" varies across locales.
        ok = self.wait_for(resource_id="android:id/button1", timeout=8, poll=0.3)
        if not ok:
            # Maybe the previous step left us on an in-app birthday card. Try
            # to surface the picker by tapping any year-looking text first.
            xml = self._dump_xml(force=True, ttl=0)
            m = re.search(r'text="[^"]*\b(19|20)\d{2}\b[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
            if m:
                x1, y1, x2, y2 = map(int, m.groups()[1:])
                self.tap_xy((x1 + x2) // 2, (y1 + y2) // 2)
                ok = self.wait_for(resource_id="android:id/button1", timeout=6, poll=0.3)
            if not ok:
                self.log("WARNING", "⚠️ Native date dialog never appeared; falling back to whatever's visible")
                # Last-ditch: tap whichever variant of SET/OK/Done shows up
                if self.find_and_click_text("SET") or self.find_and_click_text("OK") or self.find_and_click_text("Done"):
                    return True
                return False

        xml = self._dump_xml(force=True, ttl=0)
        # Pull every numberpicker_input EditText with its bounds, in DOM order.
        # Android renders them left-to-right: [month, day, year] for en-US.
        picker_iter = re.finditer(
            r'<node[^>]*resource-id="android:id/numberpicker_input"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            xml,
        )
        pickers = [(int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4))) for m in picker_iter]
        if len(pickers) < 3:
            self.log("WARNING", f"⚠️ Expected 3 numberpicker_input nodes, found {len(pickers)}; trying SET anyway")
            if self.find_and_click_text("SET") or self.find_and_click_text("OK"):
                return True
            return False

        # Sort left-to-right by x1; locale order is month, day, year for en-US.
        pickers.sort(key=lambda b: b[0])
        month_box, day_box, year_box = pickers[0], pickers[1], pickers[2]

        def fill_picker(box, value, expected_len):
            x1, y1, x2, y2 = box
            cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
            self.tap_xy(cx, cy)
            time.sleep(0.15)
            # Clear: KEYCODE_DEL × (expected_len + 1) is enough for any
            # pre-filled value up to 4 chars.
            for _ in range(expected_len + 2):
                self._run_adb("input", "keyevent", "67")
            self._run_adb("input", "text", str(value))
            time.sleep(0.1)

        fill_picker(year_box, target_year, 4)
        fill_picker(month_box, target_month, 2)
        fill_picker(day_box, target_day, 2)

        # Tap SET (button1) by id — stable across locale ("SET" vs "OK" vs "Done")
        pos = self._find_in_xml(self._dump_xml(force=True, ttl=0),
                                resource_id="android:id/button1")
        if pos:
            self.tap_xy(*pos)
        else:
            self.find_and_click_text("SET") or self.find_and_click_text("OK") or self.find_and_click_text("Done")

        self.log("SUCCESS", f"✅ Birthday set: {target_year}-{target_month:02d}-{target_day:02d}")
        return True
    
    # =========================================================================
    # VPN CONNECTION
    # =========================================================================
    
    def step4_vpn_connection(self):
        """STEP 4: Connect to VPN (TODO)"""
        self.log("INFO", "🔒 Step 4: VPN connection - NOT IMPLEMENTED YET")
        pass


def main():
    """Run the account creation module Step 1"""
    print("\n" + "=" * 60)
    print("🚀 ACCOUNT CREATION MODULE - STEP 1 TEST")
    print("=" * 60 + "\n")
    
    # Initialize module
    module = AccountCreationModule(device_id="1A121FDF60082H")
    
    # List available profiles first
    print("📋 Available profiles:")
    result = subprocess.run(
        ["adb", "-s", "1A121FDF60082H", "shell", "pm", "list", "users"],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        for line in result.stdout.split('\n'):
            if 'UserInfo{' in line:
                print(f"   {line.strip()}")
    
    print()
    
    # Run Step 1 with "test" profile (User ID 12)
    success = module.step1_profile_switch_with_ip_reset("test")
    
    if success:
        print("\n🎉 SUCCESS! Now on 'test' profile with fresh IP.")
        print("   Ready for Step 2: Gmail account setup")
    else:
        print("\n❌ FAILED! Check logs above for details.")
    
    return success


if __name__ == "__main__":
    main()
