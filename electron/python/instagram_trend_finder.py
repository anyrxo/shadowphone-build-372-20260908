import argparse
import json
import re
import statistics
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from http.cookiejar import MozillaCookieJar
from pathlib import Path
from typing import Any


def emit(kind: str, **payload: Any) -> None:
    print(json.dumps({"kind": kind, **payload}), flush=True)


def emit_log(message: str, level: str = "info") -> None:
    emit("log", level=level, message=message)


def emit_progress(event_type: str, **payload: Any) -> None:
    emit("progress", type=event_type, **payload)


def ensure_instaloader():
    try:
        import instaloader  # type: ignore
        return instaloader
    except ImportError:
        emit_log("Instaloader not found locally. Installing it now.")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "instaloader"])
        import instaloader  # type: ignore
        return instaloader


def normalize_username(raw: Any) -> str | None:
    value = str(raw or "").strip().lower()
    value = value.replace("@", "")
    value = value.split("?")[0].split("/")[0]
    if not value or not re.match(r"^[a-z0-9._]+$", value):
        return None
    return value


def extract_hashtags(text: str | None) -> list[str]:
    return sorted(set(match.lower() for match in re.findall(r"#[\w.]+", text or "")))


def format_permalink(shortcode: str, typename: str) -> str:
    prefix = "reel" if typename == "GraphVideo" else "p"
    return f"https://www.instagram.com/{prefix}/{shortcode}/"


def load_config(path_str: str) -> dict[str, Any]:
    with open(path_str, "r", encoding="utf-8") as handle:
      return json.load(handle)


def build_loader(instaloader_module, cookies_file: str | None):
    loader = instaloader_module.Instaloader(
        download_pictures=False,
        download_videos=False,
        download_video_thumbnails=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False,
        quiet=True,
    )

    if cookies_file:
        cookie_jar = MozillaCookieJar()
        cookie_jar.load(cookies_file, ignore_discard=True, ignore_expires=True)
        session = loader.context.get_anonymous_session()
        for cookie in cookie_jar:
            session.cookies.set_cookie(cookie)
        loader.context._session = session
        try:
            username = loader.context.test_login()
            if username:
                emit_log(f"Authenticated Instagram session detected for @{username}.")
            else:
                emit_log("Browser cookies loaded, but no active Instagram login was detected.", "warn")
        except Exception as error:
            emit_log(f"Instagram cookie check failed: {error}", "warn")

    return loader


def score_creator_posts(posts: list[dict[str, Any]], follower_count: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not posts:
        return [], {
            "average_views": 0,
            "median_views": 0,
            "total_views": 0,
            "videos_last_7_days": 0,
            "breakout_count": 0,
            "health_score": 0,
        }

    view_values = [max(int(post["views"]), 0) for post in posts]
    average_views = sum(view_values) / len(view_values)
    median_views = statistics.median(view_values)
    total_views = sum(view_values)
    videos_last_7_days = sum(1 for post in posts if post["age_hours"] <= 24 * 7)

    breakout_count = 0
    for post in posts:
        creator_lift = post["views"] / max(average_views, 1)
        engagement_rate = (post["likes"] + (post["comments"] * 4)) / max(post["views"], follower_count, 1)
        recency_bonus = max(0.0, (72.0 - min(post["age_hours"], 72.0)) / 24.0)
        follower_ratio = post["views"] / max(follower_count, 1)
        virality_score = (creator_lift * 5.2) + (engagement_rate * 150.0) + min(follower_ratio, 4.0) + (recency_bonus * 1.4)

        post["creatorLift"] = round(creator_lift, 4)
        post["engagementRate"] = round(engagement_rate, 6)
        post["viralityScore"] = round(virality_score, 4)

        if creator_lift >= 1.5:
            breakout_count += 1

    avg_lift = sum(float(post["creatorLift"]) for post in posts) / len(posts)
    avg_engagement_rate = sum(float(post["engagementRate"]) for post in posts) / len(posts)
    fresh_video_count = sum(1 for post in posts if float(post["ageHours"]) <= 72.0)
    breakout_rate = breakout_count / max(len(posts), 1)
    freshness_rate = fresh_video_count / max(len(posts), 1)
    health_score = (
        (avg_lift * 22.0)
        + (avg_engagement_rate * 180.0)
        + (breakout_rate * 30.0)
        + (freshness_rate * 16.0)
        + min(videos_last_7_days, 14)
    )

    return posts, {
        "average_views": round(average_views, 2),
        "median_views": round(median_views, 2),
        "total_views": int(total_views),
        "videos_last_7_days": int(videos_last_7_days),
        "breakout_count": int(breakout_count),
        "fresh_video_count": int(fresh_video_count),
        "avg_creator_lift": round(avg_lift, 4),
        "avg_engagement_rate": round(avg_engagement_rate, 6),
        "breakout_rate": round(breakout_rate, 6),
        "health_score": round(health_score, 2),
    }


def build_snapshot(config: dict[str, Any], loader) -> dict[str, Any]:
    instaloader_module = ensure_instaloader()
    usernames = []
    for raw in config.get("manualSeeds") or []:
        username = normalize_username(raw)
        if username and username not in usernames:
            usernames.append(username)

    max_creators = max(1, min(int(config.get("maxCreators") or 60), 250))
    posts_per_creator = max(3, min(int(config.get("postsPerCreator") or 8), 15))
    min_views = max(0, int(config.get("minViews") or 0))
    lookback_days = max(3, min(int(config.get("lookbackDays") or 14), 30))
    lookback_cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)

    selected_usernames = usernames[:max_creators]
    emit_progress("run_start", totalCreators=len(selected_usernames), postsPerCreator=posts_per_creator)

    top_videos: list[dict[str, Any]] = []
    creators: list[dict[str, Any]] = []
    hashtag_map: dict[str, dict[str, Any]] = {}
    failed_creators: list[dict[str, str]] = []

    for index, username in enumerate(selected_usernames, start=1):
        emit_progress("creator_start", current=index, totalCreators=len(selected_usernames), username=username)
        try:
            profile = instaloader_module.Profile.from_username(loader.context, username)
            follower_count = int(getattr(profile, "followers", 0) or 0)
            display_name = str(getattr(profile, "full_name", "") or username)
            profile_url = f"https://www.instagram.com/{username}/"
            creator_posts: list[dict[str, Any]] = []

            for post in profile.get_posts():
                post_date = post.date_utc
                if post_date.tzinfo is None:
                    post_date = post_date.replace(tzinfo=timezone.utc)
                if post_date < lookback_cutoff and len(creator_posts) >= min(3, posts_per_creator):
                    break

                if not post.is_video:
                    continue

                views = int(getattr(post, "video_view_count", 0) or 0)
                likes = int(getattr(post, "likes", 0) or 0)
                comments = int(getattr(post, "comments", 0) or 0)
                if views <= 0:
                    views = max(likes * 8, comments * 40, likes + comments)
                if views < min_views:
                    continue

                age_hours = max((datetime.now(timezone.utc) - post_date).total_seconds() / 3600.0, 0.1)
                caption = (post.caption or "").strip()
                hashtags = extract_hashtags(caption)
                post_row = {
                    "id": post.shortcode,
                    "url": format_permalink(post.shortcode, post.typename),
                    "creatorUsername": username,
                    "creatorDisplayName": display_name,
                    "creatorProfileUrl": profile_url,
                    "title": caption.splitlines()[0][:140] if caption else "",
                    "description": caption[:500] if caption else "",
                    "views": views,
                    "likes": likes,
                    "comments": comments,
                    "reposts": 0,
                    "saves": 0,
                    "postedAt": post_date.isoformat(),
                    "ageHours": round(age_hours, 2),
                    "soundLabel": None,
                    "soundKey": None,
                    "thumbnailUrl": getattr(post, "url", None),
                    "thumbnails": [{"url": getattr(post, "url", None)}] if getattr(post, "url", None) else [],
                    "hashtags": hashtags,
                    "creatorAverageViews": 0,
                }
                creator_posts.append(post_row)

                if len(creator_posts) >= posts_per_creator:
                    break

            creator_posts, creator_metrics = score_creator_posts(creator_posts, follower_count)
            for post in creator_posts:
                post["creatorAverageViews"] = creator_metrics["average_views"]
                top_videos.append(post)
                for tag in post["hashtags"]:
                    entry = hashtag_map.setdefault(tag, {
                        "tag": tag,
                        "occurrences": 0,
                        "uniqueCreators": set(),
                        "totalViews": 0,
                    })
                    entry["occurrences"] += 1
                    entry["uniqueCreators"].add(username)
                    entry["totalViews"] += post["views"]

            creators.append({
                "username": username,
                "displayName": display_name,
                "profileUrl": profile_url,
                "scrapedPosts": len(creator_posts),
                "totalVisiblePosts": int(getattr(profile, "mediacount", 0) or 0),
                "averageViews": creator_metrics["average_views"],
                "medianViews": creator_metrics["median_views"],
                "totalViews": creator_metrics["total_views"],
                "videosLast7Days": creator_metrics["videos_last_7_days"],
                "breakoutCount": creator_metrics["breakout_count"],
                "freshVideoCount": creator_metrics["fresh_video_count"],
                "avgCreatorLift": creator_metrics["avg_creator_lift"],
                "avgEngagementRate": creator_metrics["avg_engagement_rate"],
                "breakoutRate": creator_metrics["breakout_rate"],
                "healthScore": creator_metrics["health_score"],
            })

            emit_progress("creator_complete", current=index, totalCreators=len(selected_usernames), username=username, videos=len(creator_posts))
        except Exception as error:
            failed_creators.append({"username": username, "error": str(error)})
            emit_progress("creator_error", current=index, totalCreators=len(selected_usernames), username=username, error=str(error))

    top_videos.sort(key=lambda item: ((float(item["viralityScore"]) * 1.08) + (float(item["creatorLift"]) * 12.0) + (float(item["engagementRate"]) * 120.0), item["views"]), reverse=True)
    creators.sort(key=lambda item: (item["healthScore"], item["averageViews"]), reverse=True)

    top_hashtags = []
    for item in hashtag_map.values():
        unique_creators = len(item["uniqueCreators"])
        score = (item["occurrences"] * 3.0) + (unique_creators * 6.0) + (item["totalViews"] / 160000)
        top_hashtags.append({
            "tag": item["tag"],
            "occurrences": item["occurrences"],
            "uniqueCreators": unique_creators,
            "totalViews": int(item["totalViews"]),
            "score": round(score, 3),
        })
    top_hashtags.sort(key=lambda item: (item["score"], item["totalViews"]), reverse=True)

    average_engagement_rate = (
        sum(float(post["engagementRate"]) for post in top_videos) / len(top_videos)
        if top_videos else 0.0
    )
    breakout_video_count = sum(1 for post in top_videos if float(post["creatorLift"]) >= 1.5)
    fresh_video_count = sum(1 for post in top_videos if float(post["ageHours"]) <= 72.0)

    generated_at = datetime.now(timezone.utc).isoformat()
    snapshot = {
        "generatedAt": generated_at,
        "summary": {
            "creatorCount": len(creators),
            "videoCount": len(top_videos),
            "soundCount": 0,
            "hashtagCount": len(top_hashtags),
            "seedCount": len(selected_usernames),
            "breakoutVideoCount": breakout_video_count,
            "freshVideoCount": fresh_video_count,
            "multiCreatorSoundCount": 0,
            "failedCreatorCount": len(failed_creators),
            "averageEngagementRate": round(average_engagement_rate, 6),
        },
        "topVideos": top_videos[:48],
        "topSounds": [],
        "creators": creators[:48],
        "topHashtags": top_hashtags[:64],
        "failedCreators": failed_creators,
    }

    return snapshot


def run(args: argparse.Namespace) -> int:
    instaloader_module = ensure_instaloader()
    config = load_config(args.config)
    loader = build_loader(instaloader_module, args.cookies_file)
    snapshot = build_snapshot(config, loader)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now().strftime("%Y%m%d_%H%M%S")
    snapshot_path = output_dir / f"instagram_trends_{generated_at}.json"
    snapshot_path.write_text(json.dumps(snapshot, ensure_ascii=True, indent=2), encoding="utf-8")

    emit_progress(
        "run_complete",
        totalCreators=int(snapshot["summary"]["seedCount"]),
        completedCreators=int(snapshot["summary"]["creatorCount"]),
        snapshotPath=str(snapshot_path),
    )
    emit(
        "result",
        snapshotPath=str(snapshot_path),
        summary=snapshot["summary"],
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--config", required=True)
    run_parser.add_argument("--output-dir", required=True)
    run_parser.add_argument("--cookies-file")

    args = parser.parse_args()

    if args.command == "run":
        return run(args)
    return 1


if __name__ == "__main__":
    sys.exit(main())
