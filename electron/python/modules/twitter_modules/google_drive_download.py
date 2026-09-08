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
2. Click header "More options" at (1016, 201)
3. Click "Download" at (540, 1501) in popup
4. Wait 10s, then long-press same file again
5. Click "Remove" in header to delete
6. Confirm deletion by clicking "Remove" in popup
"""

import subprocess
import time
import os
import json
import xml.etree.ElementTree as ET
import re

# No external module dependencies needed for Twitter automation

class ImprovedDriveManager:
    def __init__(self, account_number=1, device_id="1A121FDF60082H", drive_url=None):
        self.account_number = account_number
        self.device_id = device_id
        
        # Google Drive folder URL - use provided URL or default
        if drive_url and drive_url.strip():
            self.drive_base_url = drive_url.strip()
        else:
            self.drive_base_url = "https://drive.google.com/drive/u/1/folders/1s8xXGSLf-A86ltP5lVOs1o9eKWr1rhoz"
        
        # Target folders to find
        self.target_folders = ["X"]
        
        # For Twitter automation - no external posting dependencies needed
        print("🐦 Google Drive module initialized for Twitter automation")
        
        print(f"📱 Improved Drive Module initialized for Account {account_number}")
        print(f"🔗 Drive URL: {self.drive_base_url}")
        
    def adb(self, *args):
        """Execute ADB command with device ID"""
        return subprocess.run(["adb", "-s", self.device_id] + list(args), capture_output=True, text=True)
    
    def standard_twitter_init(self):
        """Standard initialization: Back 4x → Launch → Scroll Up → Home Tab"""
        print("🔄 STANDARD TWITTER INITIALIZATION")
        print("📋 Sequence: Back 4x → Launch → Scroll Up → Home Tab → Ready")
        
        try:
            # Step 1: Back 4x to ensure clean state
            print("🔙 Step 1/4: Pressing back 4x to clear any menus/screens...")
            for i in range(4):
                print(f"   🔙 Back press {i+1}/4")
                self.adb("shell", "input", "keyevent", "KEYCODE_BACK")
                time.sleep(1)
            
            # Step 2: Launch Twitter fresh
            print("🚀 Step 2/4: Launching Twitter fresh...")
            self.adb("shell", "am", "force-stop", "com.twitter.android")
            time.sleep(2)
            self.adb("shell", "monkey", "-p", "com.twitter.android", "-c", "android.intent.category.LAUNCHER", "1")
            time.sleep(5)
            print("✅ Twitter launched")
            
            # Step 3: Scroll up slightly to reveal navigation
            print("📜 Step 3/4: Scrolling up slightly to reveal navigation...")
            self.adb("shell", "input", "swipe", "540", "800", "540", "900", "300")  # Gentle scroll up
            time.sleep(2)
            print("✅ Scrolled up to reveal navigation")
            
            # Step 4: Click home tab to ensure we're on home feed
            print("🏠 Step 4/4: Clicking home tab...")
            self.adb("shell", "input", "tap", "150", "2200")  # Home tab coordinates
            time.sleep(3)
            print("✅ On home feed")
            
            print("✅ STANDARD INITIALIZATION COMPLETE - Ready for drive download work!")
            return True
            
        except Exception as e:
            print(f"❌ Initialization failed: {e}")
            return False
    
    def tap_screen_to_keep_awake(self):
        """Tap screen to keep it awake"""
        self.adb("shell", "input", "tap", "540", "960")
    
    def take_screenshot(self, filename):
        """Take screenshot and save to Twitter-specific temp directory - FIXED to avoid device storage buildup"""
        temp_dir = "/tmp/twitter_automation"
        os.makedirs(temp_dir, exist_ok=True)
        filepath = f"{temp_dir}/{filename}"
        
        # CRITICAL FIX: Use /data/local/tmp instead of /sdcard to avoid device storage buildup
        device_temp_path = f"/data/local/tmp/{filename}"
        
        result = self.adb("shell", "screencap", "-p", device_temp_path)
        if result.returncode == 0:
            pull_result = self.adb("pull", device_temp_path, filepath)
            if pull_result.returncode == 0:
                print(f"📸 Screenshot saved: {filepath}")
                # IMPORTANT: Clean up device temp file immediately
                self.adb("shell", "rm", device_temp_path)
                return filepath
        print(f"❌ Failed to take screenshot")
        return None
    
    def get_ui_dump(self, filename="current_ui.xml"):
        """Get UI hierarchy dump - FIXED to avoid device storage buildup"""
        temp_dir = "/tmp/twitter_automation"
        os.makedirs(temp_dir, exist_ok=True)
        filepath = f"{temp_dir}/{filename}"
        
        # CRITICAL FIX: Use /data/local/tmp instead of /sdcard to avoid device storage buildup
        device_temp_path = "/data/local/tmp/window_dump.xml"
        
        # Get UI dump
        dump_result = self.adb("shell", "uiautomator", "dump", device_temp_path)
        if dump_result.returncode == 0:
            # Pull the file
            pull_result = self.adb("pull", device_temp_path, filepath)
            if pull_result.returncode == 0:
                print(f"🔍 UI dump saved to {filepath}")
                
                # IMPORTANT: Clean up device temp file immediately
                self.adb("shell", "rm", device_temp_path)
                
                # Parse and return the XML
                try:
                    with open(filepath, 'r', encoding='utf-8') as f:
                        xml_content = f.read()
                    return ET.fromstring(xml_content)
                except Exception as e:
                    print(f"❌ Error parsing XML: {e}")
                    return None
        
        print(f"❌ Failed to get UI dump")
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
        
        # Wait for page to load
        print("⏳ Waiting for Drive to load...")
        time.sleep(8)
        
        # Take screenshot to verify
        self.take_screenshot("drive_opened.png")
        print("✅ Drive opened successfully")
        return True
    
    def navigate_to_subfolder(self, folder_name):
        """Navigate to a specific subfolder - try known coords first, fallback to detection"""
        print(f"📂 Navigating to '{folder_name}' folder...")
        
        # Use CORRECTED coordinates - Fixed button position mismatch
        original_coords = {
            "images": (540, 537),   # Images is currently at old Reels position
            "reels": (540, 705),    # Reels is currently at old Trial position  
            "trial": (540, 873)     # Trial moves to where Images was supposed to be
        }
        
        folder_key = folder_name.lower()
        if folder_key in original_coords:
            # Use original working coordinates first
            x, y = original_coords[folder_key]
            print(f"🎯 Using ORIGINAL coordinates for '{folder_name}': ({x}, {y})")
            result = self.adb("shell", "input", "tap", str(x), str(y))
            
            if result.returncode == 0:
                time.sleep(5)  # Wait for folder to open
                print(f"✅ Successfully clicked '{folder_name}' folder at original coordinates")
                return True
            else:
                print(f"⚠️ Original coordinates failed for '{folder_name}'")
        
        # If known coordinates fail, do ONE UI dump to find actual positions
        print(f"🔍 Doing UI analysis to find '{folder_name}' folder...")
        ui_root = self.get_ui_dump(f"find_{folder_name}.xml")
        
        if ui_root:
            x, y = self.find_folder_coordinates(folder_name, ui_root)
            if x and y:
                print(f"🎯 Found '{folder_name}' via UI analysis at ({x}, {y})")
                result = self.adb("shell", "input", "tap", str(x), str(y))
                
                if result.returncode == 0:
                    time.sleep(5)  # Wait for folder to open
                    print(f"✅ Successfully opened '{folder_name}' folder via UI analysis")
                    return True
        
        print(f"❌ Could not find or click '{folder_name}' folder")
        return False
    
    def find_first_media_file(self):
        """Find the first file in the current folder (any file type)"""
        print("🔍 Finding first file in folder...")
        
        ui_root = self.get_ui_dump("folder_contents.xml")
        if not ui_root:
            print("❌ Could not get UI dump")
            return None, None
        
        best_match = None
        best_y_position = 9999  # Start with high value, we want the topmost file
        
        for node in ui_root.iter("node"):
            text = node.attrib.get("text", "")
            content_desc = node.attrib.get("content-desc", "")
            clickable = node.attrib.get("clickable", "false")
            resource_id = node.attrib.get("resource-id", "")
            
            # Skip if not clickable
            if clickable != "true":
                continue
                
            # Skip header elements by checking if y-coordinate is too high (in header area)
            bounds = node.attrib.get("bounds")
            if bounds:
                x, y, bounds_rect = self.parse_bounds(bounds)
                if y and y < 300:  # Header area, skip this
                    continue
            
            # Look for file indicators - any file with resource-id containing file extension or clickable file rows
            file_indicators = [".png", ".jpg", ".mp4", ".mov", ".pdf", ".txt", ".doc"]
            is_file = False
            
            # Check if it's a file based on resource-id or content
            if any(ext in resource_id.lower() for ext in file_indicators):
                is_file = True
            elif any(ext in text.lower() for ext in file_indicators):
                is_file = True
            elif any(ext in content_desc.lower() for ext in file_indicators):
                is_file = True
            # Also check if it's a large clickable row (file row pattern)
            elif bounds and x and y and bounds_rect:
                x1, y1, x2, y2 = bounds_rect
                width = x2 - x1
                height = y2 - y1
                # File rows are typically wide (>500px) and medium height (100-200px)
                if width > 500 and 100 < height < 200 and y > 400:  # File row pattern
                    is_file = True
            
            if is_file and bounds and x and y:
                # Find the topmost file (smallest y-coordinate in the file list)
                if y < best_y_position and y > 400:  # Below header but topmost in list
                    best_match = (x, y, text or content_desc or resource_id)
                    best_y_position = y
        
        if best_match:
            x, y, filename = best_match
            print(f"✅ Found first file: '{filename}' at ({x}, {y})")
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
        """Download the first file using DYNAMIC detection to find actual top file"""
        print("📥 Starting DYNAMIC file download - Finding actual first file...")
        
        # STEP 1: Find the actual first file in the folder
        print("🔍 Finding first file in folder...")
        file_x, file_y = self.find_first_media_file()
        
        if not file_x or not file_y:
            print("❌ Could not find first file, using fallback coordinates")
            file_x, file_y = 540, 538  # Fallback coordinates
        
        # Calculate 3-dots position: file row + 3-dots offset (typically +467 pixels to the right)
        first_file_3dots_x = file_x + 467  # 3-dots are usually ~467px to the right of file
        first_file_3dots_y = file_y  # Same vertical position as file
        print(f"🔘 STEP 1: Clicking first file's 3 dots at ({first_file_3dots_x}, {first_file_3dots_y}) - NO IMAGE CLICK!")
        result = self.adb("shell", "input", "tap", str(first_file_3dots_x), str(first_file_3dots_y))
        
        if result.returncode != 0:
            print(f"❌ Failed to click file 3 dots: {result.stderr}")
            return False, None
        
        time.sleep(2)  # Wait for menu to appear
        print("✅ File's 3 dots menu opened successfully")
        
        # STEP 2: Click Download
        download_x, download_y = 540, 1917
        print(f"📥 STEP 2: Clicking Download at ({download_x}, {download_y})")
        result = self.adb("shell", "input", "tap", str(download_x), str(download_y))
        
        if result.returncode != 0:
            print(f"❌ Failed to click download: {result.stderr}")
            return False, None
        
        time.sleep(3)
        print("✅ Download initiated successfully!")
        
        # STEP 3: Click same file's 3 dots again for deletion
        print(f"🔄 STEP 3: Clicking first file's 3 dots again for deletion at ({first_file_3dots_x}, {first_file_3dots_y})")
        result = self.adb("shell", "input", "tap", str(first_file_3dots_x), str(first_file_3dots_y))
        
        if result.returncode != 0:
            print(f"❌ Failed to click file 3 dots for deletion: {result.stderr}")
            return False, None
        
        time.sleep(2)  # Wait for menu
        print("✅ File's 3 dots menu reopened for deletion")
        
        # STEP 4: Scroll down 3x in popup menu to reveal Remove option
        print("📜 STEP 4: Scrolling down 3x in popup menu to find Remove option...")
        self.adb("shell", "input", "swipe", "540", "1500", "540", "1200", "300")
        time.sleep(1)
        self.adb("shell", "input", "swipe", "540", "1500", "540", "1200", "300")
        time.sleep(1)
        self.adb("shell", "input", "swipe", "540", "1500", "540", "1200", "300")
        time.sleep(1)
        
        # STEP 5: Click Remove
        remove_x, remove_y = 540, 1996
        print(f"🗑️ STEP 5: Clicking Remove at ({remove_x}, {remove_y})")
        result = self.adb("shell", "input", "tap", str(remove_x), str(remove_y))
        
        if result.returncode != 0:
            print(f"❌ Failed to click remove: {result.stderr}")
            return False, None
        
        time.sleep(2)  # Wait for confirmation dialog
        print("✅ Remove clicked, waiting for confirmation dialog...")
        
        # STEP 6: Click OK to confirm deletion
        ok_x, ok_y = 842, 1441
        print(f"✔️ STEP 6: Clicking OK confirmation at ({ok_x}, {ok_y})")
        result = self.adb("shell", "input", "tap", str(ok_x), str(ok_y))
        
        if result.returncode != 0:
            print(f"❌ Failed to click OK confirmation: {result.stderr}")
            return False, None
        
        time.sleep(2)
        print("✅ File deletion confirmed and completed!")
        
        print("🎉 OPTIMIZED download and delete process completed successfully!")
        print("📋 WORKFLOW SUMMARY:")
        print(f"   1. ✅ Clicked first file 3 dots ({first_file_3dots_x}, {first_file_3dots_y}) - DYNAMIC DETECTION")
        print("   2. ✅ Downloaded file (540, 1917)")
        print(f"   3. ✅ Clicked 3 dots again ({first_file_3dots_x}, {first_file_3dots_y})")  
        print("   4. ✅ Scrolled menu 3x + Clicked Remove (540, 1996)")
        print("   5. ✅ Confirmed deletion OK (842, 1441)")
        
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
        """Find and click confirmation button ('OK' or 'Remove') by text in the final confirmation popup"""
        print("🔍 Searching for confirmation button by text in final popup...")
        
        try:
            # Get UI dump to find confirmation button by text
            ui_root = self.get_ui_dump("final_remove_confirmation.xml")
            if not ui_root:
                print("❌ Could not get UI dump")
                return False
            
            # Look for confirmation buttons by text (OK is the confirmation button)
            confirm_texts = ["OK", "ok", "Remove", "remove", "REMOVE", "Delete", "delete", "DELETE", "Yes", "YES", "Confirm"]
            
            for node in ui_root.iter("node"):
                text = node.attrib.get("text", "")
                content_desc = node.attrib.get("content-desc", "")
                clickable = node.attrib.get("clickable", "false")
                
                # Check if this is a confirmation button (prioritize OK)
                if clickable == "true" and (text in confirm_texts or content_desc in confirm_texts):
                    bounds = node.attrib.get("bounds", "")
                    if bounds:
                        x, y, bounds_rect = self.parse_bounds(bounds)
                        if x and y:
                            print(f"✅ Found confirmation button by text: '{text or content_desc}' at ({x}, {y})")
                            # Click the confirmation button
                            result = self.adb("shell", "input", "tap", str(x), str(y))
                            if result.returncode == 0:
                                print("✅ Successfully clicked confirmation button!")
                                time.sleep(2)
                                return True
                            else:
                                print(f"❌ Failed to click confirmation button: {result.stderr}")
            
            print("❌ Could not find confirmation button by text")
            return False
            
        except Exception as e:
            print(f"❌ Error finding confirmation button by text: {e}")
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
        """Complete workflow: navigate to folder, download file, ready for Twitter"""
        print(f"🚀 Starting improved workflow for '{folder_name}' folder...")
        
        # Step 0: Standard initialization (optional - only if needed for this module)
        # This module works with browser, so standard Twitter init is not required here
        # but keeping the method available for consistency
        
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
        
        # Step 4: Download completed - ready for Twitter posting module
        print("✅ File downloaded and ready for Twitter automation!")
        print(f"📁 Downloaded from '{folder_name}' folder: {filename}")
        print("🐦 File is now available for Twitter posting module to use")
        
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
    print("🎯 Google Drive Module - Auto-running for Twitter/X automation")
    print("📁 Automatically downloading content from Images folder for Twitter posts...")
    
    # Auto-run X folder workflow for Twitter/X automation  
    module = ImprovedDriveManager()
    module.post_from_drive("X")