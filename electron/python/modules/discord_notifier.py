"""
📢 SHADOWPHONE DISCORD NOTIFIER
Sends real-time notifications to Discord for all automation events.
Dynamically fetches user's webhook URL from Supabase.
"""

import os
import requests
import subprocess
from datetime import datetime
from typing import Optional, Dict, Any

# ═══════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════

# Supabase configuration (check multiple env var names for Railway/Next.js compatibility)
SUPABASE_URL = (
    os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or 
    os.environ.get("SUPABASE_URL") or 
    ""
)
SUPABASE_ANON_KEY = (
    os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY") or
    os.environ.get("SUPABASE_ANON_KEY") or  # Some deployments use this
    ""
)

# Fallback webhook (only used if user hasn't configured one)
DEFAULT_WEBHOOK_URL = "https://discord.com/api/webhooks/1461537119280304353/iwPy0jLdsHDpaXyYcf83McO4SqKtaC9B_b6I0wQpUpEDtToMOi9FPSA7dUUQodZuBbTV"

# Cache for user webhooks (user_id -> webhook_url)
_webhook_cache: Dict[str, str] = {}
_current_user_id: Optional[str] = None

# SirenCY API - syncs events to Airtable for Project Mass dashboard
SIRENCY_WEBHOOK_URL = "https://www.sirency.com/api/airtable/fleet"


def set_user_id(user_id: str):
    """Set the current user ID for webhook lookups"""
    global _current_user_id
    _current_user_id = user_id
    print(f"[Discord] User ID set: {user_id[:8]}...")


def _fetch_user_webhook(user_id: str) -> Optional[str]:
    """Fetch user's Discord webhook URL from Supabase user_integrations table"""
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        print("[Discord] Supabase not configured, using default webhook")
        return None
    
    try:
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/user_integrations",
            params={
                "user_id": f"eq.{user_id}",
                "select": "discord_webhook"
            },
            headers={
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": f"Bearer {SUPABASE_ANON_KEY}"
            },
            timeout=5
        )
        
        if response.ok:
            data = response.json()
            if data and len(data) > 0 and data[0].get("discord_webhook"):
                webhook = data[0]["discord_webhook"]
                print(f"[Discord] Fetched user webhook from Supabase")
                return webhook
            else:
                print("[Discord] No webhook configured for user, using default")
        else:
            print(f"[Discord] Failed to fetch webhook: {response.status_code}")
    except Exception as e:
        print(f"[Discord] Error fetching webhook: {e}")
    
    return None


def get_webhook_url(user_id: Optional[str] = None) -> str:
    """Get the webhook URL for a user, with caching"""
    uid = user_id or _current_user_id
    
    if not uid:
        return DEFAULT_WEBHOOK_URL
    
    # Check cache first
    if uid in _webhook_cache:
        return _webhook_cache[uid]
    
    # Fetch from Supabase
    webhook = _fetch_user_webhook(uid)
    if webhook:
        _webhook_cache[uid] = webhook
        return webhook
    
    # Fallback to default
    _webhook_cache[uid] = DEFAULT_WEBHOOK_URL
    return DEFAULT_WEBHOOK_URL


def clear_webhook_cache(user_id: Optional[str] = None):
    """Clear cached webhook (call when user updates their settings)"""
    global _webhook_cache
    if user_id:
        _webhook_cache.pop(user_id, None)
    else:
        _webhook_cache = {}

# Event colors (Discord embed colors in decimal)
COLORS = {
    "info": 3447003,      # Blue
    "success": 3066993,   # Green
    "warning": 15105570,  # Orange
    "error": 15158332,    # Red
    "profile": 10181046,  # Purple
    "post": 15844367,     # Gold
    "story": 15277667,    # Pink
    "stats": 1752220,     # Teal
    "drive": 9807270,     # Gray-Blue
}

# Event emojis
EMOJIS = {
    "start": "🚀",
    "complete": "✅",
    "error": "❌",
    "warning": "⚠️",
    "profile_switch": "🔄",
    "post": "📸",
    "story": "📱",
    "stats": "📊",
    "drive": "☁️",
    "download": "⬇️",
    "upload": "⬆️",
    "account": "👤",
    "batch": "📦",
    "device": "📲",
}


def _get_connected_device() -> str:
    """Get the connected ADB device ID"""
    try:
        result = subprocess.run(
            ["adb", "devices"], 
            capture_output=True, 
            text=True, 
            timeout=5
        )
        lines = result.stdout.strip().split('\n')
        for line in lines[1:]:  # Skip header
            if '\tdevice' in line:
                return line.split('\t')[0]
        return "No device"
    except Exception:
        return "Unknown"


class DiscordNotifier:
    """
    Send Discord webhook notifications for automation events.
    Now fetches user-specific webhook from Supabase.
    
    Usage:
        notifier = get_notifier(user_id="user_123")
        notifier.set_context(device_id="RFCR1234", profile_id="10", username="username")
        notifier.profile_switch("username", 10)
    """
    
    def __init__(self, user_id: Optional[str] = None):
        self.user_id = user_id
        self.webhook_url = get_webhook_url(user_id)
        self.session_id = datetime.now().strftime("%H%M%S")
        self.device_id = _get_connected_device()
        self.current_profile_id = None
        self.current_username = None
        print(f"[Discord] Notifier initialized with webhook: {'User custom' if user_id else 'Default'}")
    
    def set_context(self, device_id: str = None, profile_id: str = None, username: str = None):
        """Set the current context for notifications"""
        if device_id:
            self.device_id = device_id
        if profile_id:
            self.current_profile_id = str(profile_id)
        if username:
            self.current_username = username
    
    def refresh_device(self):
        """Refresh the connected device ID"""
        self.device_id = _get_connected_device()
    
    def _send(self, title: str, description: str, color: int, 
              fields: Optional[list] = None, thumbnail: Optional[str] = None,
              profile_id: str = None, username: str = None):
        """Send embed to Discord webhook"""
        # Use provided context or fall back to stored context
        pid = profile_id or self.current_profile_id
        uname = username or self.current_username
        
        # Build footer with device and context info
        footer_parts = [f"Session {self.session_id}"]
        if self.device_id and self.device_id != "Unknown":
            footer_parts.insert(0, f"📲 {self.device_id}")
        if pid:
            footer_parts.append(f"Profile #{pid}")
        
        embed = {
            "title": title,
            "description": description,
            "color": color,
            "timestamp": datetime.utcnow().isoformat(),
            "footer": {"text": " • ".join(footer_parts)}
        }
        
        if fields:
            embed["fields"] = fields
        if thumbnail:
            embed["thumbnail"] = {"url": thumbnail}
        
        payload = {"embeds": [embed]}
        
        try:
            resp = requests.post(self.webhook_url, json=payload, timeout=5)
            return resp.status_code == 204
        except Exception as e:
            print(f"Discord notification failed: {e}")
            return False
    
    def _sync_airtable(self, event: str, username: str, data: Optional[Dict[str, Any]] = None):
        """Sync event to SirenCY/Airtable for Project Mass dashboard"""
        try:
            payload = {
                "action": "webhook",
                "event": event,
                "username": username,
                "data": data or {}
            }
            resp = requests.post(SIRENCY_WEBHOOK_URL, json=payload, timeout=5)
            if resp.status_code == 200:
                return True
            else:
                print(f"[Airtable sync] Failed: {resp.status_code}")
                return False
        except Exception as e:
            print(f"[Airtable sync] Error: {e}")
            return False
    
    # ═══════════════════════════════════════════════════════════════
    # AUTOMATION LIFECYCLE
    # ═══════════════════════════════════════════════════════════════
    
    def automation_start(self, automation_type: str, details: str = ""):
        """Notify automation started"""
        self._send(
            f"{EMOJIS['start']} Automation Started",
            f"**{automation_type}**\n{details}",
            COLORS["info"]
        )
    
    def automation_complete(self, automation_type: str, stats: Dict[str, Any] = None):
        """Notify automation completed"""
        fields = []
        if stats:
            for key, val in stats.items():
                fields.append({"name": key, "value": str(val), "inline": True})
        
        self._send(
            f"{EMOJIS['complete']} Automation Complete",
            f"**{automation_type}** finished successfully",
            COLORS["success"],
            fields=fields
        )
    
    def automation_error(self, automation_type: str, error: str):
        """Notify automation error"""
        self._send(
            f"{EMOJIS['error']} Automation Error",
            f"**{automation_type}**\n```{error[:500]}```",
            COLORS["error"]
        )
    
    # ═══════════════════════════════════════════════════════════════
    # PROFILE SWITCHING
    # ═══════════════════════════════════════════════════════════════
    
    def profile_switch(self, username: str, profile_id: int):
        """Notify profile switch"""
        self._send(
            f"{EMOJIS['profile_switch']} Profile Switch",
            f"Switching to **@{username}**",
            COLORS["profile"],
            fields=[{"name": "Profile ID", "value": str(profile_id), "inline": True}]
        )
    
    def profile_switch_complete(self, username: str, success: bool):
        """Notify profile switch result"""
        if success:
            self._send(
                f"{EMOJIS['complete']} Profile Ready",
                f"Now active: **@{username}**",
                COLORS["success"]
            )
        else:
            self._send(
                f"{EMOJIS['error']} Profile Switch Failed",
                f"Failed to switch to **@{username}**",
                COLORS["error"]
            )
        # Sync to Airtable
        self._sync_airtable("profile_switch", username, {"success": success})
    
    # ═══════════════════════════════════════════════════════════════
    # POSTING
    # ═══════════════════════════════════════════════════════════════
    
    def post_started(self, username: str, post_type: str = "post"):
        """Notify post started"""
        emoji = EMOJIS['post'] if post_type != "story" else EMOJIS['story']
        self._send(
            f"{emoji} {post_type.title()} Started",
            f"Creating {post_type} for **@{username}**",
            COLORS["post"]
        )
    
    def post_complete(self, username: str, post_type: str = "post", 
                      success: bool = True, details: str = ""):
        """Notify post result"""
        if success:
            self._send(
                f"{EMOJIS['complete']} {post_type.title()} Published",
                f"**@{username}**\n{details}",
                COLORS["success"]
            )
            # Sync to Airtable
            self._sync_airtable("post_complete", username, {"type": post_type})
        else:
            self._send(
                f"{EMOJIS['error']} {post_type.title()} Failed",
                f"**@{username}**\n{details}",
                COLORS["error"]
            )
    
    def story_started(self, username: str):
        """Notify story upload started"""
        self._send(
            f"{EMOJIS['story']} Story Started",
            f"Uploading story for **@{username}**",
            COLORS["story"]
        )
    
    def story_complete(self, username: str, success: bool = True):
        """Notify story result"""
        if success:
            self._send(
                f"{EMOJIS['complete']} Story Posted",
                f"**@{username}** story is live!",
                COLORS["success"]
            )
            # Sync to Airtable
            self._sync_airtable("story_complete", username)
        else:
            self._send(
                f"{EMOJIS['error']} Story Failed",
                f"Failed to post story for **@{username}**",
                COLORS["error"]
            )
    
    # ═══════════════════════════════════════════════════════════════
    # DRIVE OPERATIONS
    # ═══════════════════════════════════════════════════════════════
    
    def drive_sync_started(self, folder_name: str, file_count: int = 0):
        """Notify Drive sync started"""
        self._send(
            f"{EMOJIS['drive']} Drive Sync Started",
            f"Syncing **{folder_name}**",
            COLORS["drive"],
            fields=[{"name": "Files", "value": str(file_count), "inline": True}] if file_count else None
        )
    
    def drive_download(self, filename: str, folder: str):
        """Notify file downloaded from Drive"""
        self._send(
            f"{EMOJIS['download']} File Downloaded",
            f"`{filename}`\nFrom: **{folder}**",
            COLORS["drive"]
        )
    
    def drive_sync_complete(self, folder_name: str, files_synced: int):
        """Notify Drive sync complete"""
        self._send(
            f"{EMOJIS['complete']} Drive Sync Complete",
            f"**{folder_name}**",
            COLORS["success"],
            fields=[{"name": "Files Synced", "value": str(files_synced), "inline": True}]
        )
    
    # ═══════════════════════════════════════════════════════════════
    # STATS SCRAPING
    # ═════════════════════════════════════════════════════════���═════
    
    def stats_started(self, account_count: int):
        """Notify stats scraping started"""
        self._send(
            f"{EMOJIS['stats']} Stats Scraping Started",
            f"Scraping **{account_count}** accounts",
            COLORS["stats"]
        )
    
    def stats_progress(self, done: int, total: int):
        """Notify stats progress"""
        pct = int((done / total) * 100) if total > 0 else 0
        bar = "█" * (pct // 10) + "░" * (10 - pct // 10)
        self._send(
            f"{EMOJIS['stats']} Stats Progress",
            f"`{bar}` {pct}%\n{done}/{total} accounts",
            COLORS["stats"]
        )
    
    def stats_complete(self, total: int, created: int, skipped: int = 0):
        """Notify stats complete"""
        self._send(
            f"{EMOJIS['complete']} Stats Complete",
            f"Daily stats logged for **{created}** accounts",
            COLORS["success"],
            fields=[
                {"name": "Total", "value": str(total), "inline": True},
                {"name": "Created", "value": str(created), "inline": True},
                {"name": "Skipped", "value": str(skipped), "inline": True},
            ]
        )
    
    def stats_account(self, username: str, followers: int, health: str, quality: int):
        """Notify individual account stats (use sparingly)"""
        emoji = {
            "Viral": "🔥",
            "Growing": "📈",
            "Healthy": "✅",
            "Stagnant": "⚠️",
            "Declining": "📉",
            "Dead": "💀"
        }.get(health, "📊")
        
        self._send(
            f"{emoji} @{username}",
            f"**{followers:,}** followers | Quality: **{quality}**/100",
            COLORS["stats"],
            fields=[{"name": "Health", "value": health, "inline": True}]
        )
    
    # ═══════════════════════════════════════════════════════════════
    # BATCH OPERATIONS
    # ═══════════════════════════════════════════════════════════════
    
    def batch_started(self, operation: str, count: int):
        """Notify batch operation started"""
        self._send(
            f"{EMOJIS['batch']} Batch {operation} Started",
            f"Processing **{count}** items",
            COLORS["info"]
        )
    
    def batch_progress(self, operation: str, current: int, total: int, current_item: str = ""):
        """Notify batch progress"""
        self._send(
            f"{EMOJIS['batch']} Batch Progress",
            f"**{operation}**: {current}/{total}\n{current_item}",
            COLORS["info"]
        )
    
    def batch_complete(self, operation: str, success: int, failed: int = 0):
        """Notify batch complete"""
        self._send(
            f"{EMOJIS['complete']} Batch Complete",
            f"**{operation}** finished",
            COLORS["success"],
            fields=[
                {"name": "Success", "value": str(success), "inline": True},
                {"name": "Failed", "value": str(failed), "inline": True},
            ]
        )
    
    # ═══════════════════════════════════════════════════════════════
    # GENERIC NOTIFICATIONS
    # ═══════════════════════════════════════════════════════════════
    
    def info(self, title: str, message: str):
        """Send info notification"""
        self._send(f"ℹ️ {title}", message, COLORS["info"])
    
    def success(self, title: str, message: str):
        """Send success notification"""
        self._send(f"✅ {title}", message, COLORS["success"])
    
    def warning(self, title: str, message: str):
        """Send warning notification"""
        self._send(f"⚠️ {title}", message, COLORS["warning"])
    
    def error(self, title: str, message: str):
        """Send error notification"""
        self._send(f"❌ {title}", message, COLORS["error"])
    
    # ═══════════════════════════════════════════════════════════════
    # SESSION TRACKING (Full Auto Mode)
    # ═══════════════════════════════════════════════════════════════
    
    def session_start(self, profiles: list, expected_duration: str = "Unknown"):
        """
        Notify when auto mode session starts.
        
        Args:
            profiles: List of dicts with keys: name, type (model/clone), actions
            expected_duration: Formatted duration string (e.g., "1h 30m")
        """
        # Build profile list with type badges
        profile_lines = []
        for p in profiles[:10]:  # Max 10 to avoid embed limit
            name = p.get('name', 'Unknown')
            ptype = p.get('type', 'unknown')
            type_badge = "👑" if ptype == 'model' else "🔄" if ptype == 'clone' else "📱"
            actions = p.get('actions', [])
            action_str = ", ".join(actions[:4]) if actions else "all"
            profile_lines.append(f"{type_badge} **{name}** → {action_str}")
        
        if len(profiles) > 10:
            profile_lines.append(f"... and {len(profiles) - 10} more")
        
        profile_list = "\n".join(profile_lines) if profile_lines else "No profiles selected"
        
        self._send(
            "🚀 AUTO MODE STARTED",
            f"**{len(profiles)} profiles** queued for execution",
            COLORS["info"],
            fields=[
                {"name": "📋 Profiles", "value": profile_list, "inline": False},
                {"name": "⏱️ Expected Duration", "value": expected_duration, "inline": True},
                {"name": "🕐 Started", "value": datetime.now().strftime("%I:%M %p"), "inline": True},
            ]
        )
        
        # Sync each profile to Airtable as 'Running'
        for p in profiles:
            name = p.get('name', '')
            if name:
                self._sync_airtable("session_start", name)
    
    def session_complete(self, total_time_seconds: float, profile_results: dict):
        """
        Notify when auto mode session ends with full summary.
        
        Args:
            total_time_seconds: Total runtime in seconds
            profile_results: Dict of profile_id -> {name, type, actions: {post, story, engagement, follow}}
                            Each action value: 'success', 'failed', 'skipped'
        """
        # Format duration
        hours = int(total_time_seconds // 3600)
        minutes = int((total_time_seconds % 3600) // 60)
        secs = int(total_time_seconds % 60)
        
        if hours > 0:
            duration_str = f"{hours}h {minutes}m {secs}s"
        elif minutes > 0:
            duration_str = f"{minutes}m {secs}s"
        else:
            duration_str = f"{secs}s"
        
        # Build results summary
        result_lines = []
        total_success = 0
        total_actions = 0
        
        for pid, data in profile_results.items():
            name = data.get('name', f'Profile {pid}')
            ptype = data.get('type', 'unknown')
            type_badge = "👑" if ptype == 'model' else "🔄" if ptype == 'clone' else "📱"
            
            actions = data.get('actions', {})
            action_icons = []
            for action, status in actions.items():
                total_actions += 1
                if status == 'success':
                    total_success += 1
                    action_icons.append(f"✅{action[0].upper()}")
                elif status == 'failed':
                    action_icons.append(f"❌{action[0].upper()}")
                elif status == 'skipped':
                    action_icons.append(f"⏭️{action[0].upper()}")
            
            action_str = " ".join(action_icons) if action_icons else "—"
            result_lines.append(f"{type_badge} **{name}**: {action_str}")
        
        result_text = "\n".join(result_lines[:15]) if result_lines else "No profiles processed"
        if len(result_lines) > 15:
            result_text += f"\n... and {len(result_lines) - 15} more"
        
        # Determine overall status
        success_rate = (total_success / total_actions * 100) if total_actions > 0 else 0
        if success_rate >= 90:
            title = "✅ AUTO MODE COMPLETE"
            color = COLORS["success"]
        elif success_rate >= 50:
            title = "⚠️ AUTO MODE COMPLETE (with issues)"
            color = COLORS["warning"]
        else:
            title = "❌ AUTO MODE COMPLETE (many failures)"
            color = COLORS["error"]
        
        self._send(
            title,
            f"Session finished after **{duration_str}**",
            color,
            fields=[
                {"name": "📊 Results", "value": result_text, "inline": False},
                {"name": "⏱️ Total Time", "value": duration_str, "inline": True},
                {"name": "✅ Success Rate", "value": f"{success_rate:.0f}%", "inline": True},
                {"name": "📱 Profiles", "value": str(len(profile_results)), "inline": True},
            ]
        )
        
        # Sync each profile to Airtable with their results
        for pid, data in profile_results.items():
            name = data.get('name', '')
            if name:
                actions = data.get('actions', {})
                self._sync_airtable("session_complete", name, {"actions": actions})
    
    # ═══════════════════════════════════════════════════════════════
    # SCHEDULED MODE TRACKING
    # ═══════════════════════════════════════════════════════════════
    
    def scheduled_slot_start(self, username: str, profile_id: str, slot_time: str, 
                             content_type: str, slots_remaining: int = 0):
        """
        Notify when a scheduled slot begins execution.
        
        Args:
            username: Account username
            profile_id: Profile ID
            slot_time: Scheduled time string (e.g., "09:00")
            content_type: Type of content (image/reel/trial)
            slots_remaining: How many slots left in today's queue
        """
        type_emoji = {
            "image": "🖼️",
            "reel": "🎬",
            "trial": "🆓",
            "video": "📹"
        }.get(content_type, "📸")
        
        self._send(
            f"📅 Scheduled Slot Started",
            f"**@{username}** • {slot_time}",
            COLORS["info"],
            fields=[
                {"name": "📁 Content", "value": f"{type_emoji} {content_type.title()}", "inline": True},
                {"name": "🆔 Profile", "value": str(profile_id), "inline": True},
                {"name": "📊 Remaining Today", "value": str(slots_remaining), "inline": True},
            ]
        )
        
        # Sync to Airtable
        self._sync_airtable("scheduled_start", username, {
            "slot_time": slot_time,
            "content_type": content_type,
            "profile_id": profile_id
        })
    
    def scheduled_slot_complete(self, username: str, profile_id: str, slot_time: str,
                                duration_seconds: float, success: bool = True, 
                                actions_completed: dict = None):
        """
        Notify when a scheduled slot finishes.
        
        Args:
            username: Account username
            profile_id: Profile ID  
            slot_time: Scheduled time string (e.g., "09:00")
            duration_seconds: How long the slot took to execute
            success: Whether the slot completed successfully
            actions_completed: Dict of action -> status (e.g., {"post": "success", "story": "success"})
        """
        # Format duration
        mins = int(duration_seconds // 60)
        secs = int(duration_seconds % 60)
        duration_str = f"{mins}m {secs}s" if mins > 0 else f"{secs}s"
        
        # Build action summary
        action_icons = []
        if actions_completed:
            for action, status in actions_completed.items():
                icon = "✅" if status == "success" else "❌" if status == "failed" else "⏭️"
                action_icons.append(f"{icon}{action[0].upper()}")
        action_str = " ".join(action_icons) if action_icons else "—"
        
        if success:
            self._send(
                f"✅ Scheduled Slot Complete",
                f"**@{username}** • {slot_time}",
                COLORS["success"],
                fields=[
                    {"name": "⏱️ Duration", "value": duration_str, "inline": True},
                    {"name": "📋 Actions", "value": action_str, "inline": True},
                    {"name": "🆔 Profile", "value": str(profile_id), "inline": True},
                ]
            )
        else:
            self._send(
                f"❌ Scheduled Slot Failed",
                f"**@{username}** • {slot_time}",
                COLORS["error"],
                fields=[
                    {"name": "⏱️ Duration", "value": duration_str, "inline": True},
                    {"name": "📋 Actions", "value": action_str, "inline": True},
                    {"name": "🆔 Profile", "value": str(profile_id), "inline": True},
                ]
            )
        
        # Sync to Airtable
        self._sync_airtable("scheduled_complete", username, {
            "slot_time": slot_time,
            "profile_id": profile_id,
            "duration_seconds": duration_seconds,
            "success": success,
            "actions": actions_completed or {}
        })
    
    def scheduled_mode_start(self, total_slots: int, profiles_enabled: int):
        """Notify when scheduled mode is activated"""
        self._send(
            "📅 SCHEDULED MODE ACTIVATED",
            f"Monitoring **{total_slots}** slots across **{profiles_enabled}** profiles",
            COLORS["info"],
            fields=[
                {"name": "🕐 Started", "value": datetime.now().strftime("%I:%M %p"), "inline": True},
                {"name": "📊 Total Slots", "value": str(total_slots), "inline": True},
                {"name": "👤 Profiles", "value": str(profiles_enabled), "inline": True},
            ]
        )
    
    def scheduled_day_complete(self, slots_run: int, total_duration_seconds: float):
        """Notify when all scheduled slots for the day are complete"""
        hours = int(total_duration_seconds // 3600)
        mins = int((total_duration_seconds % 3600) // 60)
        duration_str = f"{hours}h {mins}m" if hours > 0 else f"{mins}m"
        
        self._send(
            "🌙 Scheduled Day Complete",
            f"All **{slots_run}** slots finished for today",
            COLORS["success"],
            fields=[
                {"name": "⏱️ Total Runtime", "value": duration_str, "inline": True},
                {"name": "📊 Slots Run", "value": str(slots_run), "inline": True},
                {"name": "🔜 Next", "value": "Tomorrow", "inline": True},
            ]
        )


# ═══════════════════════════════════════════════════════════════════
# SINGLETON INSTANCE (per-user)
# ═══════════════════════════════════════════════════════════════════
_notifiers: Dict[str, DiscordNotifier] = {}
_default_notifier: Optional[DiscordNotifier] = None

def get_notifier(user_id: Optional[str] = None) -> DiscordNotifier:
    """
    Get notifier instance for a user. Creates new instance if needed.
    Each user gets their own notifier with their configured webhook.
    """
    global _notifiers, _default_notifier, _current_user_id
    
    uid = user_id or _current_user_id
    
    if uid:
        if uid not in _notifiers:
            _notifiers[uid] = DiscordNotifier(user_id=uid)
        return _notifiers[uid]
    
    # Fallback to default notifier (no user context)
    if _default_notifier is None:
        _default_notifier = DiscordNotifier()
    return _default_notifier


def refresh_notifier(user_id: Optional[str] = None):
    """Force refresh of notifier (e.g., after user updates webhook in settings)"""
    global _notifiers, _default_notifier
    
    clear_webhook_cache(user_id)
    
    if user_id and user_id in _notifiers:
        del _notifiers[user_id]
    elif not user_id:
        _notifiers = {}
        _default_notifier = None

# Convenience functions
def notify_profile_switch(username: str, profile_id: int):
    get_notifier().profile_switch(username, profile_id)

def notify_post(username: str, post_type: str, success: bool):
    get_notifier().post_complete(username, post_type, success)

def notify_story(username: str, success: bool):
    get_notifier().story_complete(username, success)

def notify_stats(total: int, created: int, skipped: int = 0):
    get_notifier().stats_complete(total, created, skipped)

def notify_error(context: str, error: str):
    get_notifier().error(context, error)


# ═══════════════════════════════════════════════════════════════════
# TEST
# ═══════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    notifier = DiscordNotifier()
    
    print("Testing Discord notifications...")
    
    # Test automation lifecycle
    notifier.automation_start("Daily Stats Scraper", "Processing 77 accounts")
    
    # Test profile switch
    notifier.profile_switch("realjocelynxo", 10)
    notifier.profile_switch_complete("realjocelynxo", True)
    
    # Test posting
    notifier.post_started("realjocelynxo", "reels")
    notifier.post_complete("realjocelynxo", "reels", True, "Posted to feed!")
    
    # Test stats
    notifier.stats_started(77)
    notifier.stats_complete(77, 75, 2)
    
    print("Done! Check Discord.")
