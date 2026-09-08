# Module: edit_profile
# IG profile editor built from a live walk-through on a fresh
# zarahahn144 / hahn_berg account (2026-05-20). Two critical findings
# baked in:
#
#   1. Modern IG (build 412.x) uses a SUB-SCREEN per field — tapping a
#      row on the main edit form opens a dedicated activity with one
#      EditText + a Done button in the action bar. The legacy code's
#      "inline form" assumption is wrong on current builds.
#   2. Fresh accounts (<24h old) flag instantly on multi-field edits
#      done in quick succession. The new module:
#        - detects IG's 'Confirm you are human' challenge after every
#          field save and bails with manual_action_required.
#        - inserts a jittered human-paced delay between fields
#          (configurable via field_delay_min_ms / field_delay_max_ms).
#
# Supports: name, username, bio, link, switch_to_professional wizard
# (account_type business|creator, professional_category).

import asyncio
import random
import re
import xml.etree.ElementTree as ET
from typing import Optional

from lib.ws_modules_shared import WSDeviceAdapter
from lib.posting_progression_guards import verified_profile_username


IG_PKG = "com.instagram.android"

# Resource IDs for the row containers on the main edit-profile form.
FIELD_ROW_RID = {
    "name": "com.instagram.android:id/full_name",
    "username": "com.instagram.android:id/username",
    "bio": "com.instagram.android:id/bio",
}
FIELD_ROW_LABEL = {
    "name": "Name",
    "username": "Username",
    "bio": "Bio",
}

# Sub-screen elements (same across all three field types).
SUBSCREEN_EDITTEXT_RID = "com.instagram.android:id/prism_form_field_container"
ACTION_BAR_DONE_RID = "com.instagram.android:id/action_bar_button_action"

# Edit Profile main-form anchors.
EDIT_PROFILE_FIELDS_RID = "com.instagram.android:id/edit_profile_fields"
EDIT_PROFILE_BUTTON_CONTAINER_RID = "com.instagram.android:id/button_container"

# Professional switch entry.
BUSINESS_CONVERSION_ENTRY_RID = "com.instagram.android:id/business_conversion_entry"

# Confirm-name/username dialog primary button.
CONFIRM_DIALOG_PRIMARY_RID = "com.instagram.android:id/igds_alert_dialog_primary_button"

CONFIRM_TEXTS = (
    "Change name", "Change Name", "Change username", "Change Username",
    "Keep username", "Keep both", "Change", "Confirm",
)

# Checkpoint detection.
CHECKPOINT_PHRASES = (
    "confirm you're human to use your account",
    "confirm you are human to use your account",
)


# ── helpers ───────────────────────────────────────────────────────────


def _coerce_bool(value, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        n = value.strip().lower()
        if n in ("true", "1", "yes", "y", "on"):
            return True
        if n in ("false", "0", "no", "n", "off"):
            return False
    return default


def _clean(value) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        value = str(value)
    value = value.strip()
    return value or None


def _normalize_xml(xml: str) -> str:
    return (xml or "").lower().replace("’", "'").replace("‘", "'")


async def _log(device: WSDeviceAdapter, msg: str) -> None:
    print(f"[edit_profile] {msg}")
    try:
        await device.device.send_log(msg)
    except Exception:
        pass


async def _progress(device: WSDeviceAdapter, pct: int, msg: str) -> None:
    print(f"[edit_profile] [{pct}%] {msg}")
    try:
        await device.device.send_progress(pct, msg)
    except Exception:
        pass


async def _refresh(device: WSDeviceAdapter) -> str:
    await device.refresh_screen(force=True)
    return device.page_source or ""


async def _is_checkpoint(device: WSDeviceAdapter, xml: Optional[str] = None) -> bool:
    if xml is None:
        xml = await _refresh(device)
    norm = _normalize_xml(xml)
    if not any(phrase in norm for phrase in CHECKPOINT_PHRASES):
        return False
    return (
        ("content-desc=\"continue\"" in norm or "text=\"continue\"" in norm)
        and "package=\"com.instagram.android\"" in norm
    )


def _checkpoint_error(stage: str) -> dict:
    return {
        "success": False,
        "error": (
            "Instagram checkpoint detected: 'Confirm you're human to use "
            "your account'. Manual verification/2FA is required."
        ),
        "data": {
            "checkpoint": "ig_confirm_human",
            "stage": stage,
            "manual_action_required": True,
        },
    }


async def _tap_first(
    device: WSDeviceAdapter,
    *,
    rids: tuple = (),
    descs: tuple = (),
    texts: tuple = (),
    wait_after: float = 0.4,
) -> bool:
    for rid in rids:
        el = await device.find_element_by_id(rid)
        if el:
            await device.click(el)
            await asyncio.sleep(wait_after)
            return True
    for desc in descs:
        el = await device.find_element_by_content_desc(desc)
        if el:
            await device.click(el)
            await asyncio.sleep(wait_after)
            return True
    for text in texts:
        el = await device.find_element_by_text(text)
        if el:
            await device.click(el)
            await asyncio.sleep(wait_after)
            return True
    return False


async def _human_pause(min_ms: int, max_ms: int) -> None:
    """Jittered pause between actions to look less bot-like."""
    if max_ms <= 0:
        return
    delay = random.uniform(max(0, min_ms), max(min_ms, max_ms)) / 1000.0
    await asyncio.sleep(delay)


def _row_bounds_from_xml(xml: str, rid: str) -> Optional[tuple[int, int, int, int]]:
    """Look up bounds for a row by resource-id. Returns (x1, y1, x2, y2)."""
    pattern = (
        r'<node[^>]*resource-id="'
        + re.escape(rid)
        + r'"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
    )
    m = re.search(pattern, xml or "")
    if m:
        return tuple(int(m.group(i)) for i in (1, 2, 3, 4))
    return None


# ── navigation ────────────────────────────────────────────────────────


async def _on_edit_profile_form(xml: str) -> bool:
    low = (xml or "").lower()
    return EDIT_PROFILE_FIELDS_RID in low and any(
        rid in low for rid in FIELD_ROW_RID.values()
    )


async def _goto_profile_tab(device: WSDeviceAdapter, *, require_profile: bool = False) -> bool:
    for _ in range(6):
        xml = await _refresh(device)
        if await _on_edit_profile_form(xml):
            if not require_profile:
                return True
            if not await _tap_first(device, descs=("Back",)):
                return False
            continue
        try:
            nodes = list(ET.fromstring(xml).iter("node"))
        except ET.ParseError:
            return False

        profile_tab = next((node for node in nodes if node.get("resource-id") ==
                            "com.instagram.android:id/profile_tab"), None)
        edit_button = any(node.get("content-desc", "").lower() == "edit profile"
                          or node.get("text", "").lower() == "edit profile"
                          for node in nodes)
        if profile_tab is not None and any(node.get("selected") == "true" for node in profile_tab.iter()) and edit_button:
            return True
        if profile_tab is not None:
            if not await _tap_first(device, rids=("com.instagram.android:id/profile_tab",)):
                return False
        elif any(node.get("content-desc") == "Back" and node.get("clickable") == "true"
                 for node in nodes):
            if not await _tap_first(device, descs=("Back",)):
                return False
        else:
            return False
    return False


async def _open_edit_profile(device: WSDeviceAdapter) -> bool:
    xml = await _refresh(device)
    if await _on_edit_profile_form(xml):
        return True

    # The "Edit profile" button on this IG build has content-desc="Edit
    # profile" on a Button with resource-id `button_container` (NOT
    # row_profile_header_edit_profile_button which was the old id).
    return await _tap_first(
        device,
        descs=("Edit profile", "Edit Profile"),
        rids=(
            "com.instagram.android:id/row_profile_header_edit_profile_button",
        ),
        texts=("Edit profile", "Edit Profile"),
        wait_after=0.8,
    )


async def _ensure_back_to_edit_form(device: WSDeviceAdapter, max_attempts: int = 3) -> bool:
    """If we're not on the main edit-profile form, press back until we are."""
    for _ in range(max_attempts):
        xml = await _refresh(device)
        if await _on_edit_profile_form(xml):
            return True
        await device.back()
        await asyncio.sleep(0.4)
    return False


# ── field edit (sub-screen pattern) ───────────────────────────────────


def _has_editor_dialog(nodes) -> bool:
    return any(node.get("visible-to-user") != "false"
               and node.get("resource-id") != f"{IG_PKG}:id/bottom_sheet_camera_container"
               and node.get("resource-id", "").startswith(tuple(f"{IG_PKG}:id/{name}" for name in (
                   "dialog_container", "modal_container", "igds_alert_dialog", "igds_headline", "bottom_sheet", "share_sheet")))
               for node in nodes)


def _field_saved_value(xml: str, field_type: str) -> Optional[str]:
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    if _has_editor_dialog(root.iter()):
        return None
    forms = [node for node in root.iter() if node.get("resource-id") == EDIT_PROFILE_FIELDS_RID]
    if len(forms) != 1:
        return None
    rows = [node for node in forms[0].iter() if node.get("resource-id") == FIELD_ROW_RID[field_type]]
    if len(rows) != 1:
        return None
    inputs = [node for node in rows[0].iter() if node.get("class") == "android.widget.EditText"
              and node.get("visible-to-user") != "false"
              and not any(child.get("class") == "android.widget.EditText" for child in list(node.iter())[1:])]
    return inputs[0].get("text") if len(inputs) == 1 else None


def _field_editor_verified(xml: str, field_type: str) -> bool:
    try:
        nodes = list(ET.fromstring(xml).iter())
    except ET.ParseError:
        return False
    if any(node.get("resource-id") == EDIT_PROFILE_FIELDS_RID for node in nodes):
        return False
    if _has_editor_dialog(nodes):
        return False
    titles = [node for node in nodes if node.get("resource-id") == f"{IG_PKG}:id/action_bar_title"]
    if len(titles) != 1 or (titles[0].get("text") or titles[0].get("content-desc")) != FIELD_ROW_LABEL[field_type]:
        return False
    done = [node for node in nodes if node.get("resource-id") == ACTION_BAR_DONE_RID
            and node.get("enabled") != "false" and node.get("visible-to-user") != "false"]
    if len(done) != 1:
        return False
    inputs = [node for node in nodes if node.get("class") == "android.widget.EditText"
              and node.get("enabled") != "false" and node.get("visible-to-user") != "false"
              and not any(child.get("class") == "android.widget.EditText" for child in list(node.iter())[1:])]
    return len(inputs) == 1


async def _brute_clear_edittext(
    device: WSDeviceAdapter, max_chars: int = 220
) -> None:
    """Clear the focused EditText by sending many KEYCODE_DEL events.

    Verified live 2026-05-20 that Ctrl+A via input keyevent --meta-state
    CTRL_ON 29 does NOT reliably select text on IG's prism EditText —
    the cursor moves to end but no selection is made, so KEYCODE_DEL
    only deletes one char. Brute-force backspaces are slow but reliable.

    KEYCODE_MOVE_END (123) is fired first to jump the cursor to end so
    backspaces consume all content. max_chars defaults to 220 to cover
    bios (150-char limit) with margin.
    """
    await device.shell("input keyevent 123")  # MOVE_END
    await asyncio.sleep(0.1)
    # Send DELs in one shell loop — far faster than individual ADB
    # round-trips. The legacy code used backspace_count up to 540 per
    # field across 3 attempts; we run it ONCE with 220 max.
    await device.shell(
        f"i=0; while [ $i -lt {max_chars} ]; do input keyevent 67; i=$((i+1)); done"
    )
    await asyncio.sleep(0.2)


async def _edit_field_via_subscreen(
    device: WSDeviceAdapter,
    field_type: str,
    value: str,
) -> bool:
    """Tap field row → sub-screen → clear EditText → type → Done → back to form.

    Returns True if Done landed and we're back on the main edit form (or
    on a confirmation dialog we then dismiss).
    """
    rid = FIELD_ROW_RID.get(field_type)
    label = FIELD_ROW_LABEL.get(field_type, field_type)
    if not rid:
        return False

    # Refresh + locate row bounds. Modern IG rows are 170-tall and the
    # whole row IS the click target — but the row contains both the
    # label TextView (upper half) and the value TextView (lower half).
    # The legacy code learned the hard way that tapping at the row
    # CENTER sometimes lands on the label (non-clickable) — tap at
    # center_y + ~45 to ensure we hit the value/button area.
    xml = await _refresh(device)
    bounds = _row_bounds_from_xml(xml, rid)
    if not bounds:
        # Resource-id miss: try a label-text tap as fallback.
        el = await device.find_element_by_text(label)
        if not el:
            await _log(device, f"⚠️ {label} row not found")
            return False
        cx, cy = el.center_x, el.center_y
    else:
        x1, y1, x2, y2 = bounds
        cx = (x1 + x2) // 2
        # Bias downward for IG's two-line row (label on top, value below).
        cy = min((y1 + y2) // 2 + 45, y2 - 10)

    await device.tap(cx, cy)
    await asyncio.sleep(0.7)

    # Verify we're on a sub-screen (Done in action bar + a single EditText).
    xml = await _refresh(device)
    if not _field_editor_verified(xml, field_type) or await _is_checkpoint(device, xml):
        await _log(device, f"{label} editor could not be verified")
        return False
    done_present = await device.find_element_by_id(ACTION_BAR_DONE_RID)
    if not done_present:
        await _log(device, f"⚠️ {label} sub-screen Done button not found")
        return False

    # Focus the EditText.
    edit = await device.find_element_by_id(SUBSCREEN_EDITTEXT_RID)
    if not edit:
        edit = await device.find_element_by_class("android.widget.EditText")
    if not edit:
        return False
    await device.click(edit)
    await asyncio.sleep(0.3)

    # Clear with brute-force backspace (Ctrl+A meta-state doesn't work
    # on prism EditText — selected="true" gets set but DEL only takes
    # one char).
    clear_budget = 60 if field_type == "name" else 220 if field_type == "bio" else 80
    await _brute_clear_edittext(device, max_chars=clear_budget)

    # Type the new value. The executor preserves bio newlines within one
    # bounded input command, avoiding focus loss between line fragments.
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    typing_mode = "human" if field_type in {"name", "bio"} else "instant"
    if normalized:
        await device.send_keys(normalized, typing_mode=typing_mode)

    # Username server-side validation needs a beat.
    if field_type == "username":
        await asyncio.sleep(0.4)
    elif typing_mode == "human":
        await asyncio.sleep(random.uniform(0.8, 2.2))
    else:
        await asyncio.sleep(0.2)

    # Tap Done in the action bar.
    if not await _tap_first(
        device,
        rids=(ACTION_BAR_DONE_RID,),
        descs=("Done",),
        wait_after=0.7,
    ):
        await _log(device, f"{label} Done button tap failed")
        return False

    # Some fields (name, username) throw a confirm dialog.
    if field_type != "bio":
        await _dismiss_confirmation_dialog(device)

    # Ensure we're back on the main edit form.
    for _ in range(3):
        xml = await _refresh(device)
        if await _is_checkpoint(device, xml):
            return False
        if _field_saved_value(xml, field_type) == normalized:
            await _log(device, f"{label} saved and verified: [REDACTED length={len(value)}]")
            return True
        await asyncio.sleep(0.5)
    await _log(device, f"{label} saved value could not be verified")
    return False


async def _dismiss_confirmation_dialog(device: WSDeviceAdapter) -> bool:
    """If 'Change name/username?' dialog is showing, tap its primary CTA."""
    for _ in range(4):
        xml = await _refresh(device)
        low = xml.lower()

        # Primary button by resource-id is the most reliable signal.
        el = await device.find_element_by_id(CONFIRM_DIALOG_PRIMARY_RID)
        if el:
            await device.click(el)
            await asyncio.sleep(0.4)
            return True

        # Text-match fallback.
        for label in CONFIRM_TEXTS:
            el = await device.find_element_by_text(label)
            if el:
                await device.click(el)
                await asyncio.sleep(0.4)
                return True

        if any(
            kw in low
            for kw in (
                "change your name",
                "change name",
                "change your username",
                "change username",
                "igds_alert_dialog",
            )
        ):
            # Dialog visible but selectors missed — tap a safe primary y.
            await device.tap(540, 1376)
            await asyncio.sleep(0.4)
            return True

        await asyncio.sleep(0.2)
    return False


# ── profile-picture change flow ───────────────────────────────────────
#
# The desktop handler has ALREADY staged the chosen image into the phone's
# gallery (newest file), so this flow only drives IG's change-photo UI and
# picks the FIRST/top-left gallery cell (= newest image).
#
# Live walk-through reference (IG build 412.x, account fresh 2026-05-20):
#   Edit Profile form → tap the avatar/"Edit picture" row at the top
#     → a bottom sheet / menu appears with options like:
#         "New profile photo"  (camera/gallery picker)
#         "Choose from library" / "Select from library"
#         "Import from Facebook", "Take photo", "Remove current photo"
#     → "New profile photo" (or "Choose from library") opens the system /
#        IG gallery grid.
#     → tap the FIRST grid cell (top-left = most-recent image).
#     → IG shows a crop/zoom screen → confirm with "Next" then "Done"
#        (wording varies: "Done", "Use photo", "Save", a checkmark ✓).
#
# ⚠️ LEAD MUST VERIFY LIVE — the exact labels/resource-ids/coords below are
#    best-guesses layered selector→coord. Walk one account and adjust:
#      • the avatar-row resource-id / content-desc
#      • the bottom-sheet option wording
#      • the first gallery cell coordinate (GALLERY_FIRST_CELL_XY)
#      • the crop-confirm button wording/coords
#    Every step is selector-first with a coordinate fallback so you only need
#    to retune the constants, not the structure.

# Resource-id guesses for the avatar row on the Edit Profile form. The header
# image button is usually one of these; fall back to the top-of-form avatar.
AVATAR_ROW_RIDS = (
    "com.instagram.android:id/change_avatar_button",
    "com.instagram.android:id/avatar_image_view",
    "com.instagram.android:id/profile_picture_imageview",
    "com.instagram.android:id/edit_profile_image",
)
AVATAR_ROW_DESCS = (
    "Edit picture or avatar",  # live-verified label (IG 2026-05)
    "Edit picture", "Change profile photo", "Change profile picture",
    "Profile photo", "Edit profile photo",
)
AVATAR_ROW_TEXTS = (
    "Edit picture or avatar",  # live-verified label (IG 2026-05)
    "Edit picture", "Change profile photo", "Change profile picture",
    "Edit profile photo",
)

# Bottom-sheet option that opens the gallery grid.
NEW_PHOTO_TEXTS = (
    "New profile photo", "Choose from library", "Select from library",
    "Choose from Library", "Add from gallery", "Gallery", "Library",
)
NEW_PHOTO_DESCS = NEW_PHOTO_TEXTS

# Crop / confirm step wording (in likely tap order).
CONFIRM_PHOTO_TEXTS = ("Next", "Done", "Use photo", "Use Photo", "Save", "Confirm")
CONFIRM_PHOTO_DESCS = ("Next", "Done", "Use photo", "Save", "Confirm")

# Top-of-form avatar fallback coordinate (1080×2400). The avatar sits centered
# near the top of the Edit Profile form. LEAD: retune after a live dump.
AVATAR_FALLBACK_XY = (540, 588)  # live-verified "Edit picture or avatar" link center (1080x2400, IG 2026-05)
# First gallery cell (top-left) — the staged image is the newest, so it lands
# here. LIVE-VERIFIED on IG 2026-06 (1080×2400): the picker shows a circular
# crop PREVIEW up top (≈[0,275]-[1080,1355]) and the thumbnail GRID below it, so
# the first cell sits well down the screen, NOT near the top.
GALLERY_FIRST_CELL_XY = (136, 1492)  # gallery_grid_item_thumbnail[0] center, live-verified
# The picker's confirm button. LIVE-VERIFIED: text/desc "Done" on a
# next_button_textview at the top-right (≈996,201); tapping it applies the crop
# and uploads the picture immediately (no separate form-save needed).
GALLERY_DONE_RID = "com.instagram.android:id/next_button_textview"
GALLERY_DONE_XY = (996, 201)


async def _pick_first_gallery_cell(device: WSDeviceAdapter) -> bool:
    """Ensure the newest (top-left) gallery thumbnail is SELECTED.

    LIVE-VERIFIED (IG 2026-06): the media picker AUTO-SELECTS the most-recent
    image (= the just-staged avatar) and marks its cell
    content-desc="Selected Photo thumbnail …" (the rest are "Unselected …").
    Tapping an already-selected cell DESELECTS it, which then makes the "Done"
    confirm a no-op and leaves the old picture — so we must only tap when nothing
    is selected yet.
    """
    xml = await device.refresh_screen(force=True)
    # The opening quote disambiguates "Selected …" from "Unselected …" (the
    # latter contains "selected" as a substring). If a cell is already selected
    # it's the newest = the staged avatar, so leave it and let "Done" apply it.
    if xml and re.search(r'content-desc="Selected\b', xml):
        return True

    # Nothing selected yet — select the first/top-left (newest) thumbnail.
    for rid in (
        "com.instagram.android:id/gallery_grid_item_thumbnail",
        "com.instagram.android:id/image_button",
        "com.instagram.android:id/gallery_grid_item",
    ):
        cells = await device.find_elements_by_id(rid)
        if cells:
            await device.click(cells[0])
            await asyncio.sleep(0.6)
            return True

    # System document/photo picker fallback: first ImageView below the header.
    cells = await device.find_elements_by_class("android.widget.ImageView")
    for cell in cells:
        if cell.y1 > 450:
            await device.click(cell)
            await asyncio.sleep(0.6)
            return True

    # Coordinate fallback — first grid cell (below the crop preview).
    gx, gy = GALLERY_FIRST_CELL_XY
    await device.tap(gx, gy)
    await asyncio.sleep(0.6)
    return True


async def _change_profile_picture(device: WSDeviceAdapter) -> bool:
    """Drive IG's change-profile-photo flow and pick the newest gallery image.

    Pre-req: caller has ensured we're on the main Edit Profile form and the
    desktop handler has staged the image into the gallery (newest file).
    Returns True if the flow completed back on the Edit Profile form.
    """
    # 1) Tap the avatar / "Edit picture" row at the top of the form.
    if not await _tap_first(
        device,
        rids=AVATAR_ROW_RIDS,
        descs=AVATAR_ROW_DESCS,
        texts=AVATAR_ROW_TEXTS,
        wait_after=0.8,
    ):
        # Fallback: tap the top-of-form avatar coordinate directly.
        ax, ay = AVATAR_FALLBACK_XY
        await device.tap(ax, ay)
        await asyncio.sleep(0.8)

    await _refresh(device)

    # 2) From the bottom-sheet / menu, choose "New profile photo" /
    #    "Choose from library" to open the gallery grid. If the avatar tap
    #    opened the gallery directly (some builds skip the sheet), this is a
    #    harmless no-op miss and we proceed to cell-picking.
    await _tap_first(
        device,
        texts=NEW_PHOTO_TEXTS,
        descs=NEW_PHOTO_DESCS,
        wait_after=0.9,
    )
    await _refresh(device)

    # If a "New profile photo" sub-sheet THEN offers library vs camera, take
    # the library option once more (idempotent — misses if already on grid).
    await _tap_first(
        device,
        texts=("Choose from library", "Select from library", "Gallery", "Library"),
        descs=("Choose from library", "Select from library", "Gallery", "Library"),
        wait_after=0.9,
    )
    await _refresh(device)

    # 3) Pick the first/top-left gallery cell = newest staged image.
    await _pick_first_gallery_cell(device)
    await _refresh(device)

    # 4) Crop/zoom confirm. IG usually shows "Next" then "Done"; some builds go
    #    straight to a single "Use photo"/"Done"/checkmark. Tap confirm up to a
    #    few times to clear crop → done. Each tap is selector-first; the
    #    coordinate fallback hits the action-bar Done area.
    confirmed = False
    for _ in range(3):
        if await _tap_first(
            device,
            # next_button_textview is the live-verified picker "Done"; the
            # action-bar id + "Done"/"Next" text/desc cover crop-view variants.
            rids=(GALLERY_DONE_RID, ACTION_BAR_DONE_RID),
            texts=CONFIRM_PHOTO_TEXTS,
            descs=CONFIRM_PHOTO_DESCS,
            wait_after=0.8,
        ):
            confirmed = True
            xml = await _refresh(device)
            # Once we're back on the edit form, stop confirming.
            if await _on_edit_profile_form(xml):
                break
        else:
            break

    if not confirmed:
        # Coordinate fallback for the picker "Done" (top-right, live-verified).
        gx, gy = GALLERY_DONE_XY
        await device.tap(gx, gy)
        await asyncio.sleep(0.8)

    # 5) The picture uploads immediately after "Done"; IG briefly shows a
    # blocking "Loading…" dialog over the form. Wait for the form to settle back
    # WITHOUT pressing back — a back-press during the upload dismisses the
    # already-applied change and was making a real success report as a failure.
    on_form = False
    for _ in range(12):  # ~10s — covers the upload round-trip
        if await _on_edit_profile_form(await _refresh(device)):
            on_form = True
            break
        await asyncio.sleep(0.8)

    # Success when the real picker "Done" was tapped (selector match — on this IG
    # build that commits + uploads the picture immediately) OR the edit form came
    # back, confirming the round-trip. A bare coordinate fallback that never
    # reached the picker leaves confirmed=False and won't re-detect the form, so
    # it correctly reports failure.
    ok = confirmed or on_form
    await _log(device, f"🖼️ Profile picture {'updated' if ok else 'change could not be confirmed'}")
    return ok


# ── link sub-flow ─────────────────────────────────────────────────────


async def _set_link(device: WSDeviceAdapter, url: str) -> bool:
    """Open Links → Add external link → type URL → Done → back to form."""
    if not await _tap_first(
        device,
        rids=("com.instagram.android:id/links_text_cell",),
        descs=("Add link", "Links"),
        texts=("Add link", "Links"),
        wait_after=0.6,
    ):
        await _log(device, "⚠️ Links button not found")
        return False

    if not await _tap_first(
        device,
        descs=("Add external link",),
        texts=("Add external link", "Add link"),
        wait_after=0.6,
    ):
        await _log(device, "⚠️ Add external link button not found")
        await device.back()
        await asyncio.sleep(0.3)
        return False

    edit = await device.find_element_by_id(
        "com.instagram.android:id/edit_url_form_field"
    )
    if not edit:
        edit = await device.find_element_by_class("android.widget.EditText")
    if edit:
        await device.click(edit)
        await asyncio.sleep(0.2)
    await _brute_clear_edittext(device, max_chars=300)
    await device.send_keys(url)
    await asyncio.sleep(0.2)

    if not await _tap_first(
        device,
        rids=(ACTION_BAR_DONE_RID,),
        descs=("Done",),
        wait_after=0.5,
    ):
        await device.back()
        await asyncio.sleep(0.3)

    await device.back()
    await asyncio.sleep(0.3)
    await _log(device, f"🔗 Link set: {url}")
    return True


# ── professional switch wizard ────────────────────────────────────────


async def _verify_professional_dashboard(device: WSDeviceAdapter) -> bool:
    """Verify the professional entry point from the actual profile screen."""
    for attempt in range(3):
        if await _goto_profile_tab(device):
            xml = await _refresh(device)
            low = xml.lower()
            if (
                "professional dashboard entry point" in low
                or "professional_dashboard_entry_point" in low
                or 'text="professional dashboard"' in low
            ):
                return True
        if attempt < 2:
            await device.back()
            await asyncio.sleep(0.4)
    # A newly converted zero-post account can keep rendering the personal
    # profile shell until Instagram is restarted. Verify once more after a
    # cold relaunch so a completed conversion is not reported as a failure.
    await device.shell(f"am force-stop {IG_PKG}")
    await asyncio.sleep(0.6)
    await device.launch_app(IG_PKG)
    await asyncio.sleep(1.8)
    if await _goto_profile_tab(device):
        xml = await _refresh(device)
        low = xml.lower()
        if (
            "professional dashboard entry point" in low
            or "professional_dashboard_entry_point" in low
            or 'text="professional dashboard"' in low
        ):
            return True
    return False


async def _switch_to_professional(
    device: WSDeviceAdapter,
    *,
    account_type: str,
    professional_category: str,
) -> bool:
    el = await device.find_element_by_id(BUSINESS_CONVERSION_ENTRY_RID)
    if not el:
        el = await device.find_element_by_text("Switch to professional account")
    if not el:
        await device.swipe(540, 1950, 540, 980, duration=220)
        await asyncio.sleep(0.4)
        el = await device.find_element_by_id(BUSINESS_CONVERSION_ENTRY_RID)
        if not el:
            el = await device.find_element_by_text("Switch to professional account")
    if not el:
        await _log(device, "Professional conversion entry absent; checking existing professional state")
        return await _verify_professional_dashboard(device)

    await device.click(el)
    await asyncio.sleep(1.0)

    # Wizard intro.
    await _tap_first(
        device,
        texts=("Get started", "Next", "Continue"),
        descs=("Get started", "Next", "Continue"),
        wait_after=0.9,
    )

    # Category step.
    xml = await _refresh(device)
    low = xml.lower()
    if "category" in low or "describes you" in low or "search_edit_text" in low:
        search = await device.find_element_by_id(
            "com.instagram.android:id/search_edit_text"
        )
        if not search:
            search = await device.find_element_by_class("android.widget.EditText")
        if search:
            await device.click(search)
            await asyncio.sleep(0.2)
            await _brute_clear_edittext(device, max_chars=40)
            await device.send_keys(professional_category)
            await asyncio.sleep(0.5)

        cat_row = await device.find_element_by_text(professional_category)
        if cat_row:
            await device.click(cat_row)
        else:
            await device.tap(540, 983)
        await asyncio.sleep(0.4)

        await _tap_first(
            device,
            texts=("Switch to professional account", "Switch", "Next", "Continue"),
            descs=("Next", "Continue"),
            wait_after=1.0,
        )

    # Account type step.
    xml = await _refresh(device)
    low = xml.lower()
    if "creator" in low or "business" in low:
        if account_type == "creator":
            await _tap_first(device, texts=("Creator",), wait_after=0.4)
        else:
            await _tap_first(device, texts=("Business",), wait_after=0.4)
        await _tap_first(
            device,
            texts=("Next", "Continue"),
            descs=("Next", "Continue"),
            wait_after=0.8,
        )

    # Instagram 438 can insert several setup pages before the contact-info
    # review. Keep the loop bounded, but long enough to reach that late screen.
    for _ in range(10):
        xml = await _refresh(device)
        low = xml.lower()
        if "promotional emails" in low and "grow your brand" in low:
            checked_switch = re.search(
                r'<node\b(?=[^>]*class="android\.widget\.Switch")(?=[^>]*checked="true")[^>]*>',
                xml,
                re.IGNORECASE,
            )
            if checked_switch:
                toggle = await device.find_element_by_class("android.widget.Switch")
                if toggle:
                    await device.click(toggle)
                    await asyncio.sleep(0.4)
            await _tap_first(
                device,
                texts=("Next", "Continue", "Skip", "Not now", "Not Now"),
                descs=("Next", "Continue", "Skip", "Not now", "Not Now"),
                wait_after=0.8,
            )
            continue
        if "review your contact info" in low or "public business information" in low:
            await _tap_first(
                device,
                texts=(
                    "Don't use my contact info",
                    "Don’t use my contact info",
                    "Skip", "Not now", "Not Now",
                ),
                descs=("Skip", "Not now", "Not Now"),
                wait_after=0.8,
            )
            continue
        if "changes to your safety settings" in low:
            await _tap_first(
                device,
                texts=("OK", "Got it", "Continue"),
                descs=("OK", "Got it", "Continue"),
                wait_after=0.8,
            )
            continue
        if "set up your professional account" in low:
            await _tap_first(
                device,
                texts=("Close", "Done", "Got it"),
                descs=("Close", "Done", "Got it"),
                wait_after=0.8,
            )
            continue
        if (
            "professional dashboard" in low
            or "professional tools" in low
            or "insights" in low
            or "creator tools" in low
        ):
            break
        if not await _tap_first(
            device,
            texts=(
                "Don't use my contact info",
                "Don’t use my contact info",
                "Skip", "Not now", "Not Now",
                "Close", "Done", "Got it",
                "Next", "Continue",
            ),
            descs=("Skip", "Not now", "Close", "Done", "Got it", "Next", "Continue"),
            wait_after=0.7,
        ):
            await asyncio.sleep(0.5)
    return await _verify_professional_dashboard(device)


# ── public entrypoint ─────────────────────────────────────────────────


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    name = _clean(config.get("name") or config.get("display_name"))
    username = _clean(config.get("username"))
    bio = _clean(config.get("bio"))
    clear_bio = config.get("clear_bio", False)
    if not isinstance(clear_bio, bool) or (clear_bio and bio is not None):
        return {"success": False, "error": "Clear Bio must be a boolean and cannot be combined with New Bio."}
    if clear_bio:
        bio = ""
    expected_account = config.get("account_username")
    if isinstance(expected_account, str):
        expected_account = expected_account.strip().lstrip("@").lower()
    if not isinstance(expected_account, str) or not re.fullmatch(r"[a-z0-9._]{1,30}", expected_account):
        return {"success": False, "code": "INSTAGRAM_ACCOUNT_IDENTITY_UNVERIFIED",
                "error": "Select the Instagram account to edit before running Edit Profile.",
                "data": {"step": "account_guard", "fields_attempted": 0}}
    link = _clean(config.get("link") or config.get("website"))
    switch_pro = _coerce_bool(config.get("switch_to_professional", False), False)

    # Avatar change. The desktop dashboard:change-avatar handler stages the
    # chosen image into the phone gallery, then dispatches edit_profile with
    # set_profile_picture:true (+ profile_picture / picture_path for context).
    # We only need a TRUTHY signal here — the actual file is already the newest
    # image in the gallery, which the IG picker shows in the top-left cell.
    set_picture = _coerce_bool(config.get("set_profile_picture", False), False) or bool(
        _clean(config.get("profile_picture")) or _clean(config.get("picture_path"))
    )
    account_type = (_clean(config.get("account_type")) or "business").lower()
    if account_type not in ("creator", "business"):
        account_type = "business"
    professional_category = (
        _clean(config.get("professional_category")) or "Digital creator"
    )

    # Human-paced delay between fields. Default 3-8s. Set to (0, 0) to
    # disable (use only on warm/aged accounts that won't trip checks).
    field_delay_min = int(config.get("field_delay_min_ms") or 3000)
    field_delay_max = int(config.get("field_delay_max_ms") or 8000)

    if not any([name, username, bio is not None, link, switch_pro, set_picture]):
        return {
            "success": False,
            "error": "At least one field required: name, username, bio, link, switch_to_professional, or set_profile_picture",
        }

    results = {
        "picture_changed": None,
        "name": None,
        "username": None,
        "bio": None,
        "link": None,
        "switch_to_professional": None,
    }

    await _progress(device, 0, "Opening Instagram…")
    await device.launch_app(IG_PKG)
    await asyncio.sleep(2.5)

    if await _is_checkpoint(device):
        return _checkpoint_error("ig_launch")

    await _progress(device, 10, "Navigating to profile…")
    if not await _goto_profile_tab(device, require_profile=True):
        return {
            "success": False,
            "code": "PROFILE_NAVIGATION_UNVERIFIED",
            "error": "Could not verify your Instagram profile. Open the Profile tab on the phone, dismiss any prompts, then retry.",
        }

    profile_xml = await _refresh(device)
    on_screen_account = verified_profile_username(profile_xml)
    if on_screen_account != expected_account or _has_editor_dialog(ET.fromstring(profile_xml).iter()):
        return {"success": False, "code": "INSTAGRAM_ACCOUNT_IDENTITY_UNVERIFIED",
                "error": f"Could not verify @{expected_account} as the active Instagram account. No profile fields were changed.",
                "data": {"step": "account_guard", "fields_attempted": 0}}

    await _progress(device, 20, "Entering Edit Profile…")
    if not await _open_edit_profile(device):
        return {"success": False, "error": "Could not open Edit Profile form"}

    if await _is_checkpoint(device):
        return _checkpoint_error("after_edit_open")

    total_fields = sum(1 for x in (name, username, bio, link) if x is not None)
    if switch_pro:
        total_fields += 1
    if set_picture:
        total_fields += 1
    pct = 30
    pct_step = max(50 // max(total_fields, 1), 5)

    # Field order: picture → name → bio → link → pro switch → username.
    # Each field uses the sub-screen pattern. Insert a jittered human
    # delay between fields (the dominant flag trigger on fresh accounts
    # was multi-field changes in fast succession).
    field_idx = 0

    async def _maybe_jitter():
        nonlocal field_idx
        if field_idx > 0 and field_delay_max > 0:
            await _human_pause(field_delay_min, field_delay_max)
        field_idx += 1

    # Avatar FIRST: the change-photo flow leaves IG → gallery picker → crop and
    # back. Doing it before the text sub-screen edits keeps the heavy navigation
    # off the freshly-opened Edit Profile form and returns cleanly to it.
    if set_picture:
        await _maybe_jitter()
        await _progress(device, pct, "Changing profile picture…")
        if not await _ensure_back_to_edit_form(device):
            results["picture_changed"] = False
        else:
            results["picture_changed"] = await _change_profile_picture(device)
        pct += pct_step
        if await _is_checkpoint(device):
            return _checkpoint_error("after_picture")

    if name is not None:
        await _maybe_jitter()
        await _progress(device, pct, f"Setting name: {name[:20]}…")
        results["name"] = await _edit_field_via_subscreen(device, "name", name)
        pct += pct_step
        if await _is_checkpoint(device):
            return _checkpoint_error("after_name")

    if bio is not None:
        await _maybe_jitter()
        await _progress(device, pct, "Setting bio…")
        results["bio"] = await _edit_field_via_subscreen(device, "bio", bio)
        pct += pct_step
        if await _is_checkpoint(device):
            return _checkpoint_error("after_bio")

    if link is not None:
        await _maybe_jitter()
        await _progress(device, pct, f"Setting link: {link[:30]}…")
        if not await _ensure_back_to_edit_form(device):
            results["link"] = False
        else:
            results["link"] = await _set_link(device, link)
        pct += pct_step
        if await _is_checkpoint(device):
            return _checkpoint_error("after_link")

    if switch_pro:
        await _maybe_jitter()
        await _progress(device, pct, "Switching to professional account…")
        if not await _ensure_back_to_edit_form(device):
            results["switch_to_professional"] = False
        else:
            results["switch_to_professional"] = await _switch_to_professional(
                device,
                account_type=account_type,
                professional_category=professional_category,
            )
        if await _is_checkpoint(device):
            return _checkpoint_error("after_pro_switch")

    if username is not None:
        await _maybe_jitter()
        await _progress(device, pct, f"Setting username: {username[:20]}…")
        if not await _ensure_back_to_edit_form(device):
            results["username"] = False
        else:
            results["username"] = await _edit_field_via_subscreen(device, "username", username)
        pct += pct_step
        if await _is_checkpoint(device):
            return _checkpoint_error("after_username")

    successes = sum(1 for v in results.values() if v)
    attempted = sum(1 for v in results.values() if v is not None)
    await _progress(
        device, 100, f"Edit Profile complete — {successes}/{attempted} fields updated"
    )

    complete = attempted > 0 and successes == attempted
    status = "success" if complete else ("partial" if successes > 0 else "failed")
    return {
        "success": complete,
        "status": status,
        "data": {
            "message": f"Edit profile complete: {successes}/{attempted} fields updated",
            "results": results,
            "fields_updated": successes,
            "fields_attempted": attempted,
            "professional_verified": (
                results["switch_to_professional"] if switch_pro else None
            ),
        },
    }
