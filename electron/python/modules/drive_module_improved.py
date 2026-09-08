#!/usr/bin/env python3
"""
📁 GOOGLE DRIVE MODULE - IMPROVED WITH UI ANALYSIS & XML PARSING
🎯 Uses UI dumps and screenshots for precise folder detection and navigation

FOLDER DETECTION STRATEGY:
1. Take UI dump to find exact folder positions
2. Use resource-id matching for folders ('Reels', 'Trial', 'Images')
3. Parse bounds to get accurate click coordinates
4. Handle scrolling if folder not found in current view

CONFIRMED WORKING DOWNLOAD METHOD:
1. Long-press file at detected coordinates for 1000ms 
2. Click header "More options" at (1016, 211)
3. Click "Download" at (284, 1917) in popup
4. Wait 10s, then long-press same file again
5. Click "Remove" in header to delete
6. Confirm deletion by clicking "Remove" in popup
"""

import subprocess
import time
import os
import json
import tempfile
import xml.etree.ElementTree as ET
import re

# Import Instagram posting helper
try:
    from post_module import InstagramPoster, MCPPostHelper
    from instagram_launcher_module import InstagramLauncher
except ImportError:
    print("⚠️ Instagram modules not found, drive module will work standalone")
    InstagramPoster = None
    MCPPostHelper = None
    try:
        from modules.instagram_launcher_module import InstagramLauncher
    except ImportError:
        InstagramLauncher = None

# Import Gallery cleaning module
try:
    from gallery_cleaning_module import auto_clean_after_post
except ImportError:
    print("⚠️ Gallery cleaning module not found, skipping gallery cleanup")
    auto_clean_after_post = None

# Import Discord notifier
try:
    from modules.discord_notifier import get_notifier
    DISCORD_AVAILABLE = True
except ImportError:
    try:
        from discord_notifier import get_notifier
        DISCORD_AVAILABLE = True
    except ImportError:
        DISCORD_AVAILABLE = False

class ImprovedDriveManager:
    def __init__(self, account_number=1, device_id="1A121FDF60082H", drive_url=None, username=None):
        self.account_number = account_number
        self.device_id = device_id
        self.username = username  # Instagram username for Supabase lookup
        
        # Initialize all config fields with defaults
        self.drive_base_url = None
        self.content_folder = None
        self.content_subfolder = None  # images/reels/trial
        self.story_link_url = None
        self.story_mention_target = None
        self.account_type = "Model"
        self.source_handle = None
        self.source_platform = None
        self.fixed_caption = None
        
        # Google Drive folder URL - Priority:
        # 1. Explicitly provided drive_url
        # 2. Supabase database (by username or profile_id)
        # 3. Local config file
        # 4. Default/fallback
        
        if drive_url and drive_url.strip():
            self.drive_base_url = drive_url.strip()
            print(f"📁 Using provided drive_url: {self.drive_base_url}")
        else:
            # Try Supabase first (by username or profile_id)
            supabase_loaded = False
            try:
                from lib.supabase_client import get_full_account_config
                account_config = get_full_account_config(username=username, profile_id=account_number)
                if account_config and account_config.get("drive_url"):
                    # Load ALL config fields from Supabase
                    self.drive_base_url = account_config.get("drive_url")
                    self.content_folder = account_config.get("content_folder")
                    self.content_subfolder = account_config.get("content_subfolder")
                    self.story_link_url = account_config.get("story_link_url")
                    self.story_mention_target = account_config.get("story_mention_target")
                    self.account_type = account_config.get("account_type", "Model")
                    self.source_handle = account_config.get("source_handle")
                    self.source_platform = account_config.get("source_platform")
                    self.fixed_caption = account_config.get("fixed_caption")
                    if not self.username:
                        self.username = account_config.get("profile_name")
                    supabase_loaded = True
                    print(f"✅ Loaded ALL config from Supabase: @{self.username}")
                    print(f"   📁 Drive: {self.drive_base_url}")
                    print(f"   📝 Caption: {self.fixed_caption[:30] + '...' if self.fixed_caption else 'None'}")
            except Exception as e:
                print(f"⚠️ Supabase lookup failed: {e}")
            
            # Try local config file if Supabase didn't work
            if not self.drive_base_url:
                try:
                    config_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'config', f'drive_url_profile_{account_number}.json')
                    if os.path.exists(config_path):
                        with open(config_path, 'r') as f:
                            config_data = json.load(f)
                            self.drive_base_url = config_data.get('drive_url', '').strip()
                            if self.drive_base_url:
                                print(f"📁 Loaded from local config: {self.drive_base_url}")
                except Exception as e:
                    print(f"⚠️ Local config load failed: {e}")
            
            # Default fallback
            if not self.drive_base_url:
                self.drive_base_url = "https://drive.google.com/drive/u/0/folders/1fGh79QzudoKVdGAJm5ZjNr5_S4wFXxhw"
                print(f"⚠️ Using DEFAULT drive URL (no config found)")
        
        # Target folders to find
        self.target_folders = ["trial", "images", "reels"]
        
        # Profile folder name mapping for "Used Images" move feature
        # Maps profile_id to the shared folder name in Google Drive
        # UPDATED 2026-01-13: Corrected usernames
        self.profile_folder_map = {
            "10": "itsjocelynchenz",   # Profile 10
            "13": "alitealivia",       # Profile 13
            "14": "klarkaaxo",         # Profile 14 - Klarka
            "15": "bbyjocelynxo",      # Profile 15
            "16": "anniixluv",         # Profile 16 - Anni
            "19": "onlylulubaby",      # Profile 19 - Lulu
            "20": "jiaxzee",           # Profile 20 - Jia
            "21": "aixiash",           # Profile 21 - AiXi
            "22": "danniibelle_",      # Profile 22 - Danni
            "23": "ralistaxo",         # Profile 23 - Ralista
            "24": "realjocelynxo",     # Profile 24
            "25": "jocelynxofans",     # Profile 25
            "26": "jocelynchenxo",     # Profile 26
            "31": "telari.lovee",      # Profile 31 - Telari
        }
        # Use mapped folder or dynamically lookup from config
        self._current_profile_folder = self.profile_folder_map.get(str(account_number), None)
        if not self._current_profile_folder and username:
            self._current_profile_folder = username  # Use username if no profile_id mapping
        if not self._current_profile_folder:
            # Try to get from drive_url_profile config
            try:
                import os
                config_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'config', f'drive_url_profile_{account_number}.json')
                if os.path.exists(config_path):
                    with open(config_path, 'r') as f:
                        config_data = json.load(f)
                        self._current_profile_folder = config_data.get('profile_name', '').lower()
            except:
                pass
        if not self._current_profile_folder:
            # Try Supabase lookup by profile_id (for new accounts not in hardcoded map)
            try:
                from lib.supabase_client import get_username_by_profile_id
                supabase_username = get_username_by_profile_id(account_number)
                if supabase_username:
                    self._current_profile_folder = supabase_username
                    print(f"✅ Found username from Supabase: {supabase_username}")
            except Exception as e:
                print(f"⚠️ Supabase profile_id lookup failed: {e}")
        if not self._current_profile_folder:
            self._current_profile_folder = f"profile_{account_number}"  # Generic fallback
        print(f"📦 DRIVE INIT: account_number={account_number} → folder='{self._current_profile_folder}'")
        
        # Initialize Instagram poster if available
        if InstagramPoster and MCPPostHelper:
            self.ig_poster = InstagramPoster(device_id=device_id, account_number=account_number)
            self.mcp_helper = MCPPostHelper(device_id=device_id)
            
            # Initialize Instagram launcher for the poster
            try:
                from instagram_launcher_module import InstagramLauncher
                self.ig_poster.launcher_controller = InstagramLauncher(device_id)
                print("✅ Instagram launcher initialized for Google Drive posting")
            except ImportError:
                print("⚠️ Instagram launcher not available")
        else:
            self.ig_poster = None
            self.mcp_helper = None
        
        print(f"📱 Improved Drive Module initialized for Account {account_number}")
        print(f"🔗 Drive URL: {self.drive_base_url}")
        print(f"📁 Profile folder for move: {self._current_profile_folder}")
        
    def adb(self, *args):
        """Execute ADB command with device ID"""
        return subprocess.run(["adb", "-s", self.device_id] + list(args), capture_output=True, text=True)
    
    def tap_screen_to_keep_awake(self):
        """Tap screen to keep it awake"""
        self.adb("shell", "input", "tap", "540", "960")
    
    def take_screenshot(self, filename):
        """Take screenshot and save to temp directory"""
        # Use system temp directory
        filepath = os.path.join(tempfile.gettempdir(), filename)
        
        result = self.adb("shell", "screencap", "-p", f"/sdcard/{filename}")
        if result.returncode == 0:
            self.adb("pull", f"/sdcard/{filename}", filepath)
            print(f"📸 Screenshot saved: {filepath}")
            
            # Cleanup device file
            try:
                self.adb("shell", "rm", f"/sdcard/{filename}")
            except:
                pass
                
        return filepath
    
    def get_ui_dump(self, filename="current_ui.xml", max_retries=3):
        """Get UI hierarchy dump - auto-cleans up after parsing
        
        Added retry logic with delays to handle flaky uiautomator
        """
        # Use system temp directory
        filepath = os.path.join(tempfile.gettempdir(), filename)
        
        for attempt in range(max_retries):
            # Get UI dump
            dump_result = self.adb("shell", "uiautomator", "dump", "/sdcard/window_dump.xml")
            if dump_result.returncode == 0:
                # Brief pause before pulling (helps with flakiness)
                time.sleep(0.5)
                
                # Pull the file
                pull_result = self.adb("pull", "/sdcard/window_dump.xml", filepath)
                if pull_result.returncode == 0:
                    # Parse and return the XML
                    try:
                        with open(filepath, 'r', encoding='utf-8') as f:
                            xml_content = f.read()
                        xml_root = ET.fromstring(xml_content)
                        
                        # CLEANUP: Delete local and device files
                        try:
                            os.remove(filepath)
                            self.adb("shell", "rm", "/sdcard/window_dump.xml")
                        except:
                            pass  # Ignore cleanup errors
                        
                        return xml_root
                    except Exception as e:
                        print(f"❌ Error parsing XML (attempt {attempt + 1}): {e}")
            
            # Wait before retry
            if attempt < max_retries - 1:
                print(f"🔄 UI dump failed, retrying in 1.5s... (attempt {attempt + 1}/{max_retries})")
                time.sleep(1.5)
        
        print(f"❌ Failed to get UI dump after {max_retries} attempts")
        return None
    
    def parse_bounds(self, bounds_str):
        """Parse bounds string like '[21,464][1059,611]' to get center coordinates"""
        try:
            # Extract numbers using regex
            numbers = re.findall(r'\d+', bounds_str)
            if len(numbers) >= 4:
                x1, y1, x2, y2 = map(int, numbers[:4])
                center_x = (x1 + x2) // 2
                center_y = (y1 + y2) // 2
                return center_x, center_y, (x1, y1, x2, y2)
            else:
                print(f"❌ Invalid bounds format: {bounds_str}")
                return None, None, None
        except Exception as e:
            print(f"❌ Error parsing bounds {bounds_str}: {e}")
            return None, None, None
    
    def get_first_filename(self):
        """Get the filename of the first file in the current Drive folder"""
        try:
            ui_root = self.get_ui_dump("first_file_check.xml")
            if ui_root:
                # Look for resource-id that looks like a filename (ends with .jpg, .png, .mp4, etc)
                for node in ui_root.iter("node"):
                    resource_id = node.attrib.get("resource-id", "")
                    # Check if it's a file (has extension)
                    if re.match(r'.*\.(jpg|png|mp4|mov|jpeg|gif|webp|heic)$', resource_id, re.IGNORECASE):
                        return resource_id
            return None
        except Exception as e:
            print(f"⚠️ Error getting filename: {e}")
            return None
    
    def is_file_still_present(self, filename):
        """Check if a specific filename is still the first file (i.e. not deleted)"""
        current_first = self.get_first_filename()
        if current_first and current_first == filename:
            return True
        return False
    
    def find_and_click_by_text(self, target_text, exact=False):
        """Find and click an element by its text or content-desc"""
        ui_root = self.get_ui_dump("find_by_text.xml")
        if not ui_root:
            return False
        
        target_lower = target_text.lower()
        for node in ui_root.iter("node"):
            text = node.attrib.get("text", "")
            content_desc = node.attrib.get("content-desc", "")
            
            # Check for match
            match = False
            if exact:
                match = text == target_text or content_desc == target_text
            else:
                match = target_lower in text.lower() or target_lower in content_desc.lower()
            
            if match:
                bounds = node.attrib.get("bounds", "")
                if bounds:
                    x, y, _ = self.parse_bounds(bounds)
                    if x and y:
                        print(f"✅ Found '{target_text}' at ({x}, {y})")
                        self.adb("shell", "input", "tap", str(x), str(y))
                        return True
        
        print(f"❌ Could not find '{target_text}'")
        return False
    
    def move_file_to_used(self, profile_folder_name, source_folder="images"):
        """Move selected file to 'Used Images' or 'Used Reels' folder based on source
        
        Args:
            profile_folder_name: The profile's Drive folder name OR 'Project Mass' for clones
            source_folder: 'images' or 'reels' - determines destination folder
        
        NOTE: After clicking Move, Drive opens a DESTINATION PICKER that starts at 'My Drive'.
        
        NAVIGATION PATHS:
        - REGULAR PROFILES: Shared with me → profile folder (e.g., jocelynchenxo) → Instagram → Used Images/Reels
        - CLONE/STACKED (Project Mass): Shared with me → Project Mass → Used Images/Reels
        
        UPDATED 2026-01-19: Fixed to properly detect and route regular vs clone profiles!
        """
        # Detect if this is a Project Mass clone or a regular profile
        # Check BOTH the folder name AND the _is_stacked_profile flag (passed from dashboard)
        is_project_mass = (
            profile_folder_name.lower() in ["project mass", "project_mass", "projectmass", "clone", "stacked"] or
            getattr(self, '_is_stacked_profile', False)
        )
        
        # Determine destination folder
        # PROJECT MASS / STACKED always uses "Used Reels" (since they always post reels)
        if is_project_mass:
            dest_folder = "Used Reels"
        # Otherwise use source folder to decide
        elif source_folder.lower() == "reels":
            dest_folder = "Used Reels"
        else:
            dest_folder = "Used Images"
        
        print(f"📦 Moving file to '{dest_folder}' folder for {profile_folder_name}...")
        print(f"   → Profile type: {'PROJECT MASS (clone/stacked)' if is_project_mass else 'REGULAR (model)'}")
        
        try:
            # STEP 1: Click Move button in header (find by content-desc dynamically)
            print("🎯 STEP 1: Clicking Move button in header...")
            if not self.find_and_click_by_text("Move", exact=True):
                print("❌ Could not find Move button in header")
                return False
            time.sleep(3)
            
            # STEP 2: Click "Shared with me" tab FIRST (picker starts at My Drive)
            print("🎯 STEP 2: Clicking 'Shared with me'...")
            if not self.find_and_click_by_text("Shared with me"):
                if not self.find_and_click_by_text("Shared"):
                    print("❌ Could not find 'Shared with me' tab")
                    return False
            time.sleep(3)
            
            # STEP 3: Navigate based on profile type
            if is_project_mass:
                # CLONE/STACKED PATH: Project Mass → Used Images/Reels
                print("🎯 STEP 3: Clicking 'Project Mass' folder (CLONE path)...")
                if not self.find_and_click_by_text("Project Mass"):
                    print("⚠️ 'Project Mass' not found, scrolling and retrying...")
                    self.adb("shell", "input", "swipe", "540", "1200", "540", "600", "500")
                    time.sleep(2)
                    if not self.find_and_click_by_text("Project Mass"):
                        print("❌ Could not find 'Project Mass' folder")
                        return False
                time.sleep(3)
                
                # Scroll down to reveal Used folders
                print("🎯 STEP 4: Scrolling down to find destination folder...")
                self.adb("shell", "input", "swipe", "540", "1400", "540", "600", "500")
                time.sleep(2)
            else:
                # REGULAR PROFILE PATH: 
                # First try "Instagram" folder (some accounts have it at top level)
                # If not found, try profile folder name
                print("🎯 STEP 3: Looking for 'Instagram' folder first (REGULAR path)...")
                
                found_folder = False
                
                # Try Instagram folder first
                if self.find_and_click_by_text("Instagram"):
                    print("✅ Found 'Instagram' folder at top level!")
                    found_folder = True
                else:
                    # Not found, try profile folder name
                    print(f"⚠️ 'Instagram' not found, trying '{profile_folder_name}'...")
                    if self.find_and_click_by_text(profile_folder_name):
                        print(f"✅ Found '{profile_folder_name}' folder!")
                        found_folder = True
                    else:
                        # Still not found, scroll and retry both
                        print("⚠️ Scrolling to search for folder...")
                        self.adb("shell", "input", "swipe", "540", "1200", "540", "600", "500")
                        time.sleep(2)
                        
                        # Try Instagram again
                        if self.find_and_click_by_text("Instagram"):
                            print("✅ Found 'Instagram' folder after scroll!")
                            found_folder = True
                        elif self.find_and_click_by_text(profile_folder_name):
                            print(f"✅ Found '{profile_folder_name}' folder after scroll!")
                            found_folder = True
                
                if not found_folder:
                    print(f"❌ Could not find 'Instagram' or '{profile_folder_name}' folder")
                    return False
                    
                time.sleep(3)
                
                # Scroll down to reveal Used folders (may be below the fold)
                print("🎯 STEP 4: Scrolling down to find destination folder...")
                self.adb("shell", "input", "swipe", "540", "1400", "540", "600", "500")
                time.sleep(2)
            
            # STEP 5: Click destination folder (Used Images OR Used Reels)
            print(f"🎯 STEP 5: Clicking '{dest_folder}' folder...")
            if not self.find_and_click_by_text(dest_folder):
                # Try scrolling to find it
                print(f"⚠️ Could not find '{dest_folder}', scrolling...")
                self.adb("shell", "input", "swipe", "540", "1400", "540", "600", "500")
                time.sleep(2)
                if not self.find_and_click_by_text(dest_folder):
                    # Try fallback to just "Used" if exact not found
                    print(f"⚠️ Still not found, trying fallback to 'Used'...")
                    if not self.find_and_click_by_text("Used"):
                        print(f"❌ Could not find '{dest_folder}' folder")
                        return False
            time.sleep(2)

            
            # STEP 6: Click Move button to confirm (at bottom)
            print("🎯 STEP 6: Clicking 'Move' button to confirm...")
            if not self.find_and_click_by_text("Move", exact=True):
                print("❌ Could not find Move confirmation button")
                return False
            time.sleep(3)
            
            # STEP 7: Handle "Change who has access?" popup if it appears
            print("🎯 STEP 7: Checking for access change popup...")
            if self.find_and_click_by_text("Move", exact=True):
                print("✅ Confirmed access change Move!")
            time.sleep(2)
            
            print(f"✅ File moved to '{dest_folder}' successfully!")
            return True
            
        except Exception as e:
            print(f"❌ Move failed: {e}")
            return False
    
    def find_folder_coordinates(self, folder_name, ui_root):
        """Find folder coordinates using UI dump analysis"""
        if not ui_root:
            return None, None
        
        folder_name_lower = folder_name.lower()
        print(f"🔍 Searching for '{folder_name_lower}' folder in UI dump...")
        
        # Look for nodes with resource-id matching folder name (main clickable element)
        for node in ui_root.iter("node"):
            resource_id = node.attrib.get("resource-id", "").lower()
            clickable = node.attrib.get("clickable", "false")
            
            # Check if this is the main folder node (resource-id matches and it's clickable)
            if (folder_name_lower == resource_id and clickable == "true"):
                bounds = node.attrib.get("bounds")
                if bounds:
                    x, y, bounds_rect = self.parse_bounds(bounds)
                    if x and y:
                        print(f"✅ Found '{folder_name}' folder at ({x}, {y}) (bounds: {bounds})")
                        return x, y
        
        # Fallback: Look for nodes with text or content-desc containing folder name
        # but prioritize larger clickable elements (avoid small text/icon elements)
        best_match = None
        best_area = 0
        
        for node in ui_root.iter("node"):
            text = node.attrib.get("text", "").lower()
            content_desc = node.attrib.get("content-desc", "").lower()
            clickable = node.attrib.get("clickable", "false")
            
            # Check if this node represents our target folder
            if (folder_name_lower in text or folder_name_lower in content_desc) and clickable == "true":
                bounds = node.attrib.get("bounds")
                if bounds:
                    x, y, bounds_rect = self.parse_bounds(bounds)
                    if x and y and bounds_rect:
                        # Calculate area to prefer larger elements
                        x1, y1, x2, y2 = bounds_rect
                        area = (x2 - x1) * (y2 - y1)
                        if area > best_area:
                            best_match = (x, y, bounds)
                            best_area = area
        
        if best_match:
            x, y, bounds = best_match
            print(f"✅ Found '{folder_name}' folder at ({x}, {y}) (bounds: {bounds}) - area: {best_area}")
            return x, y
        
        print(f"❌ '{folder_name}' folder not found in current view")
        return None, None
    
    def scroll_to_find_folder(self, folder_name):
        """Scroll down to find folder if not visible"""
        max_scrolls = 3
        
        for scroll_attempt in range(max_scrolls):
            print(f"🔄 Scroll attempt {scroll_attempt + 1}/{max_scrolls}")
            
            # Get UI dump
            ui_root = self.get_ui_dump(f"scroll_attempt_{scroll_attempt}.xml")
            
            # Try to find folder
            x, y = self.find_folder_coordinates(folder_name, ui_root)
            if x and y:
                return x, y
            
            # Scroll down if not found
            if scroll_attempt < max_scrolls - 1:
                print("⬇️ Scrolling down...")
                self.adb("shell", "input", "swipe", "540", "1200", "540", "600", "500")
                time.sleep(2)
        
        print(f"❌ Could not find '{folder_name}' folder after {max_scrolls} scroll attempts")
        return None, None
    
    def open_drive_in_browser(self):
        """Open Google Drive in browser and wait for it to load"""
        # Activate screen
        print("📱 Activating screen...")
        self.adb("shell", "input", "tap", "360", "500")
        time.sleep(1)
        self.adb("shell", "input", "swipe", "360", "1500", "360", "500", "500")
        time.sleep(2)
        
        # Open URL via intent
        print("🔗 Opening Drive URL via intent...")
        result = self.adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", self.drive_base_url)
        
        if result.returncode != 0:
            print(f"❌ Failed to open Drive: {result.stderr}")
            return False
        
        # Wait for page to load - INCREASED for reliability
        print("⏳ Waiting for Drive to load (10s)...")
        time.sleep(10)
        
        # Take screenshot to verify
        self.take_screenshot("drive_opened.png")
        print("✅ Drive opened successfully")
        return True
    
    def navigate_to_subfolder(self, folder_name):
        """Navigate to a specific subfolder - ALWAYS use UI analysis by folder name (order changes!)"""
        print(f"📂 Navigating to '{folder_name}' folder...")
        
        # Track which folder we're in for correct Used folder destination
        self._current_source_folder = folder_name.lower()  # 'images', 'reels', or 'trial'
        
        # ALWAYS use UI analysis - folder order can change so coordinates are unreliable!
        print(f"🔍 Finding '{folder_name}' folder by name in UI...")
        ui_root = self.get_ui_dump(f"find_{folder_name}.xml")
        
        if ui_root:
            x, y = self.find_folder_coordinates(folder_name, ui_root)
            if x and y:
                print(f"🎯 Found '{folder_name}' via UI analysis at ({x}, {y})")
                result = self.adb("shell", "input", "tap", str(x), str(y))
                
                if result.returncode == 0:
                    time.sleep(6)  # Wait for folder to open - INCREASED
                    print(f"✅ Successfully opened '{folder_name}' folder!")
                    return True
                else:
                    print(f"❌ Click failed for '{folder_name}'")
        
        print(f"❌ Could not find '{folder_name}' folder in UI")
        return False

    
    def find_first_media_file(self):
        """Find the first media file in the current folder"""
        print("🔍 Finding first media file in folder...")
        
        ui_root = self.get_ui_dump("folder_contents.xml")
        if not ui_root:
            print("❌ Could not get UI dump")
            return None, None
        
        # Look for video files (mp4, mov, etc.) or any file with media indicators
        # Prioritize actual file names over generic terms
        media_patterns = [".mp4", ".mov", ".avi", ".mkv", "Professional_Mode"]
        
        best_match = None
        best_y_position = 9999  # Start with high value, we want the topmost file
        
        for node in ui_root.iter("node"):
            text = node.attrib.get("text", "")
            content_desc = node.attrib.get("content-desc", "")
            clickable = node.attrib.get("clickable", "false")
            
            # Skip if not clickable or if it's header text (avoid clicking on "Reels" header)
            if clickable != "true":
                continue
                
            # Skip header elements by checking if y-coordinate is too high (in header area)
            bounds = node.attrib.get("bounds")
            if bounds:
                x, y, bounds_rect = self.parse_bounds(bounds)
                if y and y < 300:  # Header area, skip this
                    continue
            
            # Check if this looks like a media file (prioritize Professional_Mode files)
            for pattern in media_patterns:
                if pattern in text or pattern in content_desc:
                    if bounds and x and y:
                        # Find the topmost file (smallest y-coordinate in the file list)
                        if y < best_y_position and y > 300:  # Below header but topmost in list
                            best_match = (x, y, text or content_desc)
                            best_y_position = y
                            break
        
        if best_match:
            x, y, filename = best_match
            print(f"✅ Found media file: {filename} at ({x}, {y})")
            return x, y
        
        print("⚠️ No video files found in UI analysis, using CONFIRMED working coordinates")
        return 540, 538  # Confirmed working coordinates
    
    def ensure_folder_list_view(self):
        """Ensure we're in folder list view, not viewing individual file"""
        print("🔍 Checking if we're in correct folder list view...")
        
        ui_root = self.get_ui_dump("check_view_state.xml")
        if not ui_root:
            return False
        
        # Check if we're viewing a single video file
        for node in ui_root.iter("node"):
            content_desc = node.attrib.get("content-desc", "")
            text = node.attrib.get("text", "")
            
            # Indicators that we're viewing a single file instead of folder list
            single_file_indicators = [
                "File type Video",
                "Play video", 
                "video player",
                "pause",
                "play button"
            ]
            
            for indicator in single_file_indicators:
                if indicator.lower() in content_desc.lower() or indicator.lower() in text.lower():
                    print("⚠️ Currently viewing single video - going back to folder list")
                    self.adb("shell", "input", "keyevent", "4")  # Back button
                    time.sleep(3)
                    return True
        
        print("✅ Already in folder list view")
        return True
    
    def download_first_file(self, folder_context=None):
        """Download the first file using PROVEN coordinates (optimized)"""
        print("📥 Starting file download with proven coordinates...")
        
        # NOTE: Do NOT restart Drive here - we're already navigated to the correct folder!
        # Restarting would kick us out of the folder we just navigated to.
        
        # STEP 0B: Capture first filename BEFORE any operations
        first_filename = self.get_first_filename()
        if first_filename:
            print(f"📋 Target file to download: {first_filename}")
        else:
            print("⚠️ Could not detect filename, proceeding anyway...")
        
        print("🎯 STEP 1: Long-pressing first file at proven coordinates...")
        
        # Use proven coordinates for first file (confirmed working)
        select_x, select_y = 540, 538
        
        # CRITICAL: Use swipe with same coordinates to create LONG-PRESS, not tap!
        print(f"🎯 LONG-PRESSING file at proven coordinates ({select_x}, {select_y}) for 1000ms")
        result = self.adb("shell", "input", "swipe", str(select_x), str(select_y), str(select_x), str(select_y), "1000")
        
        if result.returncode != 0:
            print(f"❌ Failed to long-press file: {result.stderr}")
            return False, None
        
        time.sleep(4)  # Wait for selection UI to appear - INCREASED
        print("✅ File selected successfully")
        
        print("🎯 STEP 2: Finding and clicking 'More options' using UI analysis...")
        
        # Use UI analysis to find More options button (3-dot menu on RIGHT side)
        more_options_clicked = False
        ui_root = self.get_ui_dump("selection_header.xml")
        
        if ui_root:
            # Look for More actions/options button by content-desc - MUST be on RIGHT side of screen
            for node in ui_root.iter("node"):
                content_desc = node.attrib.get("content-desc", "")
                clickable = node.attrib.get("clickable", "false")
                
                # Match "More actions" or "More options" - Drive uses "More actions" after file selection!
                if "More actions" in content_desc or "More options" in content_desc:
                    bounds = node.attrib.get("bounds")
                    if bounds:
                        x, y, bounds_rect = self.parse_bounds(bounds)
                        # CRITICAL: Only click if on RIGHT side (x > 900) to avoid hamburger menu
                        if x and y and x > 900:
                            print(f"✅ Found '{content_desc}' (3-dot) via UI at ({x}, {y})")
                            result = self.adb("shell", "input", "tap", str(x), str(y))
                            if result.returncode == 0:
                                more_options_clicked = True
                                print("✅ More actions menu clicked via UI analysis!")
                                break
                        elif x and y:
                            print(f"⚠️ Skipping '{content_desc}' at ({x}, {y}) - too far LEFT (hamburger menu?)")
        
        # Fallback to known coordinates
        if not more_options_clicked:
            print("⚠️ UI analysis failed, trying known More options positions...")
            positions = [(1016, 211), (1000, 200), (990, 220)]
            for hx, hy in positions:
                print(f"  📋 Trying More options at ({hx}, {hy})")
                result = self.adb("shell", "input", "tap", str(hx), str(hy))
                time.sleep(2)
                
                # Take screenshot to verify popup opened
                ui_check = self.get_ui_dump("check_popup.xml")
                if ui_check:
                    for node in ui_check.iter("node"):
                        if "Download" in node.attrib.get("text", ""):
                            more_options_clicked = True
                            print(f"✅ More options opened popup at ({hx}, {hy})")
                            break
                
                if more_options_clicked:
                    break
        
        if not more_options_clicked:
            print("❌ Failed to click More options")
            return False, None
        
        time.sleep(3)  # Wait for popup menu - INCREASED
        self.take_screenshot("popup_menu_opened.png")
        print("✅ Popup menu opened")
        
        print("🎯 STEP 3: Finding and clicking Download in popup using UI analysis...")
        
        # SCROLL DOWN in popup to reveal Download option (it's below the fold)
        print("📜 Scrolling DOWN in popup to reveal more options...")
        self.adb("shell", "input", "swipe", "540", "1800", "540", "1400", "500")
        time.sleep(1.5)
        
        # Use UI analysis to find Download button
        download_clicked = False
        ui_root = self.get_ui_dump("popup_menu_download.xml")
        
        if ui_root:
            # Look for EXACT "Download" option - NOT "Make available offline"!
            print("🔍 Searching popup menu for exact 'Download' text...")
            for node in ui_root.iter("node"):
                text = node.attrib.get("text", "").strip()
                content_desc = node.attrib.get("content-desc", "").strip()
                bounds = node.attrib.get("bounds", "")
                
                # Debug: Print all menu items
                if text and bounds:
                    print(f"   📋 Menu item: '{text}' at {bounds}")
                
                # Must be EXACT "Download" - not "Make available offline" or other
                if text == "Download" or content_desc == "Download":
                    if bounds:
                        x, y, bounds_rect = self.parse_bounds(bounds)
                        if x and y:
                            print(f"✅ Found EXACT 'Download' button at ({x}, {y})")
                            result = self.adb("shell", "input", "tap", str(x), str(y))
                            if result.returncode == 0:
                                download_clicked = True
                                print("✅ Download clicked via UI analysis!")
                                break
        
        # Fallback to hardcoded coordinates if UI analysis fails
        if not download_clicked:
            print("⚠️ UI analysis failed, trying known Download positions...")
            # Try multiple known positions for Download button (verified from UI dumps)
            download_positions = [
                (263, 1563),  # VERIFIED position from Dec 26 testing
                (284, 1917),  # Original confirmed
                (540, 1500),  # Center lower popup
            ]
            
            for dx, dy in download_positions:
                print(f"  📥 Trying Download at ({dx}, {dy})")
                result = self.adb("shell", "input", "tap", str(dx), str(dy))
                time.sleep(1)
                
                # Check if we're still on popup or if tap worked
                check_ui = self.get_ui_dump("check_download_click.xml")
                if check_ui:
                    # If popup closed (no more "Download" text visible), we clicked it
                    still_has_download = False
                    for node in check_ui.iter("node"):
                        if "Download" in node.attrib.get("text", ""):
                            still_has_download = True
                            break
                    
                    if not still_has_download:
                        print(f"✅ Download clicked at ({dx}, {dy})")
                        download_clicked = True
                        break
        
        if not download_clicked:
            print("❌ Failed to click Download button")
            return False, None
        
        time.sleep(2)
        print("✅ Download initiated successfully!")
        
        # Wait for download to complete - INCREASED for reliability
        print("⏳ Waiting for download to complete (15s)...")
        time.sleep(15)
        
        # Try to dismiss any download notification
        self.dismiss_download_notification()
        
        # STEP 4: MOVE file to "Used Images" instead of deleting
        # This is more reliable than deletion which was having issues
        print("🎯 STEP 4: Moving file to appropriate 'Used' folder...")
        time.sleep(2)  # Extra delay before move step
        
        # Long-press the same file again for selection
        print(f"🎯 LONG-PRESSING same file at ({select_x}, {select_y}) for move")
        result = self.adb("shell", "input", "swipe", str(select_x), str(select_y), str(select_x), str(select_y), "1000")
        
        if result.returncode != 0:
            print(f"❌ Failed to long-press file for move: {result.stderr}")
            return False, None
        
        time.sleep(4)  # Wait for selection UI to appear
        print("✅ File selected for move")
        
        # Use move_file_to_used to move file to Used Images or Used Reels folder
        # Determine profile folder name and source folder from context
        profile_folder_name = getattr(self, '_current_profile_folder', 'jocelynbunz')
        source_folder = getattr(self, '_current_source_folder', 'images')  # Track which folder we're downloading from
        print(f"📦 DEBUG: account={self.account_number}, profile='{profile_folder_name}', source='{source_folder}'")
        
        if self.move_file_to_used(profile_folder_name, source_folder):
            dest_name = "Used Reels" if source_folder.lower() == "reels" else "Used Images"
            print(f"✅ File moved to '{dest_name}' successfully!")
        else:
            print("⚠️ Move may have failed, but download was successful")

        
        # Verify file was moved
        time.sleep(2)
        if first_filename and self.is_file_still_present(first_filename):
            print(f"⚠️ File {first_filename} still present, move may have failed")
        else:
            print("✅ File move verified - file is no longer first in list!")
        
        print("✅ Download and move process completed!")
        
        # Discord notification for successful download
        if DISCORD_AVAILABLE:
            get_notifier().drive_file_downloaded(first_filename if first_filename else "file", "Downloads")
        
        return True, "downloaded_file"  # Generic filename
    
# OLD DELETE BUTTON FUNCTION REMOVED - Now using 3 dots → popup → Remove workflow instead

    def find_remove_confirmation_button(self, folder_context=None):
        """Find remove confirmation button using UI analysis + fallback positions"""
        print("🔍 Finding remove confirmation button using UI analysis...")
        
        # First try to find it using UI analysis
        ui_root = self.get_ui_dump("remove_confirmation_search.xml")
        if ui_root:
            # Look for Remove confirmation button
            remove_indicators = ["Remove", "remove", "Delete", "delete", "Confirm", "Yes", "OK"]
            
            for node in ui_root.iter("node"):
                text = node.attrib.get("text", "")
                content_desc = node.attrib.get("content-desc", "")
                clickable = node.attrib.get("clickable", "false")
                
                # Check if this looks like a remove/confirm button
                for indicator in remove_indicators:
                    if (indicator in text or indicator in content_desc) and clickable == "true":
                        bounds = node.attrib.get("bounds")
                        if bounds:
                            x, y, bounds_rect = self.parse_bounds(bounds)
                            if x and y:
                                # Make sure it's in popup area (center-ish of screen)
                                if 200 < x < 880 and 800 < y < 1800:  # Popup area
                                    print(f"✅ Found remove confirmation via UI analysis: '{text or content_desc}' at ({x}, {y})")
                                    return x, y
        
        # If UI analysis fails, return the CONTEXT-AWARE coordinates
        print("⚠️ UI analysis failed, using context-aware fallback coordinates...")
        
        # Context-aware coordinates - Images need 100px lower than reels/trial
        if folder_context and folder_context.lower() == "images":
            proven_remove_x, proven_remove_y = 877, 2106  # 100px lower for images
            print(f"✅ Using IMAGES fallback coordinates: ({proven_remove_x}, {proven_remove_y}) - 100px lower")
        else:
            proven_remove_x, proven_remove_y = 877, 2006  # Standard for reels/trial
            print(f"✅ Using REELS/TRIAL fallback coordinates: ({proven_remove_x}, {proven_remove_y}) - standard position")
        return proven_remove_x, proven_remove_y

    def find_and_click_remove_by_text(self):
        """Find and click 'Remove' button by text in the final confirmation popup"""
        print("🔍 Searching for 'Remove' button by text in final popup...")
        
        try:
            # Get UI dump to find Remove button by text
            ui_root = self.get_ui_dump("final_remove_confirmation.xml")
            if not ui_root:
                print("❌ Could not get UI dump")
                return False
            
            # Look for Remove button by text
            remove_texts = ["Remove", "remove", "REMOVE", "Delete", "delete", "DELETE"]
            
            for node in ui_root.iter("node"):
                text = node.attrib.get("text", "")
                content_desc = node.attrib.get("content-desc", "")
                clickable = node.attrib.get("clickable", "false")
                
                # Check if this is a Remove button
                if clickable == "true" and (text in remove_texts or content_desc in remove_texts):
                    bounds = node.attrib.get("bounds", "")
                    if bounds:
                        x, y, bounds_rect = self.parse_bounds(bounds)
                        if x and y:
                            print(f"✅ Found 'Remove' button by text: '{text or content_desc}' at ({x}, {y})")
                            # Click the Remove button
                            result = self.adb("shell", "input", "tap", str(x), str(y))
                            if result.returncode == 0:
                                print("✅ Successfully clicked 'Remove' button by text!")
                                time.sleep(2)
                                return True
                            else:
                                print(f"❌ Failed to click Remove button: {result.stderr}")
            
            print("❌ Could not find 'Remove' button by text")
            
            # FALLBACK: Use verified coordinate for Remove confirmation
            # VERIFIED FROM XML: bounds="[756,1320][978,1446]" → center (867, 1383)
            print("🔄 Fallback: Tapping Remove confirmation at (867, 1383)...")
            result = self.adb("shell", "input", "tap", "867", "1383")
            if result.returncode == 0:
                print("✅ Remove confirmation tapped via fallback!")
                time.sleep(2)
                return True
            
            return False
        except Exception as e:
            print(f"❌ Error finding Remove button by text: {e}")
            return False

    def dismiss_download_notification(self):
        """Try to dismiss download completion notification"""
        print("🔄 Dismissing download notification...")
        
        ui_root = self.get_ui_dump("notification_ui.xml")
        if not ui_root:
            return
        
        # Look for download notification
        found = False
        for node in ui_root.iter("node"):
            text = node.attrib.get("text", "").lower()
            content_desc = node.attrib.get("content-desc", "").lower()
            
            # Look for download-related notifications
            if any(keyword in text or keyword in content_desc for keyword in ["download", "complete", "file"]):
                bounds = node.attrib.get("bounds")
                if bounds:
                    x1, y1, x2, y2 = map(int, bounds.replace("[", "").replace("]", ",").split(",")[:4])
                    x = (x1 + x2) // 2
                    y_start = (y1 + y2) // 2
                    y_end = max(0, y_start - 400)  # swipe up by 400px
                    
                    self.adb("shell", "input", "swipe", str(x), str(y_start), str(x), str(y_end), "300")
                    found = True
                    print("✅ Dismissed notification via swipe")
                    break
        
        if not found:
            print("⚠️ No download notification found to dismiss")
    
    def post_from_drive(self, folder_name):
        """Complete workflow: navigate to folder, download file, post to Instagram"""
        print(f"🚀 Starting improved workflow for '{folder_name}' folder...")
        
        # Step 1: Open Drive
        print("🌐 Opening Drive via intent...")
        if not self.open_drive_in_browser():
            print("❌ Failed to open Drive")
            return False
        
        # Step 2: Navigate to subfolder
        if not self.navigate_to_subfolder(folder_name):
            print(f"❌ Failed to navigate to '{folder_name}' folder")
            return False
        
        # Step 3: Download first file with folder context
        success, filename = self.download_first_file(folder_context=folder_name)
        if not success:
            print("❌ Failed to download file")
            return False
        
        print(f"✅ File downloaded: {filename}")
        
        # Step 4: Post to Instagram using appropriate workflow based on content type
        if self.ig_poster:
            print("📱 Posting to Instagram...")
            try:
                # Different posting flows for different content types
                folder_lower = folder_name.lower()
                
                if folder_lower == "reels":
                    # REEL FLOW: Simpler - no crop, no audio, just video → Next → POST → caption → Share
                    print("🎬 Using REEL posting flow (simpler - no crop/audio)")
                    if hasattr(self.ig_poster, 'post_reel_adb_only'):
                        result = self.ig_poster.post_reel_adb_only()
                    else:
                        # Fallback to standard without crop steps
                        result = self.ig_poster.post_adb_only(enable_audio=False)
                elif folder_lower == "trial":
                    # TRIAL FLOW: Standard with trial toggle
                    print("🧪 Using TRIAL posting flow (with trial toggle)")
                    if hasattr(self.ig_poster, 'launcher_controller') and self.ig_poster.launcher_controller:
                        print("🚀 Launching Instagram app...")
                        launch_result = self.ig_poster.launcher_controller.open_instagram_home_strict()
                        home_ready, home_error = type(self.ig_poster.launcher_controller).is_verified_home_ready(launch_result)
                        if not home_ready:
                            print(f"❌ {home_error}")
                            return False
                    result = self.ig_poster.post_standard_workflow(enable_trial_toggle=True)
                else:
                    # IMAGE FLOW: Standard with crop and audio
                    print("📸 Using IMAGE posting flow (with crop and audio)")
                    if hasattr(self.ig_poster, 'post_adb_only'):
                        result = self.ig_poster.post_adb_only(enable_audio=True)
                    else:
                        if hasattr(self.ig_poster, 'launcher_controller') and self.ig_poster.launcher_controller:
                            print("🚀 Launching Instagram app...")
                            launch_result = self.ig_poster.launcher_controller.open_instagram_home_strict()
                            home_ready, home_error = self.ig_poster.launcher_controller.is_verified_home_ready(launch_result)
                            if not home_ready:
                                print(f"❌ {home_error}")
                                return False
                        result = self.ig_poster.post_standard_workflow(enable_trial_toggle=False)
                
                if result:
                    print("✅ Successfully posted to Instagram!")
                    
                    # Step 5: Clean gallery after successful post
                    if auto_clean_after_post:
                        print("🧹 Cleaning gallery after successful post...")
                        auto_clean_after_post()
                    
                    return True
                else:
                    print("❌ Failed to post to Instagram")
                    return False
            except Exception as e:
                print(f"⚠️ Instagram posting error: {e}")
                return True  # Still successful download even if posting fails
        else:
            print("⚠️ Instagram posting not available")
            
            # Clean gallery even if no Instagram posting
            if auto_clean_after_post:
                print("🧹 Cleaning gallery after successful download...")
                auto_clean_after_post()
            
            return True

    def switch_folder_and_process(self, folder_name):
        """Switch to a specific folder and process it"""
        print(f"🔄 Switching to '{folder_name}' folder and processing...")
        
        # Navigate to the requested folder
        if not self.navigate_to_subfolder(folder_name):
            print(f"❌ Failed to switch to '{folder_name}' folder")
            return False
        
        # Process the folder (download and delete) with context
        success, filename = self.download_first_file(folder_context=folder_name)
        if success:
            print(f"✅ Successfully processed '{folder_name}' folder!")
            return True
        else:
            print(f"❌ Failed to process '{folder_name}' folder")
            return False

    def process_multiple_files_from_folder(self, folder_name, count):
        """Process multiple files from a folder without repeated navigation - OPTIMIZED for count control"""
        print(f"📥 Processing {count} files from '{folder_name}' folder (OPTIMIZED)...")
        
        # Navigate to folder ONCE
        print(f"📂 Navigating to '{folder_name}' folder...")
        if not self.navigate_to_subfolder(folder_name):
            print(f"❌ Failed to navigate to '{folder_name}' folder")
            return 0
        
        # Process exactly the requested number of files
        processed = 0
        for i in range(count):
            print(f"📥 Processing file {i+1}/{count}...")
            
            # Download and delete one file with context
            success, filename = self.download_first_file(folder_context=folder_name)
            if success:
                processed += 1
                print(f"✅ Successfully processed file {i+1}/{count}")
            else:
                print(f"❌ Failed to process file {i+1}/{count}")
                # Continue trying remaining files even if one fails
            
            # Brief pause between files if not the last one
            if i < count - 1:
                print("⏳ Brief pause before next file...")
                time.sleep(2)
        
        print(f"🎉 Completed processing {processed}/{count} files from '{folder_name}' folder")
        return processed

# Quick test functions
def quick_trial_improved():
    module = ImprovedDriveManager()
    return module.post_from_drive("trial")

def quick_images_improved():
    module = ImprovedDriveManager()
    return module.post_from_drive("images")

def quick_reels_improved():
    module = ImprovedDriveManager()
    return module.post_from_drive("reels")

def test_folder_switching():
    """Test switching between folders - NAVIGATION ONLY"""
    module = ImprovedDriveManager()
    
    # First open Drive
    if not module.open_drive_in_browser():
        print("❌ Failed to open Drive")
        return False
    
    print("🎯 Testing FOLDER NAVIGATION ONLY (no download/delete)...")
    
    # Test navigating between folders - NO PROCESSING
    folders_to_test = ["reels", "trial", "images"]
    
    for folder in folders_to_test:
        print(f"\n📂 Navigating to '{folder}' folder...")
        if module.navigate_to_subfolder(folder):
            print(f"✅ Successfully navigated to '{folder}' folder!")
            # Take a screenshot to show we're in the folder
            module.take_screenshot(f"in_{folder}_folder.png")
            time.sleep(2)  # Brief pause to show folder contents
        else:
            print(f"❌ Failed to navigate to '{folder}' folder!")
    
    print("\n✅ Folder navigation demonstration completed!")
    return True

def demonstrate_folder_clicking():
    """Simple demonstration of clicking folder locations"""
    module = ImprovedDriveManager()
    
    # First open Drive
    if not module.open_drive_in_browser():
        print("❌ Failed to open Drive")
        return False
    
    print("🎯 Demonstrating folder clicking capabilities...")
    print("📱 Current view should show folder list...")
    
    # Take initial screenshot
    module.take_screenshot("initial_folder_view.png")
    
    # Get UI dump to see what folders are available
    ui_root = module.get_ui_dump("folder_detection.xml")
    
    if ui_root:
        print("\n🔍 Detected folders:")
        for node in ui_root.iter("node"):
            text = node.attrib.get("text", "").lower()
            clickable = node.attrib.get("clickable", "false")
            
            if clickable == "true" and any(folder in text for folder in ["reels", "trial", "images"]):
                bounds = node.attrib.get("bounds", "")
                print(f"   • {text} - {bounds} (clickable: {clickable})")
    
    # Now demonstrate clicking each folder
    folders = ["reels", "trial", "images"]
    
    for folder in folders:
        print(f"\n📂 Attempting to click '{folder}' folder...")
        
        # Get coordinates for this folder
        x, y = module.find_folder_coordinates(folder, ui_root)
        
        if x and y:
            print(f"   🎯 Found '{folder}' at coordinates ({x}, {y})")
            print(f"   👆 Clicking '{folder}' folder now...")
            
            # Click the folder
            result = module.adb("shell", "input", "tap", str(x), str(y))
            
            if result.returncode == 0:
                time.sleep(3)  # Wait for folder to load
                module.take_screenshot(f"clicked_{folder}_folder.png")
                print(f"   ✅ Successfully clicked '{folder}' folder!")
                
                # Go back to main folder view for next test
                print("   ⬅️ Going back to main folder view...")
                module.adb("shell", "input", "keyevent", "4")  # Back button
                time.sleep(2)
                
            else:
                print(f"   ❌ Failed to click '{folder}' folder")
        else:
            print(f"   ❌ Could not find coordinates for '{folder}' folder")
    
    print("\n✅ Folder clicking demonstration completed!")
    return True

if __name__ == "__main__":
    print("🎯 Improved Google Drive Module - UI Analysis Based")
    print("Choose an option:")
    print("1. Test folder navigation (NO download/delete)")
    print("2. Demonstrate folder clicking only")
    print("3. Trial folder (full workflow)")
    print("4. Images folder (full workflow)")
    print("5. Reels folder (full workflow)")
    
    choice = input("Enter choice (1-5): ").strip()
    
    if choice == "1":
        test_folder_switching()
    elif choice == "2":
        demonstrate_folder_clicking()
    elif choice == "3":
        quick_trial_improved()
    elif choice == "4":
        quick_images_improved()
    elif choice == "5":
        quick_reels_improved()
    else:
        print("Invalid choice")