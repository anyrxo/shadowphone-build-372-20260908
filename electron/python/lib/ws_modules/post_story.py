# Module: post_story
# Posts to Instagram story with optional link sticker or mention sticker.
import asyncio
import random
import re
from xml.etree import ElementTree as ET
from lib.ws_modules_shared import (
    Element as UIElement,
    WSDeviceAdapter,
    _dismiss_ig_popups,
    _navigate_to_ig_tab,
    _handle_ig_media_permission_popup,
    _tap_create_button,
    InstagramVerificationRequired,
    raise_if_instagram_verification,
)
from lib.persistent_log import ModuleLogger
from lib.posting_progression_guards import (
    verified_profile_username,
    ExactContentSelectionError,
    prepare_exact_content_selection,
    select_prepared_exact_content,
    with_exact_content_selection_proof,
)


_LOG = ModuleLogger("post_story")
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
    (("share to facebook", "also share to facebook"), ("Not Now", "Not now")),
    (("turn on notifications", "enable notifications"), ("Not Now", "Not now")),
    (("save your login info", "save login info"), ("Not Now", "Not now")),
)
_STORY_SHARE_ROW_ID = "com.instagram.android:id/share_sheet_row_your_story"
_STORY_DIRECT_SHARE_ID = "com.instagram.android:id/your_story_share_shortcut_button"
_STORY_SHARE_CONTAINER_IDS = frozenset(
    {
        "com.instagram.android:id/share_sheet_table",
        "com.instagram.android:id/reel_share_to_options",
    }
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
    """Must be scoped to the IG user with `content query --user N` — a
    browser_download push lands media in a secondary profile's MediaStore,
    invisible to an unscoped (user 0) query."""
    try:
        user_flag = f"--user {user_id} " if user_id and user_id != "0" else ""
        for uri in (
            "content://media/external/images/media",
            "content://media/external/video/media",
        ):
            out = await device.shell(
                f"content query {user_flag}--uri {uri} --projection _id 2>/dev/null | head -2"
            ) or ""
            if "Row:" in out or "_id=" in out:
                return True
        return False
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
    await raise_if_instagram_verification(device, stage="post_story_blocker", xml=xml)
    norm = _normalize(xml)
    for phrase in _CHECKPOINT_PHRASES:
        if phrase in norm:
            return ("checkpoint", "Instagram checkpoint: 'Confirm you're human'")
    for phrase in _RATE_LIMIT_PHRASES:
        if phrase in norm:
            return ("rate_limited", f"Instagram rate-limit overlay: '{phrase}'")
    return None


def _parse_story_share_xml(xml: str):
    try:
        return ET.fromstring(xml or "")
    except (ET.ParseError, ValueError):
        return None


def _story_share_sheet_ready(xml: str) -> bool:
    root = _parse_story_share_xml(xml)
    if root is None:
        return False
    return any(
        node.attrib.get("resource-id") in {_STORY_DIRECT_SHARE_ID, _STORY_SHARE_ROW_ID}
        or node.attrib.get("resource-id") in _STORY_SHARE_CONTAINER_IDS
        for node in root.iter()
    )


def _scoped_story_share_target(xml: str):
    root = _parse_story_share_xml(xml)
    if root is None:
        return None

    for node in root.iter():
        resource_id = node.attrib.get("resource-id")
        if resource_id not in {_STORY_DIRECT_SHARE_ID, _STORY_SHARE_ROW_ID}:
            continue
        bounds = node.attrib.get("bounds")
        if bounds:
            return UIElement(
                bounds=bounds,
                text=node.attrib.get("text"),
                resource_id=resource_id,
                content_desc=node.attrib.get("content-desc"),
            )

    for container in root.iter():
        if container.attrib.get("resource-id") not in _STORY_SHARE_CONTAINER_IDS:
            continue
        for node in container.iter():
            if (
                node.attrib.get("text") != "Your story"
                and node.attrib.get("content-desc") != "Your story"
            ):
                continue
            bounds = node.attrib.get("bounds")
            if bounds:
                return UIElement(
                    bounds=bounds,
                    text=node.attrib.get("text"),
                    resource_id=node.attrib.get("resource-id"),
                    content_desc=node.attrib.get("content-desc"),
                )
    return None


def _network_command_payload(result: dict | None) -> dict:
    if not isinstance(result, dict):
        return {"valid": False, "reason": "invalid_executor_response"}
    payload = result.get("data")
    if isinstance(payload, dict):
        return payload
    return result


async def _preflight_link_network(device: WSDeviceAdapter) -> tuple[bool, dict]:
    try:
        preflight = await device.device.send_command(
            "network_preflight",
            {},
            get_screen=False,
        )
        status = _network_command_payload(preflight)
    except Exception as error:
        status = {
            "valid": False,
            "reason": "network_preflight_failed",
            "error": str(error),
        }
    if status.get("valid") is True:
        return True, status

    # Exactly one executor-owned recovery attempt. The executor keeps the
    # Wi-Fi reset atomic even when this module is running through Tailnet.
    try:
        recovered = await device.device.send_command(
            "network_recover",
            {},
            get_screen=False,
        )
        recovery_status = _network_command_payload(recovered)
    except Exception as error:
        recovery_status = {
            "valid": False,
            "reason": "network_recovery_failed",
            "error": str(error),
        }
    return recovery_status.get("valid") is True, recovery_status


async def _tap_share_target(
    device: WSDeviceAdapter,
    publish_state: dict[str, bool],
) -> bool:
    share_btn = None
    for resource_id in (_STORY_DIRECT_SHARE_ID, _STORY_SHARE_ROW_ID):
        share_btn = await device.find_element_by_id(resource_id)
        if share_btn:
            break
    if not share_btn:
        share_btn = _scoped_story_share_target(getattr(device, "page_source", "") or "")
    if not share_btn:
        return False

    publish_state["attempted"] = True
    await device.click(share_btn)
    return True


def _story_selected_home(xml: str) -> bool:
    for node in re.findall(r"<node\b[^>]*>", xml or "", re.IGNORECASE):
        if not re.search(r'selected="true"', node, re.IGNORECASE):
            continue
        if re.search(
            r'(resource-id="com\.instagram\.android:id/feed_tab"|content-desc="Home")',
            node,
            re.IGNORECASE,
        ):
            return True
    return False


def _story_post_share_profile_ready(xml: str) -> bool:
    lower = (xml or "").lower()
    return (
        'resource-id="com.instagram.android:id/row_profile_header_imageview"' in lower
        and 'content-desc="your profile. unseen story"' in lower
        and 'resource-id="com.instagram.android:id/feed_tab"' in lower
    )


def _story_post_share_has_overlay(xml: str) -> bool:
    lower = (xml or "").lower()
    return any(
        marker in lower
        for marker in (
            "com.instagram.android:id/dialog_container",
            "com.instagram.android:id/modal_container",
            "com.instagram.android:id/igds_alert_dialog",
            "com.instagram.android:id/igds_headline",
            "com.instagram.android:id/bottom_sheet",
            "com.instagram.android:id/share_sheet",
            "com.instagram.android:id/reel_share_to_options",
        )
    )


def _story_post_share_safe_dialog_labels(xml: str) -> tuple[str, ...]:
    lower = _normalize(xml)
    for signatures, labels in _POST_SHARE_SAFE_DIALOG_DISMISSALS:
        if any(signature in lower for signature in signatures):
            return labels
    return ()


async def _confirm_story_publish(
    device: WSDeviceAdapter,
    initial_xml: str,
    *,
    max_attempts: int = 4,
    settle_seconds: float = 0.8,
) -> tuple[bool, str]:
    xml = initial_xml or ""
    reason = "post_share_unverified"
    for attempt in range(max(1, max_attempts)):
        if _story_post_share_has_overlay(xml):
            labels = _story_post_share_safe_dialog_labels(xml)
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
        elif _story_selected_home(xml):
            return True, "selected_home"
        elif _story_post_share_profile_ready(xml):
            feed_tab = await device.find_element_by_id(
                "com.instagram.android:id/feed_tab"
            )
            if not feed_tab:
                return False, "story_profile_home_action_missing"
            await device.click(feed_tab)
            if settle_seconds > 0:
                await asyncio.sleep(settle_seconds)
            await device.refresh_screen(force=True)
            xml = device.page_source or ""
            if _story_selected_home(xml):
                return True, "selected_home_after_story_profile"
            reason = "story_profile_home_not_selected"
        elif any(
            marker in (xml or "")
            for marker in (
                "com.instagram.android:id/next_button_textview",
                "com.instagram.android:id/share_sheet_table",
                "com.instagram.android:id/reel_share_to_options",
                "com.instagram.android:id/cam_dest_story",
                'content-desc="Stickers"',
            )
        ):
            reason = "story_share_flow_still_visible"
        else:
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


def _story_editor_ready(xml: str) -> bool:
    source = xml or ""
    return any(
        marker in source
        for marker in (
            'content-desc="Stickers"',
            "com.instagram.android:id/next_button_textview",
            'content-desc="Add text"',
            "com.instagram.android:id/text_tool_button",
            "com.instagram.android:id/story_creation",
        )
    )


def _story_picker_selection_state(
    xml: str,
    exact_picker_bounds: tuple[int, int, int, int] | None,
) -> str | None:
    try:
        root = ET.fromstring(xml or "<hierarchy />")
    except ET.ParseError:
        return None

    expected_bounds = None
    if exact_picker_bounds is not None:
        x1, y1, x2, y2 = exact_picker_bounds
        expected_bounds = f"[{x1},{y1}][{x2},{y2}]"

    selection_state = None
    for element in root.iter():
        description = element.attrib.get("content-desc", "").lower()
        if "thumbnail" not in description:
            continue
        if expected_bounds is not None and element.attrib.get("bounds") != expected_bounds:
            continue
        if description.startswith("unselected "):
            selection_state = "unselected"
            continue
        if (
            description.startswith("selected ")
            or element.attrib.get("selected", "").lower() == "true"
            or element.attrib.get("checked", "").lower() == "true"
        ):
            return "selected"
    return selection_state


async def _advance_story_picker_to_editor(
    device: WSDeviceAdapter,
    *,
    exact_picker_bounds: tuple[int, int, int, int] | None = None,
    attempts: int = 6,
    interval: float = 0.6,
) -> bool:
    for _ in range(max(1, attempts)):
        xml = await _refresh_xml(device)
        if _story_editor_ready(xml):
            return True

        selection_state = _story_picker_selection_state(xml, exact_picker_bounds)
        if selection_state == "unselected":
            if exact_picker_bounds is not None:
                x1, y1, x2, y2 = exact_picker_bounds
                await device.tap((x1 + x2) // 2, (y1 + y2) // 2)
            else:
                retry_item = await device.find_element_by_content_desc(
                    "Unselected Video thumbnail", partial=True
                ) or await device.find_element_by_content_desc(
                    "Unselected Photo thumbnail", partial=True
                )
                if retry_item:
                    await device.click(retry_item)
        elif selection_state == "selected" or (
            exact_picker_bounds is None
            and "com.instagram.android:id/cam_dest_story" in xml
        ):
            story_confirm = await device.find_element_by_id(
                "com.instagram.android:id/cam_dest_story"
            )
            if story_confirm:
                await device.click(story_confirm)

        if interval > 0:
            await asyncio.sleep(interval)

    xml = await _refresh_xml(device)
    return _story_editor_ready(xml)


async def _run(
    device: WSDeviceAdapter,
    config: dict,
    publish_state: dict[str, bool],
) -> dict:
    """Post to Instagram story via WebSocket - Resource ID first, coordinate fallback.
    Uses _tap_create_button to avoid accidentally tapping notifications (top-right)."""
    account_id = (
        config.get("account_username") or config.get("account_id") or ""
    )
    prepared_exact = None
    exact_selection = None
    try:
        link_url = (config.get("link_url") or "").strip()
        mention_target = (config.get("mention_target") or "").strip()

        # LOCAL_ONLY / sidebar wiring: the renderer only passes account_username,
        # not link_url. Resolve a per-account story link from
        # Content/Instagram/<account>/story_link.txt (first non-comment line) so
        # link stickers work from the sidebar without a cloud config. An explicit
        # config.link_url (cloud/dashboard) still wins.
        if not link_url:
            try:
                try:
                    from modules.content_manager import resolve_content_root
                except ImportError:
                    from content_manager import resolve_content_root
                import os as _os
                root = resolve_content_root(config.get("content_root") or None)
                acct = config.get("account_username") or config.get("account_id") or ""
                if root and acct:
                    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in str(acct))
                    link_file = _os.path.join(root, "Instagram", safe, "story_link.txt")
                    if _os.path.exists(link_file):
                        with open(link_file, "r", encoding="utf-8") as lf:
                            for line in lf:
                                line = line.strip()
                                if line and not line.startswith("#"):
                                    link_url = line
                                    print(f"[post_story] per-account story link: {link_url}")
                                    break
            except Exception as e:
                print(f"[post_story] story_link.txt resolve failed: {type(e).__name__}: {e}")

        # Resolve sticker text: explicit sticker_text > caption > random from pool
        sticker_text = (
            config.get("sticker_text")
            or config.get("caption")
            or ""
        ).strip()
        if link_url and not sticker_text:
            # Story captions live in their own per-account file:
            # Content/Instagram/<username>/story_captions/story_captions.txt
            # — distinct from the post-caption pool. The JS layer normally
            # injects config.sticker_text from this pool; this is the fallback.
            try:
                try:
                    from modules.content_manager import read_account_caption_pool
                except ImportError:
                    from content_manager import read_account_caption_pool
                import random as _random
                account_username = config.get("account_username") or ""
                content_root = config.get("content_root") or None
                pool = read_account_caption_pool(
                    account_username, "story_captions", content_root
                )
                if pool:
                    sticker_text = _random.choice(pool).strip()
                    print(
                        "[post_story] No sticker text set; using random from "
                        f"per-account story pool: [REDACTED length={len(sticker_text)}]"
                    )
                else:
                    print(
                        f"[post_story] No sticker text set and per-account story "
                        f"caption pool empty for @{account_username or '?'}"
                    )
            except Exception as e:
                print(f"[post_story] Sticker text fallback failed: {type(e).__name__}: {e}")
                sticker_text = ""

        await _LOG.log(
            device,
            f"post_story START account={account_id!r} link={bool(link_url)} "
            f"mention={bool(mention_target)} sticker_text_len={len(sticker_text)}",
        )

        try:
            prepared_exact = await prepare_exact_content_selection(
                device,
                config,
                {"story"},
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

        # ── Pre-flight: gallery has at least one item
        # Scope the MediaStore query to the IG user — a browser_download
        # push (secondary GrapheneOS profile) indexes media under that
        # user's MediaStore, which an unscoped (user 0) query cannot see.
        ig_user = str(
            config.get("target_user") or config.get("user_id") or ""
        ).strip()
        if not ig_user or not ig_user.isdigit():
            ig_user = await _active_user(device)
        if prepared_exact is None and not await _mediastore_has_items(device, user_id=ig_user):
            await _LOG.error(
                device, "Empty MediaStore — push_content must run before post_story"
            )
            return {
                "success": False,
                "error": (
                    "No media in device gallery — push_content must run "
                    "before post_story"
                ),
                "data": {"step": "preflight_mediastore", "account_id": account_id},
            }

        # ALWAYS force-stop IG before launching so a story starts from a
        # deterministic Home screen — not wherever IG was last left (DM inbox,
        # prior share screen, Reels). Mirrors post_feed/post_trial_reel, which are
        # reliable precisely because of this.
        try:
            _u = str(config.get("target_user") or config.get("user_id") or "").strip()
            if _u and _u != "0":
                await device.shell(f"am force-stop --user {_u} com.instagram.android")
            else:
                await device.close_app(IG_PKG)
        except Exception as e:
            print(f"[post_story] pre-launch force-stop best-effort failed: {e}")
        await asyncio.sleep(0.6)

        # Launch Instagram
        await _LOG.progress(device, 5, "Launching Instagram")
        await device.launch_app(IG_PKG)
        # launch_app already sleeps 2s; add 1s more for IG cold-launch render.
        await asyncio.sleep(1)

        # ── Pre-flight: IG actually reaches foreground. A cold launch right after
        # force-stop can take several seconds to render; during that window the
        # focused window is briefly mCurrentFocus=null. A SINGLE check read that
        # transient as "failed to foreground" and bailed before IG finished
        # launching. Poll up to ~18s, re-launch once if still not up, then fail.
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
                print("[post_story] IG not foreground after first launch — re-launching once")
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

        # Dismiss popups
        await raise_if_instagram_verification(device, stage="post_story_pre_popup")
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

        # Navigate to the PROFILE tab before creating. The profile screen
        # reliably exposes the top-left Create button, whereas the home
        # feed can be in a feed-preview gated state where the create
        # button is obscured. This matches post_trial_reel's profile-first
        # flow (Anyro-validated as the more reliable entry path).
        await _navigate_to_ig_tab(device, "profile")
        await asyncio.sleep(0.5)

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
                print(
                    f"[post_story] ABORT wrong-account: on @{_guard_on_screen},"
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

        # Tap create button (TOP-LEFT, verified safe helper)
        await _tap_create_button(device)
        await asyncio.sleep(1)
        await _handle_ig_media_permission_popup(device, "story creator entry")

        # Select STORY tab — with RECOVERY for the camera-load flake.
        # Observed live: attempt 1 occasionally lands with the camera chrome
        # not rendered (mFocusedApp=null / no cam_dest_* chips) and a fresh
        # re-entry then succeeds. So instead of failing on the first miss, we
        # re-enter the story creator up to 3 times, escalating the recovery:
        #   1) back out + re-run profile→create   2) same   3) force-stop +
        #   cold relaunch IG, then profile→create.  Happy path is unchanged —
        # a chip found on the first pass clicks once and breaks immediately.
        story_selected = False
        for cam_attempt in range(1, 4):
            story_tab = await device.find_element_by_id(
                "com.instagram.android:id/cam_dest_story"
            )
            if not story_tab:
                story_tab = await device.find_element_by_content_desc("Story")
            if not story_tab:
                story_tab = await device.find_element_by_text("STORY")
            if story_tab:
                await device.click(story_tab)
                story_selected = True
                break
            # No chip element — is the camera/destination-chip screen even up?
            cam_xml = await _refresh_xml(device)
            if "cam_dest_" in cam_xml or "cam_dest_story" in cam_xml:
                # Chrome present, element lookup just missed — blind coord is safe.
                await device.tap(
                    540, 2258
                )  # ADB-VERIFIED: cam_dest_story center [448,2213][632,2303]
                story_selected = True
                break
            # Camera screen did not load. Recover unless attempts are exhausted.
            if cam_attempt >= 3:
                break
            if cam_attempt == 1:
                print(
                    f"[post_story] camera screen not loaded (attempt {cam_attempt}) "
                    "— backing out + re-entering story creator"
                )
                await device.back()
                await asyncio.sleep(0.6)
            else:
                print(
                    f"[post_story] camera screen not loaded (attempt {cam_attempt}) "
                    "— force-stop + cold relaunch IG"
                )
                await device.close_app(IG_PKG)
                await asyncio.sleep(1.5)
                await device.launch_app(IG_PKG)
                await asyncio.sleep(3)
            # Re-run the exact creator entry sequence (profile → create).
            await _navigate_to_ig_tab(device, "profile")
            await asyncio.sleep(0.5)
            await _tap_create_button(device)
            await asyncio.sleep(1)
            await _handle_ig_media_permission_popup(
                device, f"story creator entry (retry {cam_attempt})"
            )

        if not story_selected:
            hint = await _screen_hint(device, "STORY tab missing after retries")
            await _LOG.error(
                device,
                f"Camera destination chips not on screen after 3 attempts; {hint}",
            )
            return {
                "success": False,
                "error": (
                    "STORY destination chip never appeared after create "
                    "— camera screen did not load"
                ),
                "data": {
                    "step": "select_story_tab",
                    "account_id": account_id,
                    "screen_hint": hint,
                    "camera_load_attempts": 3,
                },
            }
        await asyncio.sleep(0.6)
        await _handle_ig_media_permission_popup(device, "STORY tab")

        # Select from gallery — try resource ID, content-desc, text, then coordinate
        gallery_btn = await device.find_element_by_id(
            "com.instagram.android:id/gallery_preview_button"
        )
        if not gallery_btn:
            gallery_btn = await device.find_element_by_content_desc("Gallery")
        if not gallery_btn:
            gallery_btn = await device.find_element_by_text("Gallery")
        if gallery_btn:
            await device.click(gallery_btn)
        else:
            # VERIFY before the blind coord: confirm a gallery/picker marker
            # is on screen so the bottom-left tap isn't landing on unknown
            # chrome. If absent, fail with a hint rather than guess.
            gxml = await _refresh_xml(device)
            if (
                "gallery" not in gxml.lower()
                and "thumbnail" not in gxml.lower()
                and "cam_dest_" not in gxml
            ):
                hint = await _screen_hint(device, "gallery selector missing")
                await _LOG.error(
                    device, f"Gallery picker not on screen; {hint}"
                )
                return {
                    "success": False,
                    "error": (
                        "Gallery selector never appeared on the story camera "
                        "screen"
                    ),
                    "data": {
                        "step": "open_gallery",
                        "account_id": account_id,
                        "screen_hint": hint,
                    },
                }
            await device.tap(89, 2255)  # Fallback: gallery selector bottom-left
        await asyncio.sleep(0.6)
        await _handle_ig_media_permission_popup(device, "story gallery open")

        # Wait for the gallery thumbnails to render before trying to tap.
        # IG sometimes renders the picker chrome (Templates/Music/Collage)
        # ~1s before the actual recents grid populates, so a too-early
        # find_element_by_id returns None and the fallback tap lands on
        # an empty cell.
        await asyncio.sleep(1.0)

        # Select first media item.
        #
        # Modern IG "Add to story" picker is a TWO-STEP flow:
        #   1. tap a Recents thumbnail → marks it Selected (content-desc
        #      flips "Unselected Video..." → "Selected Video...")
        #   2. tap the STORY pill at the bottom (cam_dest_story) →
        #      advances to the editor
        #
        # We prefer the content-desc lookup ("thumbnail") over the
        # resource-id because IG sometimes renders the camera/preview
        # tile with the same gallery_grid_item_thumbnail id, and we
        # don't want to pick that.
        # Retry the thumbnail scan — a freshly push_content'd story video
        # (browser_download bridge on a secondary profile) can be MediaStore-
        # indexed but not yet rendered as a thumbnail when the picker first
        # opens, so a single check intermittently fails with "empty story
        # picker" right after a successful push. Up to 5 tries / ~10s.
        if prepared_exact is not None:
            try:
                exact_selection = await select_prepared_exact_content(
                    device,
                    prepared_exact,
                    require_selected_marker=False,
                    transition_markers=(
                        "story_share_controls_action_bar",
                        "your_story_share_shortcut_button",
                        'content-desc="Stickers"',
                    ),
                )
            except ExactContentSelectionError as error:
                await _LOG.error(device, f"Exact gallery selection failed: {error}")
                return {
                    "success": False,
                    "error": f"Exact gallery selection failed: {error}",
                    "data": {
                        "step": "exact_gallery_selection",
                        "account_id": account_id,
                    },
                }

        media_item = exact_selection
        for _pick_try in range(5):
            if exact_selection is not None:
                break
            media_item = await device.find_element_by_content_desc(
                "Video thumbnail", partial=True
            )
            if not media_item:
                media_item = await device.find_element_by_content_desc(
                    "Photo thumbnail", partial=True
                )
            if not media_item:
                media_item = await device.find_element_by_id(
                    "com.instagram.android:id/gallery_grid_item_thumbnail"
                )
            if media_item:
                break
            print(f"[post_story] story picker empty (attempt {_pick_try + 1}/5) — waiting for grid")
            await asyncio.sleep(2.0)

        if media_item:
            if exact_selection is None:
                await device.click(media_item)
                print(f"[post_story] Tapped thumbnail at ({media_item.center_x}, {media_item.center_y})")
        else:
            # No descriptor on screen. Verify the picker actually has
            # thumbnails before blind-tapping — otherwise we silently
            # "succeed" on an empty story.
            picker_xml = await _refresh_xml(device)
            if (
                "thumbnail" not in picker_xml.lower()
                and "gallery_grid_item_thumbnail" not in picker_xml
            ):
                hint = await _screen_hint(device, "empty story picker")
                await _LOG.error(
                    device, f"Story picker has no thumbnails; {hint}"
                )
                return {
                    "success": False,
                    "error": (
                        "No thumbnail found in IG story picker — picker may "
                        "be empty or permission denied"
                    ),
                    "data": {
                        "step": "select_thumbnail",
                        "account_id": account_id,
                        "screen_hint": hint,
                    },
                }
            await device.tap(540, 1004)
            print("[post_story] No descriptor; fell back to (540, 1004)")
        await asyncio.sleep(0.8)
        await _handle_ig_media_permission_popup(device, "story media select")

        # Verify the thumbnail actually got selected before tapping STORY
        # pill. content-desc flips Unselected → Selected on success.
        await device.refresh_screen(force=True)
        screen_xml_now = device._screen_xml or ""
        if "Selected Video thumbnail" in screen_xml_now or "Selected Photo thumbnail" in screen_xml_now:
            print("[post_story] Thumbnail confirmed Selected")
        elif "Unselected Video thumbnail" in screen_xml_now or "Unselected Photo thumbnail" in screen_xml_now:
            # Selection didn't take — retry once with the resolved bounds
            print("[post_story] Thumbnail still Unselected after first tap; retrying")
            retry_item = await device.find_element_by_content_desc(
                "Unselected Video thumbnail", partial=True
            ) or await device.find_element_by_content_desc(
                "Unselected Photo thumbnail", partial=True
            )
            if retry_item:
                await device.click(retry_item)
                await asyncio.sleep(1.0)

        # Confirm selection via the bottom STORY pill if it's still on
        # screen (modern picker). cam_dest_story is the destination chip
        # at center-bottom; tapping it advances to the story editor.
        story_confirm = await device.find_element_by_id(
            "com.instagram.android:id/cam_dest_story"
        )
        if story_confirm:
            await device.click(story_confirm)
            print("[post_story] Tapped STORY destination pill to advance")
        else:
            # Older IG variants: single-tap on thumbnail already advanced
            # us into the editor. Nothing to do here.
            print("[post_story] STORY destination pill not present — assuming editor already loaded")
        await asyncio.sleep(1.5)
        await _handle_ig_media_permission_popup(device, "story editor load")

        # VERIFY we actually reached the story editor before any sticker /
        # Next work. Don't false-pass an un-advanced picker into the rest of
        # the flow. The editor exposes its right-rail toolbar (Stickers icon,
        # text/draw) and/or the Next button; the picker does not. Poll a few
        # seconds (GrapheneOS transition lag) before failing.
        editor_ready = await _advance_story_picker_to_editor(
            device,
            exact_picker_bounds=(
                exact_selection.picker_bounds
                if exact_selection is not None
                else None
            ),
        )
        if not editor_ready:
            hint = await _screen_hint(device, "story editor missing")
            await _LOG.error(
                device, f"Story editor never loaded after media select; {hint}"
            )
            return {
                "success": False,
                "error": (
                    "Story editor did not load — media selection may not "
                    "have advanced past the picker"
                ),
                "data": {
                    "step": "story_editor_load",
                    "account_id": account_id,
                    "screen_hint": hint,
                },
            }

        if link_url:
            network_valid, network_status = await _preflight_link_network(device)
            if not network_valid:
                reason = network_status.get("reason") or "wifi_not_validated"
                await _LOG.error(
                    device,
                    f"Story link stopped before sticker/share: network={reason}",
                )
                return {
                    "success": False,
                    "error": (
                        "Wi-Fi internet is not validated after one recovery "
                        "attempt. Reconnect this phone to Wi-Fi and retry the "
                        "story link; publishing was not attempted."
                    ),
                    "data": {
                        "step": "link_network_preflight",
                        "account_id": account_id,
                        "network_reason": reason,
                        "recovery_path": network_status.get("recovery_path"),
                        "recovery_attempts": network_status.get("attempts", 1),
                    },
                }

        # STICKER PRIORITY (from old post_story_module): mention > link > none
        # Open sticker tray for either mention or link
        sticker_type = None
        custom_text_failed = False
        if mention_target:
            sticker_type = "mention"
        elif link_url:
            sticker_type = "link"

        if sticker_type:
            # Open sticker tray — Icon 2 in story editor right toolbar.
            # resource-id → content-desc → coord LAST.
            # ig_ui_map: the icon itself has NO resource-id/content-desc on
            # some builds, bounds [927,292][1053,418] center (990,355).
            sticker_btn = await device.find_element_by_id(
                "com.instagram.android:id/asset_picker"
            )
            if not sticker_btn:
                sticker_btn = await device.find_element_by_content_desc("Stickers")
            if sticker_btn:
                await device.click(sticker_btn)
            else:
                # ADB-VERIFIED coordinate: sticker icon in right toolbar
                await device.tap(990, 355)

            # VERIFY the sticker tray actually opened before tapping INTO it.
            # The tray exposes its asset list / search; if it never rendered
            # the mention/link taps below would land on the editor canvas.
            # Poll a few seconds then fail with a hint rather than blind-tap.
            def _tray_open(xml: str) -> bool:
                x = xml or ""
                return (
                    'com.instagram.android:id/asset_picker' in x
                    or 'com.instagram.android:id/asset_search' in x
                    or 'content-desc="Link Sticker"' in x
                    or 'content-desc="Mention Sticker"' in x
                    or 'text="Stickers"' in x
                    or 'text="Search"' in x
                )

            tray_ready = False
            for _ in range(8):
                tray_xml = await _refresh_xml(device)
                if _tray_open(tray_xml):
                    tray_ready = True
                    break
                await asyncio.sleep(0.3)
            if not tray_ready:
                hint = await _screen_hint(device, "sticker tray missing")
                await _LOG.error(
                    device, f"Sticker tray never opened; {hint}"
                )
                return {
                    "success": False,
                    "error": (
                        "Sticker tray did not open — cannot place "
                        f"{sticker_type} sticker"
                    ),
                    "data": {
                        "step": "open_sticker_tray",
                        "sticker_type": sticker_type,
                        "account_id": account_id,
                        "screen_hint": hint,
                    },
                }

            if sticker_type == "mention":
                # Mention Sticker tile — resource-id → content-desc → coord LAST.
                # TODO(live-id): resource-id for the Mention sticker tray tile
                # (the tray asset cells share a generic id on most builds);
                # capture a live dump to pin it. content-desc is reliable today.
                # VERIFIED from old Appium: Mention Sticker at (564, 893) [424,824][705,963]
                # Poll for the sticker-tray to render rather than a blind settle.
                mention_el = await device.wait_for_element(
                    device.find_element_by_content_desc,
                    "Mention Sticker",
                    timeout=4,
                    poll=0.2,
                )
                if mention_el:
                    await device.click(mention_el)
                else:
                    # VERIFY the mention tile is at least somewhere on screen
                    # before the blind coord — else fail rather than tap into
                    # an unknown tray layout.
                    mtray = await _refresh_xml(device)
                    if "Mention Sticker" not in mtray and "mention" not in mtray.lower():
                        hint = await _screen_hint(device, "mention tile missing")
                        await _LOG.error(
                            device, f"Mention sticker tile not in tray; {hint}"
                        )
                        return {
                            "success": False,
                            "error": (
                                "Mention sticker tile never appeared in the "
                                "sticker tray"
                            ),
                            "data": {
                                "step": "mention_sticker_tile",
                                "account_id": account_id,
                                "screen_hint": hint,
                            },
                        }
                    await device.tap(564, 893)

                # Focus the mention search box BEFORE typing. Live-confirmed
                # 2026-05-20: send_keys without an explicit focus tap landed
                # in nothing — the search box stayed empty and IG showed
                # generic suggestions instead of the requested user.
                # Poll for the box to mount instead of a blind 1s settle.
                search_box = await device.wait_for_element(
                    device.find_element_by_id,
                    "com.instagram.android:id/mention_user_sticky_search_box",
                    timeout=4,
                    poll=0.2,
                )
                if not search_box:
                    search_box = await device.find_element_by_id(
                        "com.instagram.android:id/mention_user_search_container"
                    )
                if search_box:
                    await device.click(search_box)
                    await asyncio.sleep(0.2)

                # Type the username to mention
                await device.send_keys(mention_target)
                # Genuine network wait: IG queries its server for matching
                # users. Keep this — it is not a render settle. Tightened
                # 1.8s → 1.3s; the result-row poll below absorbs slower
                # responses.
                await asyncio.sleep(1.3)

                # Tap the FIRST result row inside the mention recycler. The
                # old blind (540,400) tap landed above the results area
                # entirely. Resolve the first row from the recycler's XML.
                # Poll up to ~2s for the row to appear — covers a slow IG
                # search response without a fixed over-long sleep.
                # Resolve the first user result row by finding all clickable nodes
                # in the mention recycler, then filtering out header/divider rows
                # (which IG may render as clickable but are not selectable users).
                row_m = None
                for _ in range(8):
                    await device.refresh_screen(force=True)
                    page_xml = device.page_source or ""

                    # Find the recycler node and extract all clickable children
                    recycler_re = re.compile(
                        r'<node[^>]*resource-id="com\.instagram\.android:id/mention_user_recycler_view"[^>]*>'
                    )
                    recycler_match = recycler_re.search(page_xml)
                    if not recycler_match:
                        break  # Recycler vanished; fall through to error handling

                    # Find all clickable nodes starting from recycler position
                    recycler_start = recycler_match.end()
                    remaining_xml = page_xml[recycler_start:]

                    # Collect all clickable nodes with bounds; capture optional content-desc
                    clickable_re = re.compile(
                        r'<node[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*clickable="true"[^>]*(?:content-desc="([^"]*)")?'
                    )
                    clickables = list(clickable_re.finditer(remaining_xml))

                    # Filter out header/section/divider rows (typically small or keyword-marked).
                    # User result rows are ~80-150px tall; headers are ~50-60px.
                    for m in clickables:
                        y1, y2 = int(m.group(2)), int(m.group(4))
                        height = y2 - y1
                        content_desc = (m.group(5) or "").lower()
                        if height >= 60 and not any(
                            kw in content_desc
                            for kw in ('header', 'suggested', 'filter', 'section', 'divider')
                        ):
                            row_m = m
                            break

                    if row_m:
                        break
                    await asyncio.sleep(0.25)
                if row_m:
                    rx = (int(row_m.group(1)) + int(row_m.group(3))) // 2
                    ry = (int(row_m.group(2)) + int(row_m.group(4))) // 2
                    await device.tap(rx, ry)
                else:
                    # No clickable row resolved. Distinguish "IG returned no
                    # matching user" (recycler present, zero rows → FAIL, don't
                    # mention the wrong/blank user) from "recycler present but
                    # our regex missed the bounds" (layout matches → coord is a
                    # safe last resort on the verified 2026 layout).
                    rec_xml = device.page_source or ""
                    if "mention_user_recycler_view" not in rec_xml:
                        hint = await _screen_hint(device, "mention recycler missing")
                        await _LOG.error(
                            device,
                            f"Mention result list never appeared for "
                            f"@{mention_target}; {hint}",
                        )
                        return {
                            "success": False,
                            "error": (
                                f"No mention results for @{mention_target} — "
                                "search list never rendered"
                            ),
                            "data": {
                                "step": "mention_result_row",
                                "account_id": account_id,
                                "mention": mention_target,
                                "screen_hint": hint,
                            },
                        }
                    # Recycler is present (verified) — first result row sits
                    # just below the search box, ~Y1145 on the 2026 layout.
                    await device.tap(540, 1145)
                await asyncio.sleep(0.3)

                # Tap Done to place the mention sticker. After picking a
                # result IG may auto-place it; if a Done button is present
                # (resource-id done_button, verified [890,139][1069,259]),
                # tap it. Resolve by id first, then text, then coord.
                done_btn = await device.find_element_by_id(
                    "com.instagram.android:id/done_button"
                )
                if not done_btn:
                    done_btn = await device.find_element_by_text("Done")
                if done_btn:
                    await device.click(done_btn)
                else:
                    await device.tap(980, 199)
                await asyncio.sleep(0.2)

                # VERIFY the mention sticker was placed: the mention search UI
                # (search box + result recycler) must be GONE and we must be
                # back on the editor. If the search box is still up, the pick
                # didn't take — fail rather than report a phantom mention.
                placed = False
                for _ in range(6):
                    m_xml = await _refresh_xml(device)
                    search_still_up = (
                        "mention_user_sticky_search_box" in m_xml
                        or "mention_user_recycler_view" in m_xml
                    )
                    if not search_still_up and _story_editor_ready(m_xml):
                        placed = True
                        break
                    await asyncio.sleep(0.4)
                if not placed:
                    hint = await _screen_hint(device, "mention not placed")
                    await _LOG.error(
                        device,
                        f"Mention sticker not confirmed placed for "
                        f"@{mention_target}; {hint}",
                    )
                    return {
                        "success": False,
                        "error": (
                            f"Mention sticker for @{mention_target} was not "
                            "placed — still on the mention search screen"
                        ),
                        "data": {
                            "step": "mention_sticker_place",
                            "account_id": account_id,
                            "mention": mention_target,
                            "screen_hint": hint,
                        },
                    }

            elif sticker_type == "link":
                # Link Sticker tile — resource-id → content-desc → coord LAST.
                # TODO(live-id): resource-id for the Link sticker tray tile
                # (tray cells share a generic id on most builds); capture a
                # live dump to pin it. content-desc is reliable today.
                # ADB-VERIFIED: Link Sticker at cd="Link Sticker" [120,1670][326,1810]
                link_el = await device.find_element_by_content_desc("Link Sticker")
                if link_el:
                    await device.click(link_el)
                else:
                    # VERIFY the Link tile is present before the blind coord —
                    # else the tray layout differs and the coord is unsafe.
                    ltray = await _refresh_xml(device)
                    if "Link Sticker" not in ltray and "link" not in ltray.lower():
                        hint = await _screen_hint(device, "link tile missing")
                        await _LOG.error(
                            device, f"Link sticker tile not in tray; {hint}"
                        )
                        return {
                            "success": False,
                            "error": (
                                "Link sticker tile never appeared in the "
                                "sticker tray"
                            ),
                            "data": {
                                "step": "link_sticker_tile",
                                "account_id": account_id,
                                "screen_hint": hint,
                            },
                        }
                    await device.tap(223, 1740)  # ADB-verified center

                # URL input field (VERIFIED: link_sticker_list_web_url_edit_text at (540, 708))
                # This poll IS the verify the link-config screen actually
                # opened. If the field never mounts the screen isn't the URL
                # editor — fail rather than blind-type the URL into nowhere.
                url_input = await device.wait_for_element(
                    device.find_element_by_id,
                    "com.instagram.android:id/link_sticker_list_web_url_edit_text",
                    timeout=4,
                    poll=0.2,
                )
                if url_input:
                    await device.click(url_input)
                else:
                    # Last-resort coord only if the link-config screen markers
                    # are present (layout matches but id missed); else fail.
                    ucfg = await _refresh_xml(device)
                    if (
                        "link_sticker_list_web_url_edit_text" not in ucfg
                        and "link_sticker" not in ucfg
                        and "Enter URL" not in ucfg
                    ):
                        hint = await _screen_hint(device, "link URL field missing")
                        await _LOG.error(
                            device, f"Link sticker URL field not on screen; {hint}"
                        )
                        return {
                            "success": False,
                            "error": (
                                "Link sticker URL input never appeared — "
                                "link-config screen did not open"
                            ),
                            "data": {
                                "step": "link_sticker_url_field",
                                "account_id": account_id,
                                "screen_hint": hint,
                            },
                        }
                    await device.tap(540, 708)
                await asyncio.sleep(0.2)
                await device.send_keys(link_url)
                await asyncio.sleep(0.2)

                # Optional: customize sticker text so the link displays a curated caption
                # instead of IG's default "LINK" label.
                if sticker_text:
                    try:
                        # Tap "Customize sticker text" — content-desc → text →
                        # coord LAST.
                        # TODO(live-id): resource-id for the "Customize sticker
                        # text" toggle/row; not exposed in current dumps, so
                        # content-desc/text drive it. Coord stays last resort.
                        customize = await device.find_element_by_content_desc(
                            "Customize sticker text"
                        )
                        if not customize:
                            customize = await device.find_element_by_text(
                                "Customize sticker text", partial=True
                            )
                        if customize:
                            await device.click(customize)
                        else:
                            # Coord fallback from legacy post_story_module: (321, 940)
                            await device.tap(321, 940)

                        # Poll for the sticker-text field instead of a blind
                        # 1.2s settle.
                        text_input = await device.wait_for_element(
                            device.find_element_by_id,
                            "com.instagram.android:id/sticker_text_edit_text",
                            timeout=4,
                            poll=0.2,
                        )
                        if text_input:
                            await device.click(text_input)
                        else:
                            # Coord fallback from legacy: (540, 997)
                            await device.tap(540, 997)
                        await asyncio.sleep(0.2)

                        await device.send_keys(sticker_text, typing_mode="human")
                        await asyncio.sleep(random.uniform(0.4, 1.1))
                        print(
                            "[post_story] Customized link sticker text: "
                            f"[REDACTED length={len(sticker_text)}]"
                        )
                    except Exception as e:
                        await _LOG.error(device, f"Customize sticker text failed: {type(e).__name__}: {e!r}")
                        custom_text_failed = True

                # Tap Done — resource-id → text → coord LAST.
                # (VERIFIED: link_sticker_list_done_button at (983, 546))
                done_btn = await device.find_element_by_id(
                    "com.instagram.android:id/link_sticker_list_done_button"
                )
                if not done_btn:
                    done_btn = await device.find_element_by_text("Done")
                if done_btn:
                    await device.click(done_btn)
                else:
                    await device.tap(983, 546)
                await asyncio.sleep(0.3)

                # VERIFY the link sticker was placed: the link-config screen
                # (URL edit field) must be GONE and we must be back on the
                # editor. If the URL field is still up the link didn't take —
                # fail rather than report a phantom link sticker.
                placed = False
                for _ in range(6):
                    l_xml = await _refresh_xml(device)
                    cfg_still_up = (
                        "link_sticker_list_web_url_edit_text" in l_xml
                        or "link_sticker_list_done_button" in l_xml
                    )
                    if not cfg_still_up and _story_editor_ready(l_xml):
                        placed = True
                        break
                    await asyncio.sleep(0.4)
                if not placed:
                    hint = await _screen_hint(device, "link not placed")
                    await _LOG.error(
                        device, f"Link sticker not confirmed placed; {hint}"
                    )
                    return {
                        "success": False,
                        "error": (
                            "Link sticker was not placed — still on the "
                            "link-config screen after Done"
                        ),
                        "data": {
                            "step": "link_sticker_place",
                            "account_id": account_id,
                            "screen_hint": hint,
                        },
                    }

        # ── Advance editor → share sheet via the "Next" arrow.
        #
        # REGRESSION FIX (live 2026-05-20): the IG story editor screen shows
        # the editing toolbar (stickers / text / draw) — it does NOT show a
        # "Your story" share row. That share row only appears AFTER tapping
        # the bottom-right Next arrow (next_button_textview). The previous
        # code jumped straight to find_element_by_text("Your story") on the
        # editor screen, found nothing real, fell through, and the loose
        # home-feed check false-passed → logged "Story complete" without
        # ever posting. Tap Next first, then VERIFY the share sheet loaded
        # (a real share-target / share_sheet_table is present) before
        # continuing.
        await _LOG.progress(device, 85, "Advancing to share sheet (Next)")

        share_sheet_ready = False
        for attempt in range(2):
            await device.refresh_screen(force=True)
            if _story_share_sheet_ready(device.page_source or ""):
                share_sheet_ready = True
                break
            next_btn = await device.find_element_by_id(
                "com.instagram.android:id/next_button_textview"
            )
            if not next_btn:
                next_btn = await device.find_element_by_content_desc("Next")
            if not next_btn:
                next_btn = await device.find_element_by_text("Next")
            if next_btn:
                await device.click(next_btn)
                print(f"[post_story] Tapped Next (attempt {attempt + 1})")
            else:
                # ADB-VERIFIED: story editor Next arrow, bottom-right.
                await device.tap(961, 2280)
                print(f"[post_story] Next descriptor miss; tapped (961, 2280) "
                      f"(attempt {attempt + 1})")
            # Poll for the share sheet — GrapheneOS phones take several
            # seconds for this transition.
            for _ in range(12):
                await asyncio.sleep(0.6)
                await device.refresh_screen(force=True)
                if _story_share_sheet_ready(device.page_source or ""):
                    share_sheet_ready = True
                    break
            if share_sheet_ready:
                break

        if not share_sheet_ready:
            hint = await _screen_hint(device, "share sheet never loaded")
            await _LOG.error(
                device, f"Story share sheet did not load after Next; {hint}"
            )
            return {
                "success": False,
                "error": (
                    "Story share sheet never appeared after tapping Next "
                    "(editor did not advance)"
                ),
                "data": {
                    "step": "editor_next",
                    "account_id": account_id,
                    "screen_hint": hint,
                },
            }

        # ── Tap the "Your story" share-to target. Bail loudly if none of
        # the share-target buttons resolve — the old fallback tap (250,
        # 2255) silently landed on an empty area when the share row never
        # rendered.
        await _LOG.progress(device, 92, "Tapping share-to target")
        # resource-id → content-desc → text. (No fixed coord here on purpose:
        # the old blind (250,2255) silently landed on empty space when the row
        # never rendered — we fail loudly below instead.)
        # TODO(live-id): pin the "Your story" share-row resource-id (lives
        # inside share_sheet_table / reel_share_to_options; row id is
        # build-specific). content-desc/text drive it reliably today.
        if not await _tap_share_target(device, publish_state):
            hint = await _screen_hint(device, "share-target missing")
            await _LOG.error(
                device,
                f"No exact 'Your story' share target found; {hint}",
            )
            return {
                "success": False,
                "error": (
                    "Story share-target button never appeared on the share "
                    "sheet"
                ),
                "data": {
                    "step": "share_target_missing",
                    "account_id": account_id,
                    "screen_hint": hint,
                },
            }
        print("[post_story] Tapped 'Your story' share target")

        # Initial settle; the post-share verification below re-checks with a
        # further 3s wait if we're not yet on the home feed (slow upload).
        await asyncio.sleep(2.5)

        # Post-share blocker scan — rate-limit / checkpoint screens often
        # surface right after the share tap.
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
                    "manual_action_required": kind == "checkpoint",
                },
            }

        publish_confirmed, confirmation_reason = await _confirm_story_publish(
            device,
            post_xml,
        )
        if not publish_confirmed:
            hint = await _screen_hint(device, "post-share verification")
            await _LOG.error(
                device,
                f"Story share was attempted but could not be confirmed: "
                f"{confirmation_reason}; {hint}",
            )
            return {
                "success": False,
                "error": (
                    "Story share was attempted, but Instagram did not reach "
                    "a verified selected Home state"
                ),
                "data": {
                    "step": "post_share_verification",
                    "account_id": account_id,
                    "confirmation_reason": confirmation_reason,
                    "screen_hint": hint,
                },
                "link": link_url,
                "mention": mention_target,
                "sticker_text": (
                    sticker_text
                    if sticker_type == "link" and not custom_text_failed
                    else ""
                ),
                "custom_text_failed": custom_text_failed,
            }

        await _LOG.progress(device, 100, "Story complete")
        return _finalize_success(
            {
                "success": True,
                "link": link_url,
                "mention": mention_target,
                "sticker_text": (
                    sticker_text
                    if sticker_type == "link" and not custom_text_failed
                    else ""
                ),
                "custom_text_failed": custom_text_failed,
                "move_instructions": {"action": "move_to_used", "max_files": 1},
            },
            exact_selection,
            publish_confirmed=True,
        )

    except InstagramVerificationRequired as verification:
        return verification.outcome
    except Exception as e:
        await _LOG.error(device, f"post_story crashed: {type(e).__name__}: {e}")
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
