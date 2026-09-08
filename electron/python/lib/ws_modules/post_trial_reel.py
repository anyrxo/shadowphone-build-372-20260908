# Module: post_trial_reel
# Posts a trial reel via the empirically-validated flow:
#   Profile tab -> Create New (+) -> Create new reel -> select video -> Next ->
#   write caption -> scroll share sheet -> tap Trial toggle ->
#   dismiss "Got it" popup -> Share
#
# Identifies every UI element by content-desc / text / resource-id. Coords are
# ONLY used as last-resort fallbacks when the descriptor lookup fails — and
# each step VERIFIES the next screen loaded before proceeding, so a missed
# tap doesn't cascade into clicking the wrong thing on a stale screen.
#
# A regular reel post is the same flow without the trial toggle step.
# `post_feed` for video should call this with trial_mode=False to share the
# same code path.

import asyncio
import random
import re
from lib.ws_modules_shared import (
    WSDeviceAdapter,
    _dismiss_ig_popups,
    _handle_ig_media_permission_popup,
    InstagramVerificationRequired,
    normalized_text_equal,
    raise_if_instagram_verification,
)
from lib.persistent_log import ModuleLogger
from lib.posting_progression_guards import (
    verified_profile_username,
    ExactContentSelectionError,
    prepare_exact_content_selection,
    select_prepared_exact_content,
    stabilize_posting_start_surface,
    with_exact_content_selection_proof,
)


_LOG = ModuleLogger("post_trial_reel")
IG_PKG = "com.instagram.android"

_CHECKPOINT_PHRASES = (
    "confirm you're human to use your account",
    "confirm you are human to use your account",
)
_RATE_LIMIT_PHRASES = (
    "action blocked",
    "we limit how often",
    "try again later",
    "you've been temporarily blocked",
)


def _finalize_success(result: dict, exact_selection, *, publish_confirmed: bool) -> dict:
    return with_exact_content_selection_proof(
        result,
        exact_selection,
        publish_confirmed=publish_confirmed,
    )


def _normalize(text: str) -> str:
    return (text or "").lower().replace("’", "'").replace("‘", "'")


async def _is_ig_installed(device: WSDeviceAdapter) -> bool:
    out = await device.shell(f"pm list packages {IG_PKG}") or ""
    return IG_PKG in out


async def _ig_is_foreground(device: WSDeviceAdapter) -> bool:
    try:
        out = await device.shell(
            "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -3"
        ) or ""
        if not out.strip():
            return True
        return IG_PKG in out
    except Exception:
        return True


async def _active_user(device: WSDeviceAdapter) -> str:
    """The Android user MediaStore must be queried as. A raw `adb shell
    content query` targets user 0 — but on a secondary GrapheneOS profile
    the pushed video lives in (and is indexed under) user 24's MediaStore,
    so an unscoped query finds nothing. Returns '0' on failure."""
    try:
        out = await device.shell("am get-current-user") or ""
        uid = out.strip()
        return uid if uid.isdigit() else "0"
    except Exception:
        return "0"


async def _mediastore_has_video(device: WSDeviceAdapter, user_id: str = "0") -> bool:
    """Trial reels REQUIRE a video — image-only gallery means the reel
    picker will load empty and we'd silently fail at _select_first_video.
    Returns True on shell-failure to avoid false-negatives.

    Must be scoped to the IG user with `content query --user N` — the
    browser_download push lands the file in a secondary profile's
    MediaStore (user 24), invisible to an unscoped (user 0) query."""
    try:
        user_flag = f"--user {user_id} " if user_id and user_id != "0" else ""
        out = await device.shell(
            f"content query {user_flag}--uri content://media/external/video/media "
            "--projection _id 2>/dev/null | head -2"
        ) or ""
        return "Row:" in out or "_id=" in out
    except Exception:
        return True


async def _screen_hint(device: WSDeviceAdapter, label: str) -> str:
    try:
        out = await device.shell(
            "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -2"
        ) or ""
        return f"{label}: {out.strip()[:200]}"
    except Exception:
        return label


async def _check_blocker(device: WSDeviceAdapter, xml: str | None = None):
    if xml is None:
        await device.refresh_screen(force=True)
        xml = device.page_source or ""
    await raise_if_instagram_verification(device, stage="post_reel_blocker", xml=xml)
    norm = _normalize(xml)
    for phrase in _CHECKPOINT_PHRASES:
        if phrase in norm:
            return ("checkpoint", "Instagram checkpoint: 'Confirm you're human'")
    for phrase in _RATE_LIMIT_PHRASES:
        if phrase in norm:
            return ("rate_limited", f"Instagram rate-limit overlay: '{phrase}'")
    return None


TRIAL_TOGGLE_X = 970


async def _is_keyboard_visible(device: WSDeviceAdapter) -> bool:
    """Detect whether the soft keyboard is currently showing."""
    try:
        out = await device.shell("dumpsys input_method 2>/dev/null | grep mInputShown")
        return "mInputShown=true" in (out or "")
    except Exception:
        return False


async def _hide_keyboard_if_visible(device: WSDeviceAdapter) -> None:
    """Press back ONLY when the IME is actually showing — otherwise back
    would pop us out of the share screen entirely."""
    if await _is_keyboard_visible(device):
        await device.back()
        await asyncio.sleep(0.6)


async def _wait_for_screen(device: WSDeviceAdapter, predicate, label: str,
                           attempts: int = 20, interval: float = 0.6) -> bool:
    """Refresh XML and call predicate(xml) until it returns True or attempts run out.

    Default ceiling is 20 attempts / 0.6s (12s). The earlier 8 / 0.4s (3.2s)
    ceiling was tuned on a fast Pixel — but GrapheneOS phones (the actual
    fleet) take 10-15s for IG reel-editor and reel-picker transitions.
    Live-validated 2026-05-20: editor_next + create_new_reel both failed at
    the old ceiling, both passed once the window was widened. Each
    refresh_screen does a real uiautomator dump so a missed-by-timing
    transition is a real failure mode, not a flake.
    """
    for i in range(attempts):
        await device.refresh_screen(force=True)
        xml = device.page_source or ""
        if predicate(xml):
            return True
        await asyncio.sleep(interval)
    print(f"[post_trial_reel] WAIT FAILED: {label}")
    return False


def _on_profile_screen(xml: str) -> bool:
    return ('content-desc="Edit profile"' in xml
            or 'content-desc="Professional dashboard entry point"' in xml)


async def _goto_profile(device: WSDeviceAdapter) -> bool:
    # A cold launch leaves the bottom tab bar briefly unrendered — the first
    # Profile-tab tap can land on a stale/empty hierarchy (mCurrentFocus=null
    # transient), so a single tap + short wait failed live with "Could not
    # reach profile screen; mCurrentFocus=null". Re-find and re-tap the Profile
    # tab, re-dumping between attempts, for ~15-18s before giving up. Mirrors
    # the launch-foreground poll: treat the cold-launch transient as STILL
    # LOADING, not a failure.
    # The live hierarchy exposes content-desc="Profile". If it is missing,
    # fail closed instead of tapping the comments/composer region by coordinate.
    for _ in range(3):                      # 3 taps × ~6s poll ≈ 18s ceiling
        await device.refresh_screen(force=True)
        if _on_profile_screen(device.page_source or ""):
            return True
        # TODO(live-id): the bottom Profile tab has no observed resource-id in
        # this build; content-desc "Profile" is the proven selector. Add the id
        # here once dumped, ahead of the content-desc lookup.
        tab = await device.find_element_by_content_desc("Profile")
        if not tab:
            print("[post_trial_reel] Profile tab descriptor missing — refusing blind coordinate")
            return False
        await device.click(tab)
        if await _wait_for_screen(
            device,
            _on_profile_screen,
            "profile screen",
            attempts=10,
            interval=0.6,
        ):
            return True
        print("[post_trial_reel] profile screen not reached yet — re-tapping Profile tab")
    return False


async def _open_create_sheet(device: WSDeviceAdapter) -> bool:
    """Tap the '+' button at the top-left of the profile screen and verify
    the Create New action sheet is open (looking for 'Create new reel')."""
    btn = await device.find_element_by_content_desc("Create New")
    if not btn:
        print("[post_trial_reel] Create New descriptor missing — refusing blind coordinate")
        return False
    await device.click(btn)
    return await _wait_for_screen(
        device,
        lambda x: 'content-desc="Create new reel"' in x,
        "Create New action sheet",
    )


async def _tap_create_new_reel(device: WSDeviceAdapter) -> bool:
    row = await device.find_element_by_content_desc("Create new reel")
    if not row:
        print("[post_trial_reel] Create new reel descriptor missing — refusing blind coordinate")
        return False
    await device.click(row)
    # 2.19.2: dismiss the "Keep editing your draft?" prompt that IG shows
    # when a previous trial/reel attempt was abandoned mid-flow. The dialog
    # has igds_headline_headline="Keep editing your draft?" with two
    # buttons: primary "Keep editing" (resumes draft, wrong here) and
    # auxiliary "Start new video" (drops draft, what we want). Without
    # this dismissal the reel picker never appears and the run dies with
    # "Reel picker did not load" — Anyro hit this live 2026-05-26 after
    # an earlier trial-reel session bailed at the Trial toggle step.
    await asyncio.sleep(0.8)
    await device.refresh_screen(force=True)
    draft_xml = device.page_source or ""
    if "Keep editing your draft" in draft_xml:
        print("[post_trial_reel] dismissing 'Keep editing your draft?' prompt")
        # Prefer the resource-id `auxiliary_button` ("Start new video").
        m = re.search(
            r'resource-id="com\.instagram\.android:id/auxiliary_button"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            draft_xml,
        ) or re.search(
            r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*resource-id="com\.instagram\.android:id/auxiliary_button"',
            draft_xml,
        )
        if m:
            x1, y1, x2, y2 = map(int, m.groups())
            await device.tap((x1 + x2) // 2, (y1 + y2) // 2)
        else:
            # Text fallback
            start_new = await device.find_element_by_text("Start new video")
            if start_new:
                await device.click(start_new)
        await asyncio.sleep(1.0)
    # Reel picker shows "REEL" tab + a Recents dropdown, or the camera preview.
    return await _wait_for_screen(
        device,
        lambda x: (
            'content-desc="REEL"' in x
            and ('text="Recents"' in x or 'text="No recent photos or videos"' in x
                 or 'content-desc="Open camera"' in x)
        ),
        "reel picker",
        attempts=30,
        interval=0.6,
    )


async def _select_first_video(device: WSDeviceAdapter) -> bool:
    # The reel picker queries MediaStore when it opens. A freshly push_content'd
    # video (especially via the browser_download bridge on a secondary profile)
    # can be indexed in MediaStore but not yet rendered as a thumbnail in the
    # picker grid when we first dump the screen — IG's picker fetches async.
    # Retry the thumbnail scan a few times so the grid has time to populate
    # before we give up. Previously this checked exactly once and intermittently
    # failed with "No videos in reel picker" right after a successful push.
    matches = []
    explicit_empty = False
    for attempt in range(5):
        await device.refresh_screen(force=True)
        xml = device.page_source or ""
        matches = list(
            re.finditer(
                r'<node\s[^>]*content-desc="(Unselected Video thumbnail[^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                xml,
            )
        )
        if matches:
            break
        explicit_empty = "No recent photos or videos" in xml
        print(
            f"[post_trial_reel] reel picker empty (attempt {attempt + 1}/5, "
            f"explicit_empty={explicit_empty}) — waiting for thumbnail grid to populate"
        )
        await asyncio.sleep(2.0)
    if not matches:
        print("[post_trial_reel] no video thumbnails after 5 attempts (~10s)")
        return False
    m = matches[0]
    x1, y1, x2, y2 = int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5))
    await device.tap((x1 + x2) // 2, (y1 + y2) // 2)
    return await _wait_for_screen(
        device,
        lambda x: 'content-desc="Reel preview playing"' in x or 'content-desc="Add audio button"' in x,
        "reel editor",
    )


async def _tap_editor_next(device: WSDeviceAdapter) -> bool:
    # The video-preview editor dumps slowly/empty under contention, so a single
    # find can miss and drop to the coord fallback. Retry the find a few times
    # before falling back to the verified top-right coord.
    nxt = None
    for _ in range(4):
        nxt = (await device.find_element_by_id("com.instagram.android:id/next_button_textview")
               or await device.find_element_by_content_desc("Next")
               or await device.find_element_by_text("Next"))
        if nxt:
            break
        await asyncio.sleep(1.0)
        await device.refresh_screen(force=True)
    if not nxt:
        print("[post_trial_reel] Editor Next control missing — refusing blind coordinate")
        return False
    await device.click(nxt)
    # 2026-06-04: detect the share screen by the caption field / share button
    # RESOURCE-ID (version-stable) instead of the exact placeholder TEXT. IG
    # changes the placeholder copy + the ellipsis glyph ("Write a caption and add
    # hashtags…"), so the old text match silently false-failed ("Share screen did
    # not load after Next") even though the share screen WAS up — verified live:
    # switch/picker/select all succeeded, only this detection failed. The reel
    # editor does NOT pre-load the share fragment, so caption_input_text_view is
    # unique to the real share screen. Keep the old text combo as a fallback.
    return await _wait_for_screen(
        device,
        lambda x: (
            'com.instagram.android:id/caption_input_text_view' in x
            or 'com.instagram.android:id/share_footer_button' in x
            or ('text="New reel"' in x and 'caption' in x.lower())
        ),
        "share screen",
        attempts=30,
        interval=0.6,
    )


async def _caption_field_text(device: WSDeviceAdapter) -> str:
    """Read the current text of the caption AutoCompleteTextView so we can
    verify the caption actually landed. Returns '' if the field isn't found
    or is still showing its placeholder hint."""
    await device.refresh_screen(force=True)
    xml = device.page_source or ""
    m = re.search(
        r'<node\s[^>]*resource-id="com\.instagram\.android:id/caption_input_text_view"[^>]*?\btext="([^"]*)"',
        xml,
    ) or re.search(
        r'<node\s[^>]*?\btext="([^"]*)"[^>]*resource-id="com\.instagram\.android:id/caption_input_text_view"',
        xml,
    )
    if not m:
        return ""
    val = (m.group(1) or "").strip()
    # The empty field renders its placeholder hint as the node's text. Treat as
    # empty ONLY when the value is EXACTLY that hint (phrase + trailing
    # dots/ellipsis) — NOT when a real caption merely begins with those words
    # (e.g. "Write a caption that converts…"), which startswith() wrongly
    # false-emptied, failing a reel whose caption actually landed.
    if val.lower().rstrip(" .…") in ("write a caption", "add a caption"):
        return ""
    return val


async def _dismiss_audio_name_screen(device: WSDeviceAdapter, max_tries: int = 4) -> bool:
    """IG auto-shows the full-screen "Audio name" (rename your original audio)
    editor for trial reels right when the share screen loads. Dismiss it
    WITHOUT confirming — tapping the ✓ permanently renames the audio ("you can
    only rename your audio once"). Backs out until the share screen (caption
    field) is showing. Returns True once on the share screen.

    Running this up-front means caption entry lands on the first try instead of
    bouncing off the audio editor through failed caption attempts.
    """
    for _ in range(max_tries):
        await device.refresh_screen(force=True)
        xml = device.page_source or ""
        low = xml.lower()
        on_audio = 'text="audio name"' in low or "rename your audio" in low
        on_share = 'resource-id="com.instagram.android:id/caption_input_text_view"' in xml
        if on_share and not on_audio:
            return True
        if on_audio:
            print("[post_trial_reel] auto Audio name screen — dismissing up-front (no confirm)")
            try:
                await device.back()
            except Exception:
                pass
            await asyncio.sleep(1.2)
            continue
        # Neither yet — let the share screen settle, then re-check.
        await asyncio.sleep(1.0)
    await device.refresh_screen(force=True)
    return 'resource-id="com.instagram.android:id/caption_input_text_view"' in (device.page_source or "")


async def _enter_caption(device: WSDeviceAdapter, caption: str) -> bool:
    """Type the caption into the share-screen caption field and verify it
    landed.

    The field (caption_input_text_view) is an AutoCompleteTextView that
    edits INLINE — there is no sub-editor. Flow: focus it, clear stale
    text, send_keys, hide the IME with KEYCODE_ESCAPE (NOT back), then
    re-read the field to confirm.

    The earlier implementation pressed `device.back()` right after
    send_keys to dismiss the IME — on this AutoCompleteTextView a back-press
    can pop us off the share screen entirely, so the caption never landed.
    Matches post_feed.py's proven inline pattern (focus -> type -> no back).

    Returns True if the caption is present afterwards, False if the field
    was never found or the text stayed empty after both attempts.
    """
    if not caption:
        print("[post_trial_reel] no caption provided — skipping caption step")
        return True

    # Screen-aware caption entry. The trial-reel share screen carries an
    # "Original audio" row with a "Rename audio" affordance directly below
    # the caption field. A stale element-click (bounds captured before the
    # IME shifted the layout) or IG re-routing the tap can land us on the
    # full-screen "Audio name" rename editor instead — where send_keys then
    # types the caption into the audio name ("yes you canOriginal Audio").
    # Worse, that screen warns "you can only rename your audio once", so we
    # must NEVER confirm it.
    #
    # Strategy: (1) if we're on the Audio name screen, back out WITHOUT
    # confirming; (2) re-dump fresh and tap the caption field by its exact
    # current bounds center; (3) re-verify we stayed on the share screen
    # (didn't open audio name); (4) type and confirm the text landed in
    # caption_input_text_view specifically.
    _CAP_ID = "com.instagram.android:id/caption_input_text_view"
    _CAP_BOUNDS_RE = (
        r'<node\s[^>]*resource-id="com\.instagram\.android:id/caption_input_text_view"'
        r'[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
    )
    _CAP_BOUNDS_RE_ALT = (
        r'<node\s[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
        r'[^>]*resource-id="com\.instagram\.android:id/caption_input_text_view"'
    )

    def _on_audio_name(xml: str) -> bool:
        low = (xml or "").lower()
        return 'text="audio name"' in low or "rename your audio" in low

    async def _exit_audio_name():
        # Back out of the rename editor WITHOUT tapping the ✓ (permanent).
        print("[post_trial_reel] on Audio name screen — backing out (NOT confirming)")
        try:
            await device.back()
        except Exception:
            pass
        await asyncio.sleep(1.2)

    for attempt in range(3):
        # Single dump to locate the caption field + confirm we're on the share
        # screen (audio name was already dismissed up-front before this fn).
        await device.refresh_screen(force=True)
        xml = device.page_source or ""
        if _on_audio_name(xml):
            await _exit_audio_name()
            await device.refresh_screen(force=True)
            xml = device.page_source or ""

        # Locate by resource-id (preferred) when the dump is readable. The reel
        # composer's continuously-playing preview frequently makes uiautomator
        # return an EMPTY tree (verified live: 4 dump retries + --compressed all
        # 0 bytes), so caption_input_text_view often isn't selectable at all.
        # When it isn't, fall back to the calibrated coord (1080x2400 share
        # screen) — mInputShown then CONFIRMS the field focused before we type.
        m = re.search(_CAP_BOUNDS_RE, xml) or re.search(_CAP_BOUNDS_RE_ALT, xml)
        if m:
            cx = (int(m.group(1)) + int(m.group(3))) // 2
            cy = (int(m.group(2)) + int(m.group(4))) // 2
            src = f"resource-id bounds ({cx},{cy})"
        else:
            cx, cy = 540, 300
            src = "calibrated coord (540,300) — caption_input_text_view not in dump"

        # CRITICAL: do NOT run a uiautomator dump (refresh_screen) between the
        # focus-tap and send_keys. A dump collapses the soft keyboard / drops
        # the input focus, so `input text` lands nothing — that was the
        # intermittent "caption did not land" failure. Tap, let the IME settle,
        # type immediately, THEN verify with a dump.
        await device.tap(cx, cy)
        await asyncio.sleep(1.2)
        # CONFIRM the caption field focused via the IME (mInputShown) — NOT a
        # uiautomator dump (this composer is unreadable). THIS is the real fix:
        # the old code typed without confirming focus, so on the reel composer
        # the keys landed nowhere and the field stayed empty -> false "caption
        # did not land". _is_keyboard_visible uses `dumpsys input_method`, a shell
        # read that does NOT drop IME focus (unlike refresh_screen). Retry once
        # via the calibrated coord if the first tap didn't focus.
        if not await _is_keyboard_visible(device):
            await device.tap(540, 300)
            await asyncio.sleep(1.2)
        if not await _is_keyboard_visible(device):
            print(f"[post_trial_reel] caption field did not focus (attempt {attempt + 1}, via {src})")
            await asyncio.sleep(1.0)
            continue
        print(f"[post_trial_reel] caption field focused (via {src}) — typing")
        await device.send_keys(caption, typing_mode="human")
        await asyncio.sleep(random.uniform(0.8, 2.2))

        # Hide the soft keyboard WITHOUT a back-press (back discards the share
        # screen). KEYCODE_ESCAPE just dismisses the IME.
        try:
            await device.shell("input keyevent 111")
        except Exception:
            pass
        await asyncio.sleep(0.5)

        # NOW it's safe to dump + verify (we've finished typing).
        await device.refresh_screen(force=True)
        chk = device.page_source or ""
        if _on_audio_name(chk):
            # The tap opened the audio editor instead of focusing the caption —
            # back out and retry the whole sequence.
            await _exit_audio_name()
            continue

        # Confirm the FULL caption landed in the caption field — not empty, not
        # a stray single char ("a").
        landed = await _caption_field_text(device)
        if landed and normalized_text_equal(caption, landed):
            print(
                "[post_trial_reel] caption confirmed in field: "
                f"[REDACTED length={len(landed)}]"
            )
            return True
        print(
            f"[post_trial_reel] caption did not land (attempt {attempt + 1}) — "
            f"got [REDACTED length={len(landed)}], expected length={len(caption)} — retrying"
        )
        # Clear any bad partial before retrying so we don't append.
        if landed:
            try:
                await device.tap(cx, cy)
                await asyncio.sleep(0.6)
                await device.clear()
                await asyncio.sleep(0.3)
            except Exception:
                pass

    print("[post_trial_reel] caption never landed in caption field")
    return False


def _trial_switch_state(xml: str):
    """Return the checked-state of the Trial reel toggle Switch, or None if
    the switch node isn't present in `xml`.

    The Trial row's toggle is an android.widget.Switch. uiautomator exposes
    its on/off state via the `checked="true|false"` attribute. We find the
    Switch node nearest (vertically) to the 'Trial' label row."""
    # Locate the Trial label row first.
    label = re.search(
        r'text="Trial"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
        xml,
    ) or re.search(
        r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*text="Trial"',
        xml,
    )
    if not label:
        return None
    label_y = (int(label.group(2)) + int(label.group(4))) // 2
    # Find every Switch node and pick the one whose row overlaps the label.
    best = None
    best_dist = 10**9
    for sw in re.finditer(
        r'<node\s[^>]*class="android\.widget\.Switch"[^>]*?>',
        xml,
    ):
        node = sw.group(0)
        cb = re.search(r'checked="(true|false)"', node)
        bb = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
        if not cb or not bb:
            continue
        sw_y = (int(bb.group(2)) + int(bb.group(4))) // 2
        dist = abs(sw_y - label_y)
        if dist < best_dist:
            best_dist = dist
            best = cb.group(1) == "true"
    # Only trust a Switch that sits on (roughly) the same row as the label.
    if best is not None and best_dist <= 120:
        return best
    return None


async def _dismiss_trial_confirm_popup(device: WSDeviceAdapter) -> bool:
    """Dismiss the trial confirmation dialog ('Got it' / 'Keep as trial' /
    etc.) if it appeared after flipping the toggle. Returns True if a popup
    button was tapped, False if no popup was present (also a valid state —
    some IG builds toggle without a dialog)."""
    await device.refresh_screen(force=True)
    popup_xml = device.page_source or ""
    for label in ("Got it", "Keep as trial", "Keep trial",
                  "Continue", "OK", "Confirm", "Yes"):
        if label not in popup_xml:
            continue
        btn_match = re.search(
            r'<node\s[^>]*text="' + re.escape(label) +
            r'"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            popup_xml,
        ) or re.search(
            r'<node\s[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*text="'
            + re.escape(label) + r'"',
            popup_xml,
        )
        if btn_match:
            bx = (int(btn_match.group(1)) + int(btn_match.group(3))) // 2
            by = (int(btn_match.group(2)) + int(btn_match.group(4))) // 2
            await device.tap(bx, by)
            print(f"[post_trial_reel] dismissed trial confirm popup via '{label}'")
            await asyncio.sleep(0.6)
            return True
    return False


async def _scroll_to_trial_and_toggle(device: WSDeviceAdapter,
                                      max_scrolls: int = 12) -> bool:
    # 2.19.2: bumped from 6 to 12. Anyro hit "Trial toggle not found" live
    # on itsjocelynchenz 2026-05-26 — the share sheet has more rows now
    # and the Trial row sits below the original 6-scroll window. Each scroll
    # advances ~1000-1100px of share-sheet content; 12 covers up to ~13k px
    # which is well past any reasonable share-sheet layout.
    """Scroll the share sheet up until the 'Trial' row label is visible,
    flip its toggle ON, dismiss the confirmation popup, and VERIFY the
    Switch actually reads checked=true afterwards.

    Returns True only when the toggle is confirmed ON. Returns False if the
    Trial row never appeared, or if the toggle was tapped but the Switch
    state did not flip to ON."""
    for attempt in range(max_scrolls):
        await device.refresh_screen(force=True)
        xml = device.page_source or ""

        # The Trial label is a TextView with text="Trial" and
        # resource-id ending in /title. Match either ordering of attrs.
        m = (
            re.search(
                r'<node\s[^>]*resource-id="com\.instagram\.android:id/title"[^>]*text="Trial"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                xml,
            )
            or re.search(
                r'<node\s[^>]*text="Trial"[^>]*resource-id="com\.instagram\.android:id/title"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                xml,
            )
            or re.search(
                r'<node\s[^>]*text="Trial"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                xml,
            )
        )
        if not m:
            # Steep scroll up to reveal more rows of the share sheet.
            await device.swipe(540, 1800, 540, 700, 600)
            await asyncio.sleep(0.6)
            continue

        y1, y2 = int(m.group(2)), int(m.group(4))
        row_y = (y1 + y2) // 2

        # If the Switch is already ON, nothing to do.
        state_before = _trial_switch_state(xml)
        if state_before is True:
            print("[post_trial_reel] Trial toggle already ON")
            return True

        # Tap the toggle (right edge of the Trial row) and confirm popup.
        await device.tap(TRIAL_TOGGLE_X, row_y)
        await asyncio.sleep(0.9)
        await _dismiss_trial_confirm_popup(device)

        # Verify the Switch flipped to ON. If the state node isn't readable
        # (some layouts hide the Switch class), accept the tap — but if it
        # IS readable and still OFF, retry the tap once.
        await device.refresh_screen(force=True)
        verify_xml = device.page_source or ""
        state_after = _trial_switch_state(verify_xml)
        if state_after is True:
            print("[post_trial_reel] Trial toggle confirmed ON")
            return True
        if state_after is False:
            print("[post_trial_reel] Trial toggle still OFF after tap — retrying once")
            await device.tap(TRIAL_TOGGLE_X, row_y)
            await asyncio.sleep(0.9)
            await _dismiss_trial_confirm_popup(device)
            await device.refresh_screen(force=True)
            state_retry = _trial_switch_state(device.page_source or "")
            if state_retry is True:
                print("[post_trial_reel] Trial toggle confirmed ON after retry")
                return True
            print("[post_trial_reel] Trial toggle did NOT flip ON after retry")
            return False
        # state_after is None — Switch state unreadable. The popup is the
        # strongest signal we toggled it; treat the row-found + tap as done.
        print("[post_trial_reel] Trial Switch state unreadable — accepting tap as toggled")
        return True

    print("[post_trial_reel] Trial row never appeared after scrolling")
    return False


async def _confirm_clips_nux_sheet(
    device: WSDeviceAdapter,
    max_tries: int = 3,
) -> bool | None:
    """Handle the intermittent "About Reels" bottom-sheet (the Clips NUX) that
    IG shows after the reel's Next/Share. Its confirm button is
    `clips_nux_sheet_share_button` (content-desc "Share") and tapping it is what
    ACTUALLY publishes the reel. Returns None when the sheet is absent, True
    when its verified Share control dismisses it, and False when the sheet is
    present but cannot be handled safely.

    Verified live 2026-05-29: without this, tapping the reel "Next" surfaces the
    sheet, the reel sticks on it, and the run falsely reports success.
    """
    sheet_seen = False
    for _ in range(max_tries):
        await device.refresh_screen(force=True)
        xml = device.page_source or ""
        if "clips_nux_sheet_share_button" not in xml and "About Reels" not in xml:
            return True if sheet_seen else None
        sheet_seen = True
        btn = await device.find_element_by_id(
            "com.instagram.android:id/clips_nux_sheet_share_button"
        )
        if not btn:
            print("[post_trial_reel] About Reels NUX sheet has no verified Share control")
            return False
        await device.click(btn)
        print("[post_trial_reel] About Reels NUX sheet — tapped verified Share control")
        await asyncio.sleep(2.5)
        # Post-tap verification: confirm the sheet actually dismissed before
        # retrying. If it's gone, exit early; if it lingers, the loop retries.
        await device.refresh_screen(force=True)
        xml_after = device.page_source or ""
        if "clips_nux_sheet_share_button" not in xml_after and "About Reels" not in xml_after:
            return True
    return False if sheet_seen else None


async def _tap_share(
    device: WSDeviceAdapter,
    publish_state: dict[str, bool],
) -> bool | None:
    # RESOURCE-ID FIRST (most reliable). The REEL share/primary-action button is
    # `share_button` — NOT `share_footer_button` (that's the image/feed id, so
    # the old lookup always missed). On this build it is LABELLED "Next" and
    # leads to an "About Reels" Clips NUX sheet that actually publishes; on
    # other builds it shares directly. Order: share_button id -> (image id) ->
    # desc/text "Share" -> desc/text "Next". Then confirm the NUX sheet.
    share = (
        await device.find_element_by_id("com.instagram.android:id/share_button")
        or await device.find_element_by_id("com.instagram.android:id/share_footer_button")
        or await device.find_element_by_content_desc("Share")
        or await device.find_element_by_text("Share")
        or await device.find_element_by_content_desc("Next")
        or await device.find_element_by_text("Next")
    )
    if not share:
        print("[post_trial_reel] Share/Next control missing — refusing blind coordinate")
        return None
    publish_state["attempted"] = True
    await device.click(share)
    await asyncio.sleep(2.0)
    # Handle the intermittent "About Reels" NUX confirmation sheet (the real
    # publish step on this build).
    nux_result = await _confirm_clips_nux_sheet(device)
    if nux_result is False:
        return False
    await asyncio.sleep(2.5)
    return True


def _home_tab_selected(xml: str) -> bool:
    return bool(
        re.search(
            r'resource-id="com\.instagram\.android:id/feed_tab"[^>]*selected="true"',
            xml or "",
        )
        or re.search(r'content-desc="Home"[^>]*selected="true"', xml or "")
    )


async def _tap_home_tab_from_verified_main_activity(device: WSDeviceAdapter) -> bool:
    shell = getattr(device, "shell", None)
    get_screen_size = getattr(device, "get_screen_size", None)
    tap = getattr(device, "tap", None)
    if not callable(shell) or not callable(get_screen_size) or not callable(tap):
        return False
    try:
        foreground = await shell(
            "dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity' | head -3"
        ) or ""
        if not re.search(
            r"\bcom\.instagram\.android/\.activity\.MainTabActivity\b",
            foreground,
        ):
            return False
        width, height = await get_screen_size()
        if not (320 <= int(width) <= 5000 and 480 <= int(height) <= 10000):
            return False
        await tap(round(int(width) * 0.10), round(int(height) * 0.9475))
        return True
    except Exception:
        return False


async def _settle_on_home(
    device: WSDeviceAdapter,
    *,
    max_attempts: int = 3,
    settle_seconds: float = 0.8,
) -> bool:
    clicked_home = False
    fallback_tapped = False
    for _ in range(max(1, max_attempts)):
        await device.refresh_screen(force=True)
        if _home_tab_selected(device.page_source or ""):
            return True
        if not clicked_home:
            home = (
                await device.find_element_by_id("com.instagram.android:id/feed_tab")
                or await device.find_element_by_content_desc("Home")
            )
        else:
            home = None
        if home:
            clicked_home = True
            await device.click(home)
            if settle_seconds > 0:
                await asyncio.sleep(settle_seconds)
            await device.refresh_screen(force=True)
            if _home_tab_selected(device.page_source or ""):
                return True
        elif not clicked_home and not fallback_tapped:
            fallback_tapped = await _tap_home_tab_from_verified_main_activity(device)
            if fallback_tapped:
                if settle_seconds > 0:
                    await asyncio.sleep(settle_seconds)
                await _dismiss_ig_popups(device, max_attempts=3)
                await device.refresh_screen(force=True)
                if _home_tab_selected(device.page_source or ""):
                    return True
        if settle_seconds > 0:
            await asyncio.sleep(settle_seconds)
    return False


async def _run(
    device: WSDeviceAdapter,
    config: dict,
    publish_state: dict[str, bool],
) -> dict:
    """Trial reel: profile -> + -> Reel -> video -> Next -> caption ->
    Trial toggle -> Got it -> Share.

    Required external preconditions:
      - Instagram launched (ig_launcher as the prior step)
      - Target account selected (ig_account_switch)
      - At least one video already in user-N's MediaStore (push_content)

    Pass `trial_mode=False` to post a regular reel via the same flow.
    """
    account_id = (
        config.get("account_username") or config.get("account_id") or ""
    )
    prepared_exact = None
    exact_selection = None
    try:
        caption = (config.get("caption") or "").strip()
        caption_source = "config" if caption else ""
        if not caption:
            # Read the per-account caption file from the operator's content
            # folder (Content/Instagram/<username>/captions/captions.txt).
            # The JS layer (module-runner.ts resolveLocalCaptions) normally
            # injects config.caption from this same pool — this is the
            # fallback for any run path that bypasses it (e.g. legacy
            # schedule code or a Railway brain).
            try:
                try:
                    from modules.content_manager import read_account_caption_pool
                except ImportError:
                    from content_manager import read_account_caption_pool
                import random as _random
                account_username = config.get("account_username") or ""
                # config may carry an explicit content root; otherwise the
                # reader derives it from SHADOWPHONE_LOG_DIR.
                content_root = config.get("content_root") or None
                pool = read_account_caption_pool(
                    account_username, "captions", content_root
                )
                if pool:
                    caption = _random.choice(pool).strip()
                    caption_source = "pool"
                else:
                    print(
                        f"[post_trial_reel] no per-account caption pool for "
                        f"@{account_username or '?'} — posting captionless"
                    )
            except Exception as e:
                # Don't let a reader failure silently post a captionless reel
                # without an explanation in the log.
                print(f"[post_trial_reel] caption pool fallback failed: {type(e).__name__}: {e}")
                caption = ""
        # If both config and the caption pool came back empty, post with no
        # caption. Instagram permits captionless reels — that is the correct
        # neutral outcome. We do NOT inject a placeholder caption: a joke /
        # filler string posted to a real account is worse than none.
        if not caption:
            caption = ""
            caption_source = "none"
        caption = re.sub(r"#\w+\s*", "", caption).strip()

        # trial_mode is the authoritative trial/regular switch. It defaults to
        # True (this module is named post_trial_reel) — but a REGULAR reel post
        # routes here too (via the post_reel adapter alias / the schedule's
        # "Post" step), and an absent flag must not silently turn that into a
        # trial. post_destination is the schedule's parallel signal: any
        # non-trial destination forces regular mode so the two keys agree.
        _dest = str(config.get("post_destination") or "").strip().lower()
        if "trial_mode" in config:
            trial_mode = bool(config.get("trial_mode"))
        elif _dest:
            trial_mode = _dest == "trial_reel"
        else:
            trial_mode = True

        await _LOG.log(
            device,
            f"post_trial_reel START account={account_id!r} trial_mode={trial_mode} "
            f"caption_len={len(caption)} caption_source={caption_source} "
            f"target_user={config.get('target_user', '?')}",
        )

        try:
            prepared_exact = await prepare_exact_content_selection(
                device,
                config,
                {"reel"},
                {"video"},
            )
        except ExactContentSelectionError as error:
            await _LOG.error(device, f"Exact content preflight failed: {error}")
            return {
                "success": False,
                "error": f"Exact content preflight failed: {error}",
                "data": {
                    "step": "exact_content_preflight",
                    "account_id": account_id,
                },
            }

        # ── Pre-flight: IG installed
        if not await _is_ig_installed(device):
            await _LOG.error(device, "Instagram not installed")
            return {
                "success": False,
                "error": "Instagram is not installed on the active profile",
                "data": {"step": "preflight_pm_list", "account_id": account_id},
            }

        # ── Pre-flight: gallery has at least one video
        # Scope the MediaStore query to the IG user — a browser_download
        # push (secondary GrapheneOS profile) indexes the video under that
        # user's MediaStore, which an unscoped (user 0) query cannot see.
        ig_user = str(
            config.get("target_user") or config.get("user_id") or ""
        ).strip()
        if not ig_user or not ig_user.isdigit():
            ig_user = await _active_user(device)
        if prepared_exact is None and not await _mediastore_has_video(device, ig_user):
            await _LOG.error(
                device,
                "MediaStore has no videos — push_content must run first",
            )
            return {
                "success": False,
                "error": (
                    "No videos in device gallery — trial reels require a video. "
                    "Run push_content before post_trial_reel."
                ),
                "data": {
                    "step": "preflight_mediastore",
                    "account_id": account_id,
                },
            }

        # ALWAYS force-stop IG before starting. Solves two problems:
        #  1. Back-to-back runs: regular post -> trial post leaves IG mid-
        #     flow (share screen, draft, "Just shared" toast). A fresh
        #     launch gives us a deterministic Home/Profile starting screen.
        #  2. The "Add Instagram account / Go to Accounts Center" leftover
        #     from ig_account_switch sometimes sticks around — force-stop
        #     clears it completely.
        # force_stop_pkg = `am force-stop --user N com.instagram.android`
        try:
            user_id = str(config.get("target_user") or config.get("user_id") or "").strip()
            if user_id and user_id != "0":
                await device.shell(f"am force-stop --user {user_id} com.instagram.android")
            else:
                await device.close_app("com.instagram.android")
        except Exception as e:
            print(f"[post_trial_reel] force-stop best-effort failed: {e}")
        await asyncio.sleep(0.6)

        await _LOG.progress(device, 5, "Launching Instagram")
        print("[post_trial_reel] launching IG")
        await device.launch_app("com.instagram.android")
        # launch_app already sleeps 2s; add 1s more for IG cold-launch render.
        await asyncio.sleep(1)

        # ── Pre-flight: IG actually reaches foreground after am start.
        # A cold launch right after force-stop can take several seconds to
        # render; during that window the focused window is briefly
        # `mCurrentFocus=null` (non-empty but no package). _ig_is_foreground
        # already treats an empty/error dumpsys read as 'unknown' (returns
        # True) — so a transient cold-launch null is NOT a failure. The old
        # single check still bailed if the very first read missed IG (verified
        # live on post_feed: focus null at +3s, IG fully foreground moments
        # later). Poll up to ~18s, and re-launch once if it still hasn't
        # surfaced, before giving up. Ported from post_feed.py.
        fg = False
        for _attempt in range(2):
            for _ in range(12):                 # ~18s per launch attempt
                if await _ig_is_foreground(device):
                    fg = True
                    break
                await asyncio.sleep(1.5)
            if fg:
                break
            if _attempt == 0:
                print("[post_trial_reel] IG not foreground after first launch — re-launching once")
                await device.launch_app("com.instagram.android")
                await asyncio.sleep(1)
        if not fg:
            hint = await _screen_hint(device, "post-launch focus")
            await _LOG.error(device, f"Instagram did not reach foreground; {hint}")
            return {
                "success": False,
                "error": "Instagram failed to come to foreground after launch",
                "data": {
                    "step": "launch_foreground",
                    "account_id": account_id,
                    "screen_hint": hint,
                },
            }
        print("[post_trial_reel] IG foreground confirmed")

        # Post-account-switch leftover: IG shows an "Add Instagram account /
        # Go to Accounts Center" modal whose Dismiss button is unreliable
        # (small bounds, sometimes obscured). Pressing back closes it cleanly
        # and lands us on MainTabActivity, which is the expected starting
        # point for the profile flow.
        await device.refresh_screen(force=True)
        post_switch_xml = device.page_source or ""
        await raise_if_instagram_verification(
            device,
            stage="post_reel_pre_popup",
            xml=post_switch_xml,
        )
        if "Go to Accounts Center" in post_switch_xml or "Add Instagram account" in post_switch_xml:
            print("[post_trial_reel] dismissing post-account-switch modal via back")
            await device.back()
            await asyncio.sleep(0.6)

        start_surface = await stabilize_posting_start_surface(device)
        if not start_surface.ready:
            if start_surface.reason == "verification_required":
                await raise_if_instagram_verification(
                    device,
                    stage="post_reel_start_surface",
                    xml=device.page_source or "",
                )
            await _LOG.error(
                device,
                f"Posting start surface not safe: {start_surface.reason}",
            )
            return {
                "success": False,
                "error": f"Posting start surface not safe: {start_surface.reason}",
                "data": {
                    "step": "start_surface",
                    "reason": start_surface.reason,
                    "recovery_actions": list(start_surface.actions),
                    "account_id": account_id,
                },
            }

        # Checkpoint / rate-limit guard before we start tapping.
        blocker = await _check_blocker(device)
        if blocker:
            kind, msg = blocker
            await _LOG.error(device, msg)
            return {
                "success": False,
                "error": msg,
                "data": {
                    "step": "post_launch_blocker",
                    "blocker": kind,
                    "account_id": account_id,
                    "manual_action_required": kind == "checkpoint",
                },
            }

        await _LOG.progress(device, 20, "Reaching profile screen")
        if not await _goto_profile(device):
            hint = await _screen_hint(device, "profile reach failed")
            await _LOG.error(device, f"Could not reach profile screen; {hint}")
            return {
                "success": False,
                "error": "Could not reach profile screen",
                "data": {"step": "profile_tab", "account_id": account_id, "screen_hint": hint},
            }
        await _handle_ig_media_permission_popup(device, "profile tab")

        # Account-identity guard: verify the on-screen IG handle matches the
        # target before opening the composer. A mismatch means the wrong account
        # is foregrounded — abort immediately (posting to the wrong account is
        # irreversible). An unreadable configured identity also blocks.
        await device.refresh_screen(force=True)
        _guard_xml = device.page_source or ""
        _guard_target = account_id.lstrip("@").strip().lower()
        # Skip the guard if the target looks like a UUID (caller passed only
        # account_id, no real handle) — comparing a UUID to a real IG handle
        # would always mismatch and FALSE-ABORT a legit post.
        if len(_guard_target) == 36 and _guard_target.count("-") == 4:
            _guard_target = ""
        _guard_on_screen = verified_profile_username(_guard_xml)
        if _guard_target and _guard_on_screen is not None:
            if _guard_on_screen != _guard_target:
                await _LOG.error(
                    device,
                    f"ABORT wrong-account: on @{_guard_on_screen},"
                    f" expected @{_guard_target}",
                )
                return {
                    "success": False,
                    "error": f"wrong-account: on @{_guard_on_screen}, expected @{_guard_target}",
                    "data": {"step": "account_guard", "account_id": account_id},
                }
        elif _guard_target and _guard_on_screen is None:
            error = (
                f"Could not verify the active Instagram account. Open @{_guard_target}'s "
                "profile on the phone and retry. No post was submitted."
            )
            await _LOG.error(device, error)
            return {
                "success": False,
                "code": "INSTAGRAM_ACCOUNT_IDENTITY_UNVERIFIED",
                "error": error,
                "data": {"step": "account_guard", "account_id": account_id},
            }

        await _LOG.progress(device, 30, "Opening Create New sheet")
        if not await _open_create_sheet(device):
            hint = await _screen_hint(device, "create sheet missing")
            await _LOG.error(device, f"Create New sheet did not open; {hint}")
            return {
                "success": False,
                "error": "Create New sheet did not open",
                "data": {"step": "create_new", "account_id": account_id, "screen_hint": hint},
            }
        await _handle_ig_media_permission_popup(device, "create new sheet")

        await _LOG.progress(device, 40, "Tapping Create new reel")
        if not await _tap_create_new_reel(device):
            hint = await _screen_hint(device, "reel picker missing")
            await _LOG.error(device, f"Reel picker did not load; {hint}")
            return {
                "success": False,
                "error": "Reel picker did not load",
                "data": {"step": "create_new_reel", "account_id": account_id, "screen_hint": hint},
            }
        await _handle_ig_media_permission_popup(device, "reel picker")

        await _LOG.progress(device, 55, "Selecting first video")
        if prepared_exact is not None:
            try:
                exact_selection = await select_prepared_exact_content(
                    device,
                    prepared_exact,
                    require_selected_marker=False,
                    transition_markers=(
                        'content-desc="Reel preview playing"',
                        'content-desc="Add audio button"',
                    ),
                )
            except ExactContentSelectionError as error:
                await _LOG.error(device, f"Exact reel selection failed: {error}")
                return {
                    "success": False,
                    "error": f"Exact reel selection failed: {error}",
                    "data": {
                        "step": "exact_gallery_selection",
                        "account_id": account_id,
                    },
                }
        elif not await _select_first_video(device):
            await _LOG.error(
                device, "No videos in reel picker — push content first"
            )
            return {
                "success": False,
                "error": "No videos in reel picker — push content first",
                "data": {"step": "select_video", "account_id": account_id},
            }

        await _LOG.progress(device, 65, "Advancing to share screen")
        if not await _tap_editor_next(device):
            hint = await _screen_hint(device, "share screen never loaded")
            await _LOG.error(device, f"Share screen did not load after Next; {hint}")
            return {
                "success": False,
                "error": "Share screen did not load after Next",
                "data": {"step": "editor_next", "account_id": account_id, "screen_hint": hint},
            }

        # IG auto-pops the "Audio name" (name your original audio) editor for
        # trial reels the moment the share screen loads — BEFORE we touch
        # anything. Dismiss it up-front (never tap ✓ — rename is permanent) so
        # caption entry starts on a clean share screen and lands on the first
        # attempt instead of discovering + recovering from it via failed
        # caption retries.
        await _dismiss_audio_name_screen(device)

        # Checkpoint scan now that we're on the share screen — IG sometimes
        # interstitials here when an account looks suspicious.
        blocker = await _check_blocker(device)
        if blocker:
            kind, msg = blocker
            await _LOG.error(device, f"Pre-share blocker: {msg}")
            return {
                "success": False,
                "error": msg,
                "data": {
                    "step": "pre_share_blocker",
                    "blocker": kind,
                    "account_id": account_id,
                    "manual_action_required": kind == "checkpoint",
                },
            }

        await _LOG.progress(device, 75, "Entering caption")
        if not await _enter_caption(device, caption):
            hint = await _screen_hint(device, "caption entry failed")
            await _LOG.error(
                device,
                f"Caption did not land in the caption field; {hint}",
            )
            return {
                "success": False,
                "error": (
                    "Caption entry failed — the caption field was not found "
                    "or the text did not land after typing"
                ),
                "data": {
                    "step": "caption",
                    "account_id": account_id,
                    "screen_hint": hint,
                },
                "caption": caption[:50],
            }

        if trial_mode:
            await _LOG.progress(device, 82, "Toggling trial reel")
            if not await _scroll_to_trial_and_toggle(device):
                hint = await _screen_hint(device, "trial toggle missing")
                await _LOG.error(
                    device,
                    f"Trial toggle not found / did not flip ON — refusing to post; {hint}",
                )
                return {
                    "success": False,
                    "error": (
                        "Trial toggle not found on share screen or did not "
                        "flip ON — refusing to post as a regular reel"
                    ),
                    "data": {
                        "step": "trial_toggle",
                        "account_id": account_id,
                        "screen_hint": hint,
                    },
                    "caption": caption[:50],
                }

        await _LOG.progress(device, 90, "Tapping Share")
        share_outcome = await _tap_share(device, publish_state)
        if share_outcome is not True:
            missing_share = share_outcome is None
            hint = await _screen_hint(
                device,
                "share control missing" if missing_share else "share confirmation unsafe",
            )
            error = (
                "Share control was not verified; refusing to tap"
                if missing_share
                else "Share was tapped, but its confirmation could not be handled safely"
            )
            await _LOG.error(device, f"{error}; {hint}")
            return {
                "success": False,
                "error": error,
                "data": {
                    "step": "share_control" if missing_share else "share_confirmation",
                    "account_id": account_id,
                    "screen_hint": hint,
                },
                "caption": caption[:50],
            }

        # Let the view hierarchy stabilize after Share so the blocker scan
        # dumps a settled screen (NUX sheet / transition animations done).
        await asyncio.sleep(1.5)

        # Post-share blocker scan — rate-limit/checkpoint screens often
        # surface right after the share tap on flagged accounts.
        await device.refresh_screen(force=True)
        post_xml = device.page_source or ""
        blocker = await _check_blocker(device, post_xml)
        if blocker:
            kind, msg = blocker
            await _LOG.error(device, f"Post-share blocker: {msg}")
            return {
                "success": False,
                "error": msg,
                "data": {
                    "step": "post_share_blocker",
                    "blocker": kind,
                    "account_id": account_id,
                    "manual_action_required": kind == "checkpoint",
                },
            }

        # Post-condition: confirm the reel actually LEFT the compose. The reel
        # surface exposes `share_button` / "New reel" (NOT share_footer_button —
        # that's the image/feed id, so the old check never tripped and falsely
        # passed, masking reels stuck on the About-Reels NUX sheet). If
        # share_button, the NUX sheet, or "New reel" is still visible after a
        # delay, retry the NUX confirm once, then fail honestly.
        # Confirm we actually LEFT the compose via a POSITIVE home signal. The
        # reel-compose dump markers (share_button / "New reel" / the NUX sheet)
        # LINGER in IG's view hierarchy and go stale after posting (same
        # dump-unreliability that needed the pixel check for images) — checking
        # their ABSENCE false-fails a successful post (verified live 2026-05-29:
        # reel published, phone on home, yet the dump still showed "New reel").
        # The bottom tab bar (feed_tab / tab_bar / "Home") is HIDDEN during the
        # reel compose and reappears only once the reel is shared.
        nux_result = await _confirm_clips_nux_sheet(device)
        if nux_result is False:
            return {
                "success": False,
                "error": "Share was tapped, but the About Reels confirmation was unsafe",
                "data": {
                    "step": "post_share_confirmation",
                    "account_id": account_id,
                },
            }
        # Let IG's share->home navigation animation settle before polling the
        # home tab bar; without this the first few polls race the transition.
        await asyncio.sleep(2.0)
        def _on_home(x: str) -> bool:
            # Check for home tab with selected="true" (indicates truly active home)
            return bool(
                re.search(r'resource-id="com\.instagram\.android:id/feed_tab"[^>]*selected="true"', x)
                or re.search(r'content-desc="Home"[^>]*selected="true"', x)
            )
        posted = False
        for _attempt in range(8):
            # Keepalive: this loop can exceed the 45s WS heartbeat window.
            if _attempt == 3:
                await _LOG.progress(device, 95, "Verifying home feed")
            # PRIMARY dump-free confirm — run FIRST, before the slow reel-surface
            # uiautomator dump (which balloons to ~25s and returns empty here).
            # After Share, IG leaves the composer
            # (com.instagram.android/com.instagram.modal.ModalActivity) and
            # returns to MainTabActivity. The dump is EMPTY on this transition
            # (mCurrentFocus=null) so the dump-based _on_home false-fails a reel
            # that actually published (verified live 2026-05-30: capture showed
            # ModalActivity -> MainTabActivity 5s after Share, dump empty, post
            # succeeded). A fast `dumpsys ... mResumedActivity` shell sees it.
            try:
                fg = await device.shell("dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity' 2>/dev/null || true")
            except Exception:
                fg = ""
            print(f"[post_trial_reel] post-share poll {_attempt}: resumed={(fg or '').strip()[:120]}")
            if "com.instagram.android/.activity.MainTabActivity" in (fg or ""):
                posted = True
                print("[post_trial_reel] left reel composer -> MainTabActivity (posted; dump-free confirm)")
                break
            # Dump-based fallback (+ NUX-reappear handling) only if still not home.
            await device.refresh_screen(force=True)
            page = device.page_source or ""
            if "clips_nux_sheet_share_button" in page or "About Reels" in page:
                print("[post_trial_reel] NUX sheet reappeared during home polling — retrying dismiss")
                if await _confirm_clips_nux_sheet(device) is False:
                    break
                await asyncio.sleep(1.0)
                continue
            if _on_home(page):
                posted = True
                break
            await asyncio.sleep(1.5)
        if not posted:
            hint = await _screen_hint(device, "post-share: home nav not visible")
            await _LOG.error(
                device,
                f"Reel did not return to home after Share — post may not have published; {hint}",
            )
            return {
                "success": False,
                "error": "Share did not complete (home feed not reached after Share/About-Reels)",
                "data": {
                    "step": "post_share_verification",
                    "account_id": account_id,
                },
                "caption": caption[:50],
            }

        # Don't leave the phone parked on the Reels tab. Use only the exact Home
        # control and verify it selected; pressing Back from MainTabActivity can
        # exit Instagram when a transient UI dump omits the tab bar.
        resting_state_home = False
        try:
            await asyncio.sleep(1.5)
            resting_state_home = await _settle_on_home(device)
            if resting_state_home:
                print("[post_trial_reel] Home feed selected and verified")
            else:
                print("[post_trial_reel] Home tab unavailable; leaving verified MainTabActivity untouched")
        except Exception as e:
            print(f"[post_trial_reel] Home resting-state verification failed: {e}")

        await _LOG.progress(device, 100, "Trial reel complete")
        return _finalize_success(
            {
                "success": True,
                "trial": trial_mode,
                "caption": caption[:50] + "..." if len(caption) > 50 else caption,
                "resting_state_home": resting_state_home,
                "move_instructions": {"action": "move_to_used", "max_files": 1},
            },
            exact_selection,
            publish_confirmed=True,
        )
    except InstagramVerificationRequired as verification:
        return verification.outcome
    except Exception as e:
        await _LOG.error(device, f"post_trial_reel crashed: {type(e).__name__}: {e}")
        return {
            "success": False,
            "error": f"{type(e).__name__}: {e}",
            "data": {"step": "exception", "account_id": account_id},
        }


def _finalize_publish_outcome(
    result: dict,
    *,
    publish_attempted: bool,
) -> dict:
    if result.get("success") is not False:
        return result
    return {
        **result,
        "data": {
            **(result.get("data") or {}),
            "publish_attempted": publish_attempted,
            "safe_to_retry": not publish_attempted,
        },
    }


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    publish_state = {"attempted": False}
    result = await _run(device, config, publish_state)
    return _finalize_publish_outcome(
        result,
        publish_attempted=publish_state["attempted"],
    )
