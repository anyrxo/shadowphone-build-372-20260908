#!/usr/bin/env python3
"""
📝 PROFILE CONTENT CREATOR
🎯 Easy tool to create profile-specific content files

USAGE:
1. Run this script
2. Choose profile ID
3. Choose content type
4. Enter custom content or use defaults
5. Save profile-specific file

The automation modules will then use your custom content for that profile!
"""

from content_manager import ContentManager, create_custom_profile_content
import os

def create_profile_content_interactive():
    """Interactive tool to create profile-specific content"""
    cm = ContentManager()
    
    print("📝 PROFILE CONTENT CREATOR")
    print("=" * 50)
    
    # Get profile ID
    while True:
        try:
            profile_id = input("Enter Profile ID (e.g., 1, 2, 3): ").strip()
            if profile_id:
                break
            print("❌ Please enter a valid profile ID")
        except KeyboardInterrupt:
            print("\n❌ Cancelled")
            return
    
    # Show current status
    print(f"\n📋 Current content status for Profile {profile_id}:")
    cm.show_profile_status(profile_id)
    
    # Choose content type
    print("\n📝 Choose content type to customize:")
    content_types = list(cm.content_types.keys())
    for i, content_type in enumerate(content_types, 1):
        description = cm.content_types[content_type]['description']
        print(f"{i}. {content_type} ({description})")
    
    while True:
        try:
            choice = int(input(f"\nChoose content type (1-{len(content_types)}): "))
            if 1 <= choice <= len(content_types):
                selected_type = content_types[choice - 1]
                break
            print(f"❌ Please enter a number between 1 and {len(content_types)}")
        except (ValueError, KeyboardInterrupt):
            print("\n❌ Cancelled")
            return
    
    print(f"\n✅ Selected: {selected_type}")
    
    # Show current default content
    default_content = cm.load_content_list(selected_type)
    print(f"\n📄 Current default {selected_type} ({len(default_content)} items):")
    for i, item in enumerate(default_content[:5], 1):
        print(f"  {i}. {item}")
    if len(default_content) > 5:
        print(f"  ... and {len(default_content) - 5} more")
    
    # Choose creation method
    print(f"\n🎨 How do you want to create custom {selected_type} for Profile {profile_id}?")
    print("1. Start with default content (copy and modify)")
    print("2. Create completely new content")
    print("3. Cancel")
    
    while True:
        try:
            method = int(input("Choose method (1-3): "))
            if method in [1, 2, 3]:
                break
            print("❌ Please enter 1, 2, or 3")
        except (ValueError, KeyboardInterrupt):
            print("\n❌ Cancelled")
            return
    
    if method == 3:
        print("❌ Cancelled")
        return
    
    # Get content
    if method == 1:
        # Start with defaults
        content_list = default_content.copy()
        print(f"\n📝 Starting with {len(content_list)} default items.")
        print("You can now add, remove, or modify items.")
    else:
        # Start fresh
        content_list = []
        print(f"\n📝 Starting with empty {selected_type} list.")
    
    # Content editing loop
    while True:
        print(f"\n📋 Current {selected_type} for Profile {profile_id} ({len(content_list)} items):")
        
        if content_list:
            for i, item in enumerate(content_list, 1):
                print(f"  {i}. {item}")
        else:
            print("  (empty)")
        
        print(f"\n🛠️ Options:")
        print("1. Add new item")
        print("2. Remove item")
        print("3. Edit item")
        print("4. Save and finish")
        print("5. Cancel")
        
        try:
            action = int(input("Choose action (1-5): "))
        except (ValueError, KeyboardInterrupt):
            print("\n❌ Cancelled")
            return
        
        if action == 1:
            # Add new item
            new_item = input(f"Enter new {selected_type[:-1]} (or press Enter to skip): ").strip()
            if new_item:
                content_list.append(new_item)
                print(f"✅ Added: {new_item}")
        
        elif action == 2:
            # Remove item
            if not content_list:
                print("❌ No items to remove")
                continue
            try:
                item_num = int(input(f"Enter item number to remove (1-{len(content_list)}): "))
                if 1 <= item_num <= len(content_list):
                    removed = content_list.pop(item_num - 1)
                    print(f"✅ Removed: {removed}")
                else:
                    print(f"❌ Invalid item number")
            except ValueError:
                print("❌ Invalid number")
        
        elif action == 3:
            # Edit item
            if not content_list:
                print("❌ No items to edit")
                continue
            try:
                item_num = int(input(f"Enter item number to edit (1-{len(content_list)}): "))
                if 1 <= item_num <= len(content_list):
                    current = content_list[item_num - 1]
                    print(f"Current: {current}")
                    new_content = input("Enter new content (or press Enter to keep current): ").strip()
                    if new_content:
                        content_list[item_num - 1] = new_content
                        print(f"✅ Updated: {new_content}")
                else:
                    print(f"❌ Invalid item number")
            except ValueError:
                print("❌ Invalid number")
        
        elif action == 4:
            # Save and finish
            if not content_list:
                print("❌ Cannot save empty content list")
                continue
            
            print(f"\n💾 Saving {len(content_list)} {selected_type} for Profile {profile_id}...")
            
            if create_custom_profile_content(profile_id, selected_type, content_list):
                print(f"✅ Successfully created profile-specific {selected_type} file!")
                print(f"📁 Profile {profile_id} will now use this custom content for {selected_type}")
                
                # Show updated status
                print(f"\n📋 Updated content status for Profile {profile_id}:")
                cm.show_profile_status(profile_id)
                return
            else:
                print(f"❌ Failed to create profile-specific file")
        
        elif action == 5:
            # Cancel
            print("❌ Cancelled without saving")
            return

def quick_examples():
    """Create some quick example profile content"""
    print("🚀 QUICK EXAMPLES - Creating sample profile content...")
    
    # Profile 1 - Fitness content
    fitness_usernames = [
        "therock", "vancityreynolds", "zendaya", "chrishemsworth",
        "vancityreynolds", "priyankachopra", "gal_gadot", "tomholland2013"
    ]
    
    fitness_captions = [
        "Crushing today's workout! 💪 #fitness #motivation",
        "No excuses, just results! 🔥 #workout #dedication", 
        "Strong mind, strong body 🧠💪 #mindset #fitness",
        "Progress over perfection 📈 #journey #improvement"
    ]
    
    fitness_comments = [
        "Beast mode! 💪", "Keep pushing! 🔥", "Inspiring! 💯", 
        "Goals! 🎯", "Strong work! 💪", "Never give up! 🚀"
    ]
    
    print("👤 Creating fitness profile content for Profile 1...")
    create_custom_profile_content("1", "usernames", fitness_usernames)
    create_custom_profile_content("1", "post_captions", fitness_captions)
    create_custom_profile_content("1", "comments", fitness_comments)
    
    # Profile 2 - Travel content
    travel_captions = [
        "Wanderlust calling! ✈️ #travel #adventure",
        "New destination, new memories 🌍 #explore #wanderlust",
        "Life is short, travel often 🗺️ #travel #life",
        "Adventure awaits around every corner 🧭 #adventure"
    ]
    
    print("👤 Creating travel profile content for Profile 2...")
    create_custom_profile_content("2", "post_captions", travel_captions)
    
    print("✅ Sample profile content created!")
    print("📁 Profile 1: Fitness-focused content")
    print("📁 Profile 2: Travel-focused captions")

if __name__ == "__main__":
    print("📝 PROFILE CONTENT CREATOR")
    print("=" * 50)
    print("1. Create custom profile content (interactive)")
    print("2. Create quick examples")
    print("3. Show all profile status")
    print("=" * 50)
    
    try:
        choice = int(input("Choose option (1-3): "))
        
        if choice == 1:
            create_profile_content_interactive()
        elif choice == 2:
            quick_examples()
        elif choice == 3:
            cm = ContentManager()
            for profile_id in ["1", "2", "3", "4", "5"]:
                cm.show_profile_status(profile_id)
                print()
        else:
            print("❌ Invalid choice")
            
    except (ValueError, KeyboardInterrupt):
        print("\n❌ Cancelled")