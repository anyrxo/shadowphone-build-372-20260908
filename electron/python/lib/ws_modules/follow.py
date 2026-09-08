# Module: follow
# Follows Instagram users by searching for exact handles or from Explore.
import asyncio
import re
import xml.etree.ElementTree as ET

from lib.ws_modules_shared import (
    InstagramVerificationRequired,
    WSDeviceAdapter,
    _dismiss_ig_popups,
    raise_if_instagram_verification,
)


IG_PKG = "com.instagram.android"
USERNAME_ROW_ID = f"{IG_PKG}:id/row_search_user_username"
PROFILE_TITLE_IDS = {
    f"{IG_PKG}:id/action_bar_title",
    f"{IG_PKG}:id/profile_header_username",
}
PROFILE_FOLLOW_ID = f"{IG_PKG}:id/profile_header_follow_button"
EXPLORE_FOLLOW_ID = f"{IG_PKG}:id/row_user_access_follow_button"
EXPLORE_GRID_ITEM_IDS = {
    f"{IG_PKG}:id/grid_card_layout_container",
    f"{IG_PKG}:id/image_preview",
}


def _normalize_username(value: str) -> str:
    return re.sub(r"^@+", "", str(value or "").strip()).lower()


def _nodes(xml: str):
    try:
        return ET.fromstring(xml or "<hierarchy />").iter("node")
    except ET.ParseError:
        return ()


def _node_label(node) -> str:
    return str(node.attrib.get("text") or node.attrib.get("content-desc") or "")


def _node_center(node):
    match = re.fullmatch(
        r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]",
        str(node.attrib.get("bounds") or ""),
    )
    if not match:
        return None
    left, top, right, bottom = (int(value) for value in match.groups())
    if right <= left or bottom <= top:
        return None
    return ((left + right) // 2, (top + bottom) // 2)


def _exact_search_result_center(xml: str, username: str):
    target = _normalize_username(username)
    if not target:
        return None
    for node in _nodes(xml):
        if node.attrib.get("resource-id") != USERNAME_ROW_ID:
            continue
        if _normalize_username(_node_label(node)) != target:
            continue
        return _node_center(node)
    return None


def _profile_matches_target(xml: str, username: str) -> bool:
    target = _normalize_username(username)
    if not target:
        return False
    for node in _nodes(xml):
        if node.attrib.get("resource-id") not in PROFILE_TITLE_IDS:
            continue
        if _normalize_username(_node_label(node)) == target:
            return True
    return False


def _button_center(xml: str, resource_id: str, labels: set[str]):
    expected = {label.lower() for label in labels}
    for node in _nodes(xml):
        if node.attrib.get("resource-id") != resource_id:
            continue
        if _node_label(node).strip().lower() not in expected:
            continue
        return _node_center(node)
    return None


def _confirmed_follow_state(xml: str, username: str):
    if not _profile_matches_target(xml, username):
        return None
    for node in _nodes(xml):
        if node.attrib.get("resource-id") != PROFILE_FOLLOW_ID:
            continue
        state = _node_label(node).strip().lower()
        if state in {"following", "requested"}:
            return state
    return None


def _selected_tab(xml: str, resource_id: str, content_desc: str) -> bool:
    for node in _nodes(xml):
        if str(node.attrib.get("selected") or "").lower() != "true":
            continue
        if node.attrib.get("resource-id") == resource_id:
            return True
        if node.attrib.get("content-desc") == content_desc:
            return True
    return False


def _selected_home(xml: str) -> bool:
    return _selected_tab(xml, f"{IG_PKG}:id/feed_tab", "Home")


def _selected_search(xml: str) -> bool:
    return _selected_tab(
        xml,
        f"{IG_PKG}:id/search_tab",
        "Search and explore",
    )


def _explore_grid_item_center(xml: str):
    if not _selected_search(xml):
        return None
    candidates = []
    for node in _nodes(xml):
        if node.attrib.get("resource-id") not in EXPLORE_GRID_ITEM_IDS:
            continue
        if str(node.attrib.get("clickable") or "").lower() != "true":
            continue
        if not re.search(r"\brow\s+\d+\s*,\s*column\s+\d+\b", _node_label(node), re.I):
            continue
        center = _node_center(node)
        if center:
            candidates.append(center)
    if not candidates:
        return None
    return sorted(set(candidates), key=lambda point: (point[1], point[0]))[0]


def _screen_xml(device: WSDeviceAdapter) -> str:
    return str(
        getattr(device, "page_source", "")
        or getattr(device, "_screen_xml", "")
        or ""
    )


async def _refresh(device: WSDeviceAdapter, stage: str) -> str:
    await device.refresh_screen(force=True)
    xml = _screen_xml(device)
    await raise_if_instagram_verification(device, stage=stage, xml=xml)
    return xml


async def _navigate_to_exact_tab(
    device: WSDeviceAdapter,
    *,
    resource_id: str,
    content_desc: str,
    selected,
    stage: str,
) -> bool:
    xml = await _refresh(device, f"{stage}_before")
    if selected(xml):
        return True

    tab = await device.find_element_by_id(resource_id)
    if not tab:
        tab = await device.find_element_by_content_desc(content_desc)
    if not tab:
        return False

    await device.click(tab)
    await asyncio.sleep(0.8)
    return selected(await _refresh(device, f"{stage}_after"))


async def _navigate_search(device: WSDeviceAdapter) -> bool:
    return await _navigate_to_exact_tab(
        device,
        resource_id=f"{IG_PKG}:id/search_tab",
        content_desc="Search and explore",
        selected=_selected_search,
        stage="follow_search_tab",
    )


async def _settle_home(device: WSDeviceAdapter) -> bool:
    return await _navigate_to_exact_tab(
        device,
        resource_id=f"{IG_PKG}:id/feed_tab",
        content_desc="Home",
        selected=_selected_home,
        stage="follow_home_tab",
    )


async def _open_explore_grid(device: WSDeviceAdapter):
    xml = await _refresh(device, "follow_explore_before")
    center = _explore_grid_item_center(xml)
    if center:
        return center

    tab = await device.find_element_by_id(f"{IG_PKG}:id/search_tab")
    if not tab:
        tab = await device.find_element_by_content_desc("Search and explore")
    if not tab:
        return None
    # Tapping the exact selected Search tab is intentional here: when a grid
    # post is open the tab remains selected, and this returns to the grid.
    await device.click(tab)
    await asyncio.sleep(0.8)
    return _explore_grid_item_center(
        await _refresh(device, "follow_explore_after_tab")
    )


async def _poll_profile_follow_state(
    device: WSDeviceAdapter,
    username: str,
    attempts: int = 4,
):
    for attempt in range(attempts):
        xml = await _refresh(device, "follow_confirmation")
        state = _confirmed_follow_state(xml, username)
        if state:
            return state
        if attempt + 1 < attempts:
            await _dismiss_ig_popups(device, max_attempts=1)
            await asyncio.sleep(0.8)
    return None


async def _follow_exact_username(device: WSDeviceAdapter, username: str):
    target = _normalize_username(username)
    if not target:
        return False, "missing_username"
    if not await _navigate_search(device):
        return False, "search_tab_unverified"

    search_input = await device.find_element_by_id(
        f"{IG_PKG}:id/action_bar_search_edit_text"
    )
    if not search_input:
        return False, "search_input_missing"
    await device.click(search_input)
    try:
        await device.clear()
    except Exception:
        return False, "search_input_clear_failed"
    await device.send_keys(target)
    await asyncio.sleep(1.2)

    accounts_tab = await device.find_element_by_text("Accounts")
    if accounts_tab:
        await device.click(accounts_tab)
        await asyncio.sleep(0.6)

    xml = await _refresh(device, "follow_search_results")
    center = _exact_search_result_center(xml, target)
    if not center:
        return False, "exact_search_result_missing"
    await device.tap(*center)
    await asyncio.sleep(1.2)

    xml = await _refresh(device, "follow_target_profile")
    if not _profile_matches_target(xml, target):
        return False, "target_profile_mismatch"
    existing = _confirmed_follow_state(xml, target)
    if existing:
        return True, f"already_{existing}"

    follow_center = _button_center(xml, PROFILE_FOLLOW_ID, {"Follow"})
    if not follow_center:
        return False, "exact_follow_button_missing"
    await device.tap(*follow_center)
    state = await _poll_profile_follow_state(device, target)
    if not state:
        return False, "follow_state_unconfirmed"
    return True, state


async def _follow_from_explore(device: WSDeviceAdapter):
    grid_center = await _open_explore_grid(device)
    if not grid_center:
        return False, "explore_grid_unverified"
    await device.swipe(540, 1500, 540, 800, 300)
    await asyncio.sleep(0.8)
    xml = await _refresh(device, "follow_explore_grid")
    grid_center = _explore_grid_item_center(xml)
    if not grid_center:
        return False, "explore_surface_unverified"

    # Explore is intentionally non-targeted. The item coordinate comes from a
    # verified clickable grid node, and no Follow action occurs unless the
    # opened post exposes Instagram's exact owner follow control.
    await device.tap(*grid_center)
    await asyncio.sleep(1.2)
    xml = await _refresh(device, "follow_explore_post")
    follow_center = _button_center(xml, EXPLORE_FOLLOW_ID, {"Follow"})
    if not follow_center:
        return False, "explore_follow_button_missing"
    await device.tap(*follow_center)

    for attempt in range(4):
        xml = await _refresh(device, "follow_explore_confirmation")
        if _button_center(xml, EXPLORE_FOLLOW_ID, {"Following", "Requested"}):
            return True, "confirmed"
        if attempt < 3:
            await _dismiss_ig_popups(device, max_attempts=1)
            await asyncio.sleep(0.8)
    return False, "explore_follow_state_unconfirmed"


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    followed = 0
    failures = []
    try:
        count = max(0, int(config.get("count", 5)))
        usernames = list(config.get("usernames") or [])

        await device.launch_app(IG_PKG)
        await asyncio.sleep(1.2)
        await device.refresh_screen(force=True)
        launch_xml = _screen_xml(device)
        await raise_if_instagram_verification(
            device,
            stage="follow_launch",
            xml=launch_xml,
        )
        await _dismiss_ig_popups(device)
        await _refresh(device, "follow_after_startup_popups")

        if usernames:
            for raw_username in usernames:
                if followed >= count:
                    break
                username = _normalize_username(raw_username)
                ok, state = await _follow_exact_username(device, username)
                if ok and not state.startswith("already_"):
                    followed += 1
                elif not ok:
                    failures.append({"username": username, "reason": state})
        else:
            for _ in range(count):
                ok, state = await _follow_from_explore(device)
                if ok:
                    followed += 1
                else:
                    failures.append({"source": "explore", "reason": state})
                    break

        resting_state_home = await _settle_home(device)
        if not resting_state_home:
            failures.append({"reason": "home_resting_state_unverified"})
        return {
            "success": not failures,
            "followed": followed,
            "failures": failures,
            "resting_state_home": resting_state_home,
        }
    except InstagramVerificationRequired as verification:
        return verification.outcome
    except Exception as error:
        return {
            "success": False,
            "error": f"{type(error).__name__}: {error}",
            "followed": followed,
            "failures": failures,
        }
