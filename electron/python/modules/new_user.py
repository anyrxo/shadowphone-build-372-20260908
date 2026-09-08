import subprocess
import sys

# --- Configuration ---
ADB_PATH = "adb"  # Use system ADB (works with homebrew installation)

# List of app package names to install
# These apps must already be installed on the main profile (Owner) to use 'install-existing'

APPS_TO_INSTALL = [
    "com.instagram.android",
    "com.instagram.barcelona",
    "com.google.android.gm",            # Gmail
    "com.google.android.gms",           # Google Services
    "com.google.android.apps.docs",     # Google Drive - CRITICAL for content acquisition
    "com.android.vending",              # Play Store
    "com.zhiliaoapp.musically",         # TikTok
    "ch.protonvpn.android",             # ProtonVPN
    "com.twitter.android",              # X/Twitter
]

def run_adb_command(command):
    """Run an adb command and return the result."""
    result = subprocess.run(command, capture_output=True, text=True)
    return result

def create_user(profile_name):
    """Create a new user profile and return its user ID."""
    command = [
        ADB_PATH,
        "shell",
        "pm",
        "create-user",
        f'"{profile_name}"'
    ]
    result = run_adb_command(command)
    if result.returncode == 0:
        print(f"✅ Created profile: {profile_name}")
        # Extract user ID from the output
        for line in result.stdout.splitlines():
            if "Success: created user id" in line:
                user_id = line.strip().split()[-1]
                return user_id
    else:
        print(f"❌ Failed to create {profile_name}: {result.stderr.strip()}")
    return None

def install_apps_for_user(user_id):
    """Install specified apps for the given user ID."""
    for package in APPS_TO_INSTALL:
        command = [
            ADB_PATH,
            "shell",
            "pm",
            "install-existing",
            "--user",
            user_id,
            package
        ]
        result = run_adb_command(command)
        if result.returncode == 0:
            print(f"✅ Installed {package} for user {user_id}")
        else:
            print(f"❌ Failed to install {package} for user {user_id}: {result.stderr.strip()}")

def main():
    try:
        count = int(input("How many profiles do you want to create? ").strip())
        for i in range(count):
            name = input(f"Profile {i+1} name: ").strip()
            user_id = create_user(name)
            if user_id:
                install_apps_for_user(user_id)
    except ValueError:
        print("❌ Invalid number entered.")

def create_single_user_profile(profile_name, device_id="1A121FDF60082H"):
    """Create a single user profile for dashboard integration"""
    try:
        # Update ADB command to include device ID
        command = [
            "adb", "-s", device_id,
            "shell",
            "pm",
            "create-user",
            f'"{profile_name}"'
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        
        if result.returncode == 0:
            print(f"✅ Created profile: {profile_name}")
            # Extract user ID from the output
            for line in result.stdout.splitlines():
                if "Success: created user id" in line:
                    user_id = line.strip().split()[-1]
                    print(f"📱 User ID: {user_id}")
                    
                    # Install apps for the new user
                    print(f"📦 Installing apps for user {user_id}...")
                    install_apps_for_user_with_device(user_id, device_id)
                    
                    return user_id, f"Profile '{profile_name}' created successfully with ID {user_id}"
            return None, f"Profile created but could not extract user ID"
        else:
            error_msg = result.stderr.strip() if result.stderr else "Unknown error"
            return None, f"Failed to create profile: {error_msg}"
            
    except subprocess.TimeoutExpired:
        return None, "Profile creation timed out"
    except Exception as e:
        return None, f"Error creating profile: {str(e)}"

def install_apps_for_user_with_device(user_id, device_id):
    """Install specified apps for the given user ID on specific device."""
    for package in APPS_TO_INSTALL:
        command = [
            "adb", "-s", device_id,
            "shell",
            "pm",
            "install-existing",
            "--user",
            user_id,
            package
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=15)
        if result.returncode == 0:
            print(f"✅ Installed {package} for user {user_id}")
        else:
            print(f"❌ Failed to install {package} for user {user_id}: {result.stderr.strip()}")

if __name__ == "__main__":
    main()