#!/usr/bin/env python3
"""
🚀 ShadowPhone Module Runner
Entry point for running automation modules from Electron

Usage:
    python runner.py --module post_feed --device-id ABC123 --profile-id profile_1
    python runner.py --module engagement --device-id ABC123 --config '{"count": 15}'
"""

import sys
import os
import json
import argparse
import traceback
import importlib.util
from datetime import datetime

# Add modules directory to path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODULES_DIR = os.path.join(SCRIPT_DIR, 'modules')
if MODULES_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

def log(level, message):
    """Structured logging for Electron to parse."""
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(json.dumps({
        "type": "log",
        "level": level,
        "message": message,
        "timestamp": timestamp
    }), flush=True)

def progress(percent, message):
    """Report progress to Electron."""
    print(json.dumps({
        "type": "progress",
        "percent": percent,
        "message": message
    }), flush=True)

def result(success, data=None, error=None):
    """Report final result to Electron."""
    print(json.dumps({
        "type": "result",
        "success": success,
        "data": data,
        "error": error
    }), flush=True)

def _module_available(module_name: str) -> bool:
    """Checks if a python module can be resolved in current environment."""
    return importlib.util.find_spec(module_name) is not None

def run_post_feed(device_id, profile_id, config):
    """Run post to feed module."""
    from modules.post_module import InstagramPoster
    
    log("INFO", f"📸 Starting Post to Feed for profile: {profile_id}")
    progress(10, "Connecting to device...")
    
    poster = InstagramPoster(
        device_id=device_id,
        profile_id=profile_id,
        account_number=config.get('account_number', 0)
    )
    
    progress(20, "Opening Instagram...")
    enable_trial = config.get('enable_trial', False)
    
    success = poster.post_standard_workflow(enable_trial=enable_trial)
    
    if success:
        log("SUCCESS", "✅ Post published successfully!")
        result(True, {"action": "post_feed"})
    else:
        log("ERROR", "❌ Post failed")
        result(False, error="Post workflow failed")

def run_post_story(device_id, profile_id, config):
    """Run post story module."""
    from modules.post_story_module import InstagramStoryPoster
    
    log("INFO", f"📱 Starting Post Story for profile: {profile_id}")
    progress(10, "Connecting to device...")
    
    story_poster = InstagramStoryPoster(
        device_id=device_id,
        profile_id=profile_id
    )
    
    # Set link if provided
    link_url = config.get('link_url')
    if link_url:
        story_poster.set_profile_link(link_url)
        log("INFO", f"🔗 Link sticker will use: {link_url}")
    
    progress(20, "Opening Instagram...")
    success = story_poster.post_story()
    
    if success:
        log("SUCCESS", "✅ Story posted successfully!")
        result(True, {"action": "post_story"})
    else:
        log("ERROR", "❌ Story post failed")
        result(False, error="Story workflow failed")

def run_engagement(device_id, profile_id, config):
    """Run engagement module."""
    from modules.engagement_module import InstagramEngager
    
    count = config.get('count', 15)
    user_id = config.get('user_id')  # Get user_id for settings
    log("INFO", f"💬 Starting Engagement: {count} posts")
    progress(10, "Connecting to device...")
    
    # Pass user_id to load settings from Supabase
    engager = InstagramEngager(device_id=device_id, user_id=user_id)
    engager.connect()
    
    progress(20, "Opening Instagram Reels...")
    engager.engage_posts(count=count)
    
    log("SUCCESS", f"✅ Engaged with {count} posts!")
    result(True, {"action": "engagement", "count": count})

def run_follow(device_id, profile_id, config):
    """Run follow module."""
    from modules.follow_module import InstagramFollower
    
    count = config.get('count', 5)
    log("INFO", f"👥 Starting Follow: {count} users")
    progress(10, "Connecting to device...")
    
    follower = InstagramFollower(device_id=device_id, profile_id=profile_id)
    follower.connect()
    
    progress(20, "Loading username list...")
    follower.follow_users(count=count, profile_id=profile_id)
    
    log("SUCCESS", f"✅ Followed {count} users!")
    result(True, {"action": "follow", "count": count})

def run_gallery_clean(device_id, profile_id, config):
    """Run gallery cleaning module."""
    from modules.gallery_cleaning_module import GalleryCleaningModule
    
    log("INFO", "🗑️ Starting Gallery Cleanup")
    progress(10, "Connecting to device...")
    
    gallery = GalleryCleaningModule(device_id=device_id)
    
    progress(30, "Cleaning gallery...")
    gallery.smart_gallery_clean()
    
    log("SUCCESS", "✅ Gallery cleaned!")
    result(True, {"action": "gallery_clean"})

def run_vpn_connect(device_id, profile_id, config):
    """Run VPN connection module."""
    from modules.vpn_module import ProtonVPNConnector
    
    log("INFO", "🛡️ Starting VPN Connection")
    progress(10, "Connecting to device...")
    
    vpn = ProtonVPNConnector(device_id=device_id)
    
    progress(30, "Connecting to ProtonVPN US Streaming...")
    success = vpn.connect_to_us_streaming()
    
    if success:
        log("SUCCESS", "✅ VPN connected!")
        result(True, {"action": "vpn_connect"})
    else:
        log("ERROR", "❌ VPN connection failed")
        result(False, error="VPN connection failed")

def run_detect_accounts(device_id, profile_id, config):
    """Detect Instagram accounts on device."""
    from modules.account_creation_module import AccountCreationModule
    
    log("INFO", "🔍 Detecting Instagram accounts...")
    progress(10, "Connecting to device...")
    
    acm = AccountCreationModule(device_id=device_id, profile_id=profile_id or "default")
    
    progress(30, "Opening Instagram...")
    accounts = acm.get_ig_count()
    
    log("SUCCESS", f"✅ Found {len(accounts)} accounts: {accounts}")
    result(True, {"accounts": accounts})

def run_account_creation(device_id, profile_id, config):
    """Run account creation module."""
    from modules.account_creation_module import AccountCreationModule
    
    log("INFO", "🆕 Starting Account Creation")
    progress(10, "Connecting to device...")
    
    acm = AccountCreationModule(device_id=device_id, profile_id=profile_id or "new")
    
    progress(20, "Initiating account creation workflow...")
    email_domain = config.get('email_domain', 'gmail.com')
    success = acm.create_account_workflow(email_domain=email_domain)
    
    if success:
        log("SUCCESS", "✅ Account created successfully!")
        result(True, {"action": "account_creation"})
    else:
        log("ERROR", "❌ Account creation failed")
        result(False, error="Account creation workflow failed")

def run_account_validator(device_id, profile_id, config):
    """Run account validation module."""
    from modules.account_validator import AccountValidator
    
    log("INFO", "✔️ Starting Account Validation")
    progress(10, "Connecting to device...")
    
    validator = AccountValidator(device_id=device_id)
    
    progress(30, "Validating all accounts...")
    results = validator.validate_all_accounts()
    
    log("SUCCESS", f"✅ Validated {len(results)} accounts")
    result(True, {"action": "account_validator", "accounts": results})

def run_drive_sync(device_id, profile_id, config):
    """Sync content from Google Drive."""
    from modules.drive_module_improved import GoogleDriveSync
    
    log("INFO", "☁️ Starting Drive Sync")
    progress(10, "Connecting to device...")
    
    drive = GoogleDriveSync(device_id=device_id, profile_id=profile_id)
    
    folder_name = config.get('folder_name', '')
    progress(30, f"Syncing from Drive folder: {folder_name or 'default'}...")
    success = drive.sync_content(folder_name=folder_name)
    
    if success:
        log("SUCCESS", "✅ Drive sync complete!")
        result(True, {"action": "drive_sync"})
    else:
        log("ERROR", "❌ Drive sync failed")
        result(False, error="Drive sync failed")

def run_profile_switch(device_id, profile_id, config):
    """Switch to a different GrapheneOS profile."""
    from modules.profile_switching_module import GrapheneProfileSwitcher
    
    target = config.get('target_profile', 0)
    log("INFO", f"🔄 Switching to profile {target}")
    progress(10, "Connecting to device...")
    
    switcher = GrapheneProfileSwitcher(device_id=device_id)
    
    progress(30, f"Switching to profile index {target}...")
    success = switcher.switch_to_profile(target)
    
    if success:
        log("SUCCESS", f"✅ Switched to profile {target}")
        result(True, {"action": "profile_switch", "target": target})
    else:
        log("ERROR", f"❌ Failed to switch to profile {target}")
        result(False, error=f"Profile switch failed")

def run_repost(device_id, profile_id, config):
    """Repost content from another account."""
    from modules.repost_module import InstagramReposter
    
    source = config.get('source_username', '')
    log("INFO", f"🔁 Starting Repost from @{source}")
    progress(10, "Connecting to device...")
    
    reposter = InstagramReposter(device_id=device_id, profile_id=profile_id)
    
    progress(30, f"Finding content from @{source}...")
    success = reposter.repost_from_user(source)
    
    if success:
        log("SUCCESS", f"✅ Reposted from @{source}")
        result(True, {"action": "repost", "source": source})
    else:
        log("ERROR", "❌ Repost failed")
        result(False, error="Repost workflow failed")

def run_airplane_toggle(device_id, profile_id, config):
    """Toggle airplane mode to reset IP."""
    from modules.airplane_mode_module import AirplaneModeController
    
    log("INFO", "✈️ Toggling Airplane Mode")
    progress(10, "Connecting to device...")
    
    wait_seconds = config.get('wait_seconds', 5)
    airplane = AirplaneModeController(device_id=device_id)
    
    progress(30, "Enabling airplane mode...")
    airplane.enable_airplane_mode()
    import time
    time.sleep(wait_seconds)
    progress(70, "Disabling airplane mode...")
    airplane.disable_airplane_mode()
    
    log("SUCCESS", "✅ Airplane mode toggled - IP reset!")
    result(True, {"action": "airplane_toggle"})

def run_edit_profile(device_id, profile_id, config):
    """Edit Instagram profile settings."""
    from modules.edit_profile_module import InstagramProfileEditor
    
    log("INFO", "✏️ Editing Profile")
    progress(10, "Connecting to device...")
    
    editor = InstagramProfileEditor(device_id=device_id)
    
    bio = config.get('bio', '')
    name = config.get('name', '')
    website = config.get('website', '')
    
    progress(20, "Connecting to device...")
    if not editor.connect():
        log("ERROR", "❌ Failed to connect")
        result(False, error="Connection failed")
        return
    
    progress(40, "Opening profile editor...")
    editor.navigate_to_profile()
    editor.enter_edit_profile()
    
    results = editor.update_full_profile(name=name if name else None, bio=bio if bio else None, link=website if website else None)
    
    if results.get('overall'):
        log("SUCCESS", "✅ Profile updated!")
        result(True, {"action": "edit_profile"})
    else:
        log("ERROR", "❌ Profile edit failed")
        result(False, error="Profile edit failed")

def run_ig_launcher(device_id, profile_id, config):
    """Launch Instagram with popup handling."""
    from modules.instagram_launcher_module import InstagramLauncher
    
    log("INFO", "📱 Launching Instagram")
    progress(10, "Connecting to device...")
    
    launcher = InstagramLauncher(device_id=device_id)
    progress(30, "Opening Instagram...")
    launcher.launch_instagram()
    
    log("SUCCESS", "✅ Instagram launched!")
    result(True, {"action": "ig_launcher"})

def run_ig_account_switch(device_id, profile_id, config):
    """Switch Instagram accounts."""
    from modules.ig_account_switcher import IGAccountSwitcher
    
    target_username = str(config.get('target_username', '') or '').strip()
    raw_target_index = config.get('target_index', 0)
    try:
        target_index = int(raw_target_index)
    except (TypeError, ValueError):
        target_index = 0

    target_label = f"@{target_username}" if target_username else f"index {target_index}"
    log("INFO", f"🔄 Switching to IG account {target_label}")
    progress(10, "Connecting to device...")
    
    switcher = IGAccountSwitcher(device_id=device_id)

    if not target_username:
        progress(25, "Reading available IG accounts...")
        available_accounts = switcher.list_available_accounts()
        if not available_accounts:
            # Fallback for single-account setups where popup detection fails:
            # keep index 0 usable by switching to the currently active account.
            if target_index == 0:
                current_account = switcher.get_current_account()
                if current_account:
                    available_accounts = [current_account]
            if not available_accounts:
                log("ERROR", "❌ No IG accounts found in account switcher popup")
                result(False, error="No IG accounts found")
                return
        if target_index < 0 or target_index >= len(available_accounts):
            log("ERROR", f"❌ Invalid account index {target_index}; found {len(available_accounts)} account(s)")
            result(False, error=f"Invalid target_index: {target_index}")
            return
        target_username = available_accounts[target_index]

    progress(55, f"Switching to @{target_username}...")
    success = switcher.switch_to_account(target_username)
    
    if success:
        log("SUCCESS", f"✅ Switched to @{target_username}")
        result(True, {
            "action": "ig_account_switch",
            "target_index": target_index,
            "target_username": target_username,
        })
    else:
        log("ERROR", "❌ Account switch failed")
        result(False, error="Account switch failed")

def run_stats_scraper(device_id, profile_id, config):
    """Scrape account statistics."""
    from modules.stats_scraper import StatsScraper
    
    log("INFO", "📊 Scraping Stats")
    progress(10, "Connecting to device...")
    
    scraper = StatsScraper(device_id=device_id, profile_id=profile_id)
    progress(30, "Collecting stats...")
    stats = scraper.scrape_stats()
    
    log("SUCCESS", f"✅ Stats collected: {stats}")
    result(True, {"action": "stats_scraper", "stats": stats})

def run_threads_post(device_id, profile_id, config):
    """Post to Threads."""
    from modules.threads_modules.threads_posting import ThreadsPoster
    
    text = config.get('text', '')
    log("INFO", f"🧵 Posting to Threads")
    progress(10, "Connecting to device...")
    
    poster = ThreadsPoster(device_id=device_id, profile_id=profile_id)
    progress(30, "Creating Threads post...")
    success = poster.post(text=text)
    
    if success:
        log("SUCCESS", "✅ Posted to Threads!")
        result(True, {"action": "threads_post"})
    else:
        log("ERROR", "❌ Threads post failed")
        result(False, error="Threads posting failed")

def run_threads_engage(device_id, profile_id, config):
    """Engage on Threads."""
    from modules.threads_modules.threads_engagement import ThreadsEngager
    
    count = config.get('count', 10)
    log("INFO", f"💬 Engaging on Threads: {count} posts")
    progress(10, "Connecting to device...")
    
    engager = ThreadsEngager(device_id=device_id)
    progress(30, "Engaging on Threads...")
    engager.engage(count=count)
    
    log("SUCCESS", f"✅ Engaged with {count} Threads posts!")
    result(True, {"action": "threads_engage", "count": count})

def run_tiktok_post(device_id, profile_id, config):
    """Post to TikTok."""
    from modules.tiktok_modules.tiktok_posting import TikTokPoster
    
    caption = config.get('caption', '')
    log("INFO", "🎵 Posting to TikTok")
    progress(10, "Connecting to device...")
    
    poster = TikTokPoster(device_id=device_id, profile_id=profile_id)
    progress(30, "Creating TikTok post...")
    success = poster.post(caption=caption)
    
    if success:
        log("SUCCESS", "✅ Posted to TikTok!")
        result(True, {"action": "tiktok_post"})
    else:
        log("ERROR", "❌ TikTok post failed")
        result(False, error="TikTok posting failed")

def run_tiktok_engage(device_id, profile_id, config):
    """Engage on TikTok."""
    from modules.tiktok_modules.tiktok_engagement import TikTokEngager
    
    count = config.get('count', 15)
    log("INFO", f"❤️ Engaging on TikTok: {count} videos")
    progress(10, "Connecting to device...")
    
    engager = TikTokEngager(device_id=device_id)
    progress(30, "Engaging on TikTok...")
    engager.engage(count=count)
    
    log("SUCCESS", f"✅ Engaged with {count} TikTok videos!")
    result(True, {"action": "tiktok_engage", "count": count})

def run_tiktok_launcher(device_id, profile_id, config):
    """Launch TikTok."""
    from modules.tiktok_modules.tiktok_launcher import TikTokLauncher
    
    log("INFO", "📱 Launching TikTok")
    progress(10, "Connecting to device...")
    
    launcher = TikTokLauncher(device_id=device_id)
    progress(30, "Opening TikTok...")
    launcher.launch()
    
    log("SUCCESS", "✅ TikTok launched!")
    result(True, {"action": "tiktok_launcher"})

def run_twitter_post(device_id, profile_id, config):
    """Post to Twitter/X."""
    from modules.twitter_modules.twitter_posting import TwitterPoster
    
    text = config.get('text', '')
    log("INFO", "🐦 Posting to Twitter/X")
    progress(10, "Connecting to device...")
    
    poster = TwitterPoster(device_id=device_id, profile_id=profile_id)
    progress(30, "Creating tweet...")
    success = poster.post(text=text)
    
    if success:
        log("SUCCESS", "✅ Posted to Twitter/X!")
        result(True, {"action": "twitter_post"})
    else:
        log("ERROR", "❌ Twitter post failed")
        result(False, error="Twitter posting failed")

def run_twitter_engage(device_id, profile_id, config):
    """Engage on Twitter/X."""
    from modules.twitter_modules.twitter_engagement import TwitterEngager
    
    count = config.get('count', 15)
    log("INFO", f"❤️ Engaging on Twitter: {count} tweets")
    progress(10, "Connecting to device...")
    
    engager = TwitterEngager(device_id=device_id)
    progress(30, "Engaging on Twitter...")
    engager.engage(count=count)
    
    log("SUCCESS", f"✅ Engaged with {count} tweets!")
    result(True, {"action": "twitter_engage", "count": count})

def run_twitter_follow(device_id, profile_id, config):
    """Follow users on Twitter/X."""
    from modules.twitter_modules.twitter_follow import TwitterFollower
    
    count = config.get('count', 5)
    log("INFO", f"👥 Following {count} users on Twitter")
    progress(10, "Connecting to device...")
    
    follower = TwitterFollower(device_id=device_id)
    progress(30, "Following users...")
    follower.follow(count=count)
    
    log("SUCCESS", f"✅ Followed {count} Twitter users!")
    result(True, {"action": "twitter_follow", "count": count})

def run_twitter_retweet(device_id, profile_id, config):
    """Retweet on Twitter/X."""
    from modules.twitter_modules.twitter_retweet import TwitterRetweeter
    
    count = config.get('count', 5)
    log("INFO", f"🔁 Retweeting {count} posts")
    progress(10, "Connecting to device...")
    
    retweeter = TwitterRetweeter(device_id=device_id)
    progress(30, "Retweeting...")
    retweeter.retweet(count=count)
    
    log("SUCCESS", f"✅ Retweeted {count} tweets!")
    result(True, {"action": "twitter_retweet", "count": count})

def run_twitter_launcher(device_id, profile_id, config):
    """Launch Twitter/X."""
    from modules.twitter_modules.twitter_launcher import TwitterLauncher
    
    log("INFO", "📱 Launching Twitter/X")
    progress(10, "Connecting to device...")
    
    launcher = TwitterLauncher(device_id=device_id)
    progress(30, "Opening Twitter...")
    launcher.launch()
    
    log("SUCCESS", "✅ Twitter/X launched!")
    result(True, {"action": "twitter_launcher"})

def run_content_manager(device_id, profile_id, config):
    """Manage content queue."""
    from modules.content_manager import ContentManager
    
    log("INFO", "📂 Managing Content")
    progress(10, "Connecting to device...")
    
    manager = ContentManager(device_id=device_id, profile_id=profile_id)
    progress(30, "Loading content queue...")
    content = manager.get_queue()
    
    log("SUCCESS", f"✅ Content queue loaded: {len(content)} items")
    result(True, {"action": "content_manager", "count": len(content)})

def run_create_profile_content(device_id, profile_id, config):
    """Generate profile content."""
    from modules.create_profile_content import ProfileContentGenerator
    
    log("INFO", "🎨 Generating Profile Content")
    progress(10, "Connecting to device...")
    
    generator = ProfileContentGenerator(device_id=device_id, profile_id=profile_id)
    progress(30, "Creating content...")
    success = generator.generate()
    
    if success:
        log("SUCCESS", "✅ Content generated!")
        result(True, {"action": "create_profile_content"})
    else:
        log("ERROR", "❌ Content generation failed")
        result(False, error="Content generation failed")

def run_airtable_sync(device_id, profile_id, config):
    """Sync with Airtable CRM."""
    from modules.airtable_sync import AirtableSync
    
    log("INFO", "📊 Syncing with Airtable")
    progress(10, "Connecting...")
    
    syncer = AirtableSync()
    progress(30, "Syncing registry to Airtable...")
    sync_result = syncer.sync_from_registry(device_id=device_id)
    
    if sync_result:
        log("SUCCESS", f"✅ Airtable sync complete! Updated: {sync_result.get('updated', 0)}, Created: {sync_result.get('created', 0)}")
        result(True, {"action": "airtable_sync", **sync_result})
    else:
        log("ERROR", "❌ Airtable sync failed")
        result(False, error="Airtable sync failed")

def run_validate_current(device_id, profile_id, config):
    """Validate current profile."""
    from modules.account_validator import AccountValidator
    
    sync_airtable = config.get('sync_airtable', True)
    log("INFO", "🔍 Validating Current Profile")
    progress(10, "Connecting to device...")
    
    validator = AccountValidator(device_id=device_id)
    progress(30, "Scanning accounts...")
    scan_result = validator.validate_current_profile()
    
    if sync_airtable:
        progress(80, "Syncing to Airtable...")
        validator.sync_to_airtable()
    
    log("SUCCESS", f"✅ Profile validated: {scan_result}")
    result(True, {"action": "validate_current", "scan": scan_result})

def run_validate_all(device_id, profile_id, config):
    """Validate all profiles."""
    from modules.account_validator import AccountValidator
    
    secure = config.get('secure_mode', True)
    sync_airtable = config.get('sync_airtable', True)
    log("INFO", "🔍 Validating All Profiles")
    progress(10, "Connecting to device...")
    
    validator = AccountValidator(device_id=device_id)
    progress(20, "Starting full profile scan...")
    results = validator.validate_all_profiles(secure=secure)
    
    if sync_airtable:
        progress(90, "Syncing to Airtable...")
        validator.sync_to_airtable()
    
    log("SUCCESS", f"✅ All profiles validated: {len(results)} profiles")
    result(True, {"action": "validate_all", "profiles_scanned": len(results)})

def run_ig_login(device_id, profile_id, config):
    """Login to Instagram account."""
    from modules.account_creation_module import AccountCreationModule
    
    email = config.get('email', '')
    password = config.get('password', '')
    log("INFO", f"📲 Logging into Instagram: {email}")
    progress(10, "Connecting to device...")
    
    creator = AccountCreationModule(device_id=device_id, profile_id=profile_id)
    progress(30, "Starting IG login flow...")
    login_result = creator.instagram_login_existing(email, password)
    
    if login_result.get('success'):
        username = login_result.get('username', email)
        log("SUCCESS", f"✅ Logged into Instagram as {username}")
        result(True, {"action": "ig_login", "username": username})
    elif login_result.get('verification_needed'):
        log("WARNING", "⚠️ Verification required - account flagged")
        result(False, error="Verification needed", data=login_result)
    else:
        log("ERROR", "❌ Instagram login failed")
        result(False, error="Login failed")

def run_gmail_login(device_id, profile_id, config):
    """Add/login Gmail account."""
    from modules.account_creation_module import AccountCreationModule
    
    email = config.get('email', '')
    password = config.get('password', '')
    recovery = config.get('recovery_email', '')
    log("INFO", f"📧 Adding Gmail account: {email}")
    progress(10, "Connecting to device...")
    
    creator = AccountCreationModule(device_id=device_id, profile_id=profile_id)
    progress(30, "Starting Gmail login flow...")
    success = creator.gmail_login(email, password, recovery_email=recovery if recovery else None)
    
    if success:
        log("SUCCESS", f"✅ Gmail account added: {email}")
        result(True, {"action": "gmail_login", "email": email})
    else:
        log("ERROR", "❌ Gmail login failed")
        result(False, error="Gmail login failed")

def run_gmail_logout(device_id, profile_id, config):
    """Remove Gmail account from device."""
    from modules.account_creation_module import AccountCreationModule
    
    email = config.get('email', '')
    log("INFO", f"🚪 Removing Gmail account: {email}")
    progress(10, "Connecting to device...")
    
    creator = AccountCreationModule(device_id=device_id, profile_id=profile_id)
    progress(30, "Removing Gmail account...")
    success = creator.gmail_logout_account(email)
    
    if success:
        log("SUCCESS", f"✅ Gmail removed: {email}")
        result(True, {"action": "gmail_logout", "email": email})
    else:
        log("ERROR", "❌ Gmail removal failed")
        result(False, error="Gmail removal failed")

def run_ig_logout(device_id, profile_id, config):
    """Logout Instagram account."""
    from modules.account_creation_module import AccountCreationModule
    
    username = config.get('username', '')
    log("INFO", f"🚪 Logging out Instagram: {username}")
    progress(10, "Connecting to device...")
    
    creator = AccountCreationModule(device_id=device_id, profile_id=profile_id)
    progress(30, "Logging out IG account...")
    success = creator._logout_ig_account(username)
    
    if success:
        log("SUCCESS", f"✅ Instagram logged out: {username}")
        result(True, {"action": "ig_logout", "username": username})
    else:
        log("ERROR", "❌ Instagram logout failed")
        result(False, error="IG logout failed")

# Module registry - 27 MODULES (IG + Threads + Account Management)
MODULES = {
    # Instagram (8)
    "post_feed": run_post_feed,
    "post_story": run_post_story,
    "repost": run_repost,
    "engagement": run_engagement,
    "follow": run_follow,
    "ig_launcher": run_ig_launcher,
    "ig_account_switch": run_ig_account_switch,
    "stats_scraper": run_stats_scraper,
    # Threads (2)
    "threads_post": run_threads_post,
    "threads_engage": run_threads_engage,
    # Account (11)
    "account_creation": run_account_creation,
    "account_validator": run_account_validator,
    "validate_current": run_validate_current,
    "validate_all": run_validate_all,
    "ig_login": run_ig_login,
    "gmail_login": run_gmail_login,
    "gmail_logout": run_gmail_logout,
    "ig_logout": run_ig_logout,
    "profile_switch": run_profile_switch,
    "edit_profile": run_edit_profile,
    "detect_accounts": run_detect_accounts,
    # Content
    "drive_sync": run_drive_sync,
    "content_manager": run_content_manager,
    # Network
    "vpn_connect": run_vpn_connect,
    "airplane_toggle": run_airplane_toggle,
    # Maintenance
    "gallery_clean": run_gallery_clean,
    # Utility
    "airtable_sync": run_airtable_sync,
}

# Modules that require local Appium+Selenium stack (desktop-side automation).
APPIUM_REQUIRED_MODULES = {
    "post_feed",
    "post_story",
    "repost",
    "ig_launcher",
    "ig_account_switch",
    "profile_switch",
    "edit_profile",
}

def main():
    parser = argparse.ArgumentParser(description="ShadowPhone Module Runner")
    parser.add_argument('--module', required=True, choices=MODULES.keys(),
                        help="Module to run")
    parser.add_argument('--device-id', required=True,
                        help="ADB device ID")
    parser.add_argument('--profile-id', default=None,
                        help="Profile/account ID")
    parser.add_argument('--config', default='{}',
                        help="JSON configuration")
    parser.add_argument('--modules-path', default=None,
                        help="Path to modules directory (if not using bundled)")
    
    args = parser.parse_args()
    
    # Override modules path if specified
    if args.modules_path:
        if args.modules_path not in sys.path:
            sys.path.insert(0, args.modules_path)
        log("INFO", f"📁 Using modules from: {args.modules_path}")
    
    try:
        config = json.loads(args.config)
    except json.JSONDecodeError as e:
        result(False, error=f"Invalid JSON config: {e}")
        sys.exit(1)
    
    module_func = MODULES.get(args.module)
    if not module_func:
        result(False, error=f"Unknown module: {args.module}")
        sys.exit(1)
    
    log("INFO", f"🚀 Running module: {args.module}")
    log("INFO", f"📱 Device: {args.device_id}")
    if args.profile_id:
        log("INFO", f"👤 Profile: {args.profile_id}")

    if args.module in APPIUM_REQUIRED_MODULES:
        missing = []
        if not _module_available("appium"):
            missing.append("appium-python-client")
        if not _module_available("selenium"):
            missing.append("selenium")
        if missing:
            missing_csv = ", ".join(missing)
            guidance = (
                f"Missing local automation dependencies: {missing_csv}. "
                "Install in your desktop Python environment before running this module."
            )
            log("ERROR", f"❌ {guidance}")
            result(False, error=guidance)
            sys.exit(1)
    
    try:
        module_func(args.device_id, args.profile_id, config)
    except Exception as e:
        log("ERROR", f"❌ Module crashed: {e}")
        if isinstance(e, ModuleNotFoundError):
            missing_name = getattr(e, "name", None)
            if missing_name in {"appium", "selenium"}:
                guidance = (
                    f"Missing local python package: {missing_name}. "
                    "Install required automation dependencies in the desktop python environment."
                )
                log("ERROR", f"❌ {guidance}")
                result(False, error=guidance)
                sys.exit(1)
        traceback.print_exc()
        result(False, error=str(e))
        sys.exit(1)

if __name__ == '__main__':
    main()
