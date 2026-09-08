#!/usr/bin/env python3
"""
🚀 INSTAGRAM AUTOMATION - MAIN CONTROLLER
Choose which module to run
"""

def main():
    print("🚀 INSTAGRAM AUTOMATION MODULES")
    print("=" * 40)
    print("1 - 📱 Engagement (Like/Save/Comment)")
    print("2 - 👥 Follow/Unfollow Users") 
    print("3 - 📖 Story Viewer")
    print("4 - 💬 Send DMs")
    print("5 - 📸 Post Content (Photos/Videos)")
    print("6 - 🔒 ProtonVPN (US Streaming)")
    print("7 - 👤 Profile Switching (Graphene)")
    print("8 - ✈️ Airplane Mode Control")
    print("=" * 40)
    
    choice = input("Choose module (1-8): ").strip()
    
    if choice == "1":
        from engagement_module import InstagramEngager
        engager = InstagramEngager()
        count = int(input("How many posts? ") or "5")
        engager.engage_posts(count)
        
    elif choice == "2":
        from follow_module import InstagramFollower
        follower = InstagramFollower()
        users = input("Usernames (comma separated): ").strip()
        usernames = [u.strip() for u in users.split(",")]
        follower.follow_users_batch(usernames)
        
    elif choice == "3":
        from story_module import InstagramStoryViewer
        story_viewer = InstagramStoryViewer()
        count = int(input("How many stories? ") or "5")
        story_viewer.view_story_batch(count)
        
    elif choice == "4":
        from dm_module import InstagramDM
        dm_sender = InstagramDM()
        username = input("Username to message: ").strip()
        message = input("Message (or Enter for random): ").strip()
        dm_sender.send_dm_to_user(username, message if message else None)
        
    elif choice == "5":
        from post_module import InstagramPoster
        
        # Account selection
        print("\n📁 SELECT ACCOUNT:")
        print("1 - Account 1")
        print("2 - Account 2") 
        print("3 - Account 3")
        account_choice = input("Choose account (1-3): ").strip()
        account_number = int(account_choice) if account_choice in ['1', '2', '3'] else 1
        
        poster = InstagramPoster(account_number=account_number)
        
        # Content type selection
        print(f"\n📸 POST CONTENT (Account {account_number}):")
        print("1 - 📷 Image Post (device gallery)")
        print("2 - 🎬 Reel Post (device gallery)")
        print("3 - 🧪 Trial Reel (device gallery)")
        print("4 - 📖 Story Post")
        print("5 - 🖥️ Image from Computer (Images folder)")
        print("6 - 🖥️ Reel from Computer (Reels folder)")
        print("7 - 🖥️ Trial from Computer (Trials folder)")
        post_type = input("Choose content type (1-7): ").strip()
        
        caption = input("Caption (or Enter for random): ").strip()
        
        if post_type == "1":
            print(f"📸 Posting image from device gallery...")
            poster.post_image(caption=caption if caption else None)
        elif post_type == "2":
            print(f"🎬 Posting reel from device gallery...")
            poster.post_reel(caption=caption if caption else None)
        elif post_type == "3":
            print(f"🧪 Posting trial reel from device gallery...")
            poster.post_trial_reel(caption=caption if caption else None)
        elif post_type == "4":
            print(f"📖 Posting story from device...")
            poster.post_story()
        elif post_type == "5":
            print(f"🖥️ Posting image from computer Account {account_number}/Images folder...")
            filename = input("Filename (or Enter for random): ").strip()
            poster.post_image_from_computer(filename if filename else None)
        elif post_type == "6":
            print(f"🖥️ Posting reel from computer Account {account_number}/Reels folder...")
            filename = input("Filename (or Enter for random): ").strip()
            poster.post_reel_from_computer(filename if filename else None)
        elif post_type == "7":
            print(f"🖥️ Posting trial reel from computer Account {account_number}/Trials folder...")
            filename = input("Filename (or Enter for random): ").strip()
            poster.post_trial_reel_from_computer(filename if filename else None)
        
    elif choice == "6":
        from vpn_module import ProtonVPNConnector
        vpn = ProtonVPNConnector()
        vpn_choice = input("(1) Connect or (2) Disconnect VPN? ")
        
        if vpn_choice == "1":
            print("🚀 Connecting ProtonVPN US Streaming...")
            if vpn.full_vpn_connect():
                print("✅ VPN connected!")
            else:
                print("❌ VPN connection failed!")
        
        elif vpn_choice == "2":
            print("🔌 Disconnecting ProtonVPN...")
            if vpn.disconnect_vpn():
                print("✅ VPN disconnected!")
            else:
                print("❌ VPN disconnection failed!")
    
    elif choice == "7":
        from profile_switching_module import GrapheneProfileSwitcher
        switcher = GrapheneProfileSwitcher()
        
        print("\n👤 PROFILE SWITCHING OPTIONS:")
        print("1 - Switch to profile")
        print("2 - Check current profile")
        print("3 - List available profiles")
        
        profile_choice = input("Choose option (1-3): ")
        
        if profile_choice == "1":
            profile = input("Enter profile name (owner/work/guest/user2): ").strip()
            if switcher.switch_to_profile(profile):
                print("✅ Profile switch successful!")
            else:
                print("❌ Profile switch failed!")
        
        elif profile_choice == "2":
            current = switcher.get_current_profile()
            if current:
                print(f"✅ Current profile: {current}")
        
        elif profile_choice == "3":
            profiles = switcher.list_available_profiles()
            if profiles:
                print("✅ Available profiles:")
                for profile in profiles:
                    print(f"  📱 {profile}")
    
    elif choice == "8":
        from airplane_mode_module import AirplaneModeController
        airplane = AirplaneModeController()
        
        print("\n✈️ AIRPLANE MODE OPTIONS:")
        print("1 - Turn ON")
        print("2 - Turn OFF") 
        print("3 - Toggle")
        print("4 - Check status")
        print("5 - Cycle (ON→OFF)")
        
        airplane_choice = input("Choose option (1-5): ")
        
        if airplane_choice == "1":
            if airplane.airplane_on():
                print("✅ Airplane mode ON!")
            else:
                print("❌ Failed!")
        
        elif airplane_choice == "2":
            if airplane.airplane_off():
                print("✅ Airplane mode OFF!")
            else:
                print("❌ Failed!")
        
        elif airplane_choice == "3":
            if airplane.toggle_airplane_mode():
                print("✅ Airplane mode toggled!")
            else:
                print("❌ Failed!")
        
        elif airplane_choice == "4":
            status = airplane.get_airplane_status()
            if status is True:
                print("✅ Airplane mode is ON ✈️")
            elif status is False:
                print("✅ Airplane mode is OFF 📶")
        
        elif airplane_choice == "5":
            duration = int(input("OFF duration (seconds): ") or "5")
            if airplane.airplane_cycle(duration):
                print("✅ Cycle complete!")
    
    else:
        print("❌ Invalid choice")

if __name__ == "__main__":
    main()