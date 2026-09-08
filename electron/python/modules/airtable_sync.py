#!/usr/bin/env python3
"""
🔗 AIRTABLE SYNC MODULE
Syncs account validation data between local registry and Airtable.

Features:
- Fetch/update Accounts table records
- Sync validation results from account_registry.json
- Add Last Validated timestamp
"""

import requests
import json
import os
import re
import time
from datetime import datetime

# ==================== CONFIGURATION ====================

# Standard account fields use names so each user can configure their own base.
FIELD_USERNAME = "Username"
FIELD_PROFILE_ID = "Profile ID"
FIELD_PHONE = "Phone"
FIELD_COMPUTER = "Computer"
FIELD_LOGIN_EMAIL = "Login Email"
FIELD_ACCOUNT_PASSWORD = "Account Password"
FIELD_RECOVERY_EMAIL = "Recovery Email"
FIELD_STATUS = "Status"
FIELD_ACCOUNT_TYPE = "Account Type"
FIELD_DRIVE_LINK = "Drive Link"
FIELD_CONTENT_FOLDER = "Content Folder"
FIELD_CONTENT_SUBFOLDER = "Content Subfolder"
FIELD_STORY_MENTION = "Story Mention Target"
FIELD_STORY_LINK = "Story Link URL"
FIELD_BIO = "Bio"
FIELD_VIDEO_CAPTION = "Video Caption"

# Local paths
BASE_DIR = os.path.dirname(os.path.dirname(__file__))
REGISTRY_PATH = os.path.join(BASE_DIR, "data", "account_registry.json")
CONFIG_DIR = os.path.join(BASE_DIR, "config")
PROFILES_DIR = os.path.join(BASE_DIR, "profiles")



class AirtableSync:
    """
    Sync account data between local registry and Airtable.
    
    Usage:
        sync = AirtableSync()
        sync.sync_from_registry()  # Push local data to Airtable
    """
    
    def __init__(self, config=None):
        settings = config if isinstance(config, dict) else {}
        api_key = str(settings.get("airtable_api_key") or "").strip()
        base_id = str(settings.get("airtable_base_id") or "").strip()
        table_id = str(settings.get("airtable_table_id") or "").strip()
        if not api_key or "\r" in api_key or "\n" in api_key or not re.fullmatch(r"app[A-Za-z0-9]{14}", base_id) or not re.fullmatch(r"tbl[A-Za-z0-9]{14}", table_id):
            raise ValueError("Airtable setup required: pass your own airtable_api_key, airtable_base_id and airtable_table_id in the module configuration.")
        self.base_url = f"https://api.airtable.com/v0/{base_id}/{table_id}"
        self.headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        
    def log(self, level, message):
        """Log with timestamp"""
        timestamp = datetime.now().strftime("%H:%M:%S")
        print(f"[{timestamp}] [{level}] {message}")
        
    # ==================== AIRTABLE API ====================
    
    def get_all_accounts(self):
        """
        Fetch all records from Accounts table.
        
        Returns:
            list: [{id, fields}, ...]
        """
        self.log("INFO", "📥 Fetching all accounts from Airtable...")
        all_records = []
        offset = None
        
        while True:
            params = {}
            if offset:
                params["offset"] = offset
                
            try:
                resp = requests.get(self.base_url, headers=self.headers, params=params)
                if resp.status_code != 200:
                    self.log("ERROR", f"Airtable API error: {resp.status_code}")
                    break
                    
                data = resp.json()
                all_records.extend(data.get("records", []))
                offset = data.get("offset")
                
                if not offset:
                    break
                time.sleep(0.2)  # Rate limit
            except Exception as e:
                self.log("ERROR", f"Request failed: {e}")
                break
                
        self.log("INFO", f"📋 Fetched {len(all_records)} accounts")
        return all_records
    
    def find_by_username(self, username):
        """Find account record by Instagram username"""
        formula = f"{{Username}} = '{username}'"
        params = {"filterByFormula": formula, "maxRecords": 1}
        
        try:
            resp = requests.get(self.base_url, headers=self.headers, params=params)
            records = resp.json().get("records", [])
            return records[0] if records else None
        except Exception as e:
            self.log("ERROR", f"Find by username failed: {e}")
            return None
    
    def find_by_profile_id(self, profile_id):
        """Find account record by Profile ID"""
        formula = f"{{Profile ID}} = '{profile_id}'"
        params = {"filterByFormula": formula, "maxRecords": 1}
        
        try:
            resp = requests.get(self.base_url, headers=self.headers, params=params)
            records = resp.json().get("records", [])
            return records[0] if records else None
        except Exception as e:
            self.log("ERROR", f"Find by profile_id failed: {e}")
            return None
    
    def update_record(self, record_id, fields):
        """Update an existing record"""
        url = f"{self.base_url}/{record_id}"
        payload = {"fields": fields, "typecast": True}
        
        try:
            resp = requests.patch(url, headers=self.headers, json=payload)
            if resp.status_code == 200:
                return True
            else:
                self.log("ERROR", f"Update failed: {resp.status_code} - {resp.text}")
                return False
        except Exception as e:
            self.log("ERROR", f"Update error: {e}")
            return False
    
    def create_record(self, fields):
        """Create a new record"""
        payload = {"fields": fields, "typecast": True}
        
        try:
            resp = requests.post(self.base_url, headers=self.headers, json=payload)
            if resp.status_code == 200:
                return resp.json()
            else:
                self.log("ERROR", f"Create failed: {resp.status_code} - {resp.text}")
                return None
        except Exception as e:
            self.log("ERROR", f"Create error: {e}")
            return None
    
    def batch_update(self, updates):
        """Batch update records (max 10 per batch)"""
        batch_size = 10
        success_count = 0
        
        for i in range(0, len(updates), batch_size):
            batch = updates[i:i + batch_size]
            payload = {"records": batch, "typecast": True}
            
            try:
                resp = requests.patch(self.base_url, headers=self.headers, json=payload)
                if resp.status_code == 200:
                    success_count += len(batch)
                else:
                    self.log("ERROR", f"Batch update failed: {resp.status_code}")
                time.sleep(0.2)
            except Exception as e:
                self.log("ERROR", f"Batch error: {e}")
                
        return success_count
    
    # ==================== REGISTRY SYNC ====================
    
    def load_registry(self):
        """Load local account registry"""
        try:
            if os.path.exists(REGISTRY_PATH):
                with open(REGISTRY_PATH, 'r') as f:
                    return json.load(f)
        except Exception as e:
            self.log("ERROR", f"Failed to load registry: {e}")
        return {"profiles": {}}
    
    def load_local_drive_configs(self):
        """
        Load all local drive configs from config/ directory.
        
        Returns:
            dict: {profile_id: {drive_url, profile_name, subfolder}}
        """
        import glob
        configs = {}
        
        # Load drive_url_profile_*.json files
        pattern = os.path.join(CONFIG_DIR, "drive_url_profile_*.json")
        for path in glob.glob(pattern):
            try:
                with open(path, 'r') as f:
                    data = json.load(f)
                    pid = data.get("profile_id")
                    if pid:
                        pid = str(pid)
                        configs[pid] = {
                            "drive_url": data.get("drive_url"),
                            "profile_name": data.get("profile_name"),
                            "content_folder": data.get("content_folder"),  # From Airtable pull
                            "content_subfolder": data.get("content_subfolder")  # From Airtable pull
                        }
            except Exception as e:
                self.log("WARNING", f"Error loading {path}: {e}")
        
        # Load subfolders from module_settings_drive.json
        settings_path = os.path.join(CONFIG_DIR, "module_settings_drive.json")
        if os.path.exists(settings_path):
            try:
                with open(settings_path, 'r') as f:
                    settings = json.load(f)
                    for key, val in settings.items():
                        if key.startswith("selected_folder_"):
                            pid = key.replace("selected_folder_", "")
                            if pid in configs:
                                configs[pid]["content_subfolder"] = val
                            else:
                                configs[pid] = {"content_subfolder": val}
            except Exception as e:
                self.log("WARNING", f"Error loading drive settings: {e}")
        
        return configs
    
    def sync_from_registry(self, device_id=None):
        """
        Sync local registry data to Airtable.
        
        For each profile in registry:
        - Find matching Airtable record by username or profile_id
        - Update Profile ID, Login Email, Phone, Drive Link, Content Subfolder if changed
        
        Args:
            device_id: If provided, set Phone field to this value for all synced profiles
        """
        self.log("INFO", "=" * 60)
        self.log("INFO", "🔄 AIRTABLE SYNC - Starting...")
        self.log("INFO", "=" * 60)
        
        registry = self.load_registry()
        profiles = registry.get("profiles", {})
        
        if not profiles:
            self.log("WARNING", "⚠️ No profiles in registry")
            return
        
        # Load local drive configs
        drive_configs = self.load_local_drive_configs()
        self.log("INFO", f"📁 Loaded {len(drive_configs)} drive configs from local files")
        
        # Fetch all Airtable accounts for matching
        airtable_accounts = self.get_all_accounts()
        
        # Build lookup maps
        by_username = {}
        by_profile_id = {}
        for rec in airtable_accounts:
            fields = rec.get("fields", {})
            if fields.get("Username"):
                by_username[fields["Username"].lower()] = rec
            if fields.get("Profile ID"):
                by_profile_id[str(fields["Profile ID"])] = rec
        
        updates = []
        creates = []
        
        for profile_name, profile_data in profiles.items():
            ig_accounts = profile_data.get("ig_accounts", [])
            gmail_accounts = profile_data.get("gmail_accounts", [])
            user_id = profile_data.get("user_id")
            updated_at = profile_data.get("updated_at", "")
            
            if not ig_accounts:
                self.log("INFO", f"   ⏭️ {profile_name}: No IG accounts, skipping")
                continue
            
            primary_username = ig_accounts[0]
            primary_email = gmail_accounts[0] if gmail_accounts else None
            
            # Get drive config for this profile
            drive_config = drive_configs.get(str(user_id), {}) if user_id else {}
            
            # Find existing record
            record = by_username.get(primary_username.lower())
            if not record and user_id:
                record = by_profile_id.get(str(user_id))
            
            if record:
                # Update existing
                fields_to_update = {}
                current_fields = record.get("fields", {})
                
                # Update Profile ID if missing or different
                if user_id and str(current_fields.get("Profile ID", "")) != str(user_id):
                    fields_to_update["Profile ID"] = str(user_id)
                
                # Update Login Email if missing or different
                if primary_email and current_fields.get("Login Email") != primary_email:
                    fields_to_update["Login Email"] = primary_email
                
                # Update Phone (device ID) if provided and different
                if device_id and current_fields.get("Phone") != device_id:
                    fields_to_update["Phone"] = device_id
                
                # Update Drive Link from local config
                if drive_config.get("drive_url") and current_fields.get("Drive Link") != drive_config["drive_url"]:
                    fields_to_update["Drive Link"] = drive_config["drive_url"]
                
                # Update Content Subfolder from local config (images/reels/trial)
                if drive_config.get("content_subfolder") and current_fields.get("Content Subfolder") != drive_config["content_subfolder"]:
                    fields_to_update["Content Subfolder"] = drive_config["content_subfolder"]
                
                if fields_to_update:
                    updates.append({
                        "id": record["id"],
                        "fields": fields_to_update
                    })
                    self.log("INFO", f"   📝 {primary_username}: Updating {list(fields_to_update.keys())}")
                else:
                    self.log("INFO", f"   ✅ {primary_username}: Already synced")
            else:
                # Create new record
                new_fields = {
                    "Username": primary_username,
                    "Account Platform": "Instagram",
                    "Account Type": "Model",
                    "Status": "Active"
                }
                if user_id:
                    new_fields["Profile ID"] = str(user_id)
                if primary_email:
                    new_fields["Login Email"] = primary_email
                if device_id:
                    new_fields["Phone"] = device_id
                if drive_config.get("drive_url"):
                    new_fields["Drive Link"] = drive_config["drive_url"]
                if drive_config.get("content_subfolder"):
                    new_fields["Content Subfolder"] = drive_config["content_subfolder"]
                    
                creates.append(new_fields)
                self.log("INFO", f"   ➕ {primary_username}: Will create new record")
        
        # Execute updates
        if updates:
            self.log("INFO", f"📤 Updating {len(updates)} records...")
            count = self.batch_update(updates)
            self.log("SUCCESS", f"✅ Updated {count} records")
        
        # Execute creates
        for fields in creates:
            self.log("INFO", f"➕ Creating: {fields.get('Username')}")
            self.create_record(fields)
            time.sleep(0.2)
        
        self.log("SUCCESS", f"✅ Sync complete! Updated: {len(updates)}, Created: {len(creates)}")
        return {"updated": len(updates), "created": len(creates)}
    
    # ==================== PULL FROM AIRTABLE ====================
    
    def pull_from_airtable(self, device_filter=None):
        """
        Pull account configs from Airtable and generate local config files.
        
        Creates/updates:
        - config/drive_url_profile_{id}.json - Drive folder URLs per profile
        - profiles/{username}/config.json - Full account config
        
        Args:
            device_filter: Only pull accounts matching this Phone ID (e.g. "1A121FDF60082H")
        """
        self.log("INFO", "=" * 60)
        self.log("INFO", "📥 PULL FROM AIRTABLE - Generating local configs...")
        self.log("INFO", "=" * 60)
        
        accounts = self.get_all_accounts()
        
        created_configs = 0
        skipped = 0
        
        for rec in accounts:
            fields = rec.get("fields", {})
            username = fields.get("Username")
            profile_id = fields.get("Profile ID")
            phone = fields.get("Phone", "")
            drive_link = fields.get("Drive Link")
            status = fields.get("Status", "")
            
            if not username:
                continue
                
            # Filter by device if specified
            if device_filter and phone != device_filter:
                skipped += 1
                continue
                
            # Skip inactive/suspended accounts
            if status in ["Inactive", "Suspended"]:
                self.log("INFO", f"   ⏭️ {username}: Status is {status}, skipping")
                continue
            
            # Create drive_url_profile_{id}.json if profile_id exists
            if profile_id and drive_link:
                config_path = os.path.join(CONFIG_DIR, f"drive_url_profile_{profile_id}.json")
                config_data = {
                    "profile_id": str(profile_id),
                    "profile_name": username,
                    "drive_url": drive_link,
                    "source": "airtable",
                    "updated_at": datetime.now().isoformat()
                }
                
                # Add optional fields if present
                if fields.get("Content Folder"):
                    config_data["content_folder"] = fields["Content Folder"]
                if fields.get("Content Subfolder"):
                    config_data["content_subfolder"] = fields["Content Subfolder"]
                
                os.makedirs(CONFIG_DIR, exist_ok=True)
                with open(config_path, 'w') as f:
                    json.dump(config_data, f, indent=2)
                    
                self.log("INFO", f"   📁 {username}: Created config/drive_url_profile_{profile_id}.json")
                created_configs += 1
            
            # Create profiles/{username}/config.json with full account data
            profile_dir = os.path.join(PROFILES_DIR, username)
            os.makedirs(profile_dir, exist_ok=True)
            
            full_config = {
                "username": username,
                "profile_id": profile_id,
                "phone": phone,
                "drive_link": drive_link,
                "login_email": fields.get("Login Email"),
                "account_type": fields.get("Account Type"),
                "status": status,
                "story_mention_target": fields.get("Story Mention Target"),
                "story_link_url": fields.get("Story Link URL"),
                "bio": fields.get("Bio"),
                "video_caption": fields.get("Video Caption"),
                "airtable_record_id": rec["id"],
                "updated_at": datetime.now().isoformat()
            }
            
            config_path = os.path.join(profile_dir, "config.json")
            with open(config_path, 'w') as f:
                json.dump(full_config, f, indent=2)
        
        if device_filter:
            self.log("INFO", f"   📱 Filtered by device: {device_filter} (skipped {skipped} accounts)")
            
        self.log("SUCCESS", f"✅ Pull complete! Created {created_configs} drive configs")
        return {"created_configs": created_configs, "skipped": skipped}
    
    def get_account_config(self, username=None, profile_id=None):
        """
        Get account config from Airtable for use in bot.
        
        Args:
            username: IG username to lookup
            profile_id: Profile ID to lookup
            
        Returns:
            dict with account fields or None
        """
        record = None
        if username:
            record = self.find_by_username(username)
        elif profile_id:
            record = self.find_by_profile_id(profile_id)
            
        if not record:
            return None
            
        fields = record.get("fields", {})
        return {
            "username": fields.get("Username"),
            "profile_id": fields.get("Profile ID"),
            "phone": fields.get("Phone"),
            "computer": fields.get("Computer"),
            "login_email": fields.get("Login Email"),
            "account_password": fields.get("Account Password"),
            "recovery_email": fields.get("Recovery Email"),
            "drive_link": fields.get("Drive Link"),
            "content_folder": fields.get("Content Folder"),
            "content_subfolder": fields.get("Content Subfolder"),
            "story_mention_target": fields.get("Story Mention Target"),
            "story_link_url": fields.get("Story Link URL"),
            "bio": fields.get("Bio"),
            "video_caption": fields.get("Video Caption"),
            "status": fields.get("Status"),
            "account_type": fields.get("Account Type"),
            "airtable_record_id": record["id"]
        }
    
    def get_all_profile_configs(self, device_id=None):
        """
        Get all profile configs from Airtable formatted for dashboard use.
        
        Returns ready-to-use dicts:
        - profile_story_links: {profile_id: story_link_url}
        - profile_story_mentions: {profile_id: mention_target}
        - profile_fixed_captions: {profile_id: caption}
        - profile_drive_urls: {profile_id: drive_link}
        
        Args:
            device_id: Filter by Phone field if provided
            
        Returns:
            dict with all config dicts
        """
        self.log("INFO", "📥 Loading all profile configs from Airtable...")
        accounts = self.get_all_accounts()
        
        story_links = {}
        story_mentions = {}
        video_captions = {}
        drive_urls = {}
        post_captions = {}
        content_subfolders = {}
        
        for rec in accounts:
            fields = rec.get("fields", {})
            
            # Filter by device if specified
            if device_id and fields.get("Phone") != device_id:
                continue
                
            profile_id = fields.get("Profile ID")
            if not profile_id:
                continue
                
            pid = str(profile_id)
            
            # Populate all config dicts
            if fields.get("Story Link URL"):
                story_links[pid] = fields["Story Link URL"]
            if fields.get("Story Mention Target"):
                story_mentions[pid] = fields["Story Mention Target"]
            if fields.get("Video Caption"):
                video_captions[pid] = fields["Video Caption"]
            if fields.get("Drive Link"):
                drive_urls[pid] = fields["Drive Link"]
            if fields.get("Post Caption"):
                post_captions[pid] = fields["Post Caption"]
            if fields.get("Content Subfolder"):
                content_subfolders[pid] = fields["Content Subfolder"]
        
        self.log("INFO", f"✅ Loaded configs for {len(story_links)} profiles with story links")
        
        return {
            "profile_story_links": story_links,
            "profile_story_mentions": story_mentions,
            "profile_video_captions": video_captions,
            "profile_drive_urls": drive_urls,
            "profile_post_captions": post_captions,
            "profile_content_subfolders": content_subfolders
        }
    
    def list_accounts_for_device(self, device_id):
        """Get all accounts assigned to a specific phone/device."""
        accounts = self.get_all_accounts()
        result = []
        
        for rec in accounts:
            fields = rec.get("fields", {})
            if fields.get("Phone") == device_id:
                result.append({
                    "username": fields.get("Username"),
                    "profile_id": fields.get("Profile ID"),
                    "status": fields.get("Status"),
                    "account_type": fields.get("Account Type")
                })
        
        return result


# ==================== CLI ====================

if __name__ == "__main__":
    import sys
    
    sync = AirtableSync()
    
    if len(sys.argv) > 1:
        cmd = sys.argv[1]
        if cmd == "list":
            accounts = sync.get_all_accounts()
            for acc in accounts:
                f = acc['fields']
                print(f"  - {f.get('Username', 'N/A')} | Profile: {f.get('Profile ID', 'N/A')} | Phone: {f.get('Phone', 'N/A')}")
        elif cmd == "sync":
            device = sys.argv[2] if len(sys.argv) > 2 else None
            sync.sync_from_registry(device_id=device)
        elif cmd == "pull":
            device = sys.argv[2] if len(sys.argv) > 2 else None
            sync.pull_from_airtable(device_filter=device)
        elif cmd == "device":
            if len(sys.argv) > 2:
                device_id = sys.argv[2]
                accounts = sync.list_accounts_for_device(device_id)
                print(f"📱 Accounts on device {device_id}:")
                for acc in accounts:
                    print(f"   - @{acc['username']} (Profile {acc['profile_id']}) [{acc['status']}]")
            else:
                print("Usage: python airtable_sync.py device <DEVICE_ID>")
        elif cmd == "configs":
            device = sys.argv[2] if len(sys.argv) > 2 else None
            configs = sync.get_all_profile_configs(device_id=device)
            print(f"\n📋 Profile Configs {f'(Device: {device})' if device else '(All)'}:")
            print(f"\n🔗 Story Links ({len(configs['profile_story_links'])}):")
            for pid, link in configs['profile_story_links'].items():
                print(f"   Profile {pid}: {link[:50]}...")
            print(f"\n👤 Story Mentions ({len(configs['profile_story_mentions'])}):")
            for pid, mention in configs['profile_story_mentions'].items():
                print(f"   Profile {pid}: @{mention}")
            print(f"\n📝 Fixed Captions ({len(configs['profile_fixed_captions'])}):")
            for pid, caption in configs['profile_fixed_captions'].items():
                print(f"   Profile {pid}: {caption[:40]}...")
        else:
            print("Usage: python airtable_sync.py [list|sync|pull|device|configs]")
            print("  list              - List all accounts with Phone/Profile IDs")
            print("  sync [DEVICE]     - Push local registry to Airtable (sets Phone if provided)")
            print("  pull [DEVICE]     - Pull Airtable configs to local files")
            print("  device <ID>       - List accounts for specific device/phone")
            print("  configs [DEVICE]  - Show story links, mentions, captions for profiles")
    else:
        # Default: run sync
        sync.sync_from_registry()

