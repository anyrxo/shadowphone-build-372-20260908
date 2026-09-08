
import time
import re
from .post_story_module import InstagramStoryPoster
from .ig_selectors import InstagramSelectors

class StatsScraper(InstagramStoryPoster):
    """
    Extends InstagramStoryPoster to include Profile Stats Scraping capabilities.
    Uses Verified Selectors from ig_selectors.py
    """
    
    def __init__(self, device_id, account_number=0):
        super().__init__(device_id, account_number)
        
    def scrape_current_profile(self):
        """
        Scrapes stats from the CURRENTLY logged in profile (Profile Tab).
        Assumes already handled account switching.
        """
        print(f"📊 Scraping stats for current profile (Profile {self.profile_id})...")
        
        # 1. Go to Profile Tab
        if not self.go_to_profile_tab():
            print("❌ Failed to navigate to Profile Tab")
            return None
            
        time.sleep(3) # Wait for load
        
        # 2. Read Stats
        stats = self._read_stats_from_ui()
        if stats:
            print(f"✅ Scraped Stats: {stats}")
        return stats

    def scrape_external_profile(self, target_username):
        """
        Scrapes stats for an EXTERNAL profile (via Search).
        Useful for Clones or Competitors.
        """
        print(f"📊 Scraping external stats for: {target_username}")
        
        # 1. Search and Open Profile
        # We reuse the robust search logic (or implement a simple one here)
        # For now, simple implementation:
        
        # Go to Search Tab
        self.tap(*InstagramSelectors.Coords.NAV_SEARCH_TAB)
        time.sleep(2)
        
        # Click search bar
        self.tap(540, 150) # Approx search bar top
        time.sleep(1)
        
        # Type username
        self.input_text(target_username)
        time.sleep(2)
        
        # Click first result (Accounts tab usually safer but 'Top' works for exact match)
        # TODO: Use specific selector for first result if needed. 
        # For now, simplistic tap at top result
        self.tap(540, 400) 
        time.sleep(4)
        
        # Verify we are on profile (check for username or 'Message' button)
        # TODO: Verification logic
        
        # 2. Read Stats
        stats = self._read_stats_from_ui()
        return stats

    def _read_stats_from_ui(self):
        """
        Reads Posts, Followers, Following using Golden Selectors
        """
        try:
            # We need to get the UI dump to read text values
            # Using ADB to dump and verify
            
            # Helper to get text by ID
            def get_text(resource_id):
                # This requires a method to get text from UI hierarchy.
                # Since we don't have a direct 'get_text(id)' in the parent class (it creates XML dumps manually),
                # we should use the `get_ui_dump` method from `drive_module_improved` logic or similar.
                # But `InstagramStoryPoster` doesn't have `get_ui_dump`? 
                # Wait, I saw `get_ui_dump` in `ImprovedDriveManager`.
                # I should implement a lightweight parser here.
                return None 

            # Actually, `InstagramStoryPoster` inherits `InstagramPoster` or similar? 
            # I need `get_ui_dump` logic.
            # I'll implement a simple one here reusing `subprocess`.
            pass 
            
        except Exception as e:
            print(f"❌ Error reading stats: {e}")
            return None
            
        # Re-implementing robust UI dump logic for stats
        from .drive_module_improved import ImprovedDriveManager
        # Leveraged parsing logic from drive manager without init overhead?
        # Or just copy the logic.
        
        # Let's copy the `get_ui_dump` logic for simplicity to keep this module self-contained 
        # but inheriting from Base.
        
        return self._manual_ui_dump_scrape()

    def _manual_ui_dump_scrape(self):
        """
        Performs adb dump and extracts verified IDs.
        """
        import xml.etree.ElementTree as ET
        import os
        
        filename = "stats_dump.xml"
        local_path = f"/tmp/{filename}"
        
        # Dump
        self.adb("shell", "uiautomator", "dump", f"/sdcard/{filename}")
        self.adb("pull", f"/sdcard/{filename}", local_path)
        
        stats = {"posts": 0, "followers": 0, "following": 0}
        
        try:
            tree = ET.parse(local_path)
            root = tree.getroot()
            
            # Selectors from ig_selectors.py
            ID_POSTS = "com.instagram.android:id/profile_header_familiar_post_count_value"
            ID_FOLLOWERS = "com.instagram.android:id/profile_header_familiar_followers_value"
            ID_FOLLOWING = "com.instagram.android:id/profile_header_familiar_following_value"
            
            # Also support the "stacked" view for smaller screens (sometimes different IDs)
            # But the 'familiar' IDs are usually consistent on new layout.
            
            for node in root.iter("node"):
                res_id = node.attrib.get("resource-id", "")
                text = node.attrib.get("text", "")
                
                if res_id == ID_POSTS:
                    stats["posts"] = self._parse_number(text)
                elif res_id == ID_FOLLOWERS:
                    stats["followers"] = self._parse_number(text)
                elif res_id == ID_FOLLOWING:
                    stats["following"] = self._parse_number(text)
                    
            # Cleanup
            try: os.remove(local_path) 
            except: pass
            
            return stats
            
        except Exception as e:
            print(f"Stats parse error: {e}")
            return None

    def _parse_number(self, text):
        """Converts '1,234' or '1.5M' to integers"""
        if not text: return 0
        text = text.upper().strip()
        multiplier = 1
        if "K" in text:
            multiplier = 1000
            text = text.replace("K", "")
        elif "M" in text:
            multiplier = 1000000
            text = text.replace("M", "")
            
        try:
            # Handle commas
            text = text.replace(",", "")
            return int(float(text) * multiplier)
        except:
            return 0
