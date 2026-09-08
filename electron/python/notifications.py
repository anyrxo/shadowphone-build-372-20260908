"""
Desktop Toast Notifications Module
===================================
Provides Windows desktop notifications for AUTO mode progress updates.
Uses plyer for cross-platform native toast notifications.

Features:
- Notification levels: CRITICAL, SUCCESS, INFO, PROGRESS
- Rate limiting to avoid notification spam
- Sound alerts for critical events
- Profile-aware messaging
"""

import time
import threading
from datetime import datetime
from typing import Optional

# Try to import plyer for native notifications
try:
    from plyer import notification as plyer_notification
    PLYER_AVAILABLE = True
except ImportError:
    PLYER_AVAILABLE = False
    print("⚠️ plyer not installed - desktop notifications disabled. Run: pip install plyer")


class NotificationLevel:
    """Notification importance levels"""
    CRITICAL = "critical"   # Errors, failures - always show
    SUCCESS = "success"     # Completed tasks - show unless muted
    INFO = "info"           # Status updates - optional
    PROGRESS = "progress"   # Step-by-step progress - rate limited


class DashboardNotifier:
    """
    Desktop notification manager for the automation dashboard.
    
    Features:
    - Windows toast notifications via plyer
    - Rate limiting to prevent spam
    - Configurable notification levels
    - Thread-safe operation
    """
    
    # App info for notifications
    APP_NAME = "IG Automation"
    APP_ICON = None  # Will use default system icon
    
    # Rate limiting settings
    MIN_PROGRESS_INTERVAL = 5.0  # Minimum seconds between progress notifications
    MIN_INFO_INTERVAL = 3.0      # Minimum seconds between info notifications
    
    def __init__(self, enabled: bool = True, level: str = "success"):
        """
        Initialize the notification manager.
        
        Args:
            enabled: Whether notifications are enabled
            level: Minimum level to show - "critical", "success", "info", or "progress"
        """
        self.enabled = enabled
        self._level = level.lower()
        self._last_progress_time = 0
        self._last_info_time = 0
        self._lock = threading.Lock()
        
        # Level hierarchy
        self._level_priority = {
            "critical": 4,
            "success": 3,
            "info": 2,
            "progress": 1
        }
    
    @property
    def level(self):
        return self._level
    
    @level.setter
    def level(self, value: str):
        self._level = value.lower()
    
    def _should_show(self, level: str) -> bool:
        """Check if notification should be shown based on level settings"""
        if not self.enabled:
            return False
        if not PLYER_AVAILABLE:
            return False
        
        current_priority = self._level_priority.get(level, 1)
        min_priority = self._level_priority.get(self._level, 3)
        
        return current_priority >= min_priority
    
    def _can_show_rate_limited(self, level: str) -> bool:
        """Check rate limiting for progress/info notifications"""
        current_time = time.time()
        
        with self._lock:
            if level == "progress":
                if current_time - self._last_progress_time < self.MIN_PROGRESS_INTERVAL:
                    return False
                self._last_progress_time = current_time
            elif level == "info":
                if current_time - self._last_info_time < self.MIN_INFO_INTERVAL:
                    return False
                self._last_info_time = current_time
        
        return True
    
    def _send_notification(self, title: str, message: str, timeout: int = 5):
        """Send a Windows toast notification"""
        if not PLYER_AVAILABLE:
            print(f"[NOTIFY] {title}: {message}")
            return
        
        try:
            # Run notification in thread to avoid blocking
            def send():
                try:
                    plyer_notification.notify(
                        title=title,
                        message=message,
                        app_name=self.APP_NAME,
                        app_icon=self.APP_ICON,
                        timeout=timeout
                    )
                except Exception as e:
                    print(f"[NOTIFY ERROR] {e}")
            
            threading.Thread(target=send, daemon=True).start()
        except Exception as e:
            print(f"[NOTIFY THREAD ERROR] {e}")
    
    # === Public Notification Methods ===
    
    def notify_profile_switch(self, profile_name: str, profile_id: str):
        """Notify when switching to a new profile"""
        if not self._should_show("progress"):
            return
        if not self._can_show_rate_limited("progress"):
            return
        
        self._send_notification(
            title="🔄 Profile Switch",
            message=f"Now running: {profile_name} (ID: {profile_id})",
            timeout=4
        )
    
    def notify_step_start(self, profile_name: str, step_name: str):
        """Notify when starting a major step (IG track, X track, etc)"""
        if not self._should_show("progress"):
            return
        if not self._can_show_rate_limited("progress"):
            return
        
        # Use appropriate emoji based on step
        emoji = "🚀"
        if "instagram" in step_name.lower() or "ig" in step_name.lower():
            emoji = "📷"
        elif "twitter" in step_name.lower() or " x " in step_name.lower():
            emoji = "🐦"
        elif "tiktok" in step_name.lower():
            emoji = "🎵"
        elif "vpn" in step_name.lower():
            emoji = "🔐"
        elif "airplane" in step_name.lower():
            emoji = "✈️"
        
        self._send_notification(
            title=f"{emoji} {profile_name}",
            message=f"Starting: {step_name}",
            timeout=4
        )
    
    def notify_success(self, profile_name: str, message: str):
        """Notify on successful completion of a task"""
        if not self._should_show("success"):
            return
        
        self._send_notification(
            title=f"✅ {profile_name}",
            message=message,
            timeout=5
        )
    
    def notify_cycle_complete(self, profiles_done: int, total_time_seconds: int, next_cycle: Optional[str] = None):
        """Notify when a full automation cycle completes"""
        if not self._should_show("success"):
            return
        
        # Format time nicely
        minutes = total_time_seconds // 60
        seconds = total_time_seconds % 60
        time_str = f"{minutes}m {seconds}s" if minutes > 0 else f"{seconds}s"
        
        message = f"Completed {profiles_done} profiles in {time_str}"
        if next_cycle:
            message += f"\nNext cycle: {next_cycle}"
        
        self._send_notification(
            title="🎉 Fleet Cycle Complete!",
            message=message,
            timeout=8
        )
    
    def notify_error(self, profile_name: str, error_message: str):
        """Notify on error (always shows unless notifications disabled)"""
        if not self._should_show("critical"):
            return
        
        self._send_notification(
            title=f"❌ Error: {profile_name}",
            message=error_message[:100],  # Truncate long errors
            timeout=10
        )
    
    def notify_warning(self, message: str):
        """Notify on warning condition"""
        if not self._should_show("info"):
            return
        if not self._can_show_rate_limited("info"):
            return
        
        self._send_notification(
            title="⚠️ Warning",
            message=message,
            timeout=6
        )
    
    def notify_profile_update(self, old_count: int, new_count: int):
        """Notify when profiles are detected/changed"""
        if not self._should_show("info"):
            return
        
        if new_count > old_count:
            message = f"Detected {new_count - old_count} new profile(s)!"
        elif new_count < old_count:
            message = f"{old_count - new_count} profile(s) removed"
        else:
            return  # No change
        
        self._send_notification(
            title="📱 Profile Update",
            message=message,
            timeout=5
        )
    
    def notify_auto_mode_started(self, profile_count: int):
        """Notify when AUTO mode begins"""
        if not self._should_show("success"):
            return
        
        self._send_notification(
            title="🚀 AUTO Mode Started",
            message=f"Running automation on {profile_count} enabled profile(s)",
            timeout=5
        )
    
    def notify_auto_mode_stopped(self, reason: str = "User stopped"):
        """Notify when AUTO mode ends"""
        if not self._should_show("success"):
            return
        
        self._send_notification(
            title="⏹️ AUTO Mode Stopped",
            message=reason,
            timeout=5
        )
    
    def test_notification(self):
        """Send a test notification to verify the system works"""
        self._send_notification(
            title="🔔 Test Notification",
            message="Desktop notifications are working!",
            timeout=5
        )


# Global instance for easy access
_notifier: Optional[DashboardNotifier] = None


def get_notifier() -> DashboardNotifier:
    """Get or create the global notifier instance"""
    global _notifier
    if _notifier is None:
        _notifier = DashboardNotifier(enabled=True, level="success")
    return _notifier


def set_notifier(enabled: bool = True, level: str = "success"):
    """Configure the global notifier"""
    global _notifier
    _notifier = DashboardNotifier(enabled=enabled, level=level)
    return _notifier


# Convenience functions for quick access
def notify_profile_switch(profile_name: str, profile_id: str):
    get_notifier().notify_profile_switch(profile_name, profile_id)

def notify_step_start(profile_name: str, step_name: str):
    get_notifier().notify_step_start(profile_name, step_name)

def notify_success(profile_name: str, message: str):
    get_notifier().notify_success(profile_name, message)

def notify_error(profile_name: str, error_message: str):
    get_notifier().notify_error(profile_name, error_message)

def notify_cycle_complete(profiles_done: int, total_time_seconds: int, next_cycle: Optional[str] = None):
    get_notifier().notify_cycle_complete(profiles_done, total_time_seconds, next_cycle)

def notify_auto_started(profile_count: int):
    get_notifier().notify_auto_mode_started(profile_count)

def notify_auto_stopped(reason: str = "User stopped"):
    get_notifier().notify_auto_mode_stopped(reason)


if __name__ == "__main__":
    # Test notifications
    print("Testing desktop notifications...")
    notifier = DashboardNotifier(enabled=True, level="progress")
    notifier.test_notification()
    print("If you see a toast notification, it's working!")
