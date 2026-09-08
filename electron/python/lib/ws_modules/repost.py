# Module: repost
# Reposts content to Instagram feed from the device gallery.
import asyncio
import random
import re
from threading import Lock
from lib.ws_modules_shared import (
    WSDeviceAdapter,
    _dismiss_ig_popups,
    _handle_ig_media_permission_popup,
    _navigate_to_ig_tab,
    _tap_create_button,
    normalized_text_equal,
)
from lib.persistent_log import ModuleLogger


_LOG = ModuleLogger("repost")
IG_PKG = "com.instagram.android"


# Checkpoint + rate-limit markers — keep in sync with the other post modules.
# Apostrophes get normalised before matching so smart-quotes don't slip past.
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
REPOST_SOURCE_KEYS = ("source_username", "source_user", "source_url")
REPOST_SOURCE_LIST_KEY = "source_accounts"
REPOST_ROTATION_KEY_FIELDS = (
    "repost_cascade_key",
    "cascade_key",
    "campaign_id",
    "schedule_id",
    "workflow_id",
)

# Intentionally process-local. Durable run identity/cursors belong to the
# schedule persistence layer; this only preserves round-robin order while a
# brain process is serving the active campaign.
_REPOST_ROTATION_LOCK = Lock()
_REPOST_ROTATION_CURSORS = {}


def _normalize_repost_source(value) -> str:
    source = str(value or "").strip()
    return source[1:] if source.startswith("@") else source


def _repost_rotation_key(
    config: dict,
    sources: list,
    tenant_id=None,
    device_id=None,
    profile_id=None,
):
    campaign = next(
        (
            str(config.get(field) or "").strip()
            for field in REPOST_ROTATION_KEY_FIELDS
            if str(config.get(field) or "").strip()
        ),
        "",
    )
    destination = str(
        config.get("account_id")
        or config.get("account_username")
        or config.get("username")
        or ""
    ).strip()
    if not destination:
        destination = f"{str(device_id or '').strip()}:{str(profile_id or '').strip()}"
    return (
        str(tenant_id or "anonymous").strip() or "anonymous",
        campaign or "default-campaign",
        destination or "default-destination",
        tuple(source.casefold() for source in sources),
    )


def _select_repost_source(rotation_key, sources: list) -> str:
    with _REPOST_ROTATION_LOCK:
        index = _REPOST_ROTATION_CURSORS.get(rotation_key, 0)
        _REPOST_ROTATION_CURSORS[rotation_key] = (index + 1) % len(sources)
    return sources[index % len(sources)]


def reset_repost_rotation_state(rotation_key=None):
    """Reset one in-memory cursor, or all cursors for focused test isolation."""
    with _REPOST_ROTATION_LOCK:
        if rotation_key is None:
            _REPOST_ROTATION_CURSORS.clear()
        else:
            _REPOST_ROTATION_CURSORS.pop(rotation_key, None)


def normalize_repost_config(
    config: dict,
    *,
    tenant_id=None,
    device_id=None,
    profile_id=None,
) -> dict:
    if not isinstance(config, dict):
        raise ValueError("Repost config must be an object")

    sources = []
    seen = set()

    def add_source(value):
        source = _normalize_repost_source(value)
        key = source.casefold()
        if source and key not in seen:
            sources.append(source)
            seen.add(key)

    explicit_source = ""
    for key in REPOST_SOURCE_KEYS:
        if config.get(key):
            explicit_source = _normalize_repost_source(config[key])
            add_source(explicit_source)
            break

    raw_sources = config.get(REPOST_SOURCE_LIST_KEY, [])
    if isinstance(raw_sources, str):
        raw_sources = re.split(r"[\s,;]+", raw_sources)
    elif not isinstance(raw_sources, (list, tuple)):
        raise ValueError("Repost source_accounts must be a list of usernames")
    for source in raw_sources:
        add_source(source)

    if not sources:
        raise ValueError("Repost requires non-empty source_username")

    if explicit_source:
        selected_source = explicit_source
    else:
        rotation_key = _repost_rotation_key(
            config,
            sources,
            tenant_id=tenant_id,
            device_id=device_id,
            profile_id=profile_id,
        )
        selected_source = _select_repost_source(rotation_key, sources)

    normalized = dict(config)
    normalized["source_username"] = selected_source
    normalized[REPOST_SOURCE_LIST_KEY] = sources
    return normalized


def _normalize(text: str) -> str:
    return (text or "").lower().replace("’", "'").replace("‘", "'")


async def _refresh(device: WSDeviceAdapter) -> str:
    await device.refresh_screen(force=True)
    return device.page_source or ""


async def _is_ig_installed(device: WSDeviceAdapter) -> bool:
    out = await device.shell(f"pm list packages {IG_PKG}") or ""
    return IG_PKG in out


async def _ig_is_foreground(device: WSDeviceAdapter) -> bool:
    """Best-effort foreground check. Treat shell failures as 'unknown' (True)
    rather than failing the run on a quirky GrapheneOS dumpsys output."""
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
    the pushed media lives in (and is indexed under) that user's MediaStore,
    so an unscoped query finds nothing. Returns '0' on failure."""
    try:
        out = await device.shell("am get-current-user") or ""
        uid = out.strip()
        return uid if uid.isdigit() else "0"
    except Exception:
        return "0"


async def _mediastore_has_items(device: WSDeviceAdapter, user_id: str = "0") -> bool:
    """Verify the gallery actually has at least one image or video on the
    active Android user. Without this, repost lands on an empty picker and
    the fallback tap (136, 1629) hits empty space — silent failure.

    Must be scoped to the IG user with `content query --user N` — a
    browser_download push lands media in a secondary profile's MediaStore,
    invisible to an unscoped (user 0) query."""
    try:
        user_flag = f"--user {user_id} " if user_id and user_id != "0" else ""
        out = await device.shell(
            f"content query {user_flag}--uri content://media/external/images/media --projection _id 2>/dev/null | head -2"
        ) or ""
        if "Row:" in out or "_id=" in out:
            return True
        out2 = await device.shell(
            f"content query {user_flag}--uri content://media/external/video/media --projection _id 2>/dev/null | head -2"
        ) or ""
        return "Row:" in out2 or "_id=" in out2
    except Exception:
        # If the content provider isn't queryable, don't block the run.
        return True


async def _screen_hint(device: WSDeviceAdapter, label: str) -> str:
    """Tiny dumpsys snippet to embed in error responses so the user can see
    WHAT was on screen when the module bailed."""
    try:
        out = await device.shell(
            "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -2"
        ) or ""
        return f"{label}: {out.strip()[:200]}"
    except Exception:
        return label


async def _check_blocker(device: WSDeviceAdapter, xml: str | None = None):
    """Return ('checkpoint'|'rate_limited', message) or None."""
    if xml is None:
        xml = await _refresh(device)
    norm = _normalize(xml)
    for phrase in _CHECKPOINT_PHRASES:
        if phrase in norm:
            return ("checkpoint", "Instagram checkpoint: 'Confirm you're human'")
    for phrase in _RATE_LIMIT_PHRASES:
        if phrase in norm:
            return ("rate_limited", f"Instagram rate-limit overlay: '{phrase}'")
    return None


async def _confirm_clips_nux_sheet(device: WSDeviceAdapter, max_tries: int = 3) -> bool:
    """Handle the intermittent "About Reels" bottom-sheet (the Clips NUX) IG can
    surface after Share. Its confirm button is `clips_nux_sheet_share_button`
    (content-desc "Share") and tapping it is what ACTUALLY publishes. Resource-id
    first, then content-desc, then a paranoid fixed-coord fallback. No-op if the
    sheet isn't shown. Ported from post_trial_reel._confirm_clips_nux_sheet
    (validated live 2026-05-29): without it the post sticks on the sheet and the
    run falsely reports success."""
    tapped = False
    for _ in range(max_tries):
        xml = await _refresh(device)
        if "clips_nux_sheet_share_button" not in xml and "About Reels" not in xml:
            break
        btn = await device.find_element_by_id(
            "com.instagram.android:id/clips_nux_sheet_share_button"
        ) or await device.find_element_by_content_desc("Share")
        if btn:
            await device.click(btn)
            print("[repost] About Reels NUX sheet — tapped Share")
        else:
            await device.tap(540, 2110)  # verified NUX-sheet Share center
            print("[repost] About Reels NUX sheet — Share via fixed coord (540,2110)")
        tapped = True
        await asyncio.sleep(2.5)
    return tapped


async def _dismiss_share_interstitials(device: WSDeviceAdapter, context: str = "") -> bool:
    """Dismiss the optional sheets IG can stack between the second Next and the
    caption screen, and again right after Share: cross-post ("Share to
    Facebook?"), "Add to your story", and generic "Got it"/"Not now" nags. None
    are required for a feed post, so we decline/dismiss them by resource-id ->
    content-desc -> text and KEEP going. Best-effort: returns True if anything
    was dismissed. Decline-style buttons (Not now/Skip/Cancel) are preferred so
    we never opt INTO a cross-post we weren't asked for."""
    ctx = f" ({context})" if context else ""
    dismissed = False
    for _ in range(3):
        xml = await _refresh(device)
        low = xml.lower()
        has_sheet = (
            "share to facebook" in low
            or "add to your story" in low
            or "also share to" in low
            or "share to other apps" in low
        )
        # Prefer the explicit decline action by id, then a decline label, then a
        # neutral acknowledge label. Only act if a known sheet/nag is present so
        # we don't blind-dismiss the real share screen.
        btn = (
            await device.find_element_by_id(
                "com.instagram.android:id/igds_alert_dialog_secondary_button"
            )
            or await device.find_element_by_id(
                "com.instagram.android:id/igds_headline_secondary_action_button"
            )
            or await device.find_element_by_text("Not now")
            or await device.find_element_by_text("Not Now")
            or await device.find_element_by_text("Skip")
        )
        if not (has_sheet and btn):
            # Fall back to the shared dismisser for plain "Got it"/"OK" nags
            # (notification / cross-post-info), but only when a recognised nag
            # marker is present so we don't tap through the live share screen.
            if "got it" in low or "turn on notifications" in low:
                await _dismiss_ig_popups(device, max_attempts=1)
                dismissed = True
                continue
            break
        await device.click(btn)
        print(f"[repost] dismissed share interstitial{ctx}")
        dismissed = True
        await asyncio.sleep(1.0)
    return dismissed


async def _caption_field_text(device: WSDeviceAdapter) -> str:
    """Read the current text of the caption AutoCompleteTextView so we can
    verify the caption actually landed. Returns '' if the field isn't found
    or is still showing its placeholder hint."""
    xml = await _refresh(device)
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
    # The empty field renders its placeholder hint as the node's text. Reel =
    # "Write a caption…", image/feed = "Add a caption…" — treat both as empty.
    if val.lower().rstrip(" .…") in ("write a caption", "add a caption"):
        return ""
    return val


async def _enter_caption(device: WSDeviceAdapter, caption: str) -> bool:
    """Type the caption into the share-screen caption field and verify it
    landed. Ported from post_feed._enter_caption (validated live).

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
        print("[repost] no caption provided — skipping caption step")
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
        xml = await _refresh(device)
        m = re.search(_CAP_BOUNDS_RE, xml) or re.search(_CAP_BOUNDS_RE_ALT, xml)
        if not m:
            print(f"[repost] caption field not on screen (attempt {attempt + 1})")
            await asyncio.sleep(1.0)
            continue

        cx = (int(m.group(1)) + int(m.group(3))) // 2
        cy = (int(m.group(2)) + int(m.group(4))) // 2

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

        # NOW it's safe to dump + verify (we've finished typing). Confirm the
        # FULL caption landed — not empty, not a stray single char ("a").
        landed = await _caption_field_text(device)
        if landed and normalized_text_equal(caption, landed):
            print(
                "[repost] caption confirmed in field: "
                f"[REDACTED length={len(landed)}]"
            )
            return True
        print(
            f"[repost] caption did not land (attempt {attempt + 1}) — "
            f"got [REDACTED length={len(landed)}], expected length={len(caption)} — retrying"
        )
        # Clear any bad partial before retrying so we don't append. Only clear
        # when the field actually holds text — clear() on an empty field is
        # both pointless and historically risky.
        if landed:
            try:
                await device.tap(cx, cy)
                await asyncio.sleep(0.6)
                await device.clear()
                await asyncio.sleep(0.3)
            except Exception:
                pass

    print("[repost] caption never landed in caption field")
    return False


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Repost content to Instagram via WebSocket.

    Assumes the content has already been pushed to the device gallery (the
    upstream `push_content` module is responsible for that). If the gallery
    is empty we bail with a `no_media_in_gallery` error instead of tapping
    blindly and silently succeeding on an empty picker.
    """
    try:
        config = normalize_repost_config(config)
    except ValueError as error:
        return {"success": False, "error": str(error)}

    try:
        source_username = config["source_username"]
        caption = (config.get("caption") or "").strip()
        account_id = (
            config.get("account_username") or config.get("account_id") or ""
        )

        await _LOG.log(
            device,
            f"Repost START account={account_id!r} source={source_username!r} "
            f"caption_len={len(caption)}",
        )

        # ── Pre-flight 1: Instagram installed
        if not await _is_ig_installed(device):
            await _LOG.error(device, "Instagram is not installed on this profile")
            return {
                "success": False,
                "error": "Instagram is not installed on the active profile",
                "data": {"step": "preflight_pm_list", "account_id": account_id},
            }

        # ── Pre-flight 2: gallery has at least one item
        # Scope the MediaStore query to the IG user — a browser_download
        # push (secondary GrapheneOS profile) indexes media under that
        # user's MediaStore, which an unscoped (user 0) query cannot see.
        ig_user = str(
            config.get("target_user") or config.get("user_id") or ""
        ).strip()
        if not ig_user or not ig_user.isdigit():
            ig_user = await _active_user(device)
        if not await _mediastore_has_items(device, user_id=ig_user):
            await _LOG.error(
                device,
                "No media in MediaStore — push_content must run before repost",
            )
            return {
                "success": False,
                "error": (
                    "No media in device gallery — run push_content (or "
                    "ensure source_url downloaded successfully) before repost"
                ),
                "data": {
                    "step": "preflight_mediastore",
                    "account_id": account_id,
                    "source_username": source_username,
                },
            }

        # Launch Instagram
        await _LOG.progress(device, 5, "Launching Instagram")
        await device.launch_app(IG_PKG)
        await asyncio.sleep(3)

        # ── Pre-flight 3: verify IG actually came to the foreground. If
        # something else (permissions dialog, system overlay) grabbed focus
        # we'd silently fail on the very next tap.
        if not await _ig_is_foreground(device):
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

        await _dismiss_ig_popups(device)

        # Checkpoint guard before we start tapping.
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

        # Navigate home + tap create
        await _navigate_to_ig_tab(device, "home")
        await asyncio.sleep(1)
        await _tap_create_button(device)
        await asyncio.sleep(2)
        await _handle_ig_media_permission_popup(device, "repost creator entry")

        # ── Select first gallery item — but verify it actually got picked.
        # The picker queries MediaStore async when it opens. A freshly
        # push_content'd item (especially via the browser_download bridge on a
        # secondary profile) can be indexed in MediaStore but not yet rendered
        # as a thumbnail when we first dump the screen. Retry the scan a few
        # times so the grid has time to populate before giving up — this used
        # to fail once with "no thumbnail" right after a successful push.
        await _LOG.progress(device, 30, "Selecting first gallery item")
        gallery_item = None
        picker_xml = ""
        for attempt in range(5):
            # RESOURCE-ID first, then content-desc. The live picker labels its
            # cells "Unselected Video thumbnail …" / "Unselected Photo thumbnail …"
            # (validated in post_trial_reel._select_first_video); keep the older
            # bare "Video/Photo thumbnail" descriptors as a fallback for builds
            # that don't carry the "Unselected " prefix.
            gallery_item = await device.find_element_by_id(
                "com.instagram.android:id/gallery_grid_item_thumbnail"
            )
            if not gallery_item:
                gallery_item = (
                    await device.find_element_by_content_desc(
                        "Unselected Video thumbnail", partial=True
                    )
                    or await device.find_element_by_content_desc(
                        "Unselected Photo thumbnail", partial=True
                    )
                    or await device.find_element_by_content_desc(
                        "Video thumbnail", partial=True
                    )
                    or await device.find_element_by_content_desc(
                        "Photo thumbnail", partial=True
                    )
                )
            if gallery_item:
                break
            picker_xml = device.page_source or ""
            if (
                "gallery_grid_item_thumbnail" in picker_xml
                or "thumbnail" in picker_xml.lower()
            ):
                # A thumbnail node IS present but didn't resolve to an element
                # yet — fall through to the loud-fail check below.
                break
            print(
                f"[repost] gallery picker empty (attempt {attempt + 1}/5) — "
                "waiting for thumbnail grid to populate"
            )
            await asyncio.sleep(2.0)

        if gallery_item:
            await device.click(gallery_item)
        else:
            # No thumbnail descriptor on screen after 5 attempts — picker is
            # empty or we haven't actually landed on it. Fail loudly rather
            # than tapping coords blindly.
            hint = await _screen_hint(device, "gallery picker")
            await _LOG.error(
                device, f"No gallery thumbnail visible after 5 attempts; {hint}"
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
                    "screen_hint": hint,
                },
            }
        await asyncio.sleep(1.5)

        # First Next — RESOURCE-ID -> content-desc -> text -> coord (last resort).
        await _LOG.progress(device, 45, "Tapping first Next (picker -> editor)")
        next_btn = (
            await device.find_element_by_id(
                "com.instagram.android:id/next_button_textview"
            )
            or await device.find_element_by_content_desc("Next")
            or await device.find_element_by_text("Next")
        )
        if next_btn:
            await device.click(next_btn)
        else:
            # No Next descriptor resolved. Before blind-tapping the top-right
            # coord, confirm we're actually still on the picker (a thumbnail grid
            # is present) — otherwise (1000,201) could land on an unknown screen.
            verify_xml = await _refresh(device)
            if "gallery_grid_item_thumbnail" not in verify_xml and "thumbnail" not in verify_xml.lower():
                hint = await _screen_hint(device, "first Next: not on picker")
                await _LOG.error(
                    device,
                    f"First Next descriptor missing and not on picker; {hint}",
                )
                return {
                    "success": False,
                    "error": "First Next button not found and gallery picker no longer visible",
                    "data": {
                        "step": "first_next_lost",
                        "account_id": account_id,
                        "screen_hint": hint,
                    },
                }
            await device.tap(1000, 201)  # top-right Next — paranoid last resort
        await asyncio.sleep(2)

        xml = await _refresh(device)
        if 'gallery_grid_item_thumbnail' in xml:
            # Still on picker — selection or Next didn't take.
            hint = await _screen_hint(device, "stuck on picker")
            await _LOG.error(device, f"Did not advance past gallery picker; {hint}")
            return {
                "success": False,
                "error": "Did not advance past gallery picker after Next",
                "data": {
                    "step": "first_next",
                    "account_id": account_id,
                    "screen_hint": hint,
                },
            }

        # Second Next — filters/edit -> caption screen.
        # RESOURCE-ID -> content-desc -> text -> coord (last resort).
        await _LOG.progress(device, 60, "Tapping second Next (editor -> share)")
        # Verify we're on the editor before tapping its Next. The editor exposes
        # the Next button id; if neither it nor the preloaded share fragment
        # ("New post"/caption field) is on screen we never advanced past the
        # picker, so don't blind-tap the editor's bottom-right Next coord.
        editor_xml = await _refresh(device)
        next_btn2 = (
            await device.find_element_by_id(
                "com.instagram.android:id/next_button_textview"
            )
            or await device.find_element_by_content_desc("Next")
            or await device.find_element_by_text("Next")
        )
        if next_btn2:
            await device.click(next_btn2)
        elif (
            "next_button_textview" in editor_xml
            or "New post" in editor_xml
            or "caption_input_text_view" in editor_xml
        ):
            # Editor confirmed present but the descriptor didn't resolve under
            # dump contention — bottom-right Next coord as paranoid last resort.
            await device.tap(961, 2280)
        else:
            hint = await _screen_hint(device, "second Next: not on editor")
            await _LOG.error(
                device,
                f"Second Next descriptor missing and editor not detected; {hint}",
            )
            return {
                "success": False,
                "error": "Second Next button not found and photo editor not visible",
                "data": {
                    "step": "second_next_lost",
                    "account_id": account_id,
                    "screen_hint": hint,
                },
            }
        await asyncio.sleep(2)

        # Permission popups + interstitial sheets + checkpoint sweep between the
        # second Next and the caption screen. IG can stack a cross-post sheet
        # ("Share to Facebook?"), an "Add to your story" prompt, or a notification
        # nag here — none required for a feed post; decline/dismiss them so the
        # caption field is reachable. (Audit gap: 2nd-Next -> caption.)
        await _handle_ig_media_permission_popup(device, "repost editor->share")
        await _dismiss_share_interstitials(device, "editor->share")
        blocker = await _check_blocker(device)
        if blocker:
            kind, msg = blocker
            await _LOG.error(device, msg)
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

        # Caption (best-effort — empty caption is allowed). Route through the
        # validated no-dump-before-type helper: it taps the field by its fresh
        # bounds, types WITHOUT a dump in between (a dump collapses the IME and
        # drops the typed text — the intermittent "caption did not land" bug),
        # hides the IME with KEYCODE_ESCAPE, then verifies the full caption.
        if caption:
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

        # Share — RESOURCE-ID -> content-desc -> text (NO blind coord here: if no
        # Share descriptor resolves we never reached the share sheet, and the old
        # blind tap on (540,2279) was the silent failure). The IMAGE/feed share id
        # is `share_footer_button`; a VIDEO repost lands on the REEL surface whose
        # primary-action id is `share_button` (often LABELLED "Next" and leading to
        # an "About Reels" NUX sheet that actually publishes) — try both ids so a
        # reposted video doesn't miss its share button.
        await _LOG.progress(device, 90, "Tapping Share")
        share_btn = (
            await device.find_element_by_id(
                "com.instagram.android:id/share_footer_button"
            )
            or await device.find_element_by_id(
                "com.instagram.android:id/share_button"
            )
            or await device.find_element_by_content_desc("Share")
            or await device.find_element_by_text("Share")
            or await device.find_element_by_content_desc("Next")
            or await device.find_element_by_text("Next")
        )
        if not share_btn:
            hint = await _screen_hint(device, "no share button")
            await _LOG.error(device, f"Share button not found; {hint}")
            return {
                "success": False,
                "error": "Share button never appeared on the share screen",
                "data": {
                    "step": "share_button_missing",
                    "account_id": account_id,
                    "screen_hint": hint,
                },
            }
        await device.click(share_btn)
        await asyncio.sleep(2.0)
        # A video repost's "Next"/Share can surface the "About Reels" NUX sheet —
        # tapping its Share is the real publish. No-op for an image post.
        await _confirm_clips_nux_sheet(device)
        # Some builds stack a cross-post / "Add to your story" sheet right after
        # Share — dismiss so they don't masquerade as "still composing".
        await _dismiss_share_interstitials(device, "post-share")
        await asyncio.sleep(3)

        # Post-condition: confirm the post actually LEFT the compose + no
        # rate-limit overlay. Check BOTH the image share id (share_footer_button)
        # AND the reel surface markers (share_button / clips NUX / "New reel") —
        # checking only share_footer_button false-passed a stuck video repost.
        post_xml = await _refresh(device)
        blocker = await _check_blocker(device, post_xml)
        if blocker:
            kind, msg = blocker
            await _LOG.error(device, f"Post-share blocker detected: {msg}")
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

        # Confirm we LEFT the compose via a POSITIVE home signal. Compose dump
        # markers (share_footer_button / share_button / "New post" / "New reel" /
        # the NUX sheet) LINGER and go stale after posting, so checking their
        # absence false-fails a successful repost — especially an IMAGE repost,
        # where "New post" persists on the post-publish surface. The bottom tab
        # bar reappears only once the post is actually shared.
        await _confirm_clips_nux_sheet(device)
        def _on_home(x: str) -> bool:
            # Check for home tab with selected="true" (indicates truly active home)
            return bool(
                re.search(r'resource-id="com\.instagram\.android:id/feed_tab"[^>]*selected="true"', x)
                or re.search(r'content-desc="Home"[^>]*selected="true"', x)
            )
        posted = False
        for _ in range(6):
            post_xml = await _refresh(device)
            # If NUX sheet reappeared, retry dismissal
            if "clips_nux_sheet_share_button" in post_xml or "About Reels" in post_xml:
                print("[repost] NUX sheet reappeared during home polling — retrying dismiss")
                await _confirm_clips_nux_sheet(device)
                await asyncio.sleep(1.0)
                continue
            if _on_home(post_xml):
                posted = True
                break
            await asyncio.sleep(1.5)
        if not posted:
            await _LOG.error(
                device,
                "Home feed not reached after Share — repost may not have published",
            )
            return {
                "success": False,
                "error": (
                    "Share did not complete (home feed not reached after "
                    "Share/About-Reels; possible block or network issue)"
                ),
                "data": {
                    "step": "post_share_verification",
                    "account_id": account_id,
                },
            }

        # Don't leave the phone parked on a looping reels/feed surface — an
        # idle profile autoplaying an endless feed reads as non-human to IG
        # anti-fraud. Navigate to the Home feed as a neutral resting screen.
        # Best-effort: never fail an otherwise-successful repost over this.
        try:
            await asyncio.sleep(1.5)
            await device.refresh_screen(force=True)
            home = await device.find_element_by_content_desc("Home")
            if home:
                await device.click(home)
                await asyncio.sleep(1.0)
            else:
                await device.back()
                await asyncio.sleep(0.8)
            print("[repost] navigated to Home feed")
        except Exception as e:
            print(f"[repost] navigate-away best-effort failed: {e}")

        await _LOG.progress(device, 100, "Repost complete")
        return {
            "success": True,
            "caption": caption[:50] + "..." if len(caption) > 50 else caption,
            "source": source_username,
        }

    except Exception as e:
        await _LOG.error(device, f"Repost crashed: {type(e).__name__}: {e}")
        return {
            "success": False,
            "error": f"{type(e).__name__}: {e}",
            "data": {"step": "exception", "account_id": config.get("account_username", "")},
        }
