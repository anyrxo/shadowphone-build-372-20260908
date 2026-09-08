# Module: engagement
# Instagram feed + reels engagement with full human behavior simulation.
# Ported from old appium engagement_module.py with HumanBehavior system.
import asyncio
import random
import re
from lib.ws_modules_shared import (
    WSDeviceAdapter,
    _SessionState,
    _jitter,
    _snap_to_feed_post,
    _is_ig_ad_xml,
    _is_ig_suggested_card_xml,
    _dismiss_ig_popups,
    _navigate_to_ig_tab,
    _post_comment,
    _comment_sheet_open,
    InstagramVerificationRequired,
    raise_if_instagram_verification,
)
from lib.persistent_log import ModuleLogger

_LOG = ModuleLogger("engagement")


async def _warn(device, msg: str) -> None:
    """Non-fatal warning. ModuleLogger has no .warning, so we tag the line
    with WARN: and reuse .log so it lands in the persistent file + WS."""
    try:
        await _LOG.log(device, f"WARN: {msg}")
    except Exception:
        pass


async def _sleep_keepalive(device, duration: float, chunk: float = 20.0) -> None:
    """Sleep `duration`s, but if it would outlast the desktop WS keepalive window
    (45s stale), break it into <=chunk-second pieces with a tiny outgoing tick
    between them. The brain can't answer pings while blocked inside a module —
    only its OUTGOING messages keep the socket warm — so a long, fatigue-stretched
    view used to silently trip a heartbeat timeout and abort a healthy run."""
    remaining = float(duration or 0)
    if remaining <= chunk:
        if remaining > 0:
            await asyncio.sleep(remaining)
        return
    while remaining > 0:
        step = min(chunk, remaining)
        await asyncio.sleep(step)
        remaining -= step
        if remaining > 0:
            try:
                await _LOG.log(device, "…")
            except Exception:
                pass


IG_PKG = "com.instagram.android"
_EXACT_LIKE_ATTEMPTS_PER_ITEM = 3
_EXACT_COMMENT_ATTEMPTS_PER_ITEM = 3


def _resolve_run_settings(config: dict) -> dict:
    try:
        count = int(config.get("count", 5))
    except (TypeError, ValueError):
        count = 5
    count = max(1, min(count, 50))

    try:
        feed_ratio = float(config.get("feed_ratio", 0.35))
    except (TypeError, ValueError):
        feed_ratio = 0.35
    if feed_ratio > 1:
        feed_ratio /= 100
    feed_ratio = max(0.0, min(feed_ratio, 1.0))

    def chance(name: str, default: float) -> float:
        try:
            value = float(config.get(name, default)) / 100
        except (TypeError, ValueError):
            value = default / 100
        return max(0.0, min(value, 1.0))

    exact_comment_mode = config.get("exact_comment_mode") is True
    exact_like_mode = config.get("like_only") is True and not exact_comment_mode
    if exact_comment_mode:
        raw_comments = config.get("comments", ())
        if not isinstance(raw_comments, (list, tuple)):
            raw_comments = ()
        comment_texts = tuple(
            text
            for text in raw_comments
            if isinstance(text, str) and text.strip()
        )
        return {
            "count": count,
            "feed_ratio": 1.0,
            "base_like_chance": 0.0,
            "base_comment_chance": 1.0,
            "exact_like_mode": False,
            "exact_comment_mode": True,
            "comment_texts": comment_texts,
            "attempts_per_item": _EXACT_COMMENT_ATTEMPTS_PER_ITEM,
        }
    return {
        "count": count,
        "feed_ratio": feed_ratio,
        "base_like_chance": 1.0 if exact_like_mode else chance("like_chance", 80),
        "base_comment_chance": 0.0 if exact_like_mode else chance("comment_chance", 15),
        "exact_like_mode": exact_like_mode,
        "attempts_per_item": _EXACT_LIKE_ATTEMPTS_PER_ITEM if exact_like_mode else 1,
    }


def _iteration_counts(
    *,
    exact_like_mode: bool,
    skipped: bool,
    liked: bool,
    exact_comment_mode: bool = False,
    commented: bool = False,
) -> bool:
    if exact_like_mode:
        return not skipped and liked
    if exact_comment_mode:
        return not skipped and commented
    return True


def _feed_like_confirmed(xml: str) -> bool:
    return bool(
        re.search(
            r'resource-id="com\.instagram\.android:id/row_feed_button_like"[^>]*content-desc="Liked"',
            xml or "",
        )
    )


def _reel_like_confirmed(xml: str) -> bool:
    return bool(
        re.search(
            r'resource-id="com\.instagram\.android:id/like_button"[^>]*content-desc="Liked"',
            xml or "",
        )
    )


def _selected_home(xml: str) -> bool:
    for node in re.findall(r"<[a-zA-Z][^>]*>", xml or ""):
        if (
            'resource-id="com.instagram.android:id/feed_tab"' in node
            and 'selected="true"' in node
        ):
            return True
    return False


def _exact_action_error(
    *,
    exact_like_mode: bool,
    exact_comment_mode: bool,
    completed: int,
    count: int,
    settled_home: bool,
):
    if exact_like_mode and completed < count:
        return "confirmed_like_target_not_met"
    if exact_comment_mode and completed < count:
        return "confirmed_comment_target_not_met"
    if exact_like_mode and not settled_home:
        return "home_not_selected_after_engagement"
    if exact_comment_mode and not settled_home:
        return "home_not_selected_after_comment"
    return None

# IG checkpoint / rate-limit phrases. Normalized (lowered, curly→straight
# apostrophe) before matching so locale-rotated builds still hit.
_CHECKPOINT_PHRASES = (
    "confirm you're human to use your account",
    "confirm you are human to use your account",
    "we suspended your account",
    "your account has been disabled",
)
_RATE_LIMIT_PHRASES = (
    "try again later",
    "we limit how often",
    "action blocked",
    "we restrict certain activity",
    "you've been temporarily blocked",
    "youve been temporarily blocked",
)


def _normalize_xml(xml: str) -> str:
    return (xml or "").lower().replace("’", "'").replace("‘", "'")


async def _foreground_pkg(device: WSDeviceAdapter) -> str:
    """Return foreground package, or '' on any shell error. Best-effort —
    a missing answer means 'unknown', not 'failed'.

    Uses `dumpsys window | grep mCurrentFocus` — the same probe the other
    working modules use. The previous `dumpsys activity activities | grep
    mResumedActivity` returned EMPTY on GrapheneOS / modern Android (that
    key no longer exists — it's `topResumedActivity` now), so engagement
    always saw pkg=unknown and hard-failed the foreground preflight.
    Live-confirmed 2026-05-20.
    """
    try:
        out = await device.shell(
            "dumpsys window | grep mCurrentFocus"
        )
        if not (out or "").strip():
            out = await device.shell(
                "dumpsys activity activities | grep -i ResumedActivity"
            )
    except Exception as e:
        await _LOG.error(device, f"foreground probe shell failed: {type(e).__name__}: {e}")
        return ""
    m = re.search(r"([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)/[a-zA-Z0-9_.]+", out or "")
    return m.group(1) if m else ""


async def _screen_hint(device: WSDeviceAdapter) -> dict:
    """Cheap diagnostic snapshot for failure-context logging. Never raises."""
    hint = {"pkg": "", "xml_len": 0}
    try:
        hint["pkg"] = await _foreground_pkg(device)
    except Exception:
        pass
    try:
        hint["xml_len"] = len(device._screen_xml or "")
    except Exception:
        pass
    return hint


async def _detect_blockers(device: WSDeviceAdapter, xml: str, stage: str = "engagement") -> str:
    """Return a non-empty reason string when IG is showing a checkpoint or
    rate-limit screen. Empty string = no blocker detected.

    We re-use already-refreshed XML when possible to avoid double-dump cost.
    """
    await raise_if_instagram_verification(device, stage=stage, xml=xml)
    norm = _normalize_xml(xml)
    if not norm:
        return ""
    for phrase in _CHECKPOINT_PHRASES:
        if phrase in norm:
            return "checkpoint_detected"
    for phrase in _RATE_LIMIT_PHRASES:
        if phrase in norm:
            return "rate_limited_toast"
    return ""


# Interstitials IG can throw between/after engagement taps. If we don't clear
# these BEFORE deciding to like/comment, the next blind-ish tap lands on the
# sheet (e.g. shares the reel to Facebook / opens "Add to your story" / follows
# a deep-link) instead of the post. SELECTOR PRIORITY: resource-id → content-desc.
# Each entry is (label, [resource-ids], [content-descs]). The "About Reels" NUX
# share sheet (clips_nux_sheet_share_button) is excluded on purpose — its button
# IS the publish action in post_trial_reel; in an engagement session we only ever
# DISMISS, so we use its dismiss/Not-now affordance, never its share button.
_INTERSTITIAL_DISMISS = (
    ("got_it", ["com.instagram.android:id/primary_button"], ["Got it", "OK", "Continue"]),
    ("notif_prompt", ["com.instagram.android:id/negative_button"],
     ["Not Now", "Not now", "Don't allow", "Skip", "Cancel"]),
    ("crosspost_sheet", [], ["Done", "Not now", "Not Now"]),
)


async def _dismiss_interstitials(device: WSDeviceAdapter, stage: str) -> bool:
    """Best-effort dismiss of any popup/interstitial sitting over the feed/reels.
    Returns True if something was dismissed. Never raises — a failure here just
    means we proceed and let the per-tap selector logic handle it.

    Re-uses the already-cached XML (caller refreshes before invoking) so this is
    cheap. Only acts when a known sheet marker is present, so a normal feed/reel
    screen is a no-op.
    """
    xml = device._screen_xml or ""
    if not xml:
        return False
    # Cross-post confirmation sheets ("Share to Facebook?" / "Add to your story")
    # — only treat as an interstitial when their distinctive text is on screen,
    # otherwise a normal Share/Story affordance could be tapped by mistake.
    norm = xml.lower()
    sheet_present = (
        "share to facebook" in norm
        or "add to your story" in norm
        or "turn on notifications" in norm
        or "allow notifications" in norm
        or 'resource-id="com.instagram.android:id/clips_nux_sheet' in norm
        or 'resource-id="com.instagram.android:id/bottom_sheet_container_view' in norm
    )
    if not sheet_present:
        return False
    for label, ids, descs in _INTERSTITIAL_DISMISS:
        for rid in ids:
            el = await device.find_element_by_id(rid)
            if el:
                await device.click(el)
                await _warn(device, f"dismissed interstitial '{label}' via id={rid} at {stage}")
                await asyncio.sleep(0.5)
                return True
        for desc in descs:
            el = await device.find_element_by_content_desc(desc)
            if el:
                await device.click(el)
                await _warn(device, f"dismissed interstitial '{label}' via desc='{desc}' at {stage}")
                await asyncio.sleep(0.5)
                return True
        for desc in descs:
            el = await device.find_element_by_text(desc)
            if el:
                await device.click(el)
                await _warn(device, f"dismissed interstitial '{label}' via text='{desc}' at {stage}")
                await asyncio.sleep(0.5)
                return True
    return False


async def _dismiss_exact_comment_feed_preview(
    device: WSDeviceAdapter,
    xml: str,
    stage: str,
) -> str:
    if "com.instagram.android:id/feed_preview_" not in (xml or ""):
        return xml
    try:
        dismissed = await _dismiss_ig_popups(device, max_attempts=1)
    except InstagramVerificationRequired:
        raise
    except Exception as e:
        await _warn(
            device,
            f"feed preview dismissal raised at {stage}: {type(e).__name__}: {e}",
        )
        return xml
    if not dismissed:
        return xml
    try:
        await device.refresh_screen(force=True)
    except Exception as e:
        await _warn(
            device,
            f"feed preview refresh raised at {stage}: {type(e).__name__}: {e}",
        )
        return xml
    return device._screen_xml or xml


async def _ensure_ig_foreground(device: WSDeviceAdapter, stage: str) -> str:
    """Verify IG is in the foreground. Returns error reason or '' if OK.

    Self-heals once by re-launching IG before giving up — a backgrounded
    IG (user pulled the app off) is the most common silent failure.
    """
    pkg = await _foreground_pkg(device)
    if pkg == IG_PKG:
        return ""
    await _LOG.log(
        device,
        f"IG not foreground at {stage} (saw pkg={pkg or 'unknown'}); relaunching",
    )
    # Self-heal with escalation: plain relaunch first, then force-stop + cold
    # relaunch (a sticky background/other-app state — e.g. Vanadium left up by
    # push_content — won't yield to a plain launch_app but clears with force-stop,
    # mirroring the post modules). Only give up after several attempts.
    pkg2 = ""
    for attempt in range(3):
        try:
            if attempt > 0:
                try:
                    await device.close_app(IG_PKG)
                except Exception:
                    pass
                await asyncio.sleep(0.6)
            await device.launch_app(IG_PKG)
            await asyncio.sleep(2.0 + attempt)
        except Exception as e:
            await _LOG.error(
                device,
                f"relaunch_failed at {stage} (attempt {attempt + 1}): {type(e).__name__}: {e}",
            )
            return "device_unreachable_via_adb"
        pkg2 = await _foreground_pkg(device)
        if pkg2 == IG_PKG:
            if attempt > 0:
                await _LOG.log(device, f"IG foreground recovered at {stage} on attempt {attempt + 1}")
            return ""
    await _LOG.error(
        device,
        f"ig_not_in_foreground at {stage}: pkg={pkg2 or 'unknown'} after 3 relaunch attempts",
    )
    return "ig_not_in_foreground"


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Run Instagram engagement via WebSocket - split mode with full human behavior.

    Ported from old appium engagement_module.py with HumanBehavior system:
    - Session mood affects all engagement rates (engaged/passive/active/distracted)
    - Energy curve based on time of day
    - Fatigue accumulates, reducing engagement over time
    - View type system: quick_scroll / brief_view / engaged_view / deep_view
    - Only likes on brief+ views, only comments on engaged/deep views
    - Scroll patterns with variable speed/duration/pause
    - Coordinate jitter on all taps and swipes
    - Micro-pauses between rapid actions
    - Occasional distractions (pause 0.5-4s randomly)

    BATCH MODE: Navigate to each tab ONCE, do all scrolls there.
    Feed swipes stay in safe Y range (above nav bar at y=2211).
    Reels comments press back ONCE (not 2x) to stay in reels.
    """
    completed = 0
    likes = 0
    comments = 0
    skipped_ads = 0
    comment_delivery_uncertain = None
    comment_cleanup_failed = None
    comment_post_tap_attempted = False
    comment_sheet_closed = None
    last_step = "init"
    last_iter = -1
    session = None
    try:
        settings = _resolve_run_settings(config)
        count = settings["count"]
        base_like_chance = settings["base_like_chance"]
        base_comment_chance = settings["base_comment_chance"]
        feed_ratio = settings["feed_ratio"]
        exact_like_mode = settings["exact_like_mode"]
        exact_comment_mode = settings.get("exact_comment_mode", False)
        comment_texts = settings.get("comment_texts", ())
        requested_profile_id = config.get("_requested_profile_id")
        exact_action_mode = exact_like_mode or exact_comment_mode
        attempts_per_item = settings["attempts_per_item"]

        if exact_comment_mode and not comment_texts:
            return {
                "success": False,
                "error": "exact_comment_text_required",
                "completed": 0,
                "likes": 0,
                "comments": 0,
                "skipped_ads": 0,
                "settled_home": False,
            }

        await _LOG.log(
            device,
            f"Starting engagement: count={count} like%={int(base_like_chance*100)} "
            f"comment%={int(base_comment_chance*100)} feed_ratio={feed_ratio:.2f} "
            f"like_only={exact_like_mode} exact_comment={exact_comment_mode}",
        )

        # Quick ADB liveness probe — if the device is unreachable we want
        # to surface that BEFORE attempting to launch IG and getting a
        # generic timeout further down.
        last_step = "adb_liveness"
        try:
            liveness = await device.shell("echo sp_ok")
        except Exception as e:
            await _LOG.error(
                device,
                f"adb liveness shell failed: {type(e).__name__}: {e}",
            )
            return {
                "success": False,
                "error": "device_unreachable_via_adb",
                "completed": completed,
                "data": {
                    "step": last_step,
                    "exception": f"{type(e).__name__}: {e}",
                    "likes": likes,
                    "comments": comments,
                    "skipped_ads": skipped_ads,
                },
            }
        if "sp_ok" not in (liveness or ""):
            await _LOG.error(
                device,
                f"adb liveness returned no marker: {(liveness or '')[:80]!r}",
            )
            return {
                "success": False,
                "error": "device_unreachable_via_adb",
                "completed": completed,
                "data": {
                    "step": last_step,
                    "shell_output": (liveness or "")[:200],
                    "likes": likes,
                    "comments": comments,
                    "skipped_ads": skipped_ads,
                },
            }

        # Initialize human behavior session
        session = _SessionState()

        feed_count = max(1, round(count * feed_ratio))
        reels_count = count - feed_count

        # Launch Instagram
        last_step = "launch_ig"
        try:
            await device.launch_app(IG_PKG)
        except Exception as e:
            await _LOG.error(
                device,
                f"launch_app({IG_PKG}) failed: {type(e).__name__}: {e}",
            )
            return {
                "success": False,
                "error": "ig_launch_failed",
                "completed": completed,
                "data": {
                    "step": last_step,
                    "exception": f"{type(e).__name__}: {e}",
                    "likes": likes,
                    "comments": comments,
                    "skipped_ads": skipped_ads,
                },
            }
        await asyncio.sleep(2.5)

        # Pre-flight: must be on IG. _foreground_pkg + one relaunch.
        last_step = "preflight_foreground"
        fg_err = await _ensure_ig_foreground(device, "post_launch")
        if fg_err:
            hint = await _screen_hint(device)
            return {
                "success": False,
                "error": fg_err,
                "completed": completed,
                "data": {
                    "step": last_step,
                    "screen_hint": hint,
                    "likes": likes,
                    "comments": comments,
                    "skipped_ads": skipped_ads,
                },
            }

        last_step = "dismiss_popups"
        await raise_if_instagram_verification(device, stage="engagement_pre_popup")
        try:
            await _dismiss_ig_popups(device)
        except InstagramVerificationRequired:
            raise
        except Exception as e:
            await _warn(
                device, f"_dismiss_ig_popups raised (continuing): {type(e).__name__}: {e}"
            )

        # Pre-flight: refresh XML and bail on checkpoint / rate-limit screens
        # BEFORE we start scrolling and triggering more IG defenses.
        last_step = "preflight_checkpoint"
        try:
            await device.refresh_screen(force=True)
        except Exception as e:
            await _LOG.error(
                device,
                f"refresh_screen at preflight failed: {type(e).__name__}: {e}",
            )
        preflight_xml = device._screen_xml or ""
        if not preflight_xml:
            await _warn(
                device,
                "preflight XML empty after refresh — uiautomator dump may be stuck",
            )
        blocker = await _detect_blockers(device, preflight_xml, "engagement_preflight")
        if blocker:
            await _LOG.error(
                device,
                f"{blocker} on preflight — bailing before any actions",
            )
            return {
                "success": False,
                "error": blocker,
                "completed": completed,
                "data": {
                    "step": last_step,
                    "screen_hint": await _screen_hint(device),
                    "manual_action_required": blocker == "checkpoint_detected",
                    "likes": likes,
                    "comments": comments,
                    "skipped_ads": skipped_ads,
                },
            }

        # PHASE 1: HOME FEED (batch)
        if feed_count > 0:
            last_step = "nav_home"
            try:
                await _navigate_to_ig_tab(device, "home")
            except Exception as e:
                await _LOG.error(
                    device,
                    f"_navigate_to_ig_tab(home) raised: {type(e).__name__}: {e}",
                )
                return {
                    "success": False,
                    "error": "nav_home_failed",
                    "completed": completed,
                    "data": {
                        "step": last_step,
                        "exception": f"{type(e).__name__}: {e}",
                        "screen_hint": await _screen_hint(device),
                        "likes": likes,
                        "comments": comments,
                        "skipped_ads": skipped_ads,
                    },
                }
            await asyncio.sleep(1.5)

            # VERIFY-BEFORE-PROCEED: confirm we actually landed on the feed before
            # the loop starts coordinate-swiping. Without this a failed tab tap
            # leaves us on an unknown screen and every swipe/like below is blind.
            # SELECTOR PRIORITY: resource-id → content-desc. TODO(live-id): confirm
            # the home-tab id (likely com.instagram.android:id/feed_tab).
            try:
                await device.refresh_screen(force=True)
            except Exception as e:
                await _warn(device, f"nav_home verify refresh failed: {type(e).__name__}: {e}")
            home_marker = await device.find_element_by_id(
                "com.instagram.android:id/feed_tab"
            )
            if not home_marker:
                home_marker = await device.find_element_by_content_desc("Home")
            if not home_marker:
                await _LOG.error(
                    device,
                    "nav_home: no Home-tab marker after navigation — refusing to blind-swipe",
                )
                return {
                    "success": False,
                    "error": "nav_home_not_confirmed",
                    "completed": completed,
                    "data": {
                        "step": last_step,
                        "screen_hint": await _screen_hint(device),
                        "likes": likes,
                        "comments": comments,
                        "skipped_ads": skipped_ads,
                    },
                }
            if exact_action_mode and not _selected_home(device._screen_xml or ""):
                await _LOG.error(
                    device,
                    "nav_home: Home tab exists but is not selected — refusing exact action",
                )
                return {
                    "success": False,
                    "error": "nav_home_not_selected",
                    "completed": completed,
                    "likes": likes,
                    "comments": comments,
                    "skipped_ads": skipped_ads,
                    "settled_home": False,
                }

            for i in range(feed_count * attempts_per_item):
                if exact_action_mode and completed >= feed_count:
                    break
                last_iter = i
                last_step = f"feed[{i}]"
                # Pick view type for this post
                view_type = session.pick_view_type()
                scroll_pat = session.get_scroll_pattern()

                # Scroll feed with jitter - SAFE ZONE (y stays above 2211 nav bar).
                # 2.19.8: extended travel distance — was sy 1700→ey 600..1000
                # (median ~900px). Anyro flagged on 2026-05-26 that scrolls
                # weren't covering enough of the feed. Now sy ~2000 → ey
                # ~300..550 = median ~1600px = roughly two-thirds of a 2400
                # screen per swipe. Lands one fresh post per scroll on
                # typical IG feed layouts.
                sx = _jitter(540, 50)
                sy = _jitter(2000, 80)
                ey = _jitter(random.randint(300, 550), 60)
                try:
                    await device.swipe(
                        sx, sy, _jitter(540, 50), ey, scroll_pat["duration_ms"]
                    )
                except Exception as e:
                    await _LOG.error(
                        device,
                        f"feed swipe #{i} failed: {type(e).__name__}: {e}",
                    )
                    return {
                        "success": False,
                        "error": "feed_swipe_failed",
                        "completed": completed,
                        "data": {
                            "step": last_step,
                            "iter": i,
                            "exception": f"{type(e).__name__}: {e}",
                            "screen_hint": await _screen_hint(device),
                            "likes": likes,
                            "comments": comments,
                            "skipped_ads": skipped_ads,
                        },
                    }
                session.add_fatigue("scroll")

                # Watch for the view duration
                watch_time = session.get_view_duration(view_type)
                await _sleep_keepalive(device, watch_time)

                # Maybe get distracted
                distraction = session.maybe_distraction()
                if distraction > 0:
                    await asyncio.sleep(distraction)

                # Check for ads and snap to nearest post
                try:
                    await device.refresh_screen(force=True)
                except Exception as e:
                    await _warn(
                        device,
                        f"feed[{i}] refresh_screen failed: {type(e).__name__}: {e}",
                    )
                xml = device._screen_xml or ""
                if not xml:
                    # Empty XML = uiautomator hiccup. Skip this iteration's
                    # decisions instead of falling into blind coordinate taps.
                    await _warn(
                        device,
                        f"feed[{i}] empty screen XML — skipping like/comment for this iter",
                    )
                    if _iteration_counts(
                        exact_like_mode=exact_like_mode,
                        exact_comment_mode=exact_comment_mode,
                        skipped=True,
                        liked=False,
                        commented=False,
                    ):
                        completed += 1
                    await asyncio.sleep(scroll_pat["pause"])
                    continue

                # Checkpoint / rate-limit gate AFTER each scroll. IG rate-limit
                # toasts appear mid-session, so we must re-check every loop.
                blocker = await _detect_blockers(device, xml, f"engagement_feed_{i}")
                if blocker:
                    await _LOG.error(
                        device,
                        f"{blocker} detected at feed[{i}] after {completed} actions",
                    )
                    return {
                        "success": False,
                        "error": blocker,
                        "completed": completed,
                        "data": {
                            "step": last_step,
                            "iter": i,
                            "screen_hint": await _screen_hint(device),
                            "manual_action_required": blocker == "checkpoint_detected",
                            "likes": likes,
                            "comments": comments,
                            "skipped_ads": skipped_ads,
                            "session_mood": session.mood,
                        },
                    }

                if exact_comment_mode:
                    xml = await _dismiss_exact_comment_feed_preview(
                        device,
                        xml,
                        last_step,
                    )

                # Clear any interstitial sitting over the feed (cross-post sheet,
                # notification prompt, "Got it" NUX) BEFORE we decide to act — a
                # stray like/comment tap would otherwise land on the sheet. If we
                # dismissed one, re-dump so the ad/suggested/like checks below run
                # against the real feed, not the now-closed sheet.
                if await _dismiss_interstitials(device, last_step):
                    try:
                        await device.refresh_screen(force=True)
                    except Exception:
                        pass
                    xml = device._screen_xml or xml

                if _is_ig_ad_xml(xml):
                    skipped_ads += 1
                    try:
                        await device.swipe(540, 1500, 540, 800, 350)
                    except Exception as e:
                        await _warn(
                            device,
                            f"feed[{i}] ad-skip swipe failed: {type(e).__name__}: {e}",
                        )
                    await asyncio.sleep(0.3)
                    if _iteration_counts(
                        exact_like_mode=exact_like_mode,
                        exact_comment_mode=exact_comment_mode,
                        skipped=True,
                        liked=False,
                        commented=False,
                    ):
                        completed += 1
                    continue

                # 2.19.2: skip "Suggested for you" follow-recommendation
                # carousels the same way we skip ads. The carousel inserts
                # itself between real posts on the home feed and any tap
                # in it would either follow a suggested account or
                # navigate to their profile — both wrong for an engagement
                # session targeting a specific account. Swipe past, count,
                # continue.
                if _is_ig_suggested_card_xml(xml):
                    skipped_ads += 1
                    try:
                        await device.swipe(540, 1500, 540, 800, 350)
                    except Exception as e:
                        await _warn(
                            device,
                            f"feed[{i}] suggested-card-skip swipe failed: {type(e).__name__}: {e}",
                        )
                    await asyncio.sleep(0.3)
                    if _iteration_counts(
                        exact_like_mode=exact_like_mode,
                        exact_comment_mode=exact_comment_mode,
                        skipped=True,
                        liked=False,
                        commented=False,
                    ):
                        completed += 1
                    continue

                # Snap to nearest post header (uses already-dumped XML, no extra cost)
                try:
                    await _snap_to_feed_post(device, xml)
                except Exception as e:
                    await _warn(
                        device,
                        f"feed[{i}] _snap_to_feed_post failed: {type(e).__name__}: {e}",
                    )

                # The snap-scroll physically moves the feed, so the post now under
                # the action bar can DIFFER from the one ad-checked above (an ad
                # below the fold can scroll into place). Re-dump and re-check for
                # ads/suggested BEFORE liking/commenting so we never act on an ad,
                # and reuse the fresh XML for the already-liked check below.
                try:
                    await device.refresh_screen(force=True)
                    xml = device._screen_xml or xml
                except Exception:
                    pass
                if exact_comment_mode:
                    xml = await _dismiss_exact_comment_feed_preview(
                        device,
                        xml,
                        f"{last_step}:post_snap",
                    )
                if _is_ig_ad_xml(xml) or _is_ig_suggested_card_xml(xml):
                    skipped_ads += 1
                    if _iteration_counts(
                        exact_like_mode=exact_like_mode,
                        exact_comment_mode=exact_comment_mode,
                        skipped=True,
                        liked=False,
                        commented=False,
                    ):
                        completed += 1
                    await asyncio.sleep(scroll_pat["pause"])
                    continue

                # Check if already liked (resource-id="row_feed_button_like" with content-desc="Liked").
                # Use the SPECIFIC feed like button ID (not just content-desc) to avoid matching
                # a like button from an adjacent/prior post that is visible in the same XML dump.
                already_liked = bool(
                    re.search(
                        r'resource-id="com\.instagram\.android:id/row_feed_button_like"[^>]*content-desc="Liked"',
                        xml,
                    )
                )

                # Like (gated by view type + mood + energy + fatigue)
                # SELECTOR PRIORITY: resource-id → content-desc → (no blind coord).
                likes_before = likes
                eff_like = (
                    1.0
                    if exact_like_mode
                    else session.effective_like_chance(base_like_chance, view_type)
                )
                if random.random() < eff_like and not already_liked:
                    await asyncio.sleep(
                        session.micro_pause()
                    )  # tiny pause before action
                    liked_ok = False
                    # Primary: resource-id (Anyro #1 rule = id-first). TODO(live-id):
                    # confirm the current-build feed like id on the dev phone; the
                    # only id we know is the legacy row_feed_button_like, kept here
                    # and as the third attempt so we never lose the working path.
                    like_btn = await device.find_element_by_id(
                        "com.instagram.android:id/row_feed_button_like"
                    )
                    if like_btn:
                        await device.click(like_btn)
                        liked_ok = True
                    if not liked_ok:
                        # content-desc="Like" (left-side action bar button). center_x
                        # < 200 guards against matching the reels/other Like elsewhere.
                        like_btn = await device.find_element_by_content_desc("Like")
                        if like_btn and like_btn.center_x < 200:
                            await device.click(like_btn)
                            liked_ok = True
                    if not liked_ok:
                        # DON'T blind double-tap the post media as a "last resort":
                        # on a feed REEL a center tap opens the reel/post viewer and
                        # the session drifts into the author's profile (Anyro caught
                        # this live — phone on "boxogames Posts"). Skip the like
                        # instead; a missed like is cheaper than drifting off-feed.
                        await _warn(
                            device,
                            f"feed[{i}] Like button not found (id+desc) — skipping like, NO blind double-tap",
                        )
                    if liked_ok:
                        await asyncio.sleep(0.4)
                        try:
                            await device.refresh_screen(force=True)
                        except Exception:
                            pass
                        if _feed_like_confirmed(device._screen_xml or ""):
                            likes += 1
                            session.add_fatigue("like")
                        else:
                            await _warn(
                                device,
                                f"feed[{i}] selector like UNVERIFIED (no specific Liked state) — not counting",
                            )

                # Comment (only on engaged/deep views, gated by mood)
                comments_before = comments
                eff_comment = (
                    1.0
                    if exact_comment_mode
                    else session.effective_comment_chance(
                        base_comment_chance, view_type
                    )
                )
                if random.random() < eff_comment:
                    selected_comment = (
                        comment_texts[comments % len(comment_texts)]
                        if exact_comment_mode
                        else None
                    )
                    try:
                        comment_outcome = await _post_comment(
                            device,
                            mode="feed",
                            comment_text=selected_comment,
                            requested_profile_id=requested_profile_id,
                        )
                    except Exception as e:
                        comment_outcome = {
                            "state": "pre_tap_failure",
                            "reason": "unexpected_pre_tap_failure",
                            "post_tap_attempted": False,
                            "safe_to_retry": True,
                        }
                        await _warn(
                            device,
                            f"feed[{i}] _post_comment raised: {type(e).__name__}: {e}",
                        )
                    if comment_outcome.get("post_tap_attempted"):
                        comment_post_tap_attempted = True
                    if "sheet_closed" in comment_outcome:
                        comment_sheet_closed = comment_outcome.get("sheet_closed") is True
                    if comment_outcome.get("state") == "post_tap_confirmed":
                        comments += 1
                        session.add_fatigue("comment")
                        if exact_comment_mode and not comment_sheet_closed:
                            comment_cleanup_failed = comment_outcome
                    elif comment_outcome.get("state") == "post_tap_uncertain":
                        comment_delivery_uncertain = comment_outcome
                    else:
                        await _LOG.log(
                            device,
                            f"feed[{i}] comment pre-tap failure: {comment_outcome.get('reason')}",
                        )

                if comment_delivery_uncertain:
                    break

                if _iteration_counts(
                    exact_like_mode=exact_like_mode,
                    exact_comment_mode=exact_comment_mode,
                    skipped=False,
                    liked=likes > likes_before,
                    commented=comments > comments_before,
                ):
                    completed += 1
                if comment_cleanup_failed:
                    break
                await asyncio.sleep(scroll_pat["pause"])

        # PHASE 2: REELS (batch)
        if reels_count > 0 and not comment_delivery_uncertain and not comment_cleanup_failed:
            last_step = "nav_reels"
            try:
                await _navigate_to_ig_tab(device, "reels")
            except Exception as e:
                await _LOG.error(
                    device,
                    f"_navigate_to_ig_tab(reels) raised: {type(e).__name__}: {e}",
                )
                return {
                    "success": False,
                    "error": "nav_reels_failed",
                    "completed": completed,
                    "data": {
                        "step": last_step,
                        "exception": f"{type(e).__name__}: {e}",
                        "screen_hint": await _screen_hint(device),
                        "likes": likes,
                        "comments": comments,
                        "skipped_ads": skipped_ads,
                    },
                }
            await asyncio.sleep(1.5)

            # Re-verify we're still on IG — a tab tap could have bounced us
            # back to the launcher if IG crashed during the feed phase.
            fg_err = await _ensure_ig_foreground(device, "pre_reels")
            if fg_err:
                hint = await _screen_hint(device)
                return {
                    "success": False,
                    "error": fg_err,
                    "completed": completed,
                    "data": {
                        "step": last_step,
                        "screen_hint": hint,
                        "likes": likes,
                        "comments": comments,
                        "skipped_ads": skipped_ads,
                    },
                }

            # VERIFY-BEFORE-PROCEED: confirm the Reels surface is actually up
            # before blind-swiping through it. SELECTOR PRIORITY: resource-id →
            # content-desc. like_button is the reel action-bar marker we already
            # rely on below; the Reels tab content-desc confirms the surface.
            try:
                await device.refresh_screen(force=True)
            except Exception as e:
                await _warn(device, f"nav_reels verify refresh failed: {type(e).__name__}: {e}")
            reels_marker = await device.find_element_by_id(
                "com.instagram.android:id/like_button"
            )
            if not reels_marker:
                reels_marker = await device.find_element_by_content_desc(
                    "Reels", partial=True
                )
            if not reels_marker:
                await _LOG.error(
                    device,
                    "nav_reels: no Reels-surface marker after navigation — refusing to blind-swipe",
                )
                return {
                    "success": False,
                    "error": "nav_reels_not_confirmed",
                    "completed": completed,
                    "data": {
                        "step": last_step,
                        "screen_hint": await _screen_hint(device),
                        "likes": likes,
                        "comments": comments,
                        "skipped_ads": skipped_ads,
                    },
                }

            for i in range(reels_count * attempts_per_item):
                if exact_action_mode and completed >= count:
                    break
                last_iter = i
                last_step = f"reels[{i}]"
                view_type = session.pick_view_type()
                scroll_pat = session.get_scroll_pattern()
                scroll_duration = scroll_pat["duration_ms"]

                # Swipe to next reel (full screen, jittered)
                sx = _jitter(540, 50)
                sy = _jitter(1900, 80)
                ey = _jitter(500, 80)
                try:
                    await device.swipe(
                        sx, sy, _jitter(540, 50), ey, scroll_pat["duration_ms"]
                    )
                except Exception as e:
                    await _LOG.error(
                        device,
                        f"reels swipe #{i} failed: {type(e).__name__}: {e}",
                    )
                    return {
                        "success": False,
                        "error": "reels_swipe_failed",
                        "completed": completed,
                        "data": {
                            "step": last_step,
                            "iter": i,
                            "exception": f"{type(e).__name__}: {e}",
                            "screen_hint": await _screen_hint(device),
                            "likes": likes,
                            "comments": comments,
                            "skipped_ads": skipped_ads,
                        },
                    }
                session.add_fatigue("scroll")

                # Watch for view duration
                watch_time = session.get_view_duration(view_type)
                await _sleep_keepalive(device, watch_time)

                # Distraction chance
                distraction = session.maybe_distraction()
                if distraction > 0:
                    await asyncio.sleep(distraction)

                # Check for ads
                try:
                    await device.refresh_screen(force=True)
                except Exception as e:
                    await _warn(
                        device,
                        f"reels[{i}] refresh_screen failed: {type(e).__name__}: {e}",
                    )
                xml = device._screen_xml or ""
                if not xml:
                    await _warn(
                        device,
                        f"reels[{i}] empty screen XML — skipping like/comment for this iter",
                    )
                    if _iteration_counts(
                        exact_like_mode=exact_like_mode,
                        exact_comment_mode=exact_comment_mode,
                        skipped=True,
                        liked=False,
                        commented=False,
                    ):
                        completed += 1
                    await asyncio.sleep(scroll_pat["pause"])
                    continue

                blocker = await _detect_blockers(device, xml, f"engagement_reels_{i}")
                if blocker:
                    await _LOG.error(
                        device,
                        f"{blocker} detected at reels[{i}] after {completed} actions",
                    )
                    return {
                        "success": False,
                        "error": blocker,
                        "completed": completed,
                        "data": {
                            "step": last_step,
                            "iter": i,
                            "screen_hint": await _screen_hint(device),
                            "manual_action_required": blocker == "checkpoint_detected",
                            "likes": likes,
                            "comments": comments,
                            "skipped_ads": skipped_ads,
                            "session_mood": session.mood,
                        },
                    }

                # Clear any interstitial over the reel (About Reels NUX, cross-post
                # sheet, notification prompt) BEFORE acting so a like/comment tap
                # can't trigger a share/deep-link. Re-dump if we dismissed one.
                if await _dismiss_interstitials(device, last_step):
                    try:
                        await device.refresh_screen(force=True)
                    except Exception:
                        pass
                    xml = device._screen_xml or xml

                if _is_ig_ad_xml(xml):
                    skipped_ads += 1
                    try:
                        await device.swipe(540, 1800, 540, 400, scroll_duration)
                    except Exception as e:
                        await _warn(
                            device,
                            f"reels[{i}] ad-skip swipe failed: {type(e).__name__}: {e}",
                        )
                    await asyncio.sleep(0.3)
                    if _iteration_counts(
                        exact_like_mode=exact_like_mode,
                        exact_comment_mode=exact_comment_mode,
                        skipped=True,
                        liked=False,
                        commented=False,
                    ):
                        completed += 1
                    continue

                # Check if already liked
                already_liked = bool(
                    re.search(
                        r'resource-id="com\.instagram\.android:id/like_button"[^>]*content-desc="Liked"',
                        xml,
                    )
                )

                # Like (gated by view type + mood + energy)
                # SELECTOR PRIORITY: resource-id → content-desc → coord (last resort).
                likes_before = likes
                eff_like = (
                    1.0
                    if exact_like_mode
                    else session.effective_like_chance(base_like_chance, view_type)
                )
                if random.random() < eff_like and not already_liked:
                    await asyncio.sleep(session.micro_pause())
                    liked = False
                    tapped_blind = False
                    like_btn = await device.find_element_by_id(
                        "com.instagram.android:id/like_button"
                    )
                    if like_btn:
                        await device.click(like_btn)
                        liked = True
                    if not liked:
                        like_btn = await device.find_element_by_content_desc("Like")
                        if like_btn:
                            await device.click(like_btn)
                            liked = True
                    if not liked:
                        # ADB-VERIFIED: Reels like_button at (1001, 1121) from ig_ui_map
                        # [943,1063][1059,1179] -> center (1001, 1121)
                        await _warn(
                            device,
                            f"reels[{i}] like button not found via id OR content-desc — coord-tap fallback",
                        )
                        await device.tap(_jitter(1001, 15), _jitter(1121, 15))
                        tapped_blind = True
                    # NO FALSE-POSITIVE SUCCESS: only count a like once the on-screen
                    # state confirms it. A selector tap is trusted (we hit a real
                    # element); the blind coord tap must be VERIFIED — re-dump and
                    # require the button to now read content-desc="Liked" before
                    # incrementing. An unverified blind tap is logged, not counted.
                    if liked or tapped_blind:
                        await asyncio.sleep(0.4)
                        try:
                            await device.refresh_screen(force=True)
                        except Exception:
                            pass
                        verify_xml = device._screen_xml or ""
                        if _reel_like_confirmed(verify_xml):
                            likes += 1
                            session.add_fatigue("like")
                        else:
                            await _warn(
                                device,
                                f"reels[{i}] blind coord like UNVERIFIED (no 'Liked' state) — not counting",
                            )

                # Comment (only on engaged/deep views)
                comments_before = comments
                eff_comment = (
                    1.0
                    if exact_comment_mode
                    else session.effective_comment_chance(
                        base_comment_chance, view_type
                    )
                )
                if random.random() < eff_comment:
                    selected_comment = (
                        comment_texts[comments % len(comment_texts)]
                        if exact_comment_mode
                        else None
                    )
                    try:
                        comment_outcome = await _post_comment(
                            device,
                            mode="reels",
                            comment_text=selected_comment,
                            requested_profile_id=requested_profile_id,
                        )
                    except Exception as e:
                        comment_outcome = {
                            "state": "pre_tap_failure",
                            "reason": "unexpected_pre_tap_failure",
                            "post_tap_attempted": False,
                            "safe_to_retry": True,
                        }
                        await _warn(
                            device,
                            f"reels[{i}] _post_comment raised: {type(e).__name__}: {e}",
                        )
                    if comment_outcome.get("post_tap_attempted"):
                        comment_post_tap_attempted = True
                    if "sheet_closed" in comment_outcome:
                        comment_sheet_closed = comment_outcome.get("sheet_closed") is True
                    if comment_outcome.get("state") == "post_tap_confirmed":
                        comments += 1
                        session.add_fatigue("comment")
                        if exact_comment_mode and not comment_sheet_closed:
                            comment_cleanup_failed = comment_outcome
                    elif comment_outcome.get("state") == "post_tap_uncertain":
                        comment_delivery_uncertain = comment_outcome
                    else:
                        await _LOG.log(
                            device,
                            f"reels[{i}] comment pre-tap failure: {comment_outcome.get('reason')}",
                        )

                if comment_delivery_uncertain:
                    break

                if _iteration_counts(
                    exact_like_mode=exact_like_mode,
                    exact_comment_mode=exact_comment_mode,
                    skipped=False,
                    liked=likes > likes_before,
                    commented=comments > comments_before,
                ):
                    completed += 1
                if comment_cleanup_failed:
                    break
                await asyncio.sleep(scroll_pat["pause"])

        # Navigate away from the Reels tab so we don't idle on a looping reel
        # (reads as a bot). Best-effort cleanup — the engagement actions already
        # succeeded, so a failed navigate-away does NOT fail the run. SELECTOR
        # PRIORITY: resource-id → content-desc. We report the verified outcome in
        # data instead of silently assuming it worked (no false-positive).
        settled_home = False
        comment_sheet_absent = False
        try:
            await device.refresh_screen(force=True)
            # TODO(live-id): confirm the home-tab resource-id on the dev phone
            # (likely com.instagram.android:id/feed_tab); content-desc "Home" kept
            # as the working fallback below.
            home = await device.find_element_by_id(
                "com.instagram.android:id/feed_tab"
            )
            if not home:
                home = await device.find_element_by_content_desc("Home")
            if home:
                await device.click(home)
                await asyncio.sleep(1.0)
                # Verify we actually left reels: the selected Home tab reports
                # selected="true" once we're on the feed.
                try:
                    await device.refresh_screen(force=True)
                except Exception:
                    pass
                away_xml = device._screen_xml or ""
                comment_sheet_absent = not _comment_sheet_open(away_xml)
                settled_home = _selected_home(away_xml)
                if exact_comment_mode:
                    settled_home = (
                        settled_home
                        and comment_sheet_absent
                        and comment_sheet_closed is True
                    )
            if settled_home:
                print("[engagement] settled on Home feed (off reels)")
            else:
                await _warn(device, "navigate-away: Home tab not confirmed selected (best-effort)")
        except Exception as e:
            await _warn(device, f"navigate-away best-effort failed: {type(e).__name__}: {e}")

        if comment_delivery_uncertain:
            exact_action_error = "comment_delivery_uncertain"
        elif (
            exact_comment_mode
            and comment_post_tap_attempted
            and (comment_sheet_closed is not True or not comment_sheet_absent)
        ):
            exact_action_error = "comment_sheet_not_closed_after_comment"
        else:
            exact_action_error = _exact_action_error(
                exact_like_mode=exact_like_mode,
                exact_comment_mode=exact_comment_mode,
                completed=completed,
                count=count,
                settled_home=settled_home,
            )

        result = {
            "success": exact_action_error is None,
            "error": exact_action_error,
            "completed": completed,
            "likes": likes,
            "comments": comments,
            "skipped_ads": skipped_ads,
            "settled_home": settled_home,
            "sheet_closed": comment_sheet_closed,
            "session_mood": session.mood if session else None,
            "session_fatigue": round(session.fatigue, 3) if session else None,
        }
        if exact_action_error is not None and comment_post_tap_attempted:
            result["safe_to_retry"] = False
        if comment_delivery_uncertain:
            result["comment_delivery_state"] = comment_delivery_uncertain.get(
                "reason"
            )
        return result

    except InstagramVerificationRequired as verification:
        return verification.outcome
    except Exception as e:
        import traceback as _tb
        err_msg = str(e) or repr(e) or "unknown engagement error"
        tb_text = _tb.format_exc()
        # Capture the full traceback so "Pre-engagement unexpected error"
        # reports from users come with actual diagnostic info instead of
        # just str(e). _LOG.error tags lines with ERROR: prefix. Include
        # last_step/last_iter so the log line tells us WHERE we died.
        try:
            await _LOG.error(
                device,
                f"engagement crash at step={last_step} iter={last_iter}: {err_msg}\n{tb_text}",
            )
        except Exception:
            pass
        return {
            "success": False,
            "error": err_msg,
            "completed": completed,
            "data": {
                "step": last_step,
                "iter": last_iter,
                "exception_type": type(e).__name__,
                "likes": likes,
                "comments": comments,
                "skipped_ads": skipped_ads,
                "session_mood": session.mood if session else None,
            },
        }
