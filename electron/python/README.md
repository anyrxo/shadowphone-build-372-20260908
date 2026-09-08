# 🚀 ShadowPhone Module Server

FastAPI server that provides module execution as a protected API.

## Deploy to Railway (2 Minutes)

### Step 1: Create Railway Account

Go to [railway.app](https://railway.app) and sign up with GitHub

### Step 2: New Project

1. Click **"New Project"**
2. Select **"Deploy from GitHub repo"** OR **"Empty Project"**

### Step 3: If using GitHub

1. Upload this `python/` folder to a GitHub repo
2. Connect that repo to Railway
3. Railway auto-detects Python and deploys

### Step 4: If using Empty Project

1. Click **"Add Service"** → **"Empty Service"**
2. Go to **Settings** → **Deploy**
3. Set **Start Command**: `uvicorn server:app --host 0.0.0.0 --port $PORT`
4. Upload files via Railway CLI or zip upload

### Step 5: Set Environment Variables

In Railway dashboard → **Variables**:

```
SHADOWPHONE_API_SECRET=your-secret-key-here
```

### Step 6: Get Your URL

Railway gives you a URL like:

```
https://shadowphone-modules-production.up.railway.app
```

### Step 7: Update Electron

Update `electron/main.js` line 20:

```javascript
const MODULES_SERVER_URL = 'https://YOUR-RAILWAY-URL.up.railway.app'
```

Then rebuild the `.exe`:

```bash
cd electron
npm run build:win
```

---

## Quick Test

Once deployed, test with:

```bash
curl -X POST https://YOUR-URL/execute \
  -H "Authorization: Bearer your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"moduleId": "delay", "deviceId": "test", "config": {"seconds": 2}}'
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check |
| `/health` | GET | Health status |
| `/modules` | GET | List available modules |
| `/execute` | POST | Execute a module |
| `/workflow` | POST | Execute multi-profile workflow |

## Available Modules (25)

### Instagram

- `engagement` - Like/comment on feed/reels
- `follow` - Follow users from target's followers
- `post_feed` - Post to feed
- `post_story` - Post to story
- `repost` - Repost from another user
- `edit_profile` - Edit profile bio/name/website
- `ig_launcher` - Launch with popup handling
- `ig_account_switch` - Switch IG accounts
- `stats_scraper` - Collect account stats
- `detect_accounts` - Detect logged-in accounts

### Threads

- `threads_post` - Post to Threads
- `threads_engage` - Engage on Threads

### TikTok

- `tiktok_post` - Post to TikTok
- `tiktok_engage` - Engage on TikTok

### Twitter/X

- `twitter_post` - Post to X
- `twitter_engage` - Engage on X

### System

- `airplane_toggle` - Toggle airplane mode (IP reset)
- `gallery_clean` - Clean gallery/downloads
- `profile_switch` - Switch GrapheneOS profile
- `vpn_connect` - Connect to ProtonVPN
- `delay` - Fixed delay
- `random_delay` - Random delay
- `drive_sync` - Sync from Google Drive
