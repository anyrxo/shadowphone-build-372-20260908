"""
Google Drive Uploader Module
Uploads templated videos to specified Google Drive folder.
Uses OAuth2 with refresh token (no browser auth needed).
"""

from pathlib import Path
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
import mimetypes

# OAuth2 Credentials
CLIENT_ID = "1045727708702-q07gfkdll70djoi0odruiaa2slv3oa8d.apps.googleusercontent.com"
CLIENT_SECRET = "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"
REFRESH_TOKEN = "1//052fWWHgrRI7-CgYIARAAGAUSNwF-L9IrrDICccoy_I3uQSiy7jubK6CW_XYfGpmj9sHGyAnUFvURApDs5irvOCi1Rb6Qv6VkkLQ"

# Default target folder
DEFAULT_FOLDER_ID = "1Pbgghw3v2CgPrweFIP2aIlLU30nhZMKI"


def get_drive_service():
    """Create authenticated Drive API service"""
    creds = Credentials(
        token=None,
        refresh_token=REFRESH_TOKEN,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET
    )
    # Refresh to get access token
    creds.refresh(Request())
    return build('drive', 'v3', credentials=creds)


def extract_folder_id(url_or_id: str) -> str:
    """Extract folder ID from Drive URL or return as-is if already an ID"""
    if "drive.google.com" in url_or_id:
        # Extract from URL like https://drive.google.com/drive/folders/FOLDER_ID
        if "/folders/" in url_or_id:
            folder_id = url_or_id.split("/folders/")[1].split("?")[0].split("/")[0]
            return folder_id
    return url_or_id


def upload_video(file_path: Path, folder_id: str = None, log_func=None) -> dict:
    """
    Upload a video file to Google Drive folder.
    
    Args:
        file_path: Path to the video file
        folder_id: Google Drive folder ID (default: DEFAULT_FOLDER_ID)
        log_func: Optional logging function for progress updates
        
    Returns:
        dict with 'id', 'name', 'webViewLink' or None on failure
    """
    folder_id = folder_id or DEFAULT_FOLDER_ID
    
    def log(msg):
        if log_func:
            log_func(msg)
        else:
            print(msg)
    
    try:
        service = get_drive_service()
        
        # Determine MIME type
        mime_type = mimetypes.guess_type(str(file_path))[0] or 'video/mp4'
        
        file_metadata = {
            'name': file_path.name,
            'parents': [folder_id]
        }
        
        media = MediaFileUpload(
            str(file_path),
            mimetype=mime_type,
            resumable=True
        )
        
        log(f"   ☁️ Uploading: {file_path.name[:30]}...")
        
        file = service.files().create(
            body=file_metadata,
            media_body=media,
            fields='id, name, webViewLink'
        ).execute()
        
        log(f"   ✅ Uploaded: {file.get('name')}")
        return file
        
    except Exception as e:
        log(f"   ❌ Upload failed: {str(e)[:60]}")
        return None


def create_subfolder(folder_name: str, parent_id: str = None) -> str:
    """Create a subfolder in Drive and return its ID"""
    parent_id = parent_id or DEFAULT_FOLDER_ID
    
    try:
        service = get_drive_service()
        
        # Check if folder exists
        query = f"name='{folder_name}' and mimeType='application/vnd.google-apps.folder' and '{parent_id}' in parents and trashed=false"
        results = service.files().list(q=query, fields='files(id)').execute()
        
        if results.get('files'):
            return results['files'][0]['id']
        
        # Create new folder
        file_metadata = {
            'name': folder_name,
            'mimeType': 'application/vnd.google-apps.folder',
            'parents': [parent_id]
        }
        
        folder = service.files().create(body=file_metadata, fields='id').execute()
        return folder.get('id')
        
    except Exception as e:
        print(f"Failed to create folder: {e}")
        return None


def get_existing_files(folder_id: str = None) -> set:
    """Get set of filenames already in Drive folder"""
    folder_id = folder_id or DEFAULT_FOLDER_ID
    try:
        service = get_drive_service()
        query = f"'{folder_id}' in parents and trashed=false"
        results = service.files().list(q=query, fields='files(name)', pageSize=1000).execute()
        return {f['name'] for f in results.get('files', [])}
    except:
        return set()


def upload_folder(folder_path: Path, drive_folder_id: str = None, log_func=None) -> int:
    """
    Upload all videos from a local folder to Drive.
    SMART: Skips files that already exist on Drive.
    
    Args:
        folder_path: Path to folder containing videos
        drive_folder_id: Target Drive folder ID
        log_func: Optional logging function
        
    Returns:
        Number of successfully uploaded files
    """
    drive_folder_id = drive_folder_id or DEFAULT_FOLDER_ID
    VIDEO_EXTENSIONS = {'.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'}
    
    def log(msg):
        if log_func:
            log_func(msg)
        else:
            print(msg)
    
    from concurrent.futures import ThreadPoolExecutor, as_completed

    all_videos = [f for f in folder_path.iterdir() if f.is_file() and f.suffix.lower() in VIDEO_EXTENSIONS]
    
    if not all_videos:
        log(f"   ⚠️ No videos to upload in {folder_path.name}")
        return 0
    
    # Check what's already on Drive - skip duplicates
    log(f"   🔍 Checking Drive for existing files...")
    existing_on_drive = get_existing_files(drive_folder_id)
    
    videos = [v for v in all_videos if v.name not in existing_on_drive]
    skipped = len(all_videos) - len(videos)
    
    if skipped > 0:
        log(f"   ⏭️ Skipping {skipped} already on Drive")
    
    if not videos:
        log(f"   ✅ All files already on Drive!")
        return len(all_videos)  # Return total since all are uploaded
    
    log(f"   ☁️ Uploading {len(videos)} NEW videos (10 threads)...")
    
    success = 0
    max_workers = min(10, len(videos))  # Max 10 concurrent uploads
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        # Submit all upload tasks
        future_to_video = {
            executor.submit(upload_video, video, drive_folder_id, log_func): video 
            for video in videos
        }
        
        # Process results as they complete
        for future in as_completed(future_to_video):
            video = future_to_video[future]
            try:
                result = future.result()
                if result:
                    success += 1
            except Exception as e:
                log(f"   ❌ Thread error uploading {video.name}: {e}")

    log(f"   ✅ Drive upload complete: {success}/{len(videos)} new, {skipped} already existed")
    return success + skipped


def delete_contents_of_folder(folder_id: str = None, log_func=None) -> int:
    """Delete all files and subfolders within a specific Drive folder"""
    folder_id = folder_id or DEFAULT_FOLDER_ID
    
    def log(msg):
        if log_func:
            log_func(msg)
        else:
            print(msg)
            
    try:
        service = get_drive_service()
        
        # List all items in the folder
        query = f"'{folder_id}' in parents and trashed=false"
        results = service.files().list(q=query, fields='files(id, name, mimeType)').execute()
        files = results.get('files', [])
        
        if not files:
            log(f"   ℹ️ Drive folder is already empty.")
            return 0
            
        log(f"   🗑️ Deleting {len(files)} items from Drive folder...")
        
        count = 0
        for file in files:
            try:
                service.files().delete(fileId=file['id']).execute()
                count += 1
                if count % 5 == 0:
                     log(f"   Deleted {count}/{len(files)} items...")
            except Exception as e:
                log(f"   ❌ Failed to delete {file.get('name')}: {e}")
                
        log(f"   ✅ Successfully cleared {count} items from Drive.")
        return count
        
    except Exception as e:
        log(f"   ❌ Error cleaning Drive folder: {e}")
        return 0


# Quick test
if __name__ == "__main__":
    print("Testing Drive connection...")
    try:
        service = get_drive_service()
        about = service.about().get(fields='user').execute()
        print(f"✅ Connected as: {about['user']['emailAddress']}")
    except Exception as e:
        print(f"❌ Connection failed: {e}")
