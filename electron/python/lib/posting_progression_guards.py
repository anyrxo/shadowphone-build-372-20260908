"""
Reusable verified posting progression helpers for WS runtime flows.

Goals:
- keep posting screen verification out of server.py
- reuse the shared screen classifier foundation
- keep legacy posting guards additive while exact-manifest posting fails closed
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Awaitable, Callable, Iterable, Optional
from xml.etree import ElementTree

import asyncio
import re
import shlex

from lib.instagram_screen_classifier import (
    classify_instagram_screen,
    IG_CREATE_POST_GALLERY,
    IG_MEDIA_SELECTED,
    IG_CAPTION_EDITOR,
    IG_STORY_EDITOR,
    IG_HOME,
    IG_PROFILE,
)
from lib.bootstrap_profile_guards import BootstrapProfileGuards
from lib.screen_state import ScreenObservation


def verified_profile_username(xml: str) -> str | None:
    try:
        nodes = list(ElementTree.fromstring(xml).iter())
    except ElementTree.ParseError:
        return None
    prefix = "com.instagram.android:id/"
    profile_tabs = [node for node in nodes if node.get("resource-id") == prefix + "profile_tab"]
    if len(profile_tabs) != 1 or not any(node.get("selected") == "true" for node in profile_tabs[0].iter()):
        return None
    if any(child.get("selected") == "true" for node in nodes
           if node.get("resource-id") == prefix + "feed_tab" for child in node.iter()):
        return None
    header_ids = {prefix + name for name in (
        "profile_header_container", "profile_header_fixed_list", "row_profile_header",
        "row_profile_header_edit_profile_button",
    )}
    headers = [node for node in nodes if node.get("resource-id") in header_ids]
    if not any(
        node.get("enabled") != "false" and (
            node.get("resource-id") == prefix + "row_profile_header_edit_profile_button"
            or (node.get("clickable") == "true" and "Edit profile" in (node.get("text"), node.get("content-desc")))
        ) for header in headers for node in header.iter()
    ):
        # Compressed UI dumps omit layout-only profile headers but retain these controls.
        pagers = [node for node in nodes if node.get("resource-id") == prefix + "swipeable_tab_view_pager"]
        if len(pagers) != 1:
            return None
        content = [node for node in pagers[0] if node.get("resource-id") == prefix + "coordinator_root_layout"]
        title_containers = [node for node in pagers[0] if node.get("resource-id") == prefix + "action_bar_username_container"]
        if len(content) != 1 or len(title_containers) != 1 or not any(
            node.get("resource-id") in {prefix + "action_bar_title", prefix + "action_bar_textview_title"}
            for node in title_containers[0].iter()
        ):
            return None
        profile_ids = {node.get("resource-id") for node in content[0].iter()}
        if not {prefix + "row_profile_header_imageview", prefix + "profile_header_familiar_post_count_value"} <= profile_ids:
            return None
        edit_buttons = [node for node in content[0]
                        if node.get("resource-id") == prefix + "button_container"
                        and node.get("class") == "android.widget.Button"
                        and node.get("clickable") == "true"
                        and node.get("enabled") != "false"
                        and node.get("visible-to-user") != "false"
                        and "Edit profile" in (node.get("text"), node.get("content-desc"))]
        if len(edit_buttons) != 1:
            return None
    usernames = set()
    for node in nodes:
        if node.get("resource-id") not in {prefix + "action_bar_title", prefix + "action_bar_textview_title"}:
            continue
        for label in (node.get("text"), node.get("content-desc")):
            if not label:
                continue
            username = label.strip().lstrip("@").lower()
            if not re.fullmatch(r"[a-z0-9._]{1,30}", username):
                return None
            usernames.add(username)
    return next(iter(usernames)) if len(usernames) == 1 else None

@dataclass
class PostingVerificationResult:
    ok: bool
    screen_type: str
    confidence: str
    context_label: str


@dataclass(frozen=True)
class PostingStartSurfaceResult:
    ready: bool
    reason: str
    actions: tuple[str, ...] = ()


_POSTING_COMMENT_MARKERS = (
    "comment_composer_parent_updated",
    "layout_comment_thread_edittext_multiline",
    "join the conversation",
)
_POSTING_COMPOSER_MARKERS = (
    "caption_input_text_view",
    "share_footer_button",
    "com.instagram.android:id/share_button",
    "clips_post_capture_controls",
    "post_capture_controls_container",
    "gallery_recycler_view",
    "gallery_picker_grid_item_container",
    "create new reel",
    "keep editing your draft",
)
_POSTING_DISCARD_HEADLINES = (
    "discard reel",
    "discard post",
    "discard story",
    "discard changes",
    "discard edits",
)
_POSTING_SAFE_DIALOG_DISMISSALS = (
    (("turn on notifications", "enable notifications"), ("Not Now", "Not now")),
    (("save your login info", "save login info"), ("Not Now", "Not now")),
    (("sync your contacts", "connect contacts"), ("Not Now", "Not now", "Skip")),
    (("find people to follow",), ("Skip", "Not Now", "Not now")),
    (("add instagram to your home screen",), ("Cancel", "Not Now", "Not now")),
)


def _posting_main_navigation_ready(xml: str) -> bool:
    lower = (xml or "").lower()
    has_profile_nav = (
        "com.instagram.android:id/profile_tab" in lower
        or 'content-desc="profile"' in lower
    )
    has_main_nav = any(
        marker in lower
        for marker in (
            "com.instagram.android:id/feed_tab",
            "com.instagram.android:id/clips_tab",
            "com.instagram.android:id/search_tab",
            'content-desc="home"',
            'content-desc="reels"',
            'content-desc="search and explore"',
        )
    )
    return has_profile_nav and has_main_nav


def _posting_has_strong_dialog(xml: str) -> bool:
    lower = (xml or "").lower()
    return any(
        marker in lower
        for marker in (
            "com.instagram.android:id/dialog_container",
            "com.instagram.android:id/modal_container",
            "com.instagram.android:id/igds_alert_dialog",
            "com.instagram.android:id/igds_headline",
        )
    )


def _posting_safe_dialog_labels(xml: str) -> tuple[str, ...]:
    lower = (xml or "").lower()
    for signatures, labels in _POSTING_SAFE_DIALOG_DISMISSALS:
        if any(signature in lower for signature in signatures):
            return labels
    return ()


async def stabilize_posting_start_surface(
    device,
    *,
    max_attempts: int = 6,
    settle_seconds: float = 0.6,
) -> PostingStartSurfaceResult:
    actions: list[str] = []
    for _ in range(max(1, max_attempts)):
        try:
            await device.refresh_screen(force=True)
        except Exception:
            if settle_seconds > 0:
                await asyncio.sleep(settle_seconds)
            continue

        xml = device.page_source or ""
        lower = (
            xml.lower()
            .replace("\u2019", "'")
            .replace("\u2018", "'")
            .replace("â€™", "'")
            .replace("â€˜", "'")
        )
        if "confirm you're human" in lower or "confirm you are human" in lower:
            return PostingStartSurfaceResult(False, "verification_required", tuple(actions))

        if any(marker in lower for marker in _POSTING_DISCARD_HEADLINES):
            discard = await device.find_element_by_text("Discard")
            if not discard:
                return PostingStartSurfaceResult(False, "discard_action_missing", tuple(actions))
            await device.click(discard)
            actions.append("discard_stale_draft")
        elif any(marker in lower for marker in _POSTING_COMMENT_MARKERS):
            await device.back()
            actions.append("close_comments_overlay")
        elif any(marker in lower for marker in _POSTING_COMPOSER_MARKERS):
            await device.back()
            actions.append("leave_stale_composer")
        elif _posting_has_strong_dialog(xml):
            labels = _posting_safe_dialog_labels(xml)
            if not labels:
                return PostingStartSurfaceResult(False, "unknown_overlay", tuple(actions))
            dismissed = False
            for label in labels:
                button = await device.find_element_by_text(label)
                if not button:
                    button = await device.find_element_by_content_desc(label)
                if button:
                    await device.click(button)
                    actions.append(f"dismiss:{label.lower()}")
                    dismissed = True
                    break
            if not dismissed:
                return PostingStartSurfaceResult(False, "unknown_overlay", tuple(actions))
        elif _posting_main_navigation_ready(xml):
            return PostingStartSurfaceResult(True, "main_navigation_ready", tuple(actions))
        elif not xml.strip():
            if settle_seconds > 0:
                await asyncio.sleep(settle_seconds)
            continue
        else:
            return PostingStartSurfaceResult(False, "unknown_surface", tuple(actions))

        if settle_seconds > 0:
            await asyncio.sleep(settle_seconds)

    return PostingStartSurfaceResult(False, "start_surface_attempts_exhausted", tuple(actions))


class ExactContentSelectionError(RuntimeError):
    pass


@dataclass(frozen=True)
class ExactContentManifest:
    transfer_id: str
    remote_filename: str
    sha256: str
    size_bytes: int
    content_type: str
    phone_profile: str
    phone_destination: str
    device_id: str
    account_username: str
    media_kind: str


@dataclass(frozen=True)
class MediaStoreItem:
    media_id: int
    display_name: str
    size_bytes: int
    mime_type: str
    data_path: str
    media_kind: str
    collection_uri: str


@dataclass(frozen=True)
class PreparedExactContentSelection:
    manifest: ExactContentManifest
    media_item: MediaStoreItem
    picker_index: int
    picker_kinds: tuple[str, ...]


@dataclass(frozen=True)
class VerifiedExactContentSelection:
    prepared: PreparedExactContentSelection
    picker_bounds: tuple[int, int, int, int]


@dataclass(frozen=True)
class OwnerDocumentManifest:
    transfer_id: str
    remote_filename: str
    sha256: str
    size_bytes: int
    device_id: str
    account_username: str
    phone_profile: str
    download_id: str
    document_uri: str
    staging_destination: str
    method: str = "owner_document_share"
    source_profile: str = "0"


@dataclass(frozen=True)
class PreparedOwnerDocumentSelection:
    manifest: OwnerDocumentManifest


@dataclass(frozen=True)
class VerifiedOwnerDocumentSelection:
    prepared: PreparedOwnerDocumentSelection
    reservation_id: str
    dispatch_id: str


@dataclass(frozen=True)
class _PickerNode:
    media_kind: str
    bounds: tuple[int, int, int, int]
    selected: bool


# The JS planner has minted TWO 8-hex segments (path hash + transfer hash) since
# fd7da146 (2026-07-22): sp_<sha256>_<pathhash>_<transferhash><ext>. This pattern
# only accepted one, so every manifest item the desktop produced would have been
# rejected here on arity alone. Both arities stay accepted so a frozen server.exe
# built before that commit keeps working.
_GENERATED_MEDIA_NAME = re.compile(
    r"^sp_([a-f0-9]{64})_[a-f0-9]{8}(?:_[a-f0-9]{8})?\."
    r"(jpg|jpeg|png|webp|mp4|mov|avi|mkv|webm)$"
)
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_TRANSFER_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
_MEDIASTORE_PROJECTION = "_id:_display_name:_size:mime_type:_data"
_MEDIASTORE_COLLECTIONS = {
    "photo": "content://media/external/images/media",
    "video": "content://media/external/video/media",
}
_MEDIASTORE_ROW = re.compile(
    r"Row:\s*\d+\s+_id=(?P<media_id>\d+),\s*"
    r"_display_name=(?P<display_name>.*?),\s*"
    r"_size=(?P<size_bytes>\d+|NULL),\s*"
    r"mime_type=(?P<mime_type>.*?),\s*"
    r"_data=(?P<data_path>.*)$"
)
_BOUNDS = re.compile(r"^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$")


def _required_string(item: dict, field: str) -> str:
    value = item.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ExactContentSelectionError(f"content manifest {field} is required")
    return value.strip()


def _normalize_account(value: object) -> str:
    return str(value or "").strip().lstrip("@").lower()


def _validate_exact_manifest(
    config: dict,
    expected_content_types: set[str],
    device_id: str,
) -> Optional[ExactContentManifest]:
    raw = config.get("content_manifest_item")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ExactContentSelectionError("content_manifest_item must be an object")

    transfer_id = _required_string(raw, "transfer_id")
    if not _TRANSFER_ID.fullmatch(transfer_id):
        raise ExactContentSelectionError("content manifest transfer_id is malformed")
    configured_transfer = str(config.get("transfer_id") or "").strip()
    if configured_transfer and configured_transfer != transfer_id:
        raise ExactContentSelectionError("content manifest transfer_id does not match the run")

    sha256 = _required_string(raw, "sha256")
    if not _SHA256.fullmatch(sha256):
        raise ExactContentSelectionError("content manifest sha256 must be 64 lowercase hex characters")

    remote_filename = _required_string(raw, "remote_filename")
    filename_match = _GENERATED_MEDIA_NAME.fullmatch(remote_filename)
    if not filename_match or filename_match.group(1) != sha256:
        raise ExactContentSelectionError(
            "content manifest remote_filename must be the generated "
            "sp_<sha256>_<pathhash>[_<transferhash>] name"
        )

    content_type = _required_string(raw, "content_type").lower()
    normalized_expected = {str(value).strip().lower() for value in expected_content_types}
    if content_type not in normalized_expected:
        raise ExactContentSelectionError(
            f"content manifest content_type={content_type!r} is not valid for this module"
        )

    extension = filename_match.group(2)
    media_kind = "photo" if extension in _IMAGE_EXTENSIONS else "video"
    if content_type == "image" and media_kind != "photo":
        raise ExactContentSelectionError("image manifest remote_filename is not an image")
    if content_type == "reel" and media_kind != "video":
        raise ExactContentSelectionError("reel manifest remote_filename is not a video")

    try:
        size_bytes = int(raw.get("size_bytes"))
    except (TypeError, ValueError):
        raise ExactContentSelectionError("content manifest size_bytes must be an integer")
    if size_bytes <= 0:
        raise ExactContentSelectionError("content manifest size_bytes must be positive")

    phone_profile = _required_string(raw, "phone_profile")
    if not phone_profile.isdigit():
        raise ExactContentSelectionError("content manifest phone_profile must be numeric")
    configured_profile = str(config.get("target_user") or "").strip()
    if configured_profile and not configured_profile.isdigit():
        raise ExactContentSelectionError(
            "exact content selection target_user must be a numeric Android profile"
        )
    if configured_profile and configured_profile != phone_profile:
        raise ExactContentSelectionError(
            "content manifest phone profile does not match the requested profile"
        )

    phone_destination = _required_string(raw, "phone_destination").replace("\\", "/")
    destination_path = PurePosixPath(phone_destination)
    if not destination_path.is_absolute() or destination_path.name != remote_filename:
        raise ExactContentSelectionError(
            "content manifest phone_destination does not end in remote_filename"
        )
    if ".." in destination_path.parts or "\n" in phone_destination or "\r" in phone_destination:
        raise ExactContentSelectionError("content manifest phone_destination is unsafe")

    manifest_device = _required_string(raw, "device_id")
    if not device_id or manifest_device != str(device_id):
        raise ExactContentSelectionError(
            "content manifest device_id does not match the executing device"
        )

    account_username = _normalize_account(raw.get("account_username"))
    if not account_username:
        raise ExactContentSelectionError("content manifest account_username is required")
    configured_account = _normalize_account(config.get("account_username"))
    if not configured_account:
        raise ExactContentSelectionError(
            "exact content selection config account_username is required"
        )
    if configured_account != account_username:
        raise ExactContentSelectionError(
            "content manifest account_username does not match the run"
        )

    if raw.get("device_selection") != "pending_exact_gallery_selection":
        raise ExactContentSelectionError(
            "content manifest is missing the pending exact-selection marker"
        )

    return ExactContentManifest(
        transfer_id=transfer_id,
        remote_filename=remote_filename,
        sha256=sha256,
        size_bytes=size_bytes,
        content_type=content_type,
        phone_profile=phone_profile,
        phone_destination=phone_destination,
        device_id=manifest_device,
        account_username=account_username,
        media_kind=media_kind,
    )


def _parse_int(value: str) -> int:
    return int(value) if value and value != "NULL" else 0


def _parse_mediastore_rows(
    output: str,
    media_kind: str,
    collection_uri: str,
) -> list[MediaStoreItem]:
    rows = []
    for line in (output or "").splitlines():
        match = _MEDIASTORE_ROW.search(line.strip())
        if not match:
            continue
        rows.append(
            MediaStoreItem(
                media_id=int(match.group("media_id")),
                display_name=match.group("display_name"),
                size_bytes=_parse_int(match.group("size_bytes")),
                mime_type=match.group("mime_type"),
                data_path=match.group("data_path").strip(),
                media_kind=media_kind,
                collection_uri=collection_uri,
            )
        )
    return rows


async def _strict_active_user(device) -> str:
    try:
        active_user = (await device.shell("am get-current-user") or "").strip()
    except Exception as error:
        raise ExactContentSelectionError(
            f"could not read the active Android profile: {error}"
        )
    if not active_user.isdigit():
        raise ExactContentSelectionError("active Android profile was not numeric")
    return active_user


async def _remote_sha256(device, item: MediaStoreItem, profile: str) -> str:
    outputs = []
    # `device.shell` runs as the shell user, so a bare sha256sum can only ever
    # read user 0's storage. Gated to profile 0 rather than left to fail through:
    # reading another profile's data_path unscoped violates the no-cross-profile
    # rule even when it happens to return nothing today.
    if profile == "0" and item.data_path and item.data_path != "NULL":
        data_path = PurePosixPath(item.data_path.replace("\\", "/"))
        if (
            data_path.is_absolute()
            and ".." not in data_path.parts
            and "\n" not in item.data_path
            and "\r" not in item.data_path
        ):
            outputs.append(
                await device.shell(
                    f"sha256sum {shlex.quote(str(data_path))} 2>/dev/null || true"
                )
                or ""
            )
    if not any(re.search(r"\b[a-fA-F0-9]{64}\b", output) for output in outputs):
        content_uri = f"{item.collection_uri}/{item.media_id}"
        outputs.append(
            await device.shell(
                f"content read --user {profile} --uri {content_uri} 2>/dev/null | sha256sum"
            )
            or ""
        )
    for output in outputs:
        match = re.search(r"\b([a-fA-F0-9]{64})\b", output)
        if match:
            return match.group(1).lower()
    raise ExactContentSelectionError("could not verify the MediaStore item sha256")


async def prepare_exact_content_selection(
    device,
    config: dict,
    expected_content_types: set[str],
    picker_media_kinds: set[str],
) -> Optional[PreparedExactContentSelection]:
    manifest = _validate_exact_manifest(
        config,
        expected_content_types,
        getattr(device, "device_id", ""),
    )
    if manifest is None:
        return None

    normalized_picker_kinds = {str(value).strip().lower() for value in picker_media_kinds}
    if not normalized_picker_kinds or not normalized_picker_kinds.issubset({"photo", "video"}):
        raise ExactContentSelectionError("picker media kinds must be photo and/or video")
    if manifest.media_kind not in normalized_picker_kinds:
        raise ExactContentSelectionError(
            "content manifest media type is not shown by this Instagram picker"
        )

    active_user = await _strict_active_user(device)
    if active_user != manifest.phone_profile:
        raise ExactContentSelectionError(
            "content manifest phone profile is not the active Android profile"
        )

    rows = []
    for media_kind in ("photo", "video"):
        if media_kind not in normalized_picker_kinds:
            continue
        uri = _MEDIASTORE_COLLECTIONS[media_kind]
        output = await device.shell(
            f"content query --user {active_user} --uri {uri} "
            f"--projection {_MEDIASTORE_PROJECTION} 2>/dev/null"
        )
        rows.extend(_parse_mediastore_rows(output or "", media_kind, uri))

    matches = [item for item in rows if item.display_name == manifest.remote_filename]
    if not matches:
        raise ExactContentSelectionError(
            "exact content manifest item is absent from the active profile MediaStore"
        )
    if len(matches) != 1:
        raise ExactContentSelectionError(
            "exact content manifest filename is not unique in MediaStore"
        )
    if len(rows) != 1:
        raise ExactContentSelectionError(
            "exact MediaStore-to-picker mapping is ambiguous; exact mode requires "
            "one picker-eligible MediaStore row on the active profile"
        )
    media_item = matches[0]
    if media_item.media_kind != manifest.media_kind:
        raise ExactContentSelectionError("MediaStore item type does not match the manifest")
    if media_item.size_bytes != manifest.size_bytes:
        raise ExactContentSelectionError("MediaStore item size does not match the manifest")
    if media_item.media_kind == "photo" and not media_item.mime_type.startswith("image/"):
        raise ExactContentSelectionError("MediaStore item MIME type is not an image")
    if media_item.media_kind == "video" and not media_item.mime_type.startswith("video/"):
        raise ExactContentSelectionError("MediaStore item MIME type is not a video")
    if (
        media_item.data_path
        and media_item.data_path != "NULL"
        and PurePosixPath(media_item.data_path.replace("\\", "/")).name
        != manifest.remote_filename
    ):
        raise ExactContentSelectionError("MediaStore path does not match remote_filename")

    remote_hash = await _remote_sha256(device, media_item, active_user)
    if remote_hash != manifest.sha256:
        raise ExactContentSelectionError("MediaStore item sha256 does not match the manifest")

    return PreparedExactContentSelection(
        manifest=manifest,
        media_item=media_item,
        picker_index=0,
        picker_kinds=(media_item.media_kind,),
    )


async def prepare_owner_document_selection(device, config: dict) -> PreparedOwnerDocumentSelection:
    raw = config.get("content_manifest_item")
    if not isinstance(raw, dict) or raw.get("method") != "owner_document_share":
        raise ExactContentSelectionError("Owner document manifest method is required")
    if raw.get("content_type") != "image" or config.get("content_type") != "image":
        raise ExactContentSelectionError("Owner document sharing supports one Feed PNG only")
    if config.get("enable_audio") is not False or config.get("add_music_to_images") is not False:
        raise ExactContentSelectionError("Disable both image audio options before using Owner document sharing")
    if config.get("enable_trial") or config.get("trial_mode"):
        raise ExactContentSelectionError("Owner document sharing does not support trial Reels")
    if (raw.get("allowed_post_module") != "post_feed"
            or raw.get("device_selection") != "pending_exact_document_share"
            or raw.get("source_profile") != "0" or "phone_destination" in raw):
        raise ExactContentSelectionError("Owner document manifest scope or selection marker is invalid")

    transfer_id = _required_string(raw, "transfer_id")
    if not _TRANSFER_ID.fullmatch(transfer_id) or config.get("transfer_id") != transfer_id:
        raise ExactContentSelectionError("Owner document transfer_id does not match the run")
    sha256 = _required_string(raw, "sha256")
    remote_filename = _required_string(raw, "remote_filename")
    if not _SHA256.fullmatch(sha256) or not re.fullmatch(
        rf"sp_{sha256}_[a-f0-9]{{8}}_[a-f0-9]{{8}}\.png", remote_filename
    ):
        raise ExactContentSelectionError("Owner document requires the generated exact PNG filename and sha256")
    size_bytes = raw.get("size_bytes")
    if type(size_bytes) is not int or size_bytes <= 0:
        raise ExactContentSelectionError("Owner document size_bytes must be a positive integer")
    phone_profile = _required_string(raw, "phone_profile")
    if not re.fullmatch(r"[1-9][0-9]*", phone_profile) or str(config.get("target_user")) != phone_profile:
        raise ExactContentSelectionError("Owner document target profile does not match the run")
    device_id = _required_string(raw, "device_id")
    if device_id != getattr(device, "device_id", None):
        raise ExactContentSelectionError("Owner document device_id does not match the executing device")
    account_username = _required_string(raw, "account_username")
    if (not re.fullmatch(r"[a-z0-9._]{1,30}", account_username)
            or _normalize_account(config.get("account_username")) != account_username):
        raise ExactContentSelectionError("Owner document requires the configured Instagram account handle")
    download_id = _required_string(raw, "download_id")
    document_uri = _required_string(raw, "document_uri")
    staging_destination = _required_string(raw, "staging_destination")
    if (not re.fullmatch(r"[1-9][0-9]*", download_id)
            or document_uri != f"content://0@com.android.providers.downloads.documents/document/{download_id}"
            or staging_destination != f"/storage/emulated/0/Download/{remote_filename}"):
        raise ExactContentSelectionError("Owner document URI or staging destination is invalid")
    if await _strict_active_user(device) != phone_profile:
        raise ExactContentSelectionError("Owner document target is not the active Android profile")
    return PreparedOwnerDocumentSelection(OwnerDocumentManifest(
        transfer_id, remote_filename, sha256, size_bytes, device_id, account_username,
        phone_profile, download_id, document_uri, staging_destination,
    ))


def owner_document_editor_next(xml: str) -> tuple[int, int]:
    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError as error:
        raise ExactContentSelectionError("Owner document Feed editor XML is unavailable") from error
    prefix = "com.instagram.android:id/"
    nodes = list(root.iter())
    inactive = {child for node in nodes
                if node.get("enabled") == "false" or node.get("visible-to-user") == "false"
                for child in node.iter()}
    editors = [node for node in root.iter() if node.get("resource-id") == prefix + "quick_edit_fragment"]
    compressed = not editors
    if compressed:
        editors = [node for node in nodes if node.get("resource-id") == prefix + "quick_edit_compose_view"
                   and node.get("class") == "androidx.compose.ui.platform.ComposeView"]
    if len(editors) != 1 or editors[0] in inactive:
        raise ExactContentSelectionError("Owner document did not reach the observed Feed editor")
    if compressed:
        foreign_prefixes = tuple(prefix + name for name in (
            "clips_", "reel_", "story_", "gallery_grid", "gallery_picker", "gallery_recycler_view",
            "dialog_container", "modal_container", "igds_alert_dialog", "igds_headline", "bottom_sheet", "share_sheet",
        ))
        if any(node not in inactive and node.get("resource-id", "").startswith(foreign_prefixes)
               and node.get("resource-id") != prefix + "bottom_sheet_camera_container" for node in nodes):
            raise ExactContentSelectionError("Owner document photo editor is obscured by another screen")
        toolbars = [node for node in editors[0].iter()
                    if node.get("class") == "android.widget.HorizontalScrollView" and node not in inactive]
        if len(toolbars) != 1 or not {"Audio", "Text", "Overlay", "Filter", "Edit", "Ratio"} <= {
            label for node in toolbars[0].iter() if node not in inactive
            for label in (node.get("text"), node.get("content-desc")) if label
        }:
            raise ExactContentSelectionError("Owner document photo editing controls are unverified")
        trays = [node for node in nodes if node.get("resource-id") == prefix + "gallery_media_thumbnail_tray"]
        if len(trays) != 1 or trays[0] not in list(editors[0].iter()):
            raise ExactContentSelectionError("Owner document Feed thumbnail tray is unverified")
    else:
        controls = [node for node in editors[0].iter() if node.get("resource-id") == prefix + "feed_post_capture_controls_container"]
        if len(controls) != 1:
            raise ExactContentSelectionError("Owner document Feed editor controls are unverified")
        trays = [node for node in editors[0].iter() if node.get("resource-id") == prefix + "media_thumbnail_tray_constraintlayout"]
    if len(trays) != 1 or trays[0] in inactive:
        raise ExactContentSelectionError("Owner document Feed thumbnail tray is unverified")
    thumbnails = [node for node in root.iter() if node.get("resource-id") == prefix + "thumbnail_image"]
    if (len(thumbnails) != 1 or thumbnails[0].get("content-desc") != "Selected photo"
            or thumbnails[0] in inactive or thumbnails[0] not in list(trays[0].iter())):
        raise ExactContentSelectionError("Owner document editor must expose exactly one Selected photo")
    buttons = [node for node in trays[0].iter()
               if node.get("resource-id") == prefix + "media_thumbnail_tray_button"]
    if (len(buttons) != 1 or buttons[0].get("content-desc") != "Next"
            or buttons[0].get("clickable") != "true" or buttons[0] in inactive):
        raise ExactContentSelectionError("Owner document editor Next is unverified")
    if compressed:
        lists = [node for node in trays[0] if node.get("resource-id") == prefix + "media_thumbnail_tray"
                 and node.get("class") == "androidx.recyclerview.widget.RecyclerView"]
        next_layouts = [node for node in trays[0] if node.get("resource-id") == prefix + "media_thumbnail_tray_next_buttons_layout"]
        if (len(lists) != 1 or len(list(lists[0])) != 1 or thumbnails[0] not in list(lists[0].iter())
                or thumbnails[0].get("class") != "android.widget.ImageView"
                or len(next_layouts) != 1 or buttons[0] not in list(next_layouts[0])
                or buttons[0].get("class") != "android.widget.Button"):
            raise ExactContentSelectionError("Owner document photo and Next do not share the observed tray")
    match = _BOUNDS.fullmatch(buttons[0].get("bounds", ""))
    if not match:
        raise ExactContentSelectionError("Owner document editor Next bounds are unavailable")
    left, top, right, bottom = map(int, match.groups())
    if right <= left or bottom <= top:
        raise ExactContentSelectionError("Owner document editor Next bounds are invalid")
    return (left + right) // 2, (top + bottom) // 2


async def share_prepared_owner_document(device, prepared, *, verified_account, on_dispatched=None) -> VerifiedOwnerDocumentSelection:
    manifest = prepared.manifest
    if not verified_account or _normalize_account(verified_account) != manifest.account_username:
        raise ExactContentSelectionError("Owner document sharing requires a verified matching on-screen account")
    if await _strict_active_user(device) != manifest.phone_profile:
        raise ExactContentSelectionError("Owner document target profile changed before sharing")
    try:
        reply = await device.device.send_command(
            "share_owner_document", {"transfer_id": manifest.transfer_id}, get_screen=False,
        )
    except Exception as error:
        raise ExactContentSelectionError("Owner document share command failed") from error
    if not isinstance(reply, dict) or reply.get("success") is not True:
        raise ExactContentSelectionError("Owner document command envelope failed")
    data = reply.get("data")
    if not isinstance(data, dict) or data.get("success") is not True:
        raise ExactContentSelectionError("Owner document executor did not confirm dispatch")
    expected = {key: getattr(manifest, key) for key in (
        "method", "transfer_id", "device_id", "account_username", "source_profile", "phone_profile",
        "download_id", "document_uri", "remote_filename", "size_bytes", "sha256",
    )}
    expected.update({
        "success": True, "action": "share_owner_document",
        "component": "com.instagram.android/com.instagram.share.handleractivity.ShareHandlerActivity",
        "uri_grant": "read", "selection_verified": "exact_document_bytes", "share_dispatched": True,
    })
    if set(data) != set(expected) | {"reservation_id", "dispatch_id"}:
        raise ExactContentSelectionError("Owner document executor returned an invalid proof schema")
    for key, value in expected.items():
        if type(data[key]) is not type(value) or data[key] != value:
            raise ExactContentSelectionError(f"Owner document executor proof mismatch: {key}")
    for key in ("reservation_id", "dispatch_id"):
        if not isinstance(data[key], str) or not re.fullmatch(
            r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", data[key]
        ):
            raise ExactContentSelectionError(f"Owner document executor {key} is invalid")
    selection = VerifiedOwnerDocumentSelection(prepared, data["reservation_id"], data["dispatch_id"])
    if on_dispatched is not None:
        on_dispatched(selection)
    await device.refresh_screen(force=True)
    from lib.ws_modules_shared import raise_if_instagram_verification
    await raise_if_instagram_verification(device, stage="owner_document_editor", xml=device.page_source)
    owner_document_editor_next(device.page_source or "")
    return selection


def build_owner_document_selection_proof(selection, *, publish_confirmed: bool) -> Optional[dict]:
    if not isinstance(selection, VerifiedOwnerDocumentSelection) or not publish_confirmed:
        return None
    manifest = selection.prepared.manifest
    return {
        **{key: getattr(manifest, key) for key in (
            "transfer_id", "remote_filename", "sha256", "method", "source_profile", "phone_profile",
            "download_id", "document_uri", "device_id", "account_username", "size_bytes",
        )},
        "reservation_id": selection.reservation_id, "dispatch_id": selection.dispatch_id,
        "selection_verified": "exact", "publish_confirmed": True,
    }


def _picker_nodes(xml: str) -> list[_PickerNode]:
    try:
        root = ElementTree.fromstring(xml or "<hierarchy />")
    except ElementTree.ParseError as error:
        raise ExactContentSelectionError(f"Instagram picker XML is malformed: {error}")

    nodes = []
    for element in root.iter():
        description = element.attrib.get("content-desc", "")
        kind_match = re.search(r"\b(Photo|Video) thumbnail\b", description, re.IGNORECASE)
        if not kind_match:
            continue
        bounds_match = _BOUNDS.fullmatch(element.attrib.get("bounds", ""))
        if not bounds_match:
            continue
        bounds = tuple(int(value) for value in bounds_match.groups())
        selected = (
            description.lower().startswith("selected ")
            or element.attrib.get("selected", "").lower() == "true"
            or element.attrib.get("checked", "").lower() == "true"
        )
        nodes.append(
            _PickerNode(
                media_kind="photo" if kind_match.group(1).lower() == "photo" else "video",
                bounds=bounds,
                selected=selected,
            )
        )
    nodes.sort(key=lambda node: (node.bounds[1], node.bounds[0]))
    return nodes


def _verified_selection(
    prepared: PreparedExactContentSelection,
    node: _PickerNode,
) -> VerifiedExactContentSelection:
    return VerifiedExactContentSelection(prepared=prepared, picker_bounds=node.bounds)


async def select_prepared_exact_content(
    device,
    prepared: PreparedExactContentSelection,
    *,
    require_selected_marker: bool,
    transition_markers: Iterable[str] = (),
    attempts: int = 6,
    interval: float = 0.4,
) -> VerifiedExactContentSelection:
    await device.refresh_screen(force=True)
    nodes = _picker_nodes(device.page_source or "")
    if len(nodes) != 1:
        raise ExactContentSelectionError(
            "Instagram picker does not expose a one-to-one thumbnail for the "
            "single exact MediaStore row"
        )
    index = prepared.picker_index
    if index >= len(nodes):
        raise ExactContentSelectionError(
            f"MediaStore picker index {index} is not visible in the Instagram picker"
        )
    expected_kinds = prepared.picker_kinds[: index + 1]
    actual_kinds = tuple(node.media_kind for node in nodes[: index + 1])
    if actual_kinds != expected_kinds:
        raise ExactContentSelectionError(
            "Instagram picker selector order does not match the MediaStore index"
        )

    target_node = nodes[index]
    if target_node.media_kind != prepared.media_item.media_kind:
        raise ExactContentSelectionError(
            "Instagram picker selector type does not match the exact MediaStore item"
        )

    if require_selected_marker and target_node.selected:
        return _verified_selection(prepared, target_node)

    selected_before_tap = target_node.selected
    markers = tuple(str(marker) for marker in transition_markers if str(marker))
    markers_before_tap = {marker for marker in markers if marker in (device.page_source or "")}
    x1, y1, x2, y2 = target_node.bounds
    await device.tap((x1 + x2) // 2, (y1 + y2) // 2)
    for attempt in range(max(1, attempts)):
        if attempt and interval > 0:
            await asyncio.sleep(interval)
        await device.refresh_screen(force=True)
        xml = device.page_source or ""
        current_nodes = _picker_nodes(xml)
        for current in current_nodes:
            if current.bounds == target_node.bounds and current.media_kind == target_node.media_kind:
                if not selected_before_tap and current.selected:
                    return _verified_selection(prepared, current)
                break
        present_markers = {marker for marker in markers if marker in xml}
        if present_markers - markers_before_tap:
            return _verified_selection(prepared, target_node)

    requirement = "selected-node marker" if require_selected_marker else "verified editor transition"
    raise ExactContentSelectionError(
        f"Instagram did not expose the {requirement} for the exact picker item"
    )


def build_exact_content_selection_proof(
    selection: Optional[VerifiedExactContentSelection | VerifiedOwnerDocumentSelection],
    *,
    publish_confirmed: bool,
) -> Optional[dict]:
    if selection is None or not publish_confirmed:
        return None
    if isinstance(selection, VerifiedOwnerDocumentSelection):
        return build_owner_document_selection_proof(selection, publish_confirmed=publish_confirmed)
    manifest = selection.prepared.manifest
    return {
        "transfer_id": manifest.transfer_id,
        "remote_filename": manifest.remote_filename,
        "sha256": manifest.sha256,
        "selection_verified": "exact",
        "publish_confirmed": True,
    }


def with_exact_content_selection_proof(
    result: dict,
    selection: Optional[VerifiedExactContentSelection | VerifiedOwnerDocumentSelection],
    *,
    publish_confirmed: bool,
) -> dict:
    proof = build_exact_content_selection_proof(
        selection,
        publish_confirmed=publish_confirmed,
    )
    if proof is None:
        return result
    existing_data = result.get("data")
    flat_data = {
        key: value
        for key, value in result.items()
        if key not in {"success", "error", "data"}
    }
    finalized = {
        "success": result.get("success", True),
        "data": {
            **flat_data,
            **(existing_data if isinstance(existing_data, dict) else {}),
            "content_selection": proof,
        },
    }
    if "error" in result:
        finalized["error"] = result["error"]
    return finalized


async def classify_current_posting_screen(device) -> Optional[object]:
    try:
        observation = await device.refresh_screen_observation()
        return classify_instagram_screen(observation=observation)
    except Exception:
        return None


async def verify_posting_screen(device, expected_screens: Iterable[str], context_label: str) -> PostingVerificationResult:
    classification = await classify_current_posting_screen(device)
    if not classification:
        await device.send_log(f"{context_label}: classifier unavailable or inconclusive")
        return PostingVerificationResult(False, "unknown", "low", context_label)

    await device.send_log(
        f"{context_label}: classified {classification.screen_type} ({classification.confidence})"
    )
    return PostingVerificationResult(
        ok=classification.screen_type in set(expected_screens),
        screen_type=classification.screen_type,
        confidence=classification.confidence,
        context_label=context_label,
    )


async def verify_feed_gallery(device) -> PostingVerificationResult:
    return await verify_posting_screen(
        device,
        [IG_CREATE_POST_GALLERY, IG_MEDIA_SELECTED],
        "POST gallery verification",
    )


async def verify_media_selected(device) -> PostingVerificationResult:
    return await verify_posting_screen(
        device,
        [IG_CREATE_POST_GALLERY, IG_MEDIA_SELECTED],
        "Media selection verification",
    )


async def verify_feed_caption_editor(device) -> PostingVerificationResult:
    return await verify_posting_screen(
        device,
        [IG_CAPTION_EDITOR],
        "Caption screen verification",
    )


async def verify_story_gallery(device) -> PostingVerificationResult:
    return await verify_posting_screen(
        device,
        [IG_CREATE_POST_GALLERY],
        "Story gallery verification",
    )


async def verify_story_editor(device) -> PostingVerificationResult:
    return await verify_posting_screen(
        device,
        [IG_STORY_EDITOR],
        "Story editor verification",
    )


async def verify_feed_submission_confirmed(device) -> PostingVerificationResult:
    return await verify_posting_screen(
        device,
        [IG_HOME, IG_PROFILE],
        "Feed submission confirmation",
    )


async def verify_story_submission_confirmed(device) -> PostingVerificationResult:
    return await verify_posting_screen(
        device,
        [IG_HOME, IG_PROFILE],
        "Story submission confirmation",
    )


def _navigation_guards_for_device(device):
    return BootstrapProfileGuards(
        lambda: ScreenObservation(
            observed_at="posting_runtime_observation",
            device_id=getattr(device, "device_id", "unknown-device"),
            package=getattr(device, "current_package", None),
            activity=getattr(device, "current_activity", None),
            xml_source=getattr(device, "screen_xml", "") or "",
        ),
        log=lambda msg: None if not hasattr(device, "send_log") else None,
    )


async def nudge_toward_home_or_profile(device) -> bool:
    guards = _navigation_guards_for_device(device)
    return await guards.nudge_via_existing_nav(
        primary_action=lambda: device.navigate_home() if hasattr(device, "navigate_home") else False,
        fallback_action=lambda: device.tap(984, 2274, wait_after=1000) if hasattr(device, "tap") else False,
    )


async def confirm_submission_with_recovery(
    device,
    verify_fn: Callable[[object], Awaitable[PostingVerificationResult]],
    context_label: str,
    recovery_action: Optional[Callable[[], Awaitable[bool] | bool]] = None,
    settle_seconds: float = 1.0,
) -> PostingVerificationResult:
    first = await verify_fn(device)
    if first.ok and first.confidence == "high":
        return first

    if recovery_action:
        try:
            await device.send_log(
                f"{context_label}: first confirmation inconclusive; attempting bounded recovery"
            )
            recovered = recovery_action()
            if asyncio.iscoroutine(recovered):
                recovered = await recovered
            if recovered:
                await asyncio.sleep(settle_seconds)
                second = await verify_fn(device)
                if second.ok:
                    second.context_label = f"{second.context_label} (recovered)"
                return second
        except Exception as e:
            await device.send_log(
                f"{context_label}: recovery attempt failed: {e}",
                "WARN",
            )

    return first
