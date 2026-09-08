# Module: view_stories
# Views Instagram stories with ultra human-like behavior: fatigue, mood, skip/rewatch,
# like gestures, and natural exit. Ported from old appium story_module.py.
import asyncio
import random
import re
from contextlib import contextmanager
from lib.ws_modules_shared import (
    WSDeviceAdapter,
    _SessionState,
    _jitter,
    _dismiss_ig_popups,
    _navigate_to_ig_tab,
    _is_story_ad,
    InstagramVerificationRequired,
    raise_if_instagram_verification,
)

IG_PKG = "com.instagram.android"


@contextmanager
def _without_action_screen_capture(device: WSDeviceAdapter):
    previous = device.set_action_screen_capture(False)
    try:
        yield
    finally:
        device.set_action_screen_capture(previous)


def _selected_home(xml: str) -> bool:
    return bool(
        re.search(
            r'<node\b(?=[^>]*resource-id="com\.instagram\.android:id/feed_tab")'
            r'(?=[^>]*selected="true")[^>]*>',
            xml or "",
        )
    )

# Apps a story ad can deep-link into. Story ads make the whole media area a
# link, so a stray tap on a CTA can throw us into TikTok signup, the Play
# Store, a browser, etc. If we ever land on one of these we must NOT keep
# tapping (we'd be driving a foreign app) — bail back to IG and treat the
# story as a skipped ad.
_FOREIGN_AD_PKGS = (
    "com.zhiliaoapp.musically",  # TikTok
    "com.ss.android.ugc.trill",  # TikTok (alt region build)
    "com.android.vending",       # Play Store
    "com.android.chrome",        # Chrome
    "com.google.android.youtube",
)


async def _advance_story(device: WSDeviceAdapter) -> None:
    """Advance to the next story with a STRUCTURALLY ad-safe gesture.

    Why not a tap on the right side of the media?
      On a story AD, Instagram makes the *entire* media area a single
      tappable link to the sponsor. A "tap right side to advance" lands
      inside that link region and deep-links us into the advertised app —
      there is NO x-offset on the media that escapes it, because the ad
      link spans the full width. So tap-to-advance is fundamentally unsafe
      on ads.

    The gesture: a horizontal right-to-left SWIPE. IG advances to the next
    story on a horizontal swipe, and a swipe (not a tap) does NOT fire an
    ad CTA — CTAs only react to taps.

    CRITICAL FIX (2.10.x): the previous version swiped at y=80..130. That is
    the Android STATUS-BAR region — it is ABOVE the Instagram story viewer
    entirely. The story viewer's header (`reel_viewer_header`) starts at
    y=245 and its progress bar (`reel_viewer_progress_bar`) sits at
    y=241..270 (ADB-verified, ig_ui_map.md §7). A swipe at y<140 never
    touched the IG window, so on a detected ad the "skip" gesture did
    nothing and the ad stayed on screen — viewed loop kept re-detecting the
    same ad and never advanced past it.

    The swipe now runs through y~255: the segmented progress-bar strip,
    which IS inside the IG story viewer (so the swipe registers and pages
    forward) yet still sits ABOVE the ad's media-link / CTA region — the ad
    "chin" / CTA sticker always renders lower (toolbar y>=2076, CTA sticker
    near the bottom). So the gesture both works and stays ad-safe.
    """
    # y inside reel_viewer_progress_bar [0,241][1039,270] — inside the IG
    # story viewer, above the tappable ad media/CTA region.
    y = random.randint(246, 266)
    # right-to-left swipe = next story
    await device.swipe(
        random.randint(900, 1010), y,
        random.randint(90, 180), y + random.randint(-8, 8),
        random.randint(180, 320),
    )


async def _screen_hint(device: WSDeviceAdapter, label: str) -> str:
    """Compact focus dump for precise failure messages (mirrors the
    `_screen_hint` helper in post_trial_reel.py / post_feed.py)."""
    try:
        out = await device.shell(
            "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -2"
        ) or ""
        return f"{label}: {out.strip()[:200]}"
    except Exception:
        return label


async def _in_story_viewer(device: WSDeviceAdapter, force: bool = True) -> bool:
    """True when the IG story viewer is the visible screen.

    Marker: `reel_viewer_root` (the viewer container) — verified in
    ig_ui_map.md §7. Used to confirm a tap actually OPENED the viewer and
    that we're still inside it before tapping/advancing — rather than
    blind-tapping into an unknown screen and reporting a phantom view.
    """
    await device.refresh_screen(force=force)
    xml = device._screen_xml or ""
    return "com.instagram.android:id/reel_viewer_root" in xml


async def _foreground_pkg(device: WSDeviceAdapter) -> str:
    """Return the foreground app package, or '' if it can't be determined.

    Uses `dumpsys window | grep mCurrentFocus` — the same probe
    engagement.py and _navigate_to_ig_tab rely on.
    """
    try:
        out = await device.shell("dumpsys window | grep mCurrentFocus")
    except Exception:
        return ""
    m = re.search(r"([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)/[a-zA-Z0-9_.]+", out or "")
    return m.group(1) if m else ""


async def _recover_ig_foreground(device: WSDeviceAdapter) -> bool:
    """Defense-in-depth: if a story-ad CTA deep-linked us out of Instagram
    (e.g. into TikTok's I18nSignUpActivity), get back to IG.

    Returns True if IG is in the foreground after recovery, False otherwise.
    Never raises — best-effort.
    """
    pkg = await _foreground_pkg(device)
    if pkg == IG_PKG or not pkg:
        return pkg == IG_PKG
    # Foreign app is foreground. Press back a couple of times (handles the
    # in-app-browser / install-prompt case), then force-stop the foreign app
    # if it's a known ad-destination, then relaunch IG.
    for _ in range(2):
        try:
            await device.back()
        except Exception:
            pass
        await asyncio.sleep(0.5)
        if await _foreground_pkg(device) == IG_PKG:
            return True
    if pkg in _FOREIGN_AD_PKGS:
        try:
            await device.shell(f"am force-stop {pkg}")
        except Exception:
            pass
        await asyncio.sleep(0.5)
    try:
        await device.launch_app(IG_PKG)
        await asyncio.sleep(2.0)
    except Exception:
        return False
    return await _foreground_pkg(device) == IG_PKG


_STORY_DESC_RE = re.compile(
    r'content-desc="([^"]*?\'s story, (\d+) of \d+[^"]*)"'
    r'[^>]*?clickable="true"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
)


def _pick_first_story(xml: str):
    """Pick the first NON-OWN story bubble to open, from the tray XML.

    Tray bubbles self-describe via content-desc (live-verified 2026-05-30):
      "<username>'s story, <pos> of <total>, Unseen."   (or "...Seen.")
    Position 0 is the logged-in account's OWN bubble — it carries "Add to
    story" and is non-clickable; never open it. We want the first OTHER
    account's story, preferring an Unseen one (lowest tray position), falling
    back to a Seen one only if every follow is already watched.

    Returns (cx, cy, label) of the bubble to tap, or None when the tray holds
    no real story (just the own bubble + "Suggested for you" cards). Returning
    None — instead of blind-tapping a fixed coord — is what stops the module
    opening a random suggested-user PROFILE once an account has consumed all
    its stories (live-caught: tapped fixed (441,415) -> opened lacristo2014's
    profile because a suggested card had backfilled the story slot).
    """
    seen_pos = set()
    cands = []
    for m in _STORY_DESC_RE.finditer(xml or ""):
        label, pos = m.group(1), int(m.group(2))
        if pos == 0 or pos in seen_pos:
            continue  # own bubble / duplicate (outer+inner node share a desc)
        seen_pos.add(pos)
        x1, y1, x2, y2 = (int(m.group(i)) for i in range(3, 7))
        cands.append((pos, "Unseen" in label, (x1 + x2) // 2, (y1 + y2) // 2, label))
    if not cands:
        return None
    # Prefer Unseen (sorts first via `not`), then lowest tray position (left).
    cands.sort(key=lambda c: (not c[1], c[0]))
    pos, unseen, cx, cy, label = cands[0]
    return cx, cy, label


def _resolve_run_settings(config: dict) -> dict:
    def number(key: str, default: float) -> float:
        try:
            return float(config.get(key, default))
        except (TypeError, ValueError):
            return default

    humanize = config.get("humanize", True) is not False
    if humanize:
        count_min = max(1, min(6, int(number("count_min", 1))))
        count_max = max(count_min, min(6, int(number("count_max", 6))))
        count = random.randint(count_min, count_max)
    else:
        count = max(1, min(6, int(number("count", 6))))

    like_enabled = config.get("like_stories", True) is not False
    like_percent = max(0.0, min(100.0, number("like_chance", 28)))

    delay_a = max(0.0, min(6.0, number("delay_min", 1)))
    delay_b = max(0.0, min(6.0, number("delay_max", 3)))

    return {
        "count": count,
        "like_chance": like_percent / 100 if like_enabled else 0.0,
        "delay_min": min(delay_a, delay_b),
        "delay_max": max(delay_a, delay_b),
    }


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    with _without_action_screen_capture(device):
        return await _run_with_explicit_screens(device, config)


async def _run_with_explicit_screens(device: WSDeviceAdapter, config: dict) -> dict:
    """View Instagram stories via WebSocket - ULTRA human-like continuous viewing.

    Ported from old appium story_module.py view_stories_human() (the BETTER version):
    - Opens story ONCE, then advances via _advance_story() — a header-strip
      swipe that is structurally incapable of hitting a story-ad CTA
    - NO back-and-home between each story (that's the old slow method)
    - Full human behavior system: fatigue, mood, variable content-type durations
    - 12% chance to skip boring stories quickly (increases with fatigue)
    - 15% chance to re-watch (tap left side) (decreases with fatigue)
    - 10% chance to pause mid-story (simulating reading text overlay)
    - 8% chance of random "distraction" pause (1-2s)
    - Like via heart button (70%) or double-tap (30%), ~28% base chance
    - Natural exit: 30% swipe down, 70% back button, then home

    VERIFIED COORDINATES (from old ig_selectors.py / story_module.py):
    - Story tray: (441,415), (735,415), (981,415) [skip (147,415) = Your Story]
    - media_layout (the ad-clickable region on ads): [0,188][1080,2108]
    - Next story: right-to-left SWIPE in the progress-bar strip y~95 (above
      media, so it can never hit an ad link/CTA) — see _advance_story()
    - Prev story: tap LEFT EDGE (~70, 1100)
    - Pause: tap CENTER (540, 1000)
    - Like heart: toolbar_like_button at (901, 2160)  # ADB-VERIFIED Feb 2026
    """
    verification_blocked = False
    resting_home_verified = False
    try:
        run_settings = _resolve_run_settings(config)
        base_like_chance = run_settings["like_chance"]
        actual_count = run_settings["count"]
        delay_min = run_settings["delay_min"]
        delay_max = run_settings["delay_max"]
        viewed = 0
        likes = 0
        skipped = 0
        session = _SessionState()

        # CLEAN COLD LAUNCH: force-stop + relaunch IG so it opens at the TOP of
        # the home feed with the stories tray visible. The pre-engagement step
        # leaves the feed scrolled DOWN, and a plain launch_app just RESUMES at
        # that scroll position (the tray RecyclerView row is recycled off-screen)
        # — that is what made the tray "disappear". A cold start resets the feed
        # to the top, so we do NOT scroll at all; the resource-id detection below
        # then just works.
        try:
            await device.close_app("com.instagram.android")
        except Exception:
            pass
        await asyncio.sleep(1.2)
        await device.launch_app("com.instagram.android")
        await asyncio.sleep(3.5)  # cold-launch render
        await device.refresh_screen(force=True)
        await raise_if_instagram_verification(
            device,
            stage="view_stories_post_launch",
            xml=device._screen_xml or "",
        )
        await _dismiss_ig_popups(device)
        # Be explicit we're on the home tab (a cold launch lands here already).
        await _navigate_to_ig_tab(device, "home")
        await asyncio.sleep(1.5)

        # VERIFY-BEFORE-PROCEED: confirm the stories tray is on the freshly-
        # launched (top-of-feed) home screen before tapping into it. Short
        # wait-retry for it to render — NO swipes (the cold launch is already at
        # the top, so the tray is present; we only wait for it to draw).
        tray_present = False
        for _attempt in range(6):
            await device.refresh_screen(force=True)
            tray_present = (
                device._find_in_xml(
                    "resource-id", "com.instagram.android:id/reels_tray_container"
                )
                or device._find_in_xml(
                    "resource-id", "com.instagram.android:id/avatar_container"
                )
                or device._find_in_xml("content-desc", "story,", partial=True)
            )
            if tray_present:
                break
            await asyncio.sleep(0.8)
        if not tray_present:
            hint = await _screen_hint(device, "stories tray not on home feed")
            return {
                "success": False,
                "error": "stories_tray_not_found",
                "hint": hint,
                "viewed": viewed,
            }

        # Open the FIRST non-own story bubble. The tray labels each bubble via
        # content-desc ("<user>'s story, <pos> of <total>, Unseen/Seen"); parse
        # that, skip position 0 (the own "Add to story" bubble), and tap the
        # bubble's REAL center. NEVER a hardcoded coord: the old code tapped a
        # fixed (441,415) "second bubble", but once an account has watched all
        # its follows' stories IG backfills that slot with a "Suggested for you"
        # card — so the blind tap opened a random user's PROFILE (risking a
        # follow) instead of a story. Live-caught on eileenswrld 2026-05-30.
        target = _pick_first_story(device._screen_xml or "")
        if not target:
            # Only the own bubble + suggested cards — genuinely nothing to view.
            # Honest no-op (NOT a phantom success) and, crucially, NO blind tap.
            hint = await _screen_hint(device, "no viewable stories in tray")
            return {
                "success": False,
                "error": "no_stories_in_tray",
                "hint": hint,
                "viewed": 0,
            }
        cx, cy, story_label = target
        print(f"[view_stories] opening story: {story_label} @ ({cx},{cy})")
        await device.tap(_jitter(cx, 12), _jitter(cy, 10))

        # Kept short: the open-confirmation dump below is REUSED as the first
        # ad-check, so it must capture the FIRST segment before IG's ~5s story
        # auto-play advances it (a long load + a fresh ad-check dump = ~13s, by
        # which point the one real segment has already auto-played past us).
        await asyncio.sleep(random.uniform(1.2, 1.6))  # Variable load time

        # NO FALSE-POSITIVE: confirm the viewer actually opened. A tray tap can
        # miss (land on a gap / "Your story") and leave us on the feed — without
        # this check the loop would tap/advance on the feed and we'd report
        # phantom "viewed" stories. One short retry via _dismiss_ig_popups in
        # case an interstitial (e.g. "Turn on notifications") swallowed the tap.
        if not await _in_story_viewer(device):
            await _dismiss_ig_popups(device)
            await asyncio.sleep(random.uniform(0.5, 1.0))
            if not await _in_story_viewer(device):
                hint = await _screen_hint(device, "story viewer never opened")
                return {
                    "success": False,
                    "error": "story_viewer_not_opened",
                    "hint": hint,
                    "viewed": viewed,
                }

        # ---- CONTINUOUS STORY VIEWING LOOP ----
        # Stay inside the story viewer, tap right to advance
        ads_skipped = 0
        # Bound consecutive ad-skips: the ad branch `continue`s without
        # incrementing `viewed`, so a run of ads (or an advance that can't
        # page past the final story when it's an ad) would otherwise spin
        # forever. Reset whenever a real (non-ad) story is processed.
        consecutive_ad_skips = 0
        max_consecutive_ad_skips = 6
        # First loop pass reuses the open-confirmation dump (the first segment)
        # for the foreground + ad checks instead of re-dumping (~3.5s each) — a
        # fresh dump here lets IG auto-advance the first real segment past us
        # before we can count it (live: itsgrace.noir's only real segment
        # auto-played into an injected ANZ ad -> viewed=0).
        first_pass = True
        while viewed < actual_count:
            await raise_if_instagram_verification(
                device,
                stage=f"view_stories_{viewed}",
                xml=device.page_source if first_pass else None,
            )
            session.add_fatigue("story_view")
            fatigue = session.fatigue

            # FOREGROUND GUARD (defense-in-depth): before anything else, make
            # sure we're still inside Instagram. A story-ad CTA can deep-link
            # the phone into TikTok signup / the Play Store / a browser; if
            # that happened on the previous advance we must NOT keep tapping
            # (we'd be driving the foreign app) — recover IG first.
            # First pass: _in_story_viewer just confirmed the IG story viewer is
            # up, so skip the redundant dumpsys probe (its latency lets IG
            # auto-advance the first real segment past us).
            fg = IG_PKG if first_pass else await _foreground_pkg(device)
            if fg and fg != IG_PKG:
                print(f"[view_stories] Non-IG app foreground ({fg}) — likely tapped a story ad; recovering")
                ads_skipped += 1
                recovered = await _recover_ig_foreground(device)
                if not recovered:
                    # Can't get back to IG — stop cleanly rather than report
                    # success while parked on a foreign app.
                    print("[view_stories] Could not recover IG foreground; ending run")
                    break
                # IG is back but we're no longer in the story viewer; end the
                # viewing loop gracefully (this story is counted as skipped).
                break

            # AD CHECK: detect sponsored stories BEFORE doing anything that taps
            # the screen. On ads the entire media is a link target, so any tap
            # (advance, like, pause) opens the sponsor. SKIP the ad with the
            # structurally-safe advance gesture (header-strip swipe — see
            # _advance_story) and continue viewing — do NOT tap the media and
            # do NOT tap a CTA button.
            #
            # Settle delay: IG renders the "Sponsored" footer pill / label a
            # beat AFTER the story media appears. Checking too fast (right
            # after the previous advance) misses it. Give the new story ~0.7s
            # to fully render its sponsored markup before deciding ad-or-not.
            # 2.19.8: tightened settle delays — was 0.6-0.9 / 0.4-1.0 / 0.5-1.0.
            # Anyro flagged story advance felt sluggish on Run Now 2026-05-26.
            # Ad detection still needs SOME settle for the Sponsored pill to
            # render but 0.35-0.55 is enough on a modern phone.
            # First pass reuses the open dump (force=False) with no settle, so we
            # decide on the first segment before it auto-advances; later passes
            # settle briefly so the "Sponsored" pill has rendered before deciding.
            if first_pass:
                is_ad = await _is_story_ad(device, force=False)
            else:
                await asyncio.sleep(random.uniform(0.35, 0.55))
                is_ad = await _is_story_ad(device)
            first_pass = False
            if is_ad:
                consecutive_ad_skips += 1
                print(f"[view_stories] Story ad detected (after viewing {viewed}); skipping with safe advance ({consecutive_ad_skips})")
                ads_skipped += 1
                # Brief glance so the skip looks human, then advance past the
                # ad with the progress-bar-strip swipe — physically clear of
                # any CTA pill / link sticker (which sit lower in the media)
                # yet still inside the IG story viewer so the swipe registers.
                await asyncio.sleep(random.uniform(0.2, 0.5))
                await _advance_story(device)
                await asyncio.sleep(random.uniform(0.25, 0.55))
                # After advancing, re-confirm IG is still foreground — if the
                # corner tap still managed to deep-link out, recover and stop.
                if await _foreground_pkg(device) not in (IG_PKG, ""):
                    await _recover_ig_foreground(device)
                    break
                # Did we fall out of the story viewer? Check and stop if so.
                await device.refresh_screen(force=True)
                if "com.instagram.android:id/reel_viewer_root" not in (
                    device._screen_xml or ""
                ):
                    break
                # Too many ads back-to-back without ever reaching a real
                # story — either the tray is all ads or the advance can't
                # page past the final (ad) story. Stop cleanly instead of
                # spinning forever (ad branch never increments `viewed`).
                if consecutive_ad_skips >= max_consecutive_ad_skips:
                    print(f"[view_stories] {consecutive_ad_skips} consecutive ad-skips — ending viewing loop")
                    break
                continue
            # Reached a real (non-ad) story — reset the consecutive counter.
            consecutive_ad_skips = 0

            # NO FALSE-POSITIVE: confirm we're STILL in the story viewer before
            # spending watch-time / counting this as viewed. `_is_story_ad`
            # already forced a fresh dump above, so reuse the cached XML (no
            # extra round-trip). If the viewer marker is gone, the advance
            # paged off the end of the tray (back on feed) or an interstitial
            # popped — handle the popup case once, then stop counting phantom
            # views rather than burning watch-time on the wrong screen.
            if "com.instagram.android:id/reel_viewer_root" not in (
                device._screen_xml or ""
            ):
                await _dismiss_ig_popups(device)
                if not await _in_story_viewer(device):
                    print("[view_stories] Left story viewer before next view; ending loop")
                    break

            # Distraction chance (8% from old view_stories_human)
            distraction = session.maybe_distraction()
            if distraction > 0:
                await asyncio.sleep(distraction)

            # Skip chance: 12% + (fatigue * 20%) = more skips when tired
            skip_chance = 0.12 + (fatigue * 0.2)
            if random.random() < skip_chance:
                # Quick skip - barely glance at this story
                await asyncio.sleep(random.uniform(0.3, 0.8))
                skipped += 1
            else:
                # Normal viewing with variable content-type durations
                # (from old view_stories_human content_types distribution)
                roll = random.random()
                if roll < 0.40:
                    base_min, base_max = 2.0, 3.5  # quick glance (40%)
                elif roll < 0.75:
                    base_min, base_max = 3.5, 5.5  # normal viewing (35%)
                elif roll < 0.95:
                    base_min, base_max = 5.5, 8.0  # really watching (20%)
                else:
                    base_min, base_max = 8.0, 12.0  # very engaged (5%)

                watch_time = random.uniform(base_min, base_max)
                # Reduce time when fatigued
                watch_time *= max(0.6, 1 - fatigue)

                # 10% chance to pause mid-story (reading text overlay)
                if random.random() < 0.10:
                    first_half = watch_time * random.uniform(0.3, 0.6)
                    await asyncio.sleep(first_half)
                    # Pause/resume is a press-and-hold GESTURE on the media —
                    # there is no resource-id to target, so the center coord is
                    # the action (not a fallback). But VERIFY we're still in the
                    # viewer first: a stray earlier tap could have deep-linked /
                    # exited, and a center tap on the wrong screen is unsafe (on
                    # an ad-media surface it opens the sponsor). Skip the gesture
                    # if the viewer is gone — the loop's foreground/exit guards
                    # below handle the recovery.
                    # TODO(live-id): no resource-id exists for story pause-hold.
                    if await _in_story_viewer(device, force=False):
                        # Tap center to pause/hold
                        await device.tap(_jitter(540, 40), _jitter(1000, 80))
                        await asyncio.sleep(random.uniform(0.5, 1.5))
                        # Tap again to resume
                        await device.tap(_jitter(540, 40), _jitter(1000, 80))
                    await asyncio.sleep(watch_time - first_half)
                else:
                    await asyncio.sleep(watch_time)

            # Like probability decreases with fatigue (28% base from old code)
            actual_like = base_like_chance * max(0.4, 1 - fatigue)
            if random.random() < actual_like:
                liked = False
                # 70% use heart button, 30% double-tap center (from old code)
                if random.random() < 0.70:
                    # SELECTOR PRIORITY: resource-id → content-desc → coord LAST.
                    like_btn = await device.find_element_by_id(
                        "com.instagram.android:id/toolbar_like_button"
                    )
                    if not like_btn:
                        like_btn = await device.find_element_by_id(
                            "com.instagram.android:id/toolbar_like_container"
                        )
                    if not like_btn:
                        # content-desc "Like Story" — ig_ui_map.md §7 notes the
                        # like button's X shifts ~40px between stories, so the
                        # descriptor is more reliable than a fixed coord.
                        like_btn = await device.find_element_by_content_desc(
                            "Like Story"
                        )
                    if like_btn:
                        await device.click(like_btn)
                    else:
                        # ADB-VERIFIED Feb 2026: like button Y=2160 (not 2192).
                        # LAST-RESORT coord — kept per the verified path.
                        await device.tap(_jitter(901, 20), _jitter(2160, 20))
                else:
                    # Double-tap like is a GESTURE on the media center. On a
                    # story AD the whole media is a link, so a center tap opens
                    # the sponsor — guard with an in-viewer + not-an-ad check
                    # before tapping (the ad branch above normally catches ads,
                    # but the media can flip to an ad mid-watch).
                    if await _in_story_viewer(device, force=False) and not await _is_story_ad(device):
                        # Double-tap like (more natural gesture)
                        dtx = _jitter(540, 30)
                        dty = random.randint(900, 1200)
                        await device.tap(dtx, dty)
                        await asyncio.sleep(0.15)
                        await device.tap(
                            dtx + random.randint(-20, 20), dty + random.randint(-20, 20)
                        )
                # NO FALSE-POSITIVE: only count the like once the toolbar button
                # actually reads as liked ("Unlike Story" / selected=true).
                # Failing to verify is silent — we just don't inflate `likes`.
                await asyncio.sleep(random.uniform(0.3, 1.0))
                await device.refresh_screen(force=True)
                liked_xml = device._screen_xml or ""
                if (
                    "Unlike Story" in liked_xml
                    or "Unlike" in liked_xml
                    or re.search(
                        r'toolbar_like_button"[^>]*selected="true"', liked_xml
                    )
                ):
                    liked = True
                if liked:
                    likes += 1

            # 15% chance to re-watch (decreases with fatigue)
            if random.random() < (0.15 * max(0.3, 1 - fatigue)):
                # Prev-story is a tap on the LEFT EDGE of the media — a gesture
                # with no resource-id to target, so the coord IS the action.
                # VERIFY we're still in the viewer (and not on an ad whose media
                # is a sponsor link) before the blind tap.
                # TODO(live-id): no resource-id exists for story prev-tap region.
                if await _in_story_viewer(device, force=False) and not await _is_story_ad(device):
                    # Tap LEFT EDGE (was 180, now 70) — keeps us clear of any link
                    # stickers / mention chips that sit ~200-400px from edge.
                    await device.tap(_jitter(70, 30), _jitter(1100, 80))
                    await asyncio.sleep(random.uniform(1.5, 3.0))

            viewed += 1

            # ADVANCE to next story (if not last) — STRUCTURALLY ad-safe.
            if viewed < actual_count:
                await asyncio.sleep(random.uniform(delay_min, delay_max))
                # Previously a right-side media tap at (1010, 1100): that
                # lands INSIDE the ad media-link region (y 188..2108, full
                # width), so on an undetected ad it deep-links to the sponsor.
                # _advance_story swipes in the top progress-bar strip
                # (y < 188) which has no CTA / link target — it cannot open
                # an ad even if detection missed it.
                await _advance_story(device)
                await asyncio.sleep(random.uniform(0.15, 0.45))

                # FOREGROUND GUARD: the advance tap can land on a story ad's
                # link target and deep-link out of IG. Catch it immediately
                # rather than tapping again next iteration on the wrong app.
                fg_after = await _foreground_pkg(device)
                if fg_after and fg_after != IG_PKG:
                    print(f"[view_stories] Advance tap deep-linked to {fg_after} (story ad); recovering")
                    ads_skipped += 1
                    await _recover_ig_foreground(device)
                    break

                # Check if we've exited the story viewer (stories ran out)
                if (
                    viewed % 5 == 0
                ):  # Check every 5 stories to avoid excessive XML refreshes
                    await device.refresh_screen(force=True)
                    tab_bar = device._find_in_xml(
                        "resource-id", "com.instagram.android:id/tab_bar"
                    )
                    story_root = device._find_in_xml(
                        "resource-id", "com.instagram.android:id/reel_viewer_root"
                    )
                    if not story_root:
                        # story viewer is covered or missing. Could be an interstitial
                        # (e.g. "About Reels" / "Turn on notifications") or actual exit.
                        # Dismiss popups once and re-check before declaring the
                        # stories ended — otherwise a transient sheet looks like
                        # a natural exit and truncates the run early.
                        await _dismiss_ig_popups(device)
                        if not await _in_story_viewer(device):
                            # Back on feed or still blocked - stories ended or unrecoverable
                            break

        # FINAL FOREGROUND GUARD: never run the natural-exit gestures or
        # report success while parked on a foreign app (TikTok signup, Play
        # Store, browser) that a story ad deep-linked us into.
        if await _foreground_pkg(device) not in (IG_PKG, ""):
            await _recover_ig_foreground(device)

        # Natural exit (from old view_stories_human)
        if random.random() < 0.30:
            # Swipe down to exit (more natural gesture)
            await device.swipe(540, 800, 540, 1800, 200)
        else:
            # Back button
            await device.back()
        await asyncio.sleep(random.uniform(0.8, 1.5))

        # Return to home
        await _navigate_to_ig_tab(device, "home")

        # Final state is a hard gate, not an assumption from a coordinate tap.
        await device.refresh_screen(force=True)
        await raise_if_instagram_verification(
            device,
            stage="view_stories_final_home",
            xml=device._screen_xml or "",
        )
        resting_home_verified = _selected_home(device._screen_xml or "")
        if not resting_home_verified:
            return {
                "success": False,
                "error": "home_not_selected_after_story_run",
                "viewed": viewed,
                "likes": likes,
                "skipped": skipped,
                "ads_skipped": ads_skipped,
            }

        # Confirm we end on Instagram — a run that finishes parked on TikTok
        # must not be reported as a success.
        final_pkg = await _foreground_pkg(device)
        if final_pkg and final_pkg != IG_PKG:
            return {
                "success": False,
                "error": "ended_outside_instagram",
                "foreground_pkg": final_pkg,
                "viewed": viewed,
                "likes": likes,
                "skipped": skipped,
                "ads_skipped": ads_skipped,
            }

        # NO FALSE-POSITIVE: we entered the viewer (verified above) but if the
        # loop never processed a single real story (viewed == 0 — e.g. the tray
        # was all ads, or we fell out immediately), don't report a success. Be
        # honest so the scheduler doesn't treat a no-op run as engagement.
        if viewed == 0:
            return {
                "success": False,
                "error": "no_stories_viewed",
                "viewed": 0,
                "likes": likes,
                "skipped": skipped,
                "ads_skipped": ads_skipped,
            }

        return {
            "success": True,
            "viewed": viewed,
            "likes": likes,
            "skipped": skipped,
            "ads_skipped": ads_skipped,
            "settled_home": True,
            "session_mood": session.mood,
            "fatigue": round(session.fatigue, 3),
        }

    except InstagramVerificationRequired as verification:
        verification_blocked = True
        return verification.outcome
    except Exception as e:
        return {"success": False, "error": f"{type(e).__name__}: {e!r}", "viewed": viewed, "data": {"exception_type": type(e).__name__}}
    finally:
        # 2026-06-05 (Anyro: "why's it randomly on someone's profile wtf"): a
        # story-tray slot can be a backfilled SUGGESTED card that opens a
        # PROFILE instead of a story, and a mid-view exception bailed via the
        # except above without navigating away — leaving the phone parked on a
        # stranger's profile (reads as a bot + accidental-follow risk, the
        # Follow button sits right there). Guarantee we always end on the Home
        # feed on EVERY exit path. Best-effort; never raise from cleanup.
        if not verification_blocked and not resting_home_verified:
            try:
                await _navigate_to_ig_tab(device, "home")
            except Exception:
                pass
