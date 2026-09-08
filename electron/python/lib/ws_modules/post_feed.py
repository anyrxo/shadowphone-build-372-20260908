# Module: post_feed
# Posts to Instagram feed (reel or image) via WebSocket.
# Video flow: Create -> POST tab -> select media -> Next -> Next -> caption -> Share
# Image flow: Create -> POST tab -> select media -> (crop) -> Next -> (audio) -> Next -> caption -> Share
import asyncio
import random
import re
from xml.etree import ElementTree
from lib.ws_modules_shared import (
    WSDeviceAdapter,
    _jitter,
    _dismiss_ig_popups,
    _navigate_to_ig_tab,
    _handle_ig_media_permission_popup,
    _tap_create_button,
    _tap_next_button,
    InstagramVerificationRequired,
    normalized_text_equal,
    raise_if_instagram_verification,
    _classify_ig_popup,
)
from lib.persistent_log import ModuleLogger
from lib.posting_progression_guards import (
    ExactContentSelectionError,
    prepare_exact_content_selection,
    select_prepared_exact_content,
    with_exact_content_selection_proof,
    prepare_owner_document_selection,
    share_prepared_owner_document,
    owner_document_editor_next,
    VerifiedOwnerDocumentSelection,
    _strict_active_user,
    verified_profile_username as _owner_document_profile_username,
)


_LOG = ModuleLogger("post_feed")
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
_POST_SHARE_SAFE_DIALOG_DISMISSALS = (
    (("turn on notifications", "enable notifications"), ("Not Now", "Not now")),
    (("save your login info", "save login info"), ("Not Now", "Not now")),
    (("sync your contacts", "connect contacts"), ("Not Now", "Not now", "Skip")),
)


def _finalize_success(result: dict, exact_selection, *, publish_confirmed: bool) -> dict:
    return with_exact_content_selection_proof(
        result,
        exact_selection,
        publish_confirmed=publish_confirmed,
    )


def _normalize(text: str) -> str:
    return (text or "").lower().replace("’", "'").replace("‘", "'")


async def _refresh_xml(device: WSDeviceAdapter) -> str:
    await device.refresh_screen(force=True)
    return device.page_source or ""


async def _is_ig_installed(device: WSDeviceAdapter) -> bool:
    out = await device.shell(f"pm list packages {IG_PKG}") or ""
    return IG_PKG in out


async def _ig_is_foreground(device: WSDeviceAdapter) -> bool:
    """dumpsys-based foreground check. Empty/error output is treated as
    'unknown' (don't fail the run) — only a clear non-IG focus is fatal."""
    try:
        out = await device.shell(
            "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -3"
        ) or ""
        if not out.strip():
            return True
        return IG_PKG in out
    except Exception:
        return True


async def _on_system_gallery(device: WSDeviceAdapter) -> bool:
    """True if the foreground package is com.android.gallery3d (the system
    Gallery Albums). A stray blind tap during picker->edit/audio occasionally
    launches it; detecting it lets us press back to recover instead of blindly
    polling the share pixel for 300s. Empty/error output -> False (don't claim
    diverged on an unknown focus)."""
    try:
        out = await device.shell(
            "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -3"
        ) or ""
        return "com.android.gallery3d" in out
    except Exception:
        return False


async def _active_user(device: WSDeviceAdapter) -> str:
    """The Android user MediaStore must be queried as. A raw `adb shell
    content query` targets user 0 — but on a secondary GrapheneOS profile
    the pushed media lives in (and is indexed under) that user's MediaStore,
    so an unscoped query finds nothing. Returns '0' on failure."""
    try:
        out = await device.shell("am get-current-user") or ""
        uid = out.strip()
        return uid if uid.isdigit() else "0"
    except Exception:
        return "0"


async def _mediastore_has_items(device: WSDeviceAdapter, want_video: bool,
                                 user_id: str = "0") -> bool:
    """Verify gallery actually has at least one item of the right kind.
    Returns True on shell-failure to avoid false-negatives blocking the run.

    Must be scoped to the IG user with `content query --user N` — a
    browser_download push lands media in a secondary profile's MediaStore,
    invisible to an unscoped (user 0) query."""
    try:
        user_flag = f"--user {user_id} " if user_id and user_id != "0" else ""
        uri = (
            "content://media/external/video/media"
            if want_video
            else "content://media/external/images/media"
        )
        out = await device.shell(
            f"content query {user_flag}--uri {uri} --projection _id 2>/dev/null | head -2"
        ) or ""
        if "Row:" in out or "_id=" in out:
            return True
        # Fall back to the opposite kind — IG accepts either on the POST tab.
        other_uri = (
            "content://media/external/images/media"
            if want_video
            else "content://media/external/video/media"
        )
        out2 = await device.shell(
            f"content query {user_flag}--uri {other_uri} --projection _id 2>/dev/null | head -2"
        ) or ""
        return "Row:" in out2 or "_id=" in out2
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
        xml = await _refresh_xml(device)
    await raise_if_instagram_verification(device, stage="post_feed_blocker", xml=xml)
    norm = _normalize(xml)
    for phrase in _CHECKPOINT_PHRASES:
        if phrase in norm:
            return ("checkpoint", "Instagram checkpoint: 'Confirm you're human'")
    for phrase in _RATE_LIMIT_PHRASES:
        if phrase in norm:
            return ("rate_limited", f"Instagram rate-limit overlay: '{phrase}'")
    return None


async def _caption_field_text(device: WSDeviceAdapter) -> str:
    """Read the current text of the caption AutoCompleteTextView so we can
    verify the caption actually landed. Returns '' if the field isn't found
    or is still showing its placeholder hint."""
    xml = await _refresh_xml(device)
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
    # The empty field renders its placeholder hint as the node's text
    # ("Write a caption…" on reels, "Add a caption…" on image/feed). Treat as
    # empty ONLY when the value is EXACTLY that hint (phrase + trailing
    # dots/ellipsis) — NOT when a real caption merely begins with those words
    # (e.g. "Write a caption that converts followers…"), which startswith()
    # wrongly false-emptied, failing a post whose caption actually landed.
    if val.lower().rstrip(" .…") in ("write a caption", "add a caption"):
        return ""
    return val


async def _enter_caption(device: WSDeviceAdapter, caption: str) -> bool:
    """Type the caption into the share-screen caption field and verify it
    landed. Ported from post_trial_reel._enter_caption (validated live).

    The field (caption_input_text_view) is an AutoCompleteTextView that
    edits INLINE — there is no sub-editor.

    CRITICAL: do NOT run a uiautomator dump (refresh_screen) between the
    focus-tap and send_keys. A dump collapses the soft keyboard / drops the
    input focus, so `input text` lands nothing — that was the intermittent
    "caption did not land" failure. Sequence: dump ONCE to find fresh bounds
    -> tap -> sleep -> send_keys -> sleep -> KEYCODE_ESCAPE (111, hide IME,
    NOT back) -> THEN dump and verify the full caption landed.

    Returns True if the caption is present afterwards (or no caption was
    requested), False if the field was never found or the text stayed empty.
    """
    if not caption:
        print("[post_feed] no caption provided — skipping caption step")
        return True

    _CAP_BOUNDS_RE = (
        r'<node\s[^>]*resource-id="com\.instagram\.android:id/caption_input_text_view"'
        r'[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
    )
    _CAP_BOUNDS_RE_ALT = (
        r'<node\s[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
        r'[^>]*resource-id="com\.instagram\.android:id/caption_input_text_view"'
    )

    for attempt in range(3):
        # Single dump to locate the caption field by its EXACT fresh bounds.
        # DO NOT "optimize" this dump away by hardcoding (540,1053): audio is
        # added BEFORE the caption and the audio chip pushes the caption field
        # DOWN, so the field is NOT at (540,1053) once audio is present. Tried
        # removing it 2026-05-29 → caption read '' on all 3 attempts → captionless
        # FAIL (focus stuck on MediaCaptureActivity). The dump is load-bearing.
        xml = await _refresh_xml(device)
        m = re.search(_CAP_BOUNDS_RE, xml) or re.search(_CAP_BOUNDS_RE_ALT, xml)
        if m:
            cx = (int(m.group(1)) + int(m.group(3))) // 2
            cy = (int(m.group(2)) + int(m.group(4))) // 2
        else:
            # The creation-overlay dump is NON-DETERMINISTIC — the caption node
            # is frequently absent from the dump even when we ARE on the share
            # screen (verified live: 'New post' share screen, caption present
            # visually, dump missing it). Don't bail; tap the verified fixed
            # caption-field center. bounds [42,990][1038,1116] -> (540,1053).
            print(f"[post_feed] caption node not in dump (attempt {attempt + 1}) — fixed coord (540,1053)")
            cx, cy = 540, 1053

        # NO dump between this tap and send_keys (a dump drops IME focus).
        await device.tap(cx, cy)
        await asyncio.sleep(1.2)
        await device.send_keys(caption, typing_mode="human")
        await asyncio.sleep(random.uniform(0.8, 2.2))

        # Hide the soft keyboard WITHOUT a back-press (back discards the share
        # screen). KEYCODE_ESCAPE just dismisses the IME.
        try:
            await device.shell("input keyevent 111")
        except Exception:
            pass
        await asyncio.sleep(0.5)

        # STRICT verify — confirm the caption is in the caption FIELD. The frozen
        # share-screen dump reflects the real caption-field text, so if we'd
        # mistakenly typed onto the image (still on the EDIT screen, where this
        # coord is the photo and entry becomes a TEXT STICKER), the field reads
        # empty and we MUST fail. The old "assume landed when the node is absent"
        # guard is what let a caption-on-image post through as success. Poll a
        # few dumps (the overlay dump is non-deterministic) before giving up; do
        # NOT re-type blindly between polls (re-typing on the edit screen just
        # stacks more text stickers on the photo).
        confirmed = False
        landed = ""
        for _ in range(5):
            landed = await _caption_field_text(device)   # re-dumps internally
            if landed and normalized_text_equal(caption, landed):
                confirmed = True
                break
            await asyncio.sleep(0.8)
        if confirmed:
            print(
                "[post_feed] caption confirmed in field: "
                f"[REDACTED length={len(landed)}]"
            )
            return True
        print(
            f"[post_feed] caption NOT confirmed in field (attempt {attempt + 1}) — "
            f"got [REDACTED length={len(landed)}], expected length={len(caption)}"
        )
        # Clear a bad partial before the next attempt (only when the field holds
        # text — clear() on an empty field is pointless and historically risky).
        if landed:
            try:
                await device.tap(cx, cy)
                await asyncio.sleep(0.6)
                await device.clear()
                await asyncio.sleep(0.3)
            except Exception:
                pass

    print("[post_feed] caption never confirmed in field — FAILING (no false success)")
    return False


async def _tap_share(device: WSDeviceAdapter, publish_state: dict[str, bool]) -> None:
    share_btn = await device.find_element_by_id(
        "com.instagram.android:id/share_footer_button"
    )
    if not share_btn:
        share_btn = await device.find_element_by_content_desc("Share")
    if not share_btn:
        share_btn = await device.find_element_by_text("Share")
    if share_btn:
        publish_state["attempted"] = True
        await device.click(share_btn)
        return

    print("[post_feed] Share button not in dump — tapping fixed coord (540,2279)")
    publish_state["attempted"] = True
    await device.tap(540, 2279)


def _selected_feed_destination(xml: str) -> str | None:
    for node in re.findall(r"<node\b[^>]*>", xml or "", re.IGNORECASE):
        if not re.search(r'selected="true"', node, re.IGNORECASE):
            continue
        if re.search(
            r'(resource-id="com\.instagram\.android:id/feed_tab"|content-desc="Home")',
            node,
            re.IGNORECASE,
        ):
            return "selected_home"
        if re.search(
            r'(resource-id="com\.instagram\.android:id/profile_tab"|content-desc="Profile")',
            node,
            re.IGNORECASE,
        ):
            return "selected_profile"
    return None


def _post_share_has_strong_dialog(xml: str) -> bool:
    try:
        nodes = ElementTree.fromstring(xml).iter()
    except ElementTree.ParseError:
        return bool((xml or "").strip())
    return any(
        node.get("visible-to-user") != "false" and node.get("resource-id", "").startswith(marker)
        for node in nodes
        if node.get("resource-id") != "com.instagram.android:id/bottom_sheet_camera_container"
        for marker in (
            "com.instagram.android:id/dialog_container",
            "com.instagram.android:id/modal_container",
            "com.instagram.android:id/igds_alert_dialog",
            "com.instagram.android:id/igds_headline",
            "com.instagram.android:id/bottom_sheet",
            "com.instagram.android:id/share_sheet",
        )
    )


def _post_share_safe_dialog_labels(xml: str) -> tuple[str, ...]:
    lower = _normalize(xml)
    for signatures, labels in _POST_SHARE_SAFE_DIALOG_DISMISSALS:
        if any(signature in lower for signature in signatures):
            return labels
    return ()


async def _confirm_feed_publish(
    device: WSDeviceAdapter,
    initial_xml: str,
    *,
    max_attempts: int = 4,
    settle_seconds: float = 0.8,
) -> tuple[bool, str]:
    xml = initial_xml or ""
    reason = "post_share_unverified"
    for attempt in range(max(1, max_attempts)):
        if _post_share_has_strong_dialog(xml):
            labels = _post_share_safe_dialog_labels(xml)
            if not labels:
                return False, "unknown_post_share_overlay"
            dismissed = False
            for label in labels:
                button = await device.find_element_by_text(label)
                if not button:
                    button = await device.find_element_by_content_desc(label)
                if button:
                    await device.click(button)
                    dismissed = True
                    break
            if not dismissed:
                return False, "known_post_share_prompt_action_missing"
            reason = "known_post_share_prompt_dismissed"
        elif any(
            marker in (xml or "")
            for marker in (
                "share_footer_button",
                "caption_input_text_view",
            )
        ):
            reason = "share_control_still_visible"
        else:
            destination = _selected_feed_destination(xml)
            if destination:
                return True, destination
            reason = "post_share_unverified"

        if attempt + 1 >= max(1, max_attempts):
            break
        if settle_seconds > 0:
            await asyncio.sleep(settle_seconds)
        try:
            await device.refresh_screen(force=True)
            xml = device.page_source or ""
        except Exception:
            xml = ""
            reason = "post_share_screen_refresh_failed"

    return False, reason


async def _reach_share_screen(
    device: WSDeviceAdapter,
    *,
    max_attempts: int = 5,
    poll_attempts: int = 4,
    poll_seconds: float = 1.2,
    owner_document: bool = False,
) -> bool:
    if owner_document:
        for attempt in range(max(1, max_attempts) + 1):
            xml = await _refresh_xml(device)
            if await _check_blocker(device, xml):
                return False
            popup_type, action = _classify_ig_popup(xml)
            if popup_type == "sharing_posts_education" and action == "OK":
                await _dismiss_ig_popups(device, max_attempts=1)
                xml = await _refresh_xml(device)
                if await _check_blocker(device, xml):
                    return False
            if _post_share_has_strong_dialog(xml):
                return False
            try:
                nodes = list(ElementTree.fromstring(xml).iter())
            except ElementTree.ParseError:
                return False
            def matching(resource_id):
                return [node for node in nodes if node.get("resource-id") == f"{IG_PKG}:id/{resource_id}"]
            captions = matching("caption_input_text_view")
            shares = matching("share_footer_button")
            titles = matching("action_bar_textview_title")
            if (len(captions) == 1 and captions[0].get("clickable") == "true"
                    and captions[0].get("enabled") != "false"
                    and len(shares) == 1 and shares[0].get("content-desc") == "Share"
                    and shares[0].get("clickable") == "true" and shares[0].get("enabled") != "false"
                    and len(titles) == 1 and titles[0].get("text") == "New post"
                    and not matching("quick_edit_fragment") and not matching("feed_post_capture_controls_container")
                    and not matching("quick_edit_compose_view") and not matching("gallery_media_thumbnail_tray")):
                return bool(await device.is_on_share_screen())
            if attempt >= max(1, max_attempts):
                return False
            try:
                x, y = owner_document_editor_next(xml)
            except ExactContentSelectionError:
                return False
            await device.tap(x, y)
            await _LOG.progress(device, 50, "Confirming document editor transition")
            if poll_seconds > 0:
                await asyncio.sleep(poll_seconds)
        return False

    for _ in range(max(1, max_attempts)):
        if await device.is_on_share_screen():
            return True

        # A first-run education sheet can arrive after the previous poll. Always
        # classify it immediately before retrying the otherwise blind edit Next
        # coordinate, and fail closed if any unrecognised modal remains.
        await _dismiss_ig_popups(device, max_attempts=2)
        if await device.is_on_share_screen():
            return True
        await device.refresh_screen(force=True)
        if _post_share_has_strong_dialog(device.page_source or ""):
            return False

        await device.tap(940, 2280)
        await _LOG.progress(device, 50, "Confirming edit->share transition")
        for _ in range(max(1, poll_attempts)):
            if poll_seconds > 0:
                await asyncio.sleep(poll_seconds)
            if await device.is_on_share_screen():
                return True

    return False


async def _run(
    device: WSDeviceAdapter,
    config: dict,
    publish_state: dict[str, bool],
) -> dict:
    """Post to Instagram feed via WebSocket - handles both video (reel) and image content.

    Video flow: Create -> POST tab -> select media -> Next -> Next -> caption -> Share
    Image flow: Create -> POST tab -> select media -> (crop) -> Next -> (audio) -> Next -> caption -> Share

    Resource ID first, coordinate fallback. Uses _tap_create_button to avoid
    accidentally tapping notifications (top-right) instead of create (top-left).
    """
    account_id = (
        config.get("account_username") or config.get("account_id") or ""
    )
    content_type = config.get("content_type", "reel")
    prepared_exact = None
    prepared_owner = None
    exact_selection = None
    try:
        caption = (config.get("caption") or "").strip()
        if not caption:
            # Per-account caption file fallback — reads
            # Content/Instagram/<username>/captions/captions.txt. The JS layer
            # (module-runner.ts resolveLocalCaptions) normally injects
            # config.caption from this pool; this covers run paths that bypass it.
            try:
                try:
                    from modules.content_manager import read_account_caption_pool
                except ImportError:
                    from content_manager import read_account_caption_pool
                import random as _random
                account_username = config.get("account_username") or ""
                content_root = config.get("content_root") or None
                pool = read_account_caption_pool(
                    account_username, "captions", content_root
                )
                if pool:
                    caption = _random.choice(pool).strip()
                    print(
                        "[post_feed] No caption set; using random from per-account pool: "
                        f"[REDACTED length={len(caption)}]"
                    )
                else:
                    print(
                        f"[post_feed] No caption set and per-account caption pool "
                        f"empty for @{account_username or '?'} — posting captionless"
                    )
            except Exception as e:
                print(f"[post_feed] Caption fallback failed: {type(e).__name__}: {e}")
                caption = ""
        # Strip hashtags so IG suggestion dropdown doesn't block Share
        if caption:
            caption = re.sub(r"#\w+\s*", "", caption).strip()

        await _LOG.log(
            device,
            f"post_feed START account={account_id!r} content_type={content_type} "
            f"caption_len={len(caption)}",
        )

        try:
            manifest_item = config.get("content_manifest_item")
            if isinstance(manifest_item, dict) and manifest_item.get("method") == "owner_document_share":
                prepared_owner = await prepare_owner_document_selection(device, config)
            else:
                prepared_exact = await prepare_exact_content_selection(
                    device,
                    config,
                    {"image"} if content_type == "image" else {"reel"},
                    {"photo", "video"},
                )
        except ExactContentSelectionError as error:
            await _LOG.error(device, f"Exact content preflight failed: {error}")
            return {
                "success": False,
                "error": f"Exact content preflight failed: {error}",
                "data": {
                    "step": "exact_content_preflight",
                    "account_id": account_id,
                    "content_type": content_type,
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

        # ── Pre-flight: gallery has at least one item of the right kind
        # Scope the MediaStore query to the IG user — a browser_download
        # push (secondary GrapheneOS profile) indexes media under that
        # user's MediaStore, which an unscoped (user 0) query cannot see.
        ig_user = str(
            config.get("target_user") or config.get("user_id") or ""
        ).strip()
        if not ig_user or not ig_user.isdigit():
            ig_user = await _active_user(device)
        if prepared_exact is None and prepared_owner is None and not await _mediastore_has_items(
            device, want_video=(content_type != "image"), user_id=ig_user
        ):
            await _LOG.error(
                device,
                f"No {content_type} media in MediaStore — push_content must run first",
            )
            return {
                "success": False,
                "error": (
                    f"No media in device gallery for content_type={content_type} "
                    "— push_content must run before post_feed"
                ),
                "data": {
                    "step": "preflight_mediastore",
                    "account_id": account_id,
                    "content_type": content_type,
                },
            }

        # ALWAYS force-stop IG before launching so we start from a deterministic
        # Home screen — not wherever IG was last left (DMs inbox, story camera, a
        # half-finished share). This mirrors post_trial_reel (which is reliable
        # precisely because of this); without it post_feed inherited the DM inbox
        # / story-camera surface and stalled at "no thumbnail found in picker".
        try:
            _u = str(config.get("target_user") or config.get("user_id") or "").strip()
            if _u and _u != "0":
                await device.shell(f"am force-stop --user {_u} com.instagram.android")
            else:
                await device.close_app(IG_PKG)
        except Exception as e:
            print(f"[post_feed] pre-launch force-stop best-effort failed: {e}")
        await asyncio.sleep(0.6)

        # Launch Instagram and ensure we're on home
        await _LOG.progress(device, 5, "Launching Instagram")
        await device.launch_app(IG_PKG)
        # launch_app already sleeps 2s; add 1s more for IG cold-launch render.
        await asyncio.sleep(1)

        # ── Pre-flight: IG actually reaches foreground after am start.
        # A cold launch right after force-stop can take several seconds to
        # render; during that window the focused window is briefly
        # `mCurrentFocus=null` (non-empty but no package). The old single
        # check read that transient null as "failed to foreground" and bailed
        # before IG finished launching (verified live: focus null at +3s, IG
        # fully foreground moments later). Poll up to ~18s, and re-launch once
        # if it still hasn't surfaced, before giving up.
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
                print("[post_feed] IG not foreground after first launch — re-launching once")
                await device.launch_app(IG_PKG)
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
        print("[post_feed] IG foreground confirmed")

        # Dismiss popups
        await raise_if_instagram_verification(device, stage="post_feed_pre_popup")
        await _dismiss_ig_popups(device)

        # Checkpoint / rate-limit guard before we start tapping
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

        # Reach the create composer via Profile → Create New (+) → action-sheet
        # row, NOT the home "+". On this IG build the home "+" opens the
        # story-first camera (no POST tab) and tab-selection kept landing on
        # "Add to story" → "no thumbnail". The profile create-sheet route is
        # deterministic — the same path post_trial_reel + account_creation use —
        # picking a LABELLED row ("Create new post" / "Create new reel") instead
        # of guessing a camera-mode tab on a surface whose layout varies.
        enable_trial = bool(config.get("enable_trial") or config.get("trial_mode"))
        sheet_row = "Create new reel" if enable_trial else "Create new post"

        # 1) Profile tab
        prof = await device.find_element_by_content_desc("Profile")
        if prof:
            await device.click(prof)
        else:
            await device.tap(972, 2274)  # profile_tab fallback (from post_trial_reel)
        await asyncio.sleep(1.2)

        # Account-identity guard: verify the on-screen IG handle matches the
        # target before opening the composer. A mismatch means the wrong account
        # is foregrounded — abort immediately (posting to the wrong account is
        # irreversible). An unreadable identity must also stop before the composer.
        await device.refresh_screen(force=True)
        _guard_xml = device.page_source or ""
        if prepared_owner is not None:
            await raise_if_instagram_verification(device, stage="owner_document_account_guard", xml=_guard_xml)
            if _post_share_has_strong_dialog(_guard_xml):
                raise ExactContentSelectionError("Owner document account screen is obscured by a dialog")
        _guard_target = account_id.lstrip("@").strip().lower()
        # Skip the guard if the target looks like a UUID (caller passed only
        # account_id, no real handle) — comparing a UUID to a real IG handle
        # would always mismatch and FALSE-ABORT a legit post.
        if prepared_owner is None and len(_guard_target) == 36 and _guard_target.count("-") == 4:
            _guard_target = ""
        _guard_on_screen = _owner_document_profile_username(_guard_xml)
        if _guard_target and _guard_on_screen is not None:
            if _guard_on_screen != _guard_target:
                print(
                    f"[post_feed] ABORT wrong-account: on @{_guard_on_screen},"
                    f" expected @{_guard_target}"
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

        if prepared_owner is not None:
            publish_state["owner_document_share_attempted"] = True
            exact_selection = await share_prepared_owner_document(
                device, prepared_owner, verified_account=_guard_on_screen,
                on_dispatched=lambda selection: publish_state.update(owner_document_selection=selection),
            )
        else:
            await _handle_ig_media_permission_popup(device, "profile tab")

            # 2) Create New (+) — top-left; x<400 guard avoids the notifications icon
            createbtn = await device.find_element_by_content_desc("Create New") or \
                        await device.find_element_by_content_desc("New post")
            if createbtn and createbtn.center_x < 400:
                await device.click(createbtn)
            else:
                await device.tap(63, 201)  # create_new_btn fallback (verified)
            await asyncio.sleep(1.3)
            # NOTE: do NOT call _dismiss_ig_popups here. The create action sheet
            # exposes a content-desc="Dismiss" button — the popup-dismisser matches
            # it and CLOSES the sheet before we can pick our row, which dropped us to
            # the coord fallback and landed on the story camera ("Add to story" → no
            # thumbnail). This was THE image-post failure. post_trial_reel never had
            # this call between Create New and its row, which is why reels worked.

            # 3) Action sheet → tap our row, then VERIFY the IG picker actually
            # appeared. The row-find can come back empty under contention (the old
            # failure mode: "tapped=False markers=[Add to story]" -> a coord fallback
            # hit the wrong row -> story camera). So: retry the find-by-content-desc
            # several times with re-dumps + short sleeps BEFORE the coord fallback,
            # then confirm the picker surfaced (gallery_grid_item_thumbnail /
            # new_post_title / text="Recents"). If instead a story-camera surface is
            # detected, press back and retry the Profile->Create New->row sequence
            # once before failing with step="create_sheet".
            async def _tap_sheet_row() -> bool:
                tapped = False
                for attempt in range(6):
                    await device.refresh_screen(force=True)
                    row = await device.find_element_by_content_desc(sheet_row)
                    if row:
                        await device.click(row)
                        tapped = True
                        print(f"[post_feed] create-sheet row '{sheet_row}' tapped by content-desc (attempt {attempt + 1})")
                        break
                    await asyncio.sleep(0.6)
                if not tapped:
                    # Action-sheet coord fallback (ADB-verified bounds): "Create new
                    # reel" row center (540,1272), "Create new post" (540,1556). The
                    # old (540,860)/(540,988) were above the rows — they hit the scrim.
                    print(f"[post_feed] create-sheet row '{sheet_row}' not found by content-desc — coord fallback (540,{1272 if enable_trial else 1556})")
                    await device.tap(540, 1272 if enable_trial else 1556)
                await asyncio.sleep(1.5)
                await _handle_ig_media_permission_popup(device, "create new post")
                return tapped

            async def _picker_appeared() -> bool:
                """Poll a few fresh dumps for the IG picker. Returns True if the
                picker surfaced, False otherwise."""
                for _ in range(5):
                    await device.refresh_screen(force=True)
                    surf = device.page_source or ""
                    if (
                        "gallery_grid_item_thumbnail" in surf
                        or "new_post_title" in surf
                        or 'text="Recents"' in surf
                    ):
                        return True
                    await asyncio.sleep(0.8)
                return False

            async def _on_story_surface() -> bool:
                await device.refresh_screen(force=True)
                surf = device.page_source or ""
                return "Add to story" in surf and (
                    "gallery_grid_item_thumbnail" not in surf
                    and "new_post_title" not in surf
                )

            row_tapped = await _tap_sheet_row()
            if not await _picker_appeared():
                if await _on_story_surface():
                    # Wrong surface (story camera) — back out and redo the whole
                    # Profile -> Create New -> row sequence once.
                    print("[post_feed] create surface diverged to story camera — backing out and retrying Profile->Create New->row once")
                    await _LOG.log(device, "create_sheet diverged to story surface — retrying once")
                    await device.back()
                    await asyncio.sleep(1.0)
                    prof2 = await device.find_element_by_content_desc("Profile")
                    if prof2:
                        await device.click(prof2)
                    else:
                        await device.tap(972, 2274)
                    await asyncio.sleep(1.2)
                    await _handle_ig_media_permission_popup(device, "profile tab (retry)")
                    createbtn2 = await device.find_element_by_content_desc("Create New") or \
                                 await device.find_element_by_content_desc("New post")
                    if createbtn2 and createbtn2.center_x < 400:
                        await device.click(createbtn2)
                    else:
                        await device.tap(63, 201)
                    await asyncio.sleep(1.3)
                    row_tapped = await _tap_sheet_row()
                if not await _picker_appeared():
                    hint = await _screen_hint(device, "create-sheet picker missing")
                    await _LOG.error(
                        device,
                        f"IG picker never appeared after '{sheet_row}'; {hint}",
                    )
                    return {
                        "success": False,
                        "error": (
                            "Create-new-post picker never appeared — create sheet may "
                            "have opened the wrong surface (story camera)"
                        ),
                        "data": {
                            "step": "create_sheet",
                            "account_id": account_id,
                            "content_type": content_type,
                            "row": sheet_row,
                            "screen_hint": hint,
                        },
                    }

            # Diagnostic: confirm we reached the feed composer (New post / gallery),
            # not the story camera.
            await device.refresh_screen(force=True)
            _surf = device.page_source or ""
            _sm = ",".join(m for m in (
                "New post", "gallery_preview_button", "Recents", "Add to story", "Create new",
            ) if m in _surf) or "NONE"
            print(f"[post_feed] create surface (profile route): row='{sheet_row}' tapped={row_tapped} markers=[{_sm}]")

            # "Create new post" now opens DIRECTLY onto the gallery grid (Recents)
            # with the most-recent photo auto-selected and Next ready — there is no
            # Camera-first surface to switch away from. Only tap a Gallery button if
            # the grid is NOT already showing. The old unconditional path had no real
            # gallery_preview_button on this layout, fell through to a blind
            # tap(89,2255) that hit the Camera control, switched off the grid, and
            # produced the persistent "No thumbnail found" bail.
            await device.refresh_screen(force=True)
            _surf = device.page_source or ""
            _grid_showing = (
                "gallery_grid_item_thumbnail" in _surf
                or 'text="Recents"' in _surf
                or "Photo thumbnail" in _surf
            )
            if not _grid_showing:
                gallery_btn = await device.find_element_by_id(
                    "com.instagram.android:id/gallery_preview_button"
                ) or await device.find_element_by_content_desc("Gallery")
                if gallery_btn:
                    await device.click(gallery_btn)
                else:
                    await device.tap(89, 2255)  # last-resort (legacy Camera-first layout)
                await asyncio.sleep(0.6)
            else:
                print("[post_feed] gallery grid already showing — skipping Gallery-button tap")
            await _handle_ig_media_permission_popup(device, "gallery open")

            # Select first gallery item via resource ID. We descriptor-match
            # first; if NOTHING resembling a thumbnail is on screen we bail
            # instead of blind-tapping (136, 1629) which used to silently land
            # the run "succeeding" on an empty picker.
            #
            # The picker queries MediaStore async when it opens. A freshly
            # push_content'd item (especially via the browser_download bridge on a
            # secondary profile) can be indexed in MediaStore but not yet rendered
            # as a thumbnail when we first dump the screen. Retry the scan a few
            # times so the grid has time to populate before giving up — this used
            # to fail once with "no thumbnail" right after a successful push.
            if prepared_exact is not None:
                try:
                    exact_selection = await select_prepared_exact_content(
                        device,
                        prepared_exact,
                        require_selected_marker=True,
                    )
                except ExactContentSelectionError as error:
                    await _LOG.error(device, f"Exact gallery selection failed: {error}")
                    return {
                        "success": False,
                        "error": f"Exact gallery selection failed: {error}",
                        "data": {
                            "step": "exact_gallery_selection",
                            "account_id": account_id,
                            "content_type": content_type,
                        },
                    }

            gallery_item = exact_selection
            picker_xml = ""
            for attempt in range(5):
                if exact_selection is not None:
                    break
                gallery_item = await device.find_element_by_id(
                    "com.instagram.android:id/gallery_grid_item_thumbnail"
                )
                if not gallery_item:
                    gallery_item = await device.find_element_by_content_desc(
                        "Video thumbnail", partial=True
                    ) or await device.find_element_by_content_desc(
                        "Photo thumbnail", partial=True
                    )
                if gallery_item:
                    break
                picker_xml = device.page_source or ""
                if (
                    "gallery_grid_item_thumbnail" in picker_xml
                    or "thumbnail" in picker_xml.lower()
                ):
                    # A thumbnail node IS present but didn't resolve to an element
                    # yet — the descriptor-tap path below will handle it.
                    break
                _pxl = len(picker_xml)
                _markers = ",".join(
                    m for m in ("hierarchy", "Recents", "gallery_grid", "Photo thumbnail",
                                "gallery_preview_button", "New post", "Add to story")
                    if m in picker_xml
                ) or "NONE"
                print(
                    f"[post_feed] gallery picker empty (attempt {attempt + 1}/5) — "
                    f"xml_len={_pxl} markers=[{_markers}] — waiting for thumbnail grid"
                )
                await asyncio.sleep(2.0)

            if gallery_item:
                if exact_selection is None:
                    await device.click(gallery_item)
            else:
                picker_xml = await _refresh_xml(device)
                if (
                    "gallery_grid_item_thumbnail" not in picker_xml
                    and "thumbnail" not in picker_xml.lower()
                ):
                    hint = await _screen_hint(device, "empty picker")
                    await _LOG.error(
                        device, f"No gallery thumbnail found on picker after 5 attempts; {hint}"
                    )
                    return {
                        "success": False,
                        "error": (
                            "No thumbnail found in IG gallery picker — picker may "
                            "be empty or did not load"
                        ),
                        "data": {
                            "step": "select_thumbnail",
                            "account_id": account_id,
                            "content_type": content_type,
                            "screen_hint": hint,
                        },
                    }
                await device.tap(136, 1629)
            await asyncio.sleep(0.8)

            # === IMAGE-SPECIFIC: Handle crop + expand ===
            if content_type == "image":
                await device.refresh_screen(force=True)
                crop_view = device._find_in_xml(
                    "resource-id", "com.instagram.android:id/crop_image_view"
                )
                if crop_view:
                    # VERIFIED from old Appium: croptype_toggle_button at (79, 1275)
                    # Click to expand/uncrop the image (show full instead of square)
                    crop_toggle = await device.find_element_by_id(
                        "com.instagram.android:id/croptype_toggle_button"
                    )
                    if crop_toggle:
                        await device.click(crop_toggle)
                    else:
                        await device.tap(79, 1275)  # VERIFIED: Coords.GALLERY_CROP_TOGGLE
                    await asyncio.sleep(0.8)

            # --- Advance media-select (picker) -> edit -> [audio] -> share ---
            # CRITICAL: the EDIT screen (MediaCaptureActivity overlay) is NOT
            # dump-readable — a dump there returns the gallery PICKER layer behind it
            # (gallery_grid_item_thumbnail), so a dump CANNOT tell picker vs edit
            # apart. Dump-driven logic kept seeing "picker" on the edit screen and
            # tapping the picker Next forever, never advancing. So: drive the
            # live-verified FIXED coord sequence and confirm only on the SHARE screen
            # (which IS dump-readable: caption_input_text_view). Coords ADB-verified
            # 2026-05-29 on this IG build.

            # 0) Divergence guard: a stray blind tap during picker->edit/audio can
            # launch the system Gallery (com.android.gallery3d). If we're on it,
            # press back up to 2x to return to com.instagram.android instead of
            # blindly polling the share pixel for 300s. Fail with
            # step="diverged_system_gallery" if it can't recover.
            if await _on_system_gallery(device):
                print("[post_feed] diverged to system gallery (com.android.gallery3d) — backing out")
                await _LOG.log(device, "diverged to system gallery — attempting back-recovery")
                for _ in range(2):
                    await device.back()
                    await asyncio.sleep(1.0)
                    if not await _on_system_gallery(device):
                        break
                if await _on_system_gallery(device):
                    hint = await _screen_hint(device, "stuck on system gallery")
                    await _LOG.error(
                        device,
                        f"Flow diverged to system gallery and could not recover; {hint}",
                    )
                    return {
                        "success": False,
                        "error": (
                            "Flow diverged into the system gallery (com.android.gallery3d) "
                            "and could not return to Instagram"
                        ),
                        "data": {
                            "step": "diverged_system_gallery",
                            "account_id": account_id,
                            "content_type": content_type,
                            "screen_hint": hint,
                        },
                    }
                print("[post_feed] recovered from system gallery back to Instagram")

            # 1) picker -> edit  (picker Next is TOP-RIGHT)
            await _tap_next_button(device, fallback=(1000, 201))
            await asyncio.sleep(2.5)

            # 2) edit: add audio (default ON — a silent photo is low-engagement).
            # IG shows a suggested-audio pill at the top of the edit screen; tapping
            # its "+" attaches that track and opens the trim editor, then "Done"
            # confirms and returns to edit. Two blind coord taps (edit isn't
            # dump-readable), no fragile music-picker scroll. Per-account opt-out:
            # set enable_audio=False.
            if content_type == "image" and config.get("enable_audio", True) and config.get("add_music_to_images", True) is not False:
                await device.tap(765, 238)    # suggested-audio "+" (top pill) -> trim editor
                await asyncio.sleep(2.5)
                await device.tap(948, 2330)   # "Done" (bottom-right of trim editor) -> back to edit
                # Generous settle: the track attaches + the edit screen re-renders
                # (waveform/track row). Tapping the edit->share Next too soon here is
                # the main reason it didn't advance (leaving us on edit, where the
                # caption coord then typed onto the image).
                await asyncio.sleep(4.0)
                print("[post_feed] added suggested audio (+ -> Done)")

        # 3) edit -> share, CONFIRMED BY SCREENCAP PIXEL. The uiautomator dump
        # CANNOT tell edit from share — IG pre-loads the share fragment into the
        # view hierarchy, so both screens dump identical content (New post,
        # caption field, Share button all present even on edit). Verified live
        # 2026-05-29. The reliable signal is the full-width blue Share button at
        # (540,2279): blue == share, dark == still on edit. Tap the bottom-right
        # Next and poll the pixel until share is CONFIRMED; re-tap if it didn't
        # advance. We MUST NOT type the caption until share is confirmed — on the
        # edit screen the caption coord is the photo, so entry becomes a text
        # sticker burned onto the image (the 'IYKYK on photo' failure).
        # edit -> share uses the bottom-right Next at (940,2280). Instagram's
        # dump exposes the picker layer behind this screen, so the visible Next
        # has no trustworthy selector. The helper reclassifies overlays before
        # every coordinate retry and confirms the transition by the live Share
        # pixel instead of assuming a tap worked.
        on_share = (await _reach_share_screen(device, owner_document=True)
                    if prepared_owner is not None else await _reach_share_screen(device))
        if on_share:
            print("[post_feed] SHARE screen CONFIRMED (blue Share button @ 540,2279)")
        else:
            if prepared_owner is not None:
                publish_state["abandonment_eligible"] = True
            hint = await _screen_hint(device, "share screen not confirmed")
            await _LOG.error(
                device,
                f"Could not reach the share/caption screen (edit->share Next "
                f"never landed on share); {hint}",
            )
            return {
                "success": False,
                "error": "Could not reach the share/caption screen after edit->share Next",
                "data": {
                    "step": "edit_to_share",
                    "account_id": account_id,
                    "content_type": content_type,
                    "screen_hint": hint,
                },
            }

        # Enter caption — now SAFE, share is confirmed (the caption coord is the
        # real caption field here, not the photo). Types WITHOUT a dump between
        # tap and send_keys (a dump drops IME focus), hides the IME, then strictly
        # verifies the caption landed in the field.
        if caption:
            if not await _enter_caption(device, caption):
                if prepared_owner is not None:
                    publish_state["abandonment_eligible"] = True
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
                        "content_type": content_type,
                        "screen_hint": hint,
                    },
                    "caption": caption[:50],
                }

        # Optional: toggle the "Trial reel" switch before sharing. Enabled
        # either by `enable_trial: true` config or by routing through the
        # `post_trial_reel` module alias (which forces the flag).
        enable_trial = bool(config.get("enable_trial") or config.get("trial_mode"))
        if enable_trial and content_type == "reel":
            try:
                from lib.ws_modules_shared import _toggle_trial_reel
                toggled = await _toggle_trial_reel(device)
                print(f"[post_feed] enable_trial requested; toggle result={toggled}")
            except Exception as e:
                # Trial toggle is best-effort — never block Share on a missing toggle.
                print(f"[post_feed] trial toggle failed (continuing to Share): {e}")

        # Tap Share via resource ID. Bail if the button never resolves —
        # blind-tapping (540, 2279) used to mask a "share screen never
        # loaded" failure as "post sent".
        await _LOG.progress(device, 90, "Tapping Share")
        # The creation-overlay dump is non-deterministic and can omit the Share
        # node after the share screen itself was verified. Both the selector and
        # verified-coordinate paths cross the irreversible publish boundary.
        await _tap_share(device, publish_state)

        # Initial settle; the post-share verification below re-checks with a
        # further 3s wait if share_footer_button is still visible (slow upload).
        await asyncio.sleep(2.5)

        # Post-share blocker scan — rate-limit overlays usually surface here.
        post_xml = await _refresh_xml(device)
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
                    "content_type": content_type,
                    "manual_action_required": kind == "checkpoint",
                },
            }

        publish_confirmed, confirmation_reason = await _confirm_feed_publish(
            device,
            post_xml,
        )
        if not publish_confirmed:
            await _LOG.error(
                device,
                f"Share was attempted but publish could not be confirmed: {confirmation_reason}",
            )
            return {
                "success": False,
                "error": "Share was attempted, but Instagram did not reach a verified Home/Profile state",
                "data": {
                    "step": "post_share_verification",
                    "account_id": account_id,
                    "content_type": content_type,
                    "confirmation_reason": confirmation_reason,
                },
                "caption": caption[:50] + "..." if len(caption) > 50 else caption,
            }

        # Use only the exact Home control for the neutral resting state. Back can
        # exit Instagram from MainTabActivity when a transient dump omits nav.
        resting_state_home = confirmation_reason == "selected_home"
        try:
            if not resting_state_home:
                home = (
                    await device.find_element_by_id("com.instagram.android:id/feed_tab")
                    or await device.find_element_by_content_desc("Home")
                )
            else:
                home = None
            if home is not None:
                await device.click(home)
                await asyncio.sleep(1.0)
                await device.refresh_screen(force=True)
                resting_state_home = _selected_feed_destination(
                    device.page_source or ""
                ) == "selected_home"
            print(f"[post_feed] resting state Home verified={resting_state_home}")
        except Exception as e:
            print(f"[post_feed] Home resting-state verification failed: {e}")

        await _LOG.progress(device, 100, "Post complete")
        return _finalize_success(
            {
                "success": True,
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
        publish_state["abandonment_eligible"] = isinstance(e, ExactContentSelectionError) and e.__cause__ is None
        await _LOG.error(device, f"post_feed crashed: {type(e).__name__}: {e}")
        return {
            "success": False,
            "error": f"{type(e).__name__}: {e}",
            "data": {"step": "exception", "account_id": account_id, "content_type": content_type},
        }


def _owner_abandonment_surface(xml: str, account: str, *, allow_discard: bool):
    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError:
        return None
    nodes = list(root.iter())
    prefix = f"{IG_PKG}:id/"
    if any(node.get("package", "") not in ("", IG_PKG, "com.android.systemui") for node in nodes):
        return None
    inactive = {child for node in nodes if node.get("enabled") == "false" or node.get("visible-to-user") == "false"
                for child in node.iter()}

    def matching(name):
        return [node for node in nodes if node.get("resource-id") == prefix + name]

    def control(node, action):
        if node in inactive or node.get("clickable") != "true":
            return None
        if any(label and label != action for label in (node.get("text"), node.get("content-desc"))):
            return None
        bounds = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds", ""))
        if not bounds:
            return None
        left, top, right, bottom = map(int, bounds.groups())
        return ((left + right) // 2, (top + bottom) // 2) if right > left and bottom > top else None

    titles = matching("action_bar_title") + matching("action_bar_textview_title")
    if any(node in inactive or any(label and label.strip().lstrip("@").lower() not in (account, "new post")
           for label in (node.get("text"), node.get("content-desc"))) for node in titles):
        return None
    foreign = [node for node in nodes if node.get("resource-id", "").startswith(tuple(prefix + name for name in (
        "clips_", "reel_", "story_", "gallery_grid", "gallery_picker", "gallery_recycler_view",
        "dialog_container", "modal_container", "igds_alert_dialog", "igds_headline", "bottom_sheet", "share_sheet",
    ))) and node.get("resource-id") != prefix + "bottom_sheet_camera_container"
        and not (node.get("resource-id") == prefix + "clips_tab"
                 and not any(child.get("selected") == "true" for child in node.iter()))]
    if foreign:
        dialogs = matching("igds_alert_dialog")
        if not allow_discard or len(dialogs) != 1 or any(node not in list(dialogs[0].iter()) for node in foreign):
            return None
        labels = [node for node in dialogs[0].iter() if node not in inactive]
        if sum(node.get("text") == "Discard post?" for node in labels) != 1:
            return None
        discard = [node for node in nodes if "Discard" in (node.get("text"), node.get("content-desc"))]
        if len(discard) != 1 or discard[0] not in labels or discard[0].get("class") != "android.widget.Button":
            return None
        point = control(discard[0], "Discard")
        return ("discard", point) if point else None

    editor_names = ("quick_edit_fragment", "quick_edit_compose_view", "feed_post_capture_controls_container",
                    "gallery_media_thumbnail_tray", "media_thumbnail_tray_constraintlayout")
    composer_names = ("caption_input_text_view", "share_footer_button", "media_preview_recycler_view")
    if _owner_document_profile_username(xml) == account:
        if any(matching(name) for name in editor_names + composer_names):
            return None
        if any(node in inactive for node in nodes if node.get("selected") == "true"
               or "Edit profile" in (node.get("text"), node.get("content-desc"))):
            return None
        return ("profile", None)

    try:
        owner_document_editor_next(xml)
        editor = True
    except ExactContentSelectionError:
        editor = False
    if not editor:
        if any(matching(name) for name in editor_names):
            return None
        captions, shares, previews, photos = (matching(name) for name in (
            "caption_input_text_view", "share_footer_button", "media_preview_recycler_view", "photo_media_preview_image_view"))
        if not (len(titles) == len(captions) == len(shares) == len(previews) == len(photos) == 1
                and titles[0].get("text") == "New post"
                and captions[0].get("class") == "android.widget.AutoCompleteTextView"
                and captions[0].get("clickable") == "true"
                and shares[0].get("class") == "android.widget.Button"
                and shares[0].get("content-desc") == "Share" and shares[0].get("clickable") == "true"
                and previews[0].get("class") == "androidx.recyclerview.widget.RecyclerView"
                and previews[0].get("content-desc") == "Photo thumbnail" and len(previews[0]) == 1
                and photos[0].get("class") == "android.widget.ImageView" and photos[0] in list(previews[0].iter())
                and [node for node in previews[0].iter() if node.get("class") in (
                    "android.widget.ImageView", "android.widget.VideoView", "android.view.TextureView", "android.view.SurfaceView",
                )] == photos
                and not any(node in inactive for node in captions + shares + previews + photos)):
            return None
    backs = matching("button_back")
    if len(backs) != 1 or backs[0].get("content-desc") != "Back" or backs[0].get("class") != "android.widget.ImageView":
        return None
    point = control(backs[0], "Back")
    return ("back", point) if point else None


async def _abandon_owner_document(device, selection):
    if not isinstance(selection, VerifiedOwnerDocumentSelection):
        return None
    manifest = selection.prepared.manifest
    if device.device_id != manifest.device_id:
        return None
    try:
        async with asyncio.timeout(15):
            for step in range(4):
                if getattr(device.device, "aborted", False) is True or await _strict_active_user(device) != manifest.phone_profile:
                    return None
                xml = await _refresh_xml(device)
                if await _check_blocker(device, xml):
                    return None
                surface = _owner_abandonment_surface(xml, manifest.account_username, allow_discard=step > 0)
                if surface is None:
                    return None
                kind, point = surface
                if await _strict_active_user(device) != manifest.phone_profile or getattr(device.device, "aborted", False) is True:
                    return None
                if kind == "profile":
                    if step == 0:
                        return None
                    return {
                        **{key: getattr(manifest, key) for key in (
                            "transfer_id", "remote_filename", "sha256", "method", "source_profile", "phone_profile",
                            "download_id", "document_uri", "device_id", "account_username", "size_bytes",
                        )},
                        "reservation_id": selection.reservation_id, "dispatch_id": selection.dispatch_id,
                        "publish_attempted": False, "editor_closed": True,
                        "abandonment_verified": "observed_editor_to_own_profile",
                    }
                if step == 3:
                    return None
                await device.tap(*point)
                await asyncio.sleep(0.5)
    except Exception:
        return None
    return None


def _finalize_publish_outcome(
    result: dict,
    *,
    publish_attempted: bool,
    owner_document_share_attempted: bool = False,
) -> dict:
    if result.get("success") is not False:
        return result
    return {
        **result,
        "data": {
            **(result.get("data") or {}),
            "publish_attempted": publish_attempted,
            "safe_to_retry": not publish_attempted and not owner_document_share_attempted,
            **({"owner_document_editor_closed": False} if owner_document_share_attempted else {}),
        },
    }


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    publish_state = {"attempted": False}
    result = await _run(device, config, publish_state)
    result = _finalize_publish_outcome(
        result,
        publish_attempted=publish_state["attempted"],
        owner_document_share_attempted=publish_state.get("owner_document_share_attempted", False),
    )
    if (result.get("success") is False and publish_state["attempted"] is False
            and publish_state.get("abandonment_eligible") is True):
        proof = await _abandon_owner_document(device, publish_state.get("owner_document_selection"))
        if proof is not None:
            result["data"]["owner_document_abandonment"] = proof
            result["data"]["owner_document_editor_closed"] = True
    return result
