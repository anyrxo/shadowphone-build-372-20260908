#!/usr/bin/env python3
"""
📝 CONTENT MANAGER - ORGANIZED PROFILE & DEFAULT CONTENT SYSTEM
🎯 Simple either/or system: Profile-specific content OR defaults

FEATURES:
- Organized defaults folder with comprehensive content
- Organized profile folders for each user
- Simple either/or logic: Use profile-specific OR defaults (not combined)
- Random selection from content lists
- Backward compatibility with legacy file naming

ORGANIZED STRUCTURE:
- defaults/usernames.txt, defaults/story_captions.txt, etc.
- profiles/profile_[ID]/usernames.txt, profiles/profile_[ID]/story_captions.txt, etc.
- Legacy: usernames_profile_[ID].txt (still supported)

CONTENT TYPES:
- usernames (follow lists)
- story_captions
- comments  
- post_captions

SIMPLE LOGIC:
1. Check for profile-specific content (organized folder or legacy file)
2. If found: Use ONLY profile-specific content
3. If not found: Use ONLY default content
"""

import os
import random
import time
from typing import List, Optional

class ContentManager:
    def __init__(self, base_directory=None):
        if base_directory is None:
            # Default to the directory containing this script
            base_directory = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.base_dir = base_directory
        
        # Content type mappings - ORGANIZED DEFAULTS
        self.content_types = {
            'usernames': {
                'default_file': 'defaults/usernames.txt',
                'profile_pattern': 'usernames_profile_{}.txt',  # Legacy compatibility
                'description': 'Follow list usernames'
            },
            'story_captions': {
                'default_file': 'defaults/story_captions.txt', 
                'profile_pattern': 'story_captions_profile_{}.txt',  # Legacy compatibility
                'description': 'Story captions'
            },
            'comments': {
                'default_file': 'defaults/comments.txt',
                'profile_pattern': 'comments_profile_{}.txt',  # Legacy compatibility
                'description': 'Comments for posts'
            },
            'post_captions': {
                'default_file': 'defaults/post_captions.txt',
                'profile_pattern': 'post_captions_profile_{}.txt',  # Legacy compatibility
                'description': 'Post captions'
            }
        }
        
        # Ensure organized defaults folder exists
        self.defaults_folder = os.path.join(self.base_dir, 'defaults')
        self._ensure_defaults_folder_exists()
        
        print(f"📝 Content Manager initialized - Base directory: {self.base_dir}")
        print(f"📁 Defaults folder: {self.defaults_folder}")
    
    def _ensure_defaults_folder_exists(self):
        """Create organized defaults folder with default content files"""
        try:
            # Create defaults directory if it doesn't exist
            os.makedirs(self.defaults_folder, exist_ok=True)
            
            # Default content for each file type
            default_contents = {
                'usernames.txt': [
                    '# DEFAULT FOLLOW LIST - Used when no profile-specific list exists',
                    '# Add Instagram usernames to follow (one per line)',
                    '# Remove the # to uncomment',
                    '',
                    'nature_photography',
                    'travel_blogger',
                    'fitness_motivation',
                    'food_photography',
                    'lifestyle_blog',
                    'art_gallery',
                    'music_lover',
                    'book_reader',
                    'coffee_addict',
                    'adventure_seeker'
                ],
                'story_captions.txt': [
                    '# DEFAULT STORY CAPTIONS - Used when no profile-specific captions exist',
                    '# Add story captions (one per line)',
                    '# These will be randomly selected for story posts',
                    '',
                    'Active all day you know where to find me ❤️',
                    '$3 NNN SALE 🫣',
                    'LINK IN BIO',
                    'Let\'s chat I\'m feeling 👅🍑',
                    'Wanna talk? Bio\'s where I\'m waiting 💬',
                    'You know where to find me in bio 😉',
                    'I have so many DMs I can not talk to everyone If you really want it…',
                    'LINKS ❤️‍🔥',
                    'MY EXCLU PAGE IS FREE 🤍',
                    'link in bio',
                    'Check my bio, you know where 😉',
                    'CHAT WITH ME 💗',
                    'HUGE SALE 4 U',
                    'SPANK ME',
                    'You\'ll find it in my bio 👀',
                    'Think I need a bigger size…',
                    'I reply to all the messages… bio has it all ❤️‍🔥'
                ],
                'post_captions.txt': [
                    '# DEFAULT POST CAPTIONS - Used when no profile-specific captions exist',
                    '# Add post captions with hashtags (one per line)',
                    '# These will be randomly selected for main posts',
                    '',
                    'tell your wife i said hi lmaoo🤣',
                    'make reading a habit guys!🤭',
                    'is this enough to persuade you?🫣',
                    'btw i give the BEST back rubs🤭',
                    'RATE MY COSPLAYY🤌🏼',
                    'felt cute, might delete later lol🥲',
                    'what else were you thinking about?😩🤌🏼',
                    'Y\'ALL SHOULD TAKE NOTES😩',
                    'felt pretty might delete later🧚🏼‍♀️',
                    'is it just me? why do i look so innocent here?😭😭',
                    'i\'d be spoiling my future husband with this view lmaoooo',
                    'imagine coming home to this... now work harder💁🏻‍♀️',
                    'well you don\'t see this every day, do you?🤣🩺',
                    'i made you stop, didn\'t i?🫣',
                    'rate my body on a scale of 1 to 10🫣',
                    'POV: i wear this to argue with my future husband better😝',
                    'stop staring! unwrap your gift instead🙄',
                    'i hope this made your day🥺',
                    'being asian means wearing the most random stuff but still looking good af💁🏻‍♀️',
                    'feeling myself today, might delete later tho🫣',
                    'just casually giving you something to dream about🤭🫶🏼',
                    'imagine ordering asian snacks and you got me instead hehe'
                ],
                'comments.txt': [
                    '# DEFAULT COMMENTS - Used when no profile-specific comments exist',
                    '# Add engagement comments (one per line)',
                    '# These will be randomly selected for commenting on posts',
                    '',
                    'omg this is so cute! 🥺',
                    'absolutely stunning! 😍',
                    'love this so much! 💕',
                    'this is everything! ✨',
                    'so gorgeous! 🔥',
                    'obsessed with this! 💖',
                    'this is perfection! 👌',
                    'you look amazing! 🌟',
                    'such a vibe! ⚡',
                    'this made my day! ☀️',
                    'absolutely beautiful! 💫',
                    'love love love! 🥰',
                    'this is so pretty! 🌸',
                    'gorgeous as always! 👑',
                    'such a mood! 💯',
                    'you\'re glowing! ✨',
                    'this is incredible! 🙌',
                    'so aesthetic! 📸',
                    'living for this! 💗',
                    'this is art! 🎨'
                ]
            }
            
            # Create each default file if it doesn't exist
            for filename, content_lines in default_contents.items():
                file_path = os.path.join(self.defaults_folder, filename)
                
                if not os.path.exists(file_path):
                    with open(file_path, 'w', encoding='utf-8') as f:
                        for line in content_lines:
                            f.write(f"{line}\n")
                    print(f"✅ Created organized default file: defaults/{filename}")
                else:
                    print(f"📁 Organized default file exists: defaults/{filename}")
                    
        except Exception as e:
            print(f"⚠️ Error creating defaults folder: {e}")
            # Fallback to legacy default files in root directory
    
    def get_content_file_path(self, content_type: str, profile_id: Optional[str] = None) -> str:
        """Get the file path for content type - SIMPLE: Profile-specific OR Default (2 options only)"""
        if content_type not in self.content_types:
            raise ValueError(f"Unknown content type: {content_type}")
        
        config = self.content_types[content_type]
        
        if profile_id:
            # OPTION 1: Check for profile-specific content (organized folder first, then legacy)
            
            # Check organized profile folder structure
            profile_folder = os.path.join(self.base_dir, 'profiles', f'profile_{profile_id}')
            organized_file = f"{content_type}.txt"
            organized_path = os.path.join(profile_folder, organized_file)
            
            if os.path.exists(organized_path):
                print(f"📁 Using profile-specific {content_type}: profiles/profile_{profile_id}/{organized_file}")
                return organized_path
            
            # Check legacy profile-specific file pattern (backward compatibility)
            profile_file = config['profile_pattern'].format(profile_id)
            legacy_path = os.path.join(self.base_dir, profile_file)
            
            if os.path.exists(legacy_path):
                print(f"📁 Using profile-specific {content_type}: {profile_file}")
                return legacy_path
        
        # OPTION 2: Use defaults (organized first, then legacy fallback)
        
        # Check organized defaults folder
        organized_default_path = os.path.join(self.base_dir, config['default_file'])  # defaults/
        if os.path.exists(organized_default_path):
            print(f"📁 Using default {content_type}: {config['default_file']}")
            return organized_default_path
        
        # Legacy default fallback (backward compatibility)
        legacy_default_file = f"default_{content_type}.txt"
        legacy_default_path = os.path.join(self.base_dir, legacy_default_file)
        if os.path.exists(legacy_default_path):
            print(f"📁 Using default {content_type}: {legacy_default_file}")
            return legacy_default_path
        
        # If no defaults exist, return the organized path (will be created automatically)
        print(f"⚠️ No {content_type} found, using default: {config['default_file']}")
        return organized_default_path
    
    def load_content_list(self, content_type: str, profile_id: Optional[str] = None) -> List[str]:
        """Load content list from file (profile-specific or default)"""
        file_path = self.get_content_file_path(content_type, profile_id)
        
        try:
            if not os.path.exists(file_path):
                print(f"❌ Content file not found: {file_path}")
                return []
            
            with open(file_path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            
            # Filter out comments and empty lines, and handle escaped newlines
            content = []
            for line in lines:
                line = line.strip()
                if line and not line.startswith('#'):
                    # Handle files with escaped newlines (fix legacy format)
                    if '\\n' in line:
                        # Split on escaped newlines and add each part
                        parts = line.split('\\n')
                        for part in parts:
                            part = part.strip()
                            if part:
                                content.append(part)
                    else:
                        content.append(line)
            
            print(f"✅ Loaded {len(content)} {content_type} from {os.path.basename(file_path)}")
            return content
            
        except Exception as e:
            print(f"❌ Error loading {content_type}: {e}")
            return []
    
    def get_random_content(self, content_type: str, profile_id: Optional[str] = None, count: int = 1) -> List[str]:
        """Get random content from list"""
        content_list = self.load_content_list(content_type, profile_id)
        
        if not content_list:
            print(f"⚠️ No {content_type} available")
            return []
        
        if count == 1:
            selected = [random.choice(content_list)]
        else:
            # For multiple items, avoid duplicates if possible
            if count <= len(content_list):
                selected = random.sample(content_list, count)
            else:
                # If requesting more than available, allow duplicates
                selected = [random.choice(content_list) for _ in range(count)]
        
        print(f"🎲 Selected {len(selected)} random {content_type}")
        return selected
    
    def create_profile_content_file(self, content_type: str, profile_id: str, content_list: List[str]) -> bool:
        """Create a profile-specific content file"""
        if content_type not in self.content_types:
            print(f"❌ Unknown content type: {content_type}")
            return False
        
        config = self.content_types[content_type]
        profile_file = config['profile_pattern'].format(profile_id)
        profile_path = os.path.join(self.base_dir, profile_file)
        
        try:
            with open(profile_path, 'w', encoding='utf-8') as f:
                f.write(f"# PROFILE {profile_id} - {config['description'].upper()}\n")
                f.write(f"# Created: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
                f.write(f"# This file overrides default_{content_type}.txt for profile {profile_id}\n")
                f.write("\n")
                
                for item in content_list:
                    f.write(f"{item}\n")
            
            print(f"✅ Created profile-specific {content_type} file: {profile_file}")
            print(f"📊 Contains {len(content_list)} items")
            return True
            
        except Exception as e:
            print(f"❌ Error creating profile content file: {e}")
            return False
    
    def list_profile_files(self, profile_id: str) -> dict:
        """List all existing profile-specific files for a profile"""
        profile_files = {}
        
        for content_type, config in self.content_types.items():
            profile_file = config['profile_pattern'].format(profile_id)
            profile_path = os.path.join(self.base_dir, profile_file)
            
            if os.path.exists(profile_path):
                try:
                    with open(profile_path, 'r') as f:
                        lines = [line.strip() for line in f.readlines() if line.strip() and not line.startswith('#')]
                    profile_files[content_type] = {
                        'file': profile_file,
                        'count': len(lines),
                        'exists': True
                    }
                except:
                    profile_files[content_type] = {
                        'file': profile_file,
                        'count': 0,
                        'exists': True
                    }
            else:
                profile_files[content_type] = {
                    'file': profile_file,
                    'count': 0,
                    'exists': False
                }
        
        return profile_files
    
    def show_profile_status(self, profile_id: str):
        """Show content status for a profile"""
        print(f"\\n📋 CONTENT STATUS FOR PROFILE {profile_id}")
        print("=" * 50)
        
        # Check for organized folder structure first
        profile_folder = os.path.join(self.base_dir, 'profiles', f'profile_{profile_id}')
        if os.path.exists(profile_folder):
            print(f"📁 Organized folder: profiles/profile_{profile_id}/")
            
            for content_type in self.content_types.keys():
                organized_file = f"{content_type}.txt"
                organized_path = os.path.join(profile_folder, organized_file)
                
                if os.path.exists(organized_path):
                    try:
                        with open(organized_path, 'r') as f:
                            lines = [line.strip() for line in f.readlines() if line.strip() and not line.startswith('#')]
                        print(f"✅ {content_type}: {organized_file} ({len(lines)} items)")
                    except:
                        print(f"⚠️ {content_type}: {organized_file} (read error)")
                else:
                    default_count = len(self.load_content_list(content_type))
                    print(f"📁 {content_type}: Using default ({default_count} items)")
        else:
            # Fallback to legacy file checking
            profile_files = self.list_profile_files(profile_id)
            
            for content_type, info in profile_files.items():
                if info['exists']:
                    print(f"✅ {content_type}: {info['file']} ({info['count']} items)")
                else:
                    default_count = len(self.load_content_list(content_type))
                    print(f"📁 {content_type}: Using default ({default_count} items)")
        
        print("=" * 50)
    
    def show_complete_structure(self):
        """Show the complete organized folder structure"""
        print(f"\\n📁 COMPLETE CONTENT STRUCTURE")
        print("=" * 60)
        print(f"Base Directory: {self.base_dir}")
        print()
        
        # Show defaults folder
        print("📁 defaults/")
        defaults_folder = os.path.join(self.base_dir, 'defaults')
        if os.path.exists(defaults_folder):
            for content_type in self.content_types.keys():
                default_file = f"{content_type}.txt"
                default_path = os.path.join(defaults_folder, default_file)
                if os.path.exists(default_path):
                    try:
                        with open(default_path, 'r') as f:
                            lines = [line.strip() for line in f.readlines() if line.strip() and not line.startswith('#')]
                        print(f"   ✅ {default_file} ({len(lines)} items)")
                    except:
                        print(f"   ⚠️ {default_file} (read error)")
                else:
                    print(f"   ❌ {default_file} (missing)")
        else:
            print("   ❌ defaults/ folder not found")
        
        print()
        
        # Show profiles folder
        print("📁 profiles/")
        profiles_folder = os.path.join(self.base_dir, 'profiles')
        if os.path.exists(profiles_folder):
            try:
                profile_dirs = [d for d in os.listdir(profiles_folder) 
                              if os.path.isdir(os.path.join(profiles_folder, d)) and d.startswith('profile_')]
                profile_dirs.sort()
                
                if profile_dirs:
                    for profile_dir in profile_dirs:
                        profile_path = os.path.join(profiles_folder, profile_dir)
                        print(f"   📁 {profile_dir}/")
                        
                        # Show content files
                        for content_type in self.content_types.keys():
                            content_file = f"{content_type}.txt"
                            content_path = os.path.join(profile_path, content_file)
                            if os.path.exists(content_path):
                                try:
                                    with open(content_path, 'r') as f:
                                        lines = [line.strip() for line in f.readlines() if line.strip() and not line.startswith('#')]
                                    print(f"      ✅ {content_file} ({len(lines)} items)")
                                except:
                                    print(f"      ⚠️ {content_file} (read error)")
                            else:
                                print(f"      📁 {content_file} (using defaults)")
                        
                        # Show info file
                        info_file = os.path.join(profile_path, 'profile_info.txt')
                        if os.path.exists(info_file):
                            print(f"      📋 profile_info.txt")
                        print()
                else:
                    print("   📝 No profile folders found")
            except Exception as e:
                print(f"   ❌ Error reading profiles folder: {e}")
        else:
            print("   ❌ profiles/ folder not found")
        
        print("=" * 60)

# Convenience functions for modules to use
def get_usernames_for_follow(profile_id: str, count: int = 10) -> List[str]:
    """Get RANDOM usernames for following (profile-specific OR default - simple either/or)"""
    cm = ContentManager()
    
    # Load content using the simple either/or logic
    usernames = cm.load_content_list('usernames', profile_id)
    
    if not usernames:
        print("⚠️ No usernames available")
        return []
    
    # Random selection
    if count <= len(usernames):
        selected = random.sample(usernames, count)
    else:
        selected = [random.choice(usernames) for _ in range(count)]
    
    print(f"🎲 Selected {len(selected)} random usernames from {len(usernames)} available")
    print(f"🎯 Selected random usernames:")
    for i, username in enumerate(selected, 1):
        print(f"  {i}. @{username}")
    
    return selected

def get_random_story_caption(profile_id: str) -> str:
    """Get random story caption (profile-specific OR default - simple either/or)"""
    cm = ContentManager()
    
    # Load content using the simple either/or logic
    captions = cm.load_content_list('story_captions', profile_id)
    
    if captions:
        selected = random.choice(captions)
        print(f"🎲 Random story caption selected from {len(captions)} available")
        return selected
    else:
        return "Living my best life ✨"

def get_random_comment(profile_id: str) -> str:
    """Get random comment (profile-specific OR default - simple either/or)"""
    cm = ContentManager()
    
    # Load content using the simple either/or logic
    comments = cm.load_content_list('comments', profile_id)
    
    if comments:
        selected = random.choice(comments)
        print(f"🎲 Random comment selected from {len(comments)} available")
        return selected
    else:
        return "Amazing! 🔥"

def get_random_post_caption(profile_id: str) -> str:
    """Get random post caption (profile-specific OR default - simple either/or)"""
    cm = ContentManager()
    
    # Load content using the simple either/or logic
    captions = cm.load_content_list('post_captions', profile_id)
    
    if captions:
        selected = random.choice(captions)
        print(f"🎲 Random post caption selected from {len(captions)} available")
        return selected
    else:
        return "tell your wife i said hi lmaoo🤣"

def create_custom_profile_content(profile_id: str, content_type: str, content_list: List[str]) -> bool:
    """Create custom content for specific profile"""
    cm = ContentManager()
    return cm.create_profile_content_file(content_type, profile_id, content_list)


# ─────────────────────────────────────────────────────────────────────────────
# Per-account content-folder caption reader
#
# The desktop app stores each account's captions as plain-text files inside the
# operator's content root:
#
#   <userData>/Content/Instagram/<username>/captions/captions.txt
#   <userData>/Content/Instagram/<username>/story_captions/story_captions.txt
#   <userData>/Content/Instagram/<username>/comments/comments.txt
#
# The local brain process (electron/python/server.py) is spawned with
# cwd = electron/python/ and is NOT given the content root — so the
# ContentManager defaults above point at electron/python/defaults/, which
# only holds bundled placeholder captions, never the user's per-account ones.
#
# resolve_content_root() recovers the real content root from the environment
# (SHADOWPHONE_LOG_DIR is <userData>/logs, so <userData>/Content sits beside
# it) or from an explicit override. read_account_caption_pool() then reads the
# correct per-account file. This is the fallback used when the JS layer
# (module-runner.ts resolveLocalCaptions) did not already inject a caption.
# ─────────────────────────────────────────────────────────────────────────────

def resolve_content_root(explicit: Optional[str] = None) -> Optional[str]:
    """Return the operator's Content folder, or None if it can't be located.

    Resolution order:
      1. explicit argument (e.g. config['content_root'])
      2. SHADOWPHONE_CONTENT_ROOT env var
      3. <userData>/Content derived from SHADOWPHONE_LOG_DIR (<userData>/logs)
    """
    candidates = []
    if explicit:
        candidates.append(explicit)
    env_root = os.environ.get("SHADOWPHONE_CONTENT_ROOT", "").strip()
    if env_root:
        candidates.append(env_root)
    log_dir = os.environ.get("SHADOWPHONE_LOG_DIR", "").strip()
    if log_dir:
        # <userData>/logs -> <userData>/Content
        candidates.append(os.path.join(os.path.dirname(log_dir), "Content"))

    for cand in candidates:
        try:
            if cand and os.path.isdir(cand):
                return cand
        except Exception:
            continue
    return None


def read_account_caption_pool(
    account_username: str,
    kind: str = "captions",
    content_root: Optional[str] = None,
    platform: str = "Instagram",
) -> List[str]:
    """Read a per-account caption/comment pool from the content folder.

    kind: 'captions' (post/reel) | 'story_captions' | 'comments'
    Falls back to <content_root>/defaults/<kind>.txt when no per-account file
    exists. Returns [] if the content root can't be located or the file is
    missing/empty. Comment lines (#) and blank lines are stripped.
    """
    valid_kinds = {"captions", "story_captions", "comments"}
    kind = kind if kind in valid_kinds else "captions"
    file_name = f"{kind}.txt"

    root = resolve_content_root(content_root)
    if not root:
        print(f"[content_manager] content root not found — cannot read {kind} for @{account_username}")
        return []

    safe_user = "".join(c if c.isalnum() or c in "._-" else "_" for c in str(account_username or ""))

    def _parse(path: str) -> List[str]:
        try:
            with open(path, "r", encoding="utf-8") as f:
                lines = f.readlines()
        except Exception as e:
            print(f"[content_manager] failed to read caption file {path}: {e}")
            return []
        out = []
        for line in lines:
            line = line.strip()
            if line and not line.startswith("#"):
                out.append(line)
        return out

    # 1. Per-account file
    if safe_user:
        account_file = os.path.join(root, platform, safe_user, kind, file_name)
        if os.path.exists(account_file):
            pool = _parse(account_file)
            if pool:
                print(f"[content_manager] using per-account {kind}: {account_file} ({len(pool)} lines)")
                return pool

    # 2. Shared defaults folder
    defaults_file = os.path.join(root, "defaults", file_name)
    if os.path.exists(defaults_file):
        pool = _parse(defaults_file)
        if pool:
            print(f"[content_manager] using content-root defaults {kind}: {defaults_file} ({len(pool)} lines)")
            return pool

    return []


def get_account_post_caption(
    account_username: str,
    content_root: Optional[str] = None,
) -> str:
    """Random post/reel caption from the per-account content folder.
    Returns '' when nothing is available (caller decides what to do)."""
    pool = read_account_caption_pool(account_username, "captions", content_root)
    return random.choice(pool) if pool else ""


def get_account_story_caption(
    account_username: str,
    content_root: Optional[str] = None,
) -> str:
    """Random story caption from the per-account content folder.
    Returns '' when nothing is available (caller decides what to do)."""
    pool = read_account_caption_pool(account_username, "story_captions", content_root)
    return random.choice(pool) if pool else ""

if __name__ == "__main__":
    print("📝 CONTENT MANAGER - TESTING MODE")
    print("=" * 50)
    
    cm = ContentManager()
    
    # Test profile ID
    test_profile = "1"
    
    print(f"\\n🧪 Testing content for profile {test_profile}...")
    
    # Show current status
    cm.show_profile_status(test_profile)
    
    print("\\n🎲 Testing random content selection...")
    print(f"Random story caption: {get_random_story_caption(test_profile)}")
    print(f"Random comment: {get_random_comment(test_profile)}")
    print(f"Random post caption: {get_random_post_caption(test_profile)}")
    
    usernames = get_usernames_for_follow(test_profile, 5)
    print(f"Follow list (5): {usernames}")