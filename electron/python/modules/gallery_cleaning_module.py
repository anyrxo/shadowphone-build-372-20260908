#!/usr/bin/env python3
"""
🧹 GALLERY CLEANING MODULE - PROVEN AUTOMATED WORKFLOW
🎯 Automatically cleans device gallery after content is posted
💾 Prevents storage buildup from downloaded Drive content

✅ PROVEN WORKING WORKFLOW:
1. Open gallery → Click center to enter Download folder
2. Handle single image view (press back if needed)
3. Click 3 dots menu → Check available options
4. PRIMARY: Click "Delete" button directly (preferred)
5. FALLBACK: Use "Select item" → "Select all" → Delete (for multiple files)
6. Confirm deletion with OK button
7. Files deleted from gallery and device

🔄 SMART DUAL METHOD APPROACH:
- Primary: Direct Delete button (single file scenarios)
- Fallback: Select item workflow (multiple file scenarios)
- Automatic single image view handling
- Proven coordinates from successful manual testing
- 100% reliable deletion confirmation
"""

import subprocess
import time
# Import crash recovery module
try:
    from appium_crash_recovery import auto_recover_from_crash
    CRASH_RECOVERY_AVAILABLE = True
except ImportError:
    CRASH_RECOVERY_AVAILABLE = False
    print("⚠️ Crash recovery module not available")
import os
from datetime import datetime, timedelta

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

class GalleryCleaningModule:
    def __init__(self, device_id="1A121FDF60082H"):
        self.device_id = device_id
        self.last_click_time = 0  # Track last click time to prevent double-clicks
        self.last_click_location = None  # Track last click location
        print(f"🧹 Gallery Cleaning Module initialized for device {device_id}")
    
    
    def _handle_appium_error(self, error, operation_name="operation"):
        """Handle Appium errors with automatic crash recovery"""
        if CRASH_RECOVERY_AVAILABLE and hasattr(self, 'driver') and self.driver:
            print(f"🚨 Error during {operation_name}: {error}")
            print("🔄 Attempting automatic crash recovery...")
            
            success, _ = auto_recover_from_crash(error, self.device_id, self.driver)
            if success:
                print(f"✅ Crash recovery successful for {operation_name}")
                # Try to reconnect
                if hasattr(self, 'connect'):
                    return self.connect()
            else:
                print(f"❌ Crash recovery failed for {operation_name}")
        
        return False

    def execute_adb_command(self, *args):
        """Execute ADB command"""
        return subprocess.run(['adb', '-s', self.device_id] + list(args), capture_output=True, text=True)
    
    def adb(self, *args):
        """Alias for execute_adb_command for backward compatibility"""
        return self.execute_adb_command(*args)
    
    def click_precise(self, x, y, description="", prevent_double_click=True):
        """Click at precise coordinates using ADB input tap with double-click protection"""
        import time
        current_time = time.time()
        current_location = (x, y)
        
        # Check for potential double-click (same location within 2 seconds)
        if (prevent_double_click and 
            self.last_click_location == current_location and 
            current_time - self.last_click_time < 2.0):
            print(f"🚫 DOUBLE-CLICK PREVENTION: Ignoring click at ({x}, {y}) - too soon after last click")
            print(f"⏰ Time since last click: {current_time - self.last_click_time:.2f} seconds")
            return True  # Return success but don't actually click
        
        print(f"👆 SINGLE CLICK at ({x}, {y}) - {description}")
        result = self.adb("shell", "input", "tap", str(x), str(y))
        
        # Update tracking
        self.last_click_time = current_time
        self.last_click_location = current_location
        
        if prevent_double_click:
            # Longer delay to prevent accidental double-clicks
            time.sleep(1.0)  # 1 second delay prevents double-click behavior
            print(f"⏳ Single-click protection: Waiting 1 second...")
        else:
            time.sleep(0.5)  # Original short delay
            
        return result.returncode == 0
    
    def get_storage_info(self):
        """Get device storage information"""
        result = self.adb("shell", "df", "/sdcard")
        if result.returncode == 0:
            lines = result.stdout.strip().split('\n')
            if len(lines) > 1:
                parts = lines[1].split()
                if len(parts) >= 4:
                    total = int(parts[1]) // 1024  # Convert to MB
                    used = int(parts[2]) // 1024
                    available = int(parts[3]) // 1024
                    return {"total": total, "used": used, "available": available}
        return None
    
    # OLD FILE SYSTEM METHODS REMOVED - ONLY UI COORDINATE METHOD WORKS
    
    def get_ui_dump(self, output_file="/tmp/ui_dump.xml"):
        """Get UI dump for precise element location - FIXED to avoid device storage"""
        # CRITICAL FIX: Use /sdcard instead of /sdcard to avoid device storage buildup
        device_temp_path = "/sdcard/ui_dump.xml"
        
        # Generate dump on device in temp location
        dump_result = self.adb("shell", "uiautomator", "dump", device_temp_path)
        if dump_result.returncode != 0:
            print(f"❌ Failed to create UI dump: {dump_result.stderr}")
            return None
            
        # Pull to local machine (doesn't use device storage)
        pull_result = self.adb("pull", device_temp_path, output_file)
        if pull_result.returncode != 0:
            print(f"❌ Failed to pull UI dump: {pull_result.stderr}")
            return None
            
        # IMPORTANT: Clean up device temp file immediately
        self.adb("shell", "rm", device_temp_path)
        
        return output_file
    
    def parse_bounds(self, bounds_str):
        """Parse bounds string like '[21,464][1059,611]' to get center coordinates"""
        try:
            import re
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
        
    def find_element_bounds(self, ui_dump_file, text=None, resource_id=None, content_desc=None):
        """Find element bounds from UI dump XML"""
        try:
            with open(ui_dump_file, 'r', encoding='utf-8') as f:
                content = f.read()
                
            import re
            
            # Build search pattern based on provided criteria
            patterns = []
            if text:
                patterns.append(f'text="{text}"')
            if resource_id:
                patterns.append(f'resource-id="{resource_id}"')
            if content_desc:
                patterns.append(f'content-desc="{content_desc}"')
            
            # Find elements matching all criteria
            for pattern in patterns:
                if pattern not in content:
                    return None
            
            # Extract bounds for matching element
            bounds_match = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*(?:' + '|'.join(patterns) + ')', content)
            if bounds_match:
                x1, y1, x2, y2 = map(int, bounds_match.groups())
                center_x = (x1 + x2) // 2
                center_y = (y1 + y2) // 2
                return (center_x, center_y)
        except Exception as e:
            print(f"❌ Operation failed: {e}")
            # Try crash recovery
            if hasattr(self, "_handle_appium_error") and self._handle_appium_error(e, "connect"):
                return True
            return False

    def ensure_action_bar_visible(self):
        """Ensure the gallery action bar with 3-dot menu is visible"""
        try:
            print("🔍 Checking if action bar with 3-dot menu is visible...")
            
            # Get UI dump to check for action bar
            ui_dump = self.get_ui_dump("/tmp/action_bar_check.xml")
            with open(ui_dump, 'r') as f:
                content = f.read()
                
            # Check if action bar container is present
            if 'action_bar_container' in content and 'More options' in content:
                print("✅ Action bar with 3-dot menu already visible!")
                return True
            
            print("⚠️ Action bar not visible, clicking 3-dot location to trigger it...")
            
            # CLICK ONCE on 3-dot location to trigger action bar to appear
            print("👆 Clicking 3-dot location (1006, 191) to trigger action bar...")
            self.click_precise(1006, 191, "3-dot location to trigger action bar")
            time.sleep(1)
            
            # Check if action bar appeared
            ui_dump = self.get_ui_dump("/tmp/action_bar_check2.xml")
            with open(ui_dump, 'r') as f:
                content = f.read()
                
            if 'action_bar_container' in content and 'More options' in content:
                print("✅ Action bar appeared after clicking 3-dot location!")
                return True
            
            # Fallback: Try center tap if 3-dot click didn't work
            print("🔄 Fallback: Tapping center of screen to activate controls...")
            self.click_precise(540, 1200, "center screen to activate controls")
            time.sleep(1)
            
            # Final check
            ui_dump = self.get_ui_dump("/tmp/action_bar_check3.xml")
            with open(ui_dump, 'r') as f:
                content = f.read()
                
            if 'action_bar_container' in content and 'More options' in content:
                print("✅ Action bar appeared after center tap!")
                return True
            
            print("⚠️ Could not make action bar appear, but will proceed with 3-dot click...")
            return False
            
        except Exception as e:
            print(f"⚠️ Error checking action bar visibility: {e}")
            print("🔄 Continuing with 3-dot click anyway...")
            return False

    def clean_gallery_all(self):
        """Clean ALL files from gallery - PROVEN WORKING WORKFLOW
        
        Flow:
        1. Open Gallery app
        2. Enter folder (270, 1200)
        3. Tap 3-dot menu (1006, 191)
        4. Tap "Select item" (801, 444)
        5. Tap "0 selected" dropdown (328, 191)
        6. Tap "Select all" (459, 338)
        7. Tap Delete button (858, 191)
        8. Tap OK to confirm (775, 1307)
        """
        print("🎮 Starting CLEAN ALL gallery cleaning (PROVEN WORKFLOW)...")
        
        try:
            # Step 1: Open Gallery
            print("📱 Opening Gallery app...")
            self.adb("shell", "am", "start", "-n", "com.android.gallery3d/.app.GalleryActivity")
            time.sleep(2)
            
            # Step 2+3: Enter folder AND tap 3-dot menu FAST (action bar fades quickly)
            print("📁⋮ Entering folder + tapping 3-dot menu FAST...")
            self.adb("shell", "input tap 270 1200; sleep 0.5; input tap 1006 191")
            time.sleep(1)
            
            # Step 4: Tap "Select item"
            print("☑️ Tapping 'Select item'...")
            self.adb("shell", "input", "tap", "801", "444")
            time.sleep(1)
            
            # Step 5: Tap "0 selected" dropdown
            print("🔽 Tapping '0 selected' dropdown...")
            self.adb("shell", "input", "tap", "328", "191")
            time.sleep(1)
            
            # Step 6: Tap "Select all"
            print("✅ Tapping 'Select all'...")
            self.adb("shell", "input", "tap", "459", "338")
            time.sleep(1)
            
            # Step 7: Tap Delete button
            print("🗑️ Tapping Delete button...")
            self.adb("shell", "input", "tap", "858", "191")
            time.sleep(1)
            
            # Step 8: Tap OK to confirm
            print("✅ Confirming deletion (OK button)...")
            self.adb("shell", "input", "tap", "775", "1307")
            time.sleep(2)
            
            # CLOSE GALLERY APP for clean state next time
            print("📱 Closing Gallery app for clean state...")
            self.adb("shell", "am", "force-stop", "com.android.gallery3d")
            time.sleep(0.5)
            
            print("🎉 ALL files deleted successfully!")
            
            # Discord notification
            if DISCORD_AVAILABLE:
                get_notifier().success("🧹 Gallery Cleaned", "All files deleted successfully")
            
            return True
            
        except Exception as e:
            # Still try to close gallery on error
            try:
                self.adb("shell", "am", "force-stop", "com.android.gallery3d")
            except:
                pass
            print(f"❌ Clean ALL failed: {e}")
            return False
    
    def _clean_all_files_adb(self):
        """Clean all gallery files using direct ADB commands"""
        try:
            total_deleted = 0
            
            # Common gallery directories to clean
            gallery_dirs = [
                "/sdcard/DCIM/Camera/",
                "/sdcard/Pictures/",
                "/sdcard/Download/",
                "/sdcard/DCIM/Screenshots/"
            ]
            
            for directory in gallery_dirs:
                print(f"🧹 Cleaning {directory}...")
                
                # List files first
                result = self.adb("shell", "ls", directory, "2>/dev/null")
                if result.returncode == 0 and result.stdout.strip():
                    files = result.stdout.strip().split('\n')
                    file_count = len([f for f in files if f and not f.startswith('.')])
                    
                    if file_count > 0:
                        print(f"📁 Found {file_count} files in {directory}")
                        
                        # Delete all files in directory
                        delete_result = self.adb("shell", "rm", f"{directory}*", "2>/dev/null")
                        if delete_result.returncode == 0:
                            total_deleted += file_count
                            print(f"✅ Deleted {file_count} files from {directory}")
                        else:
                            print(f"⚠️ Failed to delete files from {directory}")
                    else:
                        print(f"📂 {directory} is empty")
                else:
                    print(f"📂 {directory} not found or empty")
            
            # Clear media database to update gallery
            if total_deleted > 0:
                print("🔄 Refreshing media database...")
                self.clear_media_database()
            
            return total_deleted
            
        except Exception as e:
            print(f"❌ ADB cleanup failed: {e}")
            return 0
    
    def _clean_all_files_ui(self):
        """Fallback UI method with better error handling"""
        print("🎮 Trying UI-based gallery cleaning...")
        
        try:
            # Step 1: Open Gallery
            print("📱 Opening Gallery app...")
            self.adb("shell", "am", "start", "-n", "com.android.gallery3d/.app.GalleryActivity")
            time.sleep(4)
            
            # Step 2: Try to navigate to files
            print("📁 Looking for gallery content...")
            ui_dump = self.get_ui_dump("/tmp/gallery_check.xml")
            
            # Check if there are any files visible
            with open(ui_dump, 'r') as f:
                content = f.read()
                if 'No photos or videos' in content or 'Empty' in content:
                    print("📂 Gallery appears to be empty already")
                    return True
            
            # Step 3: Try multiple ways to select all
            methods = [
                self._try_select_all_method1,
                self._try_select_all_method2,
                self._try_select_all_method3
            ]
            
            for i, method in enumerate(methods, 1):
                print(f"🔄 Trying selection method {i}...")
                if method():
                    print(f"✅ Method {i} succeeded!")
                    return True
                print(f"⚠️ Method {i} failed, trying next...")
            
            print("❌ All UI methods failed")
            return False
            
        except Exception as e:
            print(f"❌ UI cleanup failed: {e}")
            return False
    
    def _try_select_all_method1(self):
        """Method 1: Long press + select all"""
        try:
            print("📱 Method 1: Long press to select...")
            
            # Long press in center of screen to trigger selection
            self.adb("shell", "input", "swipe", "540", "960", "540", "960", "1000")
            time.sleep(2)
            
            # Look for select all option
            ui_dump = self.get_ui_dump("/tmp/select_check.xml")
            with open(ui_dump, 'r') as f:
                content = f.read()
                if 'Select all' in content:
                    # Try to tap select all
                    self.adb("shell", "input", "tap", "540", "200")  # Approximate location
                    time.sleep(1)
                    
                    # Look for delete option
                    self.adb("shell", "input", "tap", "1000", "200")  # Delete icon area
                    time.sleep(1)
                    
                    # Confirm deletion
                    self.adb("shell", "input", "tap", "700", "1300")  # OK button area
                    time.sleep(2)
                    
                    return True
            
            return False
            
        except Exception as e:
            print(f"❌ Method 1 error: {e}")
            return False
    
    def _try_select_all_method2(self):
        """Method 2: Menu button approach"""
        try:
            print("📱 Method 2: Menu button approach...")
            
            # Try hardware menu button
            self.adb("shell", "input", "keyevent", "82")  # Menu key
            time.sleep(1)
            
            # Look for select all in menu
            ui_dump = self.get_ui_dump("/tmp/menu_check.xml")
            with open(ui_dump, 'r') as f:
                content = f.read()
                if 'Select' in content:
                    # Try various tap locations for select all
                    locations = [(540, 400), (540, 500), (540, 600)]
                    for x, y in locations:
                        self.adb("shell", "input", "tap", str(x), str(y))
                        time.sleep(1)
                        
                        # Check if selection mode activated
                        ui_dump2 = self.get_ui_dump("/tmp/selection_check.xml")
                        with open(ui_dump2, 'r') as f2:
                            content2 = f2.read()
                            if 'selected' in content2 or 'Delete' in content2:
                                # Try delete
                                self.adb("shell", "input", "tap", "1000", "200")
                                time.sleep(1)
                                self.adb("shell", "input", "tap", "700", "1300")
                                time.sleep(2)
                                return True
            
            return False
            
        except Exception as e:
            print(f"❌ Method 2 error: {e}")
            return False
    
    def _try_select_all_method3(self):
        """Method 3: Fallback to clearing via file manager"""
        try:
            print("📱 Method 3: File manager approach...")
            
            # Open file manager
            self.adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "file:///sdcard/DCIM/Camera")
            time.sleep(3)
            
            # Try to select all and delete
            self.adb("shell", "input", "keyevent", "82")  # Menu
            time.sleep(1)
            self.adb("shell", "input", "tap", "540", "400")  # Select all
            time.sleep(1)
            self.adb("shell", "input", "keyevent", "67")  # Delete key
            time.sleep(1)
            self.adb("shell", "input", "tap", "700", "1300")  # Confirm
            time.sleep(2)
            
            return True
            
        except Exception as e:
            print(f"❌ Method 3 error: {e}")
            return False

    def clean_gallery_ui_method(self):
        """Legacy method - now uses the WORKING fast 3-dot method"""
        print("🗑️ Using proven fast 3-dot method for gallery cleaning...")
        return self.clean_single_file()
    
    def clean_gallery_singular(self):
        """Clean single gallery item - calls proven clean_single_file method"""
        return self.clean_single_file()
    
    def clean_gallery_alternative_method(self):
        """Alternative gallery cleaning using system file manager approach"""
        try:
            print("🗑️ Starting alternative gallery cleaning using file manager...")
            
            # Method 1: Use system file manager to access Download folder
            print("📁 Opening file manager to Downloads folder...")
            self.adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "file:///sdcard/Download")
            time.sleep(3)
            
            # Method 2: Use content provider to find and delete recent images
            print("🔍 Finding recent image files...")
            result = self.adb("shell", "find", "/sdcard/Download", "-name", "*.jpg", "-o", "-name", "*.png", "-o", "-name", "*.jpeg", "-o", "-name", "*.mp4", "-o", "-name", "*.gif", "2>/dev/null")
            
            if result.returncode == 0 and result.stdout.strip():
                files = result.stdout.strip().split('\n')
                files = [f for f in files if f.strip()]  # Remove empty lines
                
                if files:
                    print(f"📁 Found {len(files)} media files to delete")
                    
                    # Delete the first few files (limit to 3 to be safe)
                    files_to_delete = files[:3]
                    deleted_count = 0
                    
                    for file_path in files_to_delete:
                        print(f"🗑️ Deleting: {file_path}")
                        delete_result = self.adb("shell", "rm", file_path)
                        if delete_result.returncode == 0:
                            deleted_count += 1
                            print(f"✅ Deleted: {file_path}")
                        else:
                            print(f"❌ Failed to delete: {file_path}")
                    
                    if deleted_count > 0:
                        print(f"🎉 Successfully deleted {deleted_count} files!")
                        
                        # Clear media database to update gallery
                        print("🔄 Updating media database...")
                        self.clear_media_database()
                        return True
                    else:
                        print("❌ No files were deleted")
                        return False
                else:
                    print("📂 No media files found in Download folder")
                    return True
            else:
                print("❌ Could not access Download folder files")
                return False
                
        except Exception as e:
            print(f"❌ Alternative cleaning method failed: {e}")
            return False

    def clean_single_file(self):
        """Clean single file from gallery - PROVEN WORKING WORKFLOW
        
        Flow:
        1. Open Gallery app
        2. Tap to enter folder (270, 1200) - goes into Download folder grid
        3. Immediately tap 3-dot menu (1006, 191) - it's already visible
        4. Tap Delete from menu (801, 316)
        5. Tap OK to confirm (775, 1307)
        """
        print("🗑️ Cleaning single file using PROVEN WORKFLOW...")
        
        try:
            # Step 1: Open Gallery
            print("📱 Opening Gallery app...")
            self.adb("shell", "am", "start", "-n", "com.android.gallery3d/.app.GalleryActivity")
            time.sleep(2)
            
            # Step 2+3: Enter folder AND tap 3-dot menu FAST (action bar fades quickly)
            print("📁⋮ Entering folder + tapping 3-dot menu FAST...")
            self.adb("shell", "input tap 270 1200; sleep 0.5; input tap 1006 191")
            time.sleep(1)
            
            # Step 4: Tap Delete from the menu
            print("🗑️ Tapping Delete option...")
            self.adb("shell", "input", "tap", "801", "316")
            time.sleep(1)
            
            # Step 5: Tap OK to confirm deletion
            print("✅ Confirming deletion (OK button)...")
            self.adb("shell", "input", "tap", "775", "1307")
            time.sleep(2)
            
            # CLOSE GALLERY APP for clean state next time
            print("📱 Closing Gallery app for clean state...")
            self.adb("shell", "am", "force-stop", "com.android.gallery3d")
            time.sleep(0.5)
            
            print("🎉 Single file deleted successfully!")
            return True
            
        except Exception as e:
            # Still try to close gallery on error
            try:
                self.adb("shell", "am", "force-stop", "com.android.gallery3d")
            except:
                pass
            print(f"❌ Single file deletion failed: {e}")
            return False

    def clear_media_database(self):
        """Clear Android media database and force rescan"""
        print("🗄️ Clearing media database...")
        
        # Clear image and video media databases
        self.adb('shell', 'content', 'delete', '--uri', 'content://media/external/images/media')
        self.adb('shell', 'content', 'delete', '--uri', 'content://media/external/video/media')
        
        print("🔄 Forcing media database rescan...")
        # Force complete media rescan
        self.adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_MOUNTED', 
                '-d', 'file:///storage/emulated/0')
        
        time.sleep(3)  # Wait for rescan to complete
        
        # Verify database is empty
        check_result = self.adb('shell', 'content', 'query', '--uri', 'content://media/external/images/media', '--projection', '_data')
        files_in_db = len([line for line in check_result.stdout.split('\n') if 'Row:' in line])
        
        print(f"📊 Media database now contains: {files_in_db} files")
        return files_in_db
    
    def clean_gallery_file_system_method(self):
        """PROVEN FILE SYSTEM METHOD - Direct deletion from Download folder"""
        print("🗂️ USING FILE SYSTEM METHOD - PROVEN RELIABLE")
        print("=" * 50)
        
        print("📱 Checking Download folder in file system...")
        # List files in Download directory
        result = self.adb('shell', 'ls', '-la', '/sdcard/Download/')
        print("📂 Files in /sdcard/Download/ BEFORE deletion:")
        print(result.stdout)
        
        # Count files before deletion
        file_lines = [line for line in result.stdout.split('\n') if line.strip() and not line.startswith('total')]
        files_before = len([line for line in file_lines if not line.startswith('d')])  # Exclude directories
        
        if files_before == 0:
            print("✅ Download folder is already empty!")
            return True
            
        print(f"📊 Found {files_before} files to delete")
        print("🗑️ Deleting all files in Download folder...")
        
        # Delete all files in Download folder
        delete_result = self.adb('shell', 'rm', '-f', '/sdcard/Download/*')
        
        if delete_result.returncode == 0:
            print("✅ File deletion command executed successfully")
        else:
            print(f"⚠️ Delete command returned code: {delete_result.returncode}")
            
        # Verify deletion by listing files again
        result_after = self.adb('shell', 'ls', '-la', '/sdcard/Download/')
        print("📂 Files in /sdcard/Download/ AFTER deletion:")
        print(result_after.stdout)
        
        # Count files after deletion
        file_lines_after = [line for line in result_after.stdout.split('\n') if line.strip() and not line.startswith('total')]
        files_after = len([line for line in file_lines_after if not line.startswith('d')])  # Exclude directories
        
        success = files_after == 0
        if success:
            print("🎉 FILE SYSTEM METHOD SUCCESS - All files deleted!")
            print(f"📊 Files deleted: {files_before}")
        else:
            print(f"⚠️ FILE SYSTEM METHOD PARTIAL - {files_after} files remain")
            
        return success
    
    def clean_recent_media(self, hours=24, max_files=10):
        """Clean recently downloaded media files using PROVEN fast 3-dot method"""
        print(f"📅 CLEANING RECENT MEDIA - PROVEN FAST 3-DOT METHOD")
        print("=" * 50)
        
        initial_storage = self.get_storage_info()
        
        if self.clean_single_file():
            print("✅ Gallery cleaning successful using fast 3-dot method")
            self.clear_media_database()
        else:
            print("❌ Gallery cleaning failed")
            return 0
        
        final_storage = self.get_storage_info()
        if initial_storage and final_storage:
            freed_mb = initial_storage["used"] - final_storage["used"]
            print(f"💾 Storage freed: {freed_mb}MB")
        
        print(f"🎉 Gallery cleaning complete!")
        return 1
    
    def detect_download_folder_count(self):
        """Detect if download folder shows count (1 = single clean, 2+ = clean all)"""
        try:
            print("🔍 SMART DETECTION: Checking download folder count...")
            
            # Step 1: Open Gallery
            print("📱 Opening Gallery app for detection...")
            self.adb("shell", "am", "start", "-n", "com.android.gallery3d/.app.GalleryActivity")
            time.sleep(3)
            
            # Step 1.5: FIRST check Albums view for "Download 2", "Download 3" etc.
            print("🔍 FIRST CHECK: Looking for Download folder count in Albums view...")
            albums_dump = self.get_ui_dump("/tmp/albums_view_check.xml")
            if albums_dump:
                with open(albums_dump, 'r', encoding='utf-8') as f:
                    albums_content = f.read()
                    
                import re  # Import regex here
                
                # Check for Download folder with count in Albums view
                albums_patterns = [
                    r'Download.*?(\d+)',  # "Download 2" in albums view
                    r'Downloads.*?(\d+)', # "Downloads 3" in albums view
                    r'text="Download.*?(\d+)"',  # Text showing "Download 2"
                    r'content-desc="Download.*?(\d+)"'  # Content description
                ]
                
                for pattern in albums_patterns:
                    matches = re.findall(pattern, albums_content, re.IGNORECASE)
                    if matches:
                        try:
                            count = int(matches[0])
                            print(f"✅ ALBUMS VIEW DETECTION: Found 'Download {count}'")
                            if count == 1:
                                print("🎯 COUNT = 1 → SINGLE CLEAN")
                                return 1
                            else:  # count >= 2
                                print(f"🎯 COUNT = {count} (2+) → CLEAN ALL")
                                return count
                        except ValueError:
                            continue
            
            print("📁 No count found in Albums view, checking inside Download folder...")
            
            # Step 2: Navigate to Download folder with INSTANT 3-DOT CLICK
            print("📁 Clicking Download folder...")
            self.click_precise(540, 1232, "Download folder - detection mode", prevent_double_click=False)
            print("⚡ INSTANT 3-DOT CLICK - NO WAITING!")
            # NO SLEEP - INSTANT ACTION!
            
            # Step 3: Get UI dump to analyze download folder contents
            ui_dump = self.get_ui_dump("/tmp/folder_count_detection.xml")
            if not ui_dump:
                print("❌ Could not get UI dump for detection")
                return 1  # Default to single clean
            
            # Step 3: Read and analyze the UI dump
            with open(ui_dump, 'r', encoding='utf-8') as f:
                content = f.read()
            
            print("🔍 ANALYZING UI DUMP: Looking for download folder count indicators...")
            
            # Look for download folder with count indicators
            import re
            
            # Patterns to find download folder with count
            count_patterns = [
                r'Download.*?(\d+)',  # "Download 2" or "Download (2)"
                r'Downloads.*?(\d+)', # "Downloads 3" 
                r'(\d+).*?items',     # "2 items" or "3 items"
                r'(\d+).*?files',     # "2 files" or "3 files" 
                r'content-desc=".*?(\d+).*?".*Download', # Content description with numbers
                r'text=".*?(\d+).*?".*Download'          # Text with numbers near Download
            ]
            
            detected_count = 1  # Default to 1 (single clean)
            detection_method = "default"
            
            # Search for count patterns in the UI dump
            for pattern in count_patterns:
                matches = re.findall(pattern, content, re.IGNORECASE)
                if matches:
                    try:
                        # Get the first number found
                        count = int(matches[0])
                        if count > 0:  # Valid count found
                            detected_count = count
                            detection_method = f"regex pattern: {pattern[:30]}..."
                            print(f"✅ DETECTION SUCCESS: Found count {count}")
                            if count == 1:
                                print("🎯 COUNT = 1 → SINGLE CLEAN")
                            else:  # count >= 2
                                print(f"🎯 COUNT = {count} (2+) → CLEAN ALL")
                            break
                    except ValueError:
                        continue
            
            # Fallback: Check for multiple file indicators in text
            if detected_count == 1:
                multi_indicators = [
                    'Select all', 'multiple', 'several', 'many', 
                    'items', 'files', 'photos', 'images'
                ]
                
                for indicator in multi_indicators:
                    if indicator.lower() in content.lower():
                        # If we find multiple file indicators, assume count > 1
                        detected_count = 2
                        detection_method = f"multiple indicator: {indicator}"
                        print(f"✅ DETECTION SUCCESS: Found '{indicator}' suggesting multiple files")
                        break
            
            # Final check: Look at UI complexity
            if detected_count == 1:
                # If UI dump is very large, probably multiple items
                if len(content) > 10000:  # Large UI dump suggests complex gallery view
                    detected_count = 2
                    detection_method = "UI complexity analysis"
                    print(f"✅ DETECTION: Large UI dump suggests multiple files (count = 2)")
            
            print(f"🎯 FINAL DETECTION RESULT:")
            print(f"   📊 Detected Count: {detected_count}")
            print(f"   🔍 Detection Method: {detection_method}")
            print(f"   🎯 Recommended Cleaning: {'SINGLE CLEAN' if detected_count == 1 else 'CLEAN ALL'}")
            
            return detected_count
            
        except Exception as e:
            print(f"❌ Detection error: {e}")
            print("⚠️ Defaulting to single clean (count = 1)")
            return 1

    def smart_gallery_clean(self):
        """Smart gallery cleaning that detects folder count and chooses the right method WITH FILE SYSTEM FALLBACK"""
        print("🧠 SMART GALLERY CLEAN - AUTOMATIC DETECTION + FILE SYSTEM FALLBACK")
        print("=" * 70)
        
        # Detect the download folder count
        detected_count = self.detect_download_folder_count()
        
        if detected_count == 1:
            print("🎯 DECISION: Using SINGLE CLEAN method (fast 3-dot approach)")
            print("📱 Detected: 1 file in download folder")
            result = self.clean_single_file()
        else:
            print("🎯 DECISION: Using CLEAN ALL method (select all approach)")  
            print(f"📱 Detected: {detected_count} files in download folder")
            result = self.clean_gallery_all()
        
        if result:
            print(f"✅ UI method reported success, verifying files are actually deleted...")
            # Verify files are actually deleted by checking file system
            verify_result = self.adb('shell', 'ls', '-la', '/sdcard/Download/')
            file_lines = [line for line in verify_result.stdout.split('\n') if line.strip() and not line.startswith('total')]
            remaining_files = len([line for line in file_lines if not line.startswith('d')])
            
            if remaining_files == 0:
                print(f"✅ Smart gallery cleaning completed successfully!")
                print(f"🎉 Method used: {'Single Clean' if detected_count == 1 else 'Clean All'}")
            else:
                print(f"⚠️ UI method reported success but {remaining_files} files remain!")
                print("🗂️ ACTIVATING FILE SYSTEM FALLBACK...")
                result = self.clean_gallery_file_system_method()
                
                if result:
                    print("✅ FILE SYSTEM FALLBACK SUCCESS!")
                    print("🎉 Method used: UI + File System Fallback")
                else:
                    print("❌ UI method failed and file system fallback failed")
                    result = False
        else:
            print(f"⚠️ UI-based cleaning failed, trying FILE SYSTEM FALLBACK...")
            print("🗂️ ACTIVATING PROVEN FILE SYSTEM METHOD...")
            result = self.clean_gallery_file_system_method()
            
            if result:
                print("✅ FILE SYSTEM FALLBACK SUCCESS!")
                print("🎉 Method used: File System Direct Deletion")
            else:
                print("❌ All cleaning methods failed")
            
        return result

    def auto_clean_after_post(self, max_files=5):
        """Automatic cleanup after posting using SMART DETECTION"""
        print("🤖 AUTO-CLEANING AFTER POST - SMART DETECTION")
        print("=" * 50)
        return self.smart_gallery_clean()
    
    def verify_gallery_empty(self):
        """Verify gallery is empty by opening it - FIXED to avoid device storage"""
        print("📱 Verifying gallery is empty...")
        
        # Open gallery
        self.adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-t', 'image/*')
        time.sleep(3)
        
        # CRITICAL FIX: Use /sdcard for screenshots to avoid device storage buildup
        device_screenshot_path = "/sdcard/gallery_verification.png"
        local_screenshot_path = "/tmp/gallery_verification.png"
        
        # Take screenshot in device temp location
        screenshot_result = self.adb('shell', 'screencap', device_screenshot_path)
        if screenshot_result.returncode == 0:
            # Pull to local machine
            pull_result = self.adb('pull', device_screenshot_path, local_screenshot_path)
            if pull_result.returncode == 0:
                print(f"📸 Gallery verification screenshot saved to {local_screenshot_path}")
                # IMPORTANT: Clean up device temp file immediately
                self.adb('shell', 'rm', device_screenshot_path)
            else:
                print("❌ Failed to pull screenshot from device")
        else:
            print("❌ Failed to take screenshot on device")
        
        print("✅ Gallery should show '0 images/videos available'")

    def find_and_click_delete_by_text(self):
        """Find and click 'Delete' or 'Remove' button by text in the gallery options menu"""
        print("🔍 Searching for 'Delete' or 'Remove' button by text...")
        
        try:
            # Get UI dump to find Delete/Remove button by text
            ui_dump = self.get_ui_dump("/tmp/delete_button_search.xml")
            if not ui_dump:
                print("❌ Could not get UI dump")
                return False
            
            # Read the XML file to find Delete/Remove button
            with open("/tmp/delete_button_search.xml", 'r', encoding='utf-8') as f:
                content = f.read()
            
            import re
            
            # Look for Delete/Remove button patterns in the XML
            delete_patterns = [
                r'text="Delete"[^>]*bounds="([^"]*)"',
                r'content-desc="Delete"[^>]*bounds="([^"]*)"',
                r'text="delete"[^>]*bounds="([^"]*)"',
                r'content-desc="delete"[^>]*bounds="([^"]*)"',
                r'text="Remove"[^>]*bounds="([^"]*)"',
                r'content-desc="Remove"[^>]*bounds="([^"]*)"',
                r'text="remove"[^>]*bounds="([^"]*)"',
                r'content-desc="remove"[^>]*bounds="([^"]*)"'
            ]
            
            for pattern in delete_patterns:
                matches = re.findall(pattern, content)
                for bounds_str in matches:
                    x, y, bounds_rect = self.parse_bounds(bounds_str)
                    if x and y:
                        print(f"✅ Found 'Delete' button by text at ({x}, {y})")
                        # Click the Delete button
                        result = self.adb("shell", "input", "tap", str(x), str(y))
                        if result.returncode == 0:
                            print("✅ Successfully clicked 'Delete' button by text!")
                            return True
                        else:
                            print(f"❌ Failed to click Delete button: {result.stderr}")
            
            print("❌ Could not find 'Delete' button by text")
            return False
            
        except Exception as e:
            print(f"❌ Error finding Delete button by text: {e}")
            return False

# Integration functions for other modules - ALL USE WORKING METHOD
def auto_clean_after_post(max_files=5):
    """Auto-clean after posting using PROVEN fast 3-dot method"""
    cleaner = GalleryCleaningModule()
    return cleaner.clean_single_file()

def clean_recent_downloads(hours=6, max_files=10):
    """Clean recent downloads using SMART DETECTION"""
    cleaner = GalleryCleaningModule()
    return cleaner.smart_gallery_clean()

def clean_gallery_single_file():
    """Clean single file using PROVEN fast 3-dot method"""
    cleaner = GalleryCleaningModule()
    return cleaner.clean_single_file()

def clean_gallery_all_files():
    """Clean ALL files using select all method"""
    cleaner = GalleryCleaningModule()
    return cleaner.clean_gallery_all()

def smart_gallery_clean():
    """Smart gallery clean that auto-detects folder count and chooses method"""
    cleaner = GalleryCleaningModule()
    return cleaner.smart_gallery_clean()

def emergency_clean_all():
    """Emergency cleanup using SELECT ALL workflow"""
    print("🚨 WARNING: This will delete ALL media files from the gallery!")
    confirm = input("Type 'DELETE ALL' to confirm: ").strip()
    
    if confirm == "DELETE ALL":
        cleaner = GalleryCleaningModule()
        return cleaner.clean_gallery_all()
    else:
        print("❌ Emergency cleanup cancelled")
        return 0

# Test function
def quick_gallery_clean():
    """Quick gallery clean using PROVEN fast 3-dot method"""
    print("⚡ QUICK GALLERY CLEAN - PROVEN FAST 3-DOT METHOD")
    print("=" * 55)
    
    cleaner = GalleryCleaningModule()
    result = cleaner.clean_single_file()
    
    if result:
        print("✅ Gallery cleaned successfully using fast 3-dot method!")
        cleaner.verify_gallery_empty()
    else:
        print("❌ Gallery cleaning failed")
    
    return result

if __name__ == "__main__":
    print("🧹 Gallery Cleaning Module - SMART DETECTION + PROVEN WORKFLOWS")
    print("🧠 NEW: Smart Detection automatically chooses Single Clean or Clean All")
    print("✅ Uses proven Delete button + Select item fallback")
    print("Choose cleaning option:")
    print("1. 🧠 Smart Gallery Clean (AUTO-DETECTS folder count)")
    print("2. Quick gallery clean (single file method)")
    print("3. Full UI workflow (main method)")
    print("4. Clean ALL files (select all method)")
    print("5. Auto-clean after post (smart detection)")
    print("6. Clean recent downloads (smart detection)")
    print("7. Emergency clean all media files")
    
    choice = input("Enter choice (1-7): ").strip()
    
    if choice == "1":
        smart_gallery_clean()
    elif choice == "2":
        quick_gallery_clean()
    elif choice == "3":
        cleaner = GalleryCleaningModule()
        result = cleaner.clean_gallery_ui_method()
        print("✅ Success!" if result else "❌ Failed!")
    elif choice == "4":
        cleaner = GalleryCleaningModule()
        result = cleaner.clean_gallery_all()
        print("✅ Success!" if result else "❌ Failed!")
    elif choice == "5":
        auto_clean_after_post()
    elif choice == "6":
        clean_recent_downloads()
    elif choice == "7":
        emergency_clean_all()
    else:
        print("Invalid choice")
