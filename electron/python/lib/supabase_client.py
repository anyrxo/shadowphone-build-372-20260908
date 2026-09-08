"""
Supabase Client for Python Modules
Fetches account configuration data from Supabase instead of local files
"""
import os
import requests
from typing import Optional, Dict, Any, List

# Get Supabase URL and service role key from environment
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
if not SUPABASE_URL:
    print("[Supabase] WARNING: SUPABASE_URL not set in environment variables")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


class SupabaseClient:
    """Simple Supabase REST client for Python modules"""
    
    def __init__(self, url: str = None, key: str = None):
        self.url = url or SUPABASE_URL
        self.key = key or SUPABASE_KEY
        self.headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation"
        }
    
    def _request(self, method: str, endpoint: str, data: dict = None) -> dict:
        """Make request to Supabase REST API"""
        url = f"{self.url}/rest/v1/{endpoint}"
        try:
            response = requests.request(method, url, headers=self.headers, json=data, timeout=10)
            if response.status_code >= 400:
                print(f"[Supabase] Error {response.status_code}: {response.text}")
                return None
            return response.json() if response.text else {}
        except Exception as e:
            print(f"[Supabase] Request error: {e}")
            return None
    
    def get_account_by_username(self, username: str, user_id: str = None) -> Optional[Dict[str, Any]]:
        """Get account config by Instagram username"""
        query = f"instagram_accounts?username=eq.{username}"
        if user_id:
            query += f"&user_id=eq.{user_id}"
        query += "&limit=1"
        
        result = self._request("GET", query)
        return result[0] if result and len(result) > 0 else None
    
    def get_account_drive_config(self, username: str) -> Optional[Dict[str, str]]:
        """Get all config for an account"""
        account = self.get_account_by_username(username)
        if account:
            return {
                # Content source
                "drive_url": account.get("drive_link"),
                "content_folder": account.get("content_folder"),
                "content_subfolder": account.get("content_subfolder"),
                # Story settings
                "story_link_url": account.get("story_link_url"),
                "story_mention_target": account.get("story_mention_target"),
                # Source & type
                "account_type": account.get("account_type"),
                "source_handle": account.get("source_handle"),
                "source_platform": account.get("source_platform"),
                # Caption
                "fixed_caption": account.get("fixed_caption"),
                # Identity
                "profile_name": account.get("username"),
                "phone_profile_id": account.get("phone_profile_id")
            }
        return None
    
    def get_accounts_for_user(self, user_id: str) -> List[Dict[str, Any]]:
        """Get all accounts for a user"""
        query = f"instagram_accounts?user_id=eq.{user_id}&is_enabled=eq.true"
        result = self._request("GET", query)
        return result if result else []
    
    def update_account(self, account_id: str, updates: Dict[str, Any]) -> bool:
        """Update account fields"""
        query = f"instagram_accounts?id=eq.{account_id}"
        result = self._request("PATCH", query, updates)
        return result is not None


# Singleton instance
_client: Optional[SupabaseClient] = None


def get_supabase_client() -> SupabaseClient:
    """Get singleton Supabase client"""
    global _client
    if _client is None:
        _client = SupabaseClient()
    return _client


def get_drive_url_for_account(username: str) -> Optional[str]:
    """Helper to quickly get Drive URL for an account"""
    client = get_supabase_client()
    config = client.get_account_drive_config(username)
    return config.get("drive_url") if config else None


def get_story_link_for_account(username: str) -> Optional[str]:
    """Helper to quickly get story link URL for an account"""
    client = get_supabase_client()
    config = client.get_account_drive_config(username)
    return config.get("story_link_url") if config else None


def get_username_by_profile_id(profile_id: int, user_id: str = None) -> Optional[str]:
    """Get Instagram username by phone profile ID (for legacy modules)"""
    client = get_supabase_client()
    query = f"instagram_accounts?phone_profile_id=eq.{profile_id}"
    if user_id:
        query += f"&user_id=eq.{user_id}"
    query += "&limit=1"
    
    result = client._request("GET", query)
    if result and len(result) > 0:
        return result[0].get("username")
    return None


def get_full_account_config(username: str = None, profile_id: int = None) -> Optional[Dict[str, Any]]:
    """Get complete account config by username OR profile_id"""
    client = get_supabase_client()
    
    # If profile_id provided, first lookup username
    if profile_id and not username:
        username = get_username_by_profile_id(profile_id)
    
    if not username:
        return None
    
    return client.get_account_drive_config(username)


def get_fixed_caption_for_account(username: str) -> Optional[str]:
    """Get fixed caption text for an account"""
    config = get_full_account_config(username=username)
    return config.get("fixed_caption") if config else None


def get_story_mention_target(username: str) -> Optional[str]:
    """Get story mention target for an account"""
    config = get_full_account_config(username=username)
    return config.get("story_mention_target") if config else None


# ═══════════════════════════════════════════════════════════════════
# MODULE SETTINGS - User-configurable automation parameters
# ═══════════════════════════════════════════════════════════════════

# Default settings for each module (based on existing hardcoded values)
DEFAULT_MODULE_SETTINGS = {
    "engagement": {
        "like_chance": 80,           # % chance to like (0-100)
        "comment_chance": 15,        # % chance to comment (0-100)
        "feed_ratio": 33,            # % home feed vs reels (0-100)
        "jitter_range": 30,          # Pixel variance for taps
        "micro_pause_min": 0.05,     # Min pause between actions (s)
        "micro_pause_max": 0.20,     # Max pause between actions (s)
        "quick_scroll_min": 0.3,     # Quick scroll view time
        "quick_scroll_max": 0.8,
        "brief_view_min": 0.8,       # Brief view time
        "brief_view_max": 1.5,
        "engaged_view_min": 1.5,     # Engaged view time
        "engaged_view_max": 2.5,
        "deep_view_min": 2.5,        # Deep view time
        "deep_view_max": 4.0,
    },
    "story": {
        "like_chance_min": 23,       # Min % chance to like story
        "like_chance_max": 33,       # Max % chance to like story
        "viewing_time_min": 0.96,    # Min view time (s)
        "viewing_time_max": 3.94,    # Max view time (s)
        "skip_chance": 12,           # % chance to skip story quickly
        "base_like_chance": 28,      # Base like % for human mode
        "jitter_range": 30,          # Pixel variance
    },
}


def get_module_settings(user_id: str, module_name: str) -> Dict[str, Any]:
    """Get module settings for a user, falling back to defaults"""
    client = get_supabase_client()
    
    # Try to fetch from database
    query = f"module_settings?user_id=eq.{user_id}&module_name=eq.{module_name}&limit=1"
    result = client._request("GET", query)
    
    if result and len(result) > 0:
        # Merge with defaults (user settings override)
        defaults = DEFAULT_MODULE_SETTINGS.get(module_name, {})
        user_settings = result[0].get("settings", {})
        return {**defaults, **user_settings}
    
    # Return defaults if no user settings
    return DEFAULT_MODULE_SETTINGS.get(module_name, {})


def update_module_settings(user_id: str, module_name: str, settings: Dict[str, Any]) -> bool:
    """Update or create module settings for a user"""
    client = get_supabase_client()
    
    # Use upsert (insert or update)
    data = {
        "user_id": user_id,
        "module_name": module_name,
        "settings": settings,
        "updated_at": "now()"
    }
    
    # Check if exists
    query = f"module_settings?user_id=eq.{user_id}&module_name=eq.{module_name}"
    existing = client._request("GET", query)
    
    if existing and len(existing) > 0:
        # Update existing
        result = client._request("PATCH", query, {"settings": settings})
    else:
        # Insert new
        result = client._request("POST", "module_settings", data)
    
    return result is not None


def get_engagement_settings(user_id: str = None) -> Dict[str, Any]:
    """Shortcut to get engagement module settings"""
    if user_id:
        return get_module_settings(user_id, "engagement")
    return DEFAULT_MODULE_SETTINGS["engagement"].copy()


def get_story_settings(user_id: str = None) -> Dict[str, Any]:
    """Shortcut to get story module settings"""
    if user_id:
        return get_module_settings(user_id, "story")
    return DEFAULT_MODULE_SETTINGS["story"].copy()

