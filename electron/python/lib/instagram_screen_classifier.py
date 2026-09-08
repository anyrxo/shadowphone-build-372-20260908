"""
Minimal Instagram screen classifier and verified state helpers.

Phase scope:
- classify a few high-value Instagram states from package/XML/text context
- provide small reusable helpers for safer branching
- avoid behavior overhauls or broad module rewrites
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from lib.screen_state import ParsedScreenState, ScreenObservation, normalize_whitespace


IG_PACKAGE = "com.instagram.android"

IG_HOME = "ig_home"
IG_PROFILE = "ig_profile"
IG_ACCOUNT_SWITCHER = "ig_account_switcher"
IG_CREATE_POST_GALLERY = "ig_create_post_gallery"
IG_MEDIA_SELECTED = "ig_media_selected"
IG_CAPTION_EDITOR = "ig_caption_editor"
IG_STORY_EDITOR = "ig_story_editor"
IG_STORY_TEXT_EDITOR = "ig_story_text_editor"
IG_CAMERA_SETTINGS = "ig_camera_settings"
IG_VERIFICATION_REQUIRED = "ig_verification_required"
IG_POPUP_OR_CHALLENGE = "ig_popup_or_challenge"
IG_PROFILE_PICKER_OR_SETTINGS = "ig_profile_picker_or_settings"
IG_UNKNOWN = "unknown"


@dataclass
class InstagramScreenClassification:
    screen_type: str
    confidence: str = "low"
    reasons: List[str] = field(default_factory=list)
    package: Optional[str] = None

    def is_known(self) -> bool:
        return self.screen_type != IG_UNKNOWN


class InstagramScreenClassifier:
    def __init__(self, observation: Optional[ScreenObservation] = None, parsed_state: Optional[ParsedScreenState] = None):
        self.observation = observation
        self.package = (observation.package if observation else None) or None
        self.parsed = parsed_state or ParsedScreenState(observation.xml_source if observation else None)
        self.texts = [normalize_whitespace(text).lower() for text in self.parsed.text_snippets(limit=50)]

    def classify(self) -> InstagramScreenClassification:
        if self._is_verification_required():
            return InstagramScreenClassification(
                screen_type=IG_VERIFICATION_REQUIRED,
                confidence="high",
                reasons=["Instagram verification wall detected"],
                package=self.package,
            )

        if self._is_profile_picker_or_settings():
            confidence = "medium"
            reasons = ["profile picker/settings markers found"]
            if self.package and IG_PACKAGE not in self.package:
                confidence = "high"
                reasons.append(f"non-instagram package={self.package}")
            return InstagramScreenClassification(
                screen_type=IG_PROFILE_PICKER_OR_SETTINGS,
                confidence=confidence,
                reasons=reasons,
                package=self.package,
            )

        if self.package and IG_PACKAGE not in self.package:
            return InstagramScreenClassification(screen_type=IG_UNKNOWN, confidence="low", reasons=[f"package={self.package}"], package=self.package)

        if self._is_popup_or_challenge():
            return InstagramScreenClassification(
                screen_type=IG_POPUP_OR_CHALLENGE,
                confidence="high",
                reasons=["challenge or popup markers found"],
                package=self.package,
            )

        if self._is_account_switcher():
            return InstagramScreenClassification(
                screen_type=IG_ACCOUNT_SWITCHER,
                confidence="medium",
                reasons=["account switcher markers found"],
                package=self.package,
            )

        if self._is_camera_settings():
            return InstagramScreenClassification(
                screen_type=IG_CAMERA_SETTINGS,
                confidence="high",
                reasons=["camera settings markers found"],
                package=self.package,
            )

        if self._is_story_text_editor():
            return InstagramScreenClassification(
                screen_type=IG_STORY_TEXT_EDITOR,
                confidence="high",
                reasons=["story text editor markers found"],
                package=self.package,
            )

        if self._is_story_editor():
            return InstagramScreenClassification(
                screen_type=IG_STORY_EDITOR,
                confidence="medium",
                reasons=["story editor markers found"],
                package=self.package,
            )

        if self._is_caption_editor():
            return InstagramScreenClassification(
                screen_type=IG_CAPTION_EDITOR,
                confidence="medium",
                reasons=["caption editor markers found"],
                package=self.package,
            )

        if self._is_media_selected():
            return InstagramScreenClassification(
                screen_type=IG_MEDIA_SELECTED,
                confidence="medium",
                reasons=["media selected markers found"],
                package=self.package,
            )

        if self._is_create_post_gallery():
            return InstagramScreenClassification(
                screen_type=IG_CREATE_POST_GALLERY,
                confidence="medium",
                reasons=["gallery/create markers found"],
                package=self.package,
            )

        if self._is_profile():
            return InstagramScreenClassification(
                screen_type=IG_PROFILE,
                confidence="medium",
                reasons=["profile markers found"],
                package=self.package,
            )

        if self._is_home():
            return InstagramScreenClassification(
                screen_type=IG_HOME,
                confidence="medium",
                reasons=["home markers found"],
                package=self.package,
            )

        return InstagramScreenClassification(screen_type=IG_UNKNOWN, confidence="low", reasons=["no classifier matched"], package=self.package)

    def _text_contains_any(self, candidates: List[str]) -> bool:
        for candidate in candidates:
            candidate_l = candidate.lower()
            if any(candidate_l in text for text in self.texts):
                return True
        return False

    def _has_resource(self, resource_id: str) -> bool:
        return len(self.parsed.find_by_resource_id(resource_id, contains=True)) > 0

    def _has_exact_resource(self, resource_id: str) -> bool:
        if not resource_id.startswith("com."):
            resource_id = f"com.instagram.android:id/{resource_id}"
        return len(self.parsed.find_by_resource_id(resource_id, contains=False)) > 0

    def _resource_has_selected_descendant(self, resource_id: str) -> bool:
        resource_nodes = self.parsed.find_by_resource_id(resource_id, contains=True)
        selected_nodes = [
            node
            for node in self.parsed.nodes
            if str(node.raw_attrib.get("selected", "")).lower() == "true"
        ]
        for resource_node in resource_nodes:
            if str(resource_node.raw_attrib.get("selected", "")).lower() == "true":
                return True
            if not resource_node.bounds:
                continue
            x1, y1, x2, y2 = resource_node.bounds
            for selected_node in selected_nodes:
                if not selected_node.center:
                    continue
                cx, cy = selected_node.center
                if x1 <= cx <= x2 and y1 <= cy <= y2:
                    return True
        return False

    def _has_content_desc(self, content_desc: str) -> bool:
        return len(self.parsed.find_by_content_desc(content_desc, exact=False, case_sensitive=False)) > 0

    def _has_exact_content_desc(self, content_desc: str) -> bool:
        return len(self.parsed.find_by_content_desc(content_desc, exact=True, case_sensitive=False)) > 0

    def _has_exact_text(self, text: str) -> bool:
        return len(self.parsed.find_by_text(text, exact=True, case_sensitive=False)) > 0

    def _is_home(self) -> bool:
        has_feed_nav = self._has_resource("feed_tab") and (self._has_resource("tab_bar") or self._has_resource("clips_tab"))
        has_clips_surface = (
            self._resource_has_selected_descendant("clips_tab")
            or self._has_exact_resource("root_clips_layout")
            or self._has_exact_resource("clips_viewer_view_pager")
        )
        has_home_surface = (
            self._resource_has_selected_descendant("feed_tab")
            or self._has_exact_resource("reels_tray_container")
            or self._has_content_desc("Instagram Home Feed")
            or (has_feed_nav and self._has_content_desc("Home") and not has_clips_surface)
        )
        has_home_text = (
            self._text_contains_any(["your story", "instagram home feed", "search and explore", "reels"])
            or self._has_content_desc("Home")
            or self._has_content_desc("Reels")
        )
        return has_feed_nav and has_home_surface and has_home_text

    def _is_profile(self) -> bool:
        profile_selected = self._resource_has_selected_descendant("profile_tab")
        has_profile_tab = self._has_resource("profile_tab") or self._has_content_desc("Profile")
        has_profile_specific_resource = any(
            self._has_exact_resource(resource_id)
            for resource_id in [
                "profile_header_container",
                "profile_header_fixed_list",
                "row_profile_header",
                "row_profile_header_edit_profile_button",
                "profile_header_metrics_full_width",
            ]
        )
        has_profile_text = self._text_contains_any(
            [
                "edit profile",
                "share profile",
                "professional dashboard",
                "followers",
                "following",
            ]
        )
        return profile_selected or ((has_profile_tab or has_profile_specific_resource) and has_profile_text)

    def _is_profile_picker_or_settings(self) -> bool:
        # SAFETY GUARD: if any IG-specific create/gallery/editor resource
        # markers are on screen, we're inside the IG app even if the
        # package field is missing or stale. Don't classify as profile
        # picker — fall through to the more specific classifier.
        # (Without this, the Add-to-story screen — which has content-desc
        # "Camera settings" on its gear icon — was matching the broad
        # "settings" substring in the non-IG branch and blocking the
        # gallery classification.)
        if any(self._has_resource(marker) for marker in (
            "gallery_grid_item_thumbnail",
            "gallery_recycler_view",
            "gallery_picker_grid_item_container",
            "row_gallery_header",
            "media_picker_grid_view",
            "post_capture_controls_container",
            "clips_post_capture_controls",
            "post_capture_button_root_container",
            "cam_dest_story",
            "cam_dest_post",
            "cam_dest_reel",
            "reels_viewer_root",
            "reel_viewer_root",
        )):
            return False

        if self.package and IG_PACKAGE in self.package:
            if self._is_camera_settings():
                return False
            return self._text_contains_any([
                "settings and activity",
            ])
        return self._text_contains_any([
            "profiles",
            "users & profiles",
            "system users",
            "multiple users",
            "add user or profile",
            "app info",
            "settings and privacy",
            "settings and activity",
            "user or profile",
            "users &",
        ])

    def _is_account_switcher(self) -> bool:
        return self._text_contains_any([
            "add instagram account",
            "log into existing account",
            "accounts center",
            "switch account",
        ])

    def _is_create_post_gallery(self) -> bool:
        has_post_capture_editor = (
            self._has_resource("post_capture_controls_container")
            or self._has_resource("clips_post_capture_controls")
            or self._has_resource("post_capture_button_root_container")
            or (
                self._has_content_desc("Next")
                and self._text_contains_any(["audio", "text", "overlay", "filter", "edit"])
            )
        )
        if has_post_capture_editor:
            return False

        has_gallery_thumbnail = (
            self._has_resource("gallery_grid_item_thumbnail")
            or self._has_resource("gallery_picker_grid_item_container")
        )
        has_gallery_resource = (
            self._has_resource("gallery_recycler_view")
            or self._has_resource("row_gallery_header")
            or self._has_resource("media_picker_grid_view")
            or has_gallery_thumbnail
        )
        has_gallery_text = self._text_contains_any(["recents", "gallery", "select multiple"])
        has_bottom_nav_surface = self._has_resource("feed_tab") or self._has_resource("clips_tab") or self._has_content_desc("Reels")

        if has_gallery_resource:
            return True

        if has_gallery_text and not has_bottom_nav_surface and (
            has_gallery_thumbnail or self._has_resource("gallery_folder_menu")
        ):
            return True

        return False

    def _is_camera_settings(self) -> bool:
        # The reel gallery has a top-right gear whose content-desc is
        # "Camera settings". Only classify the actual settings page when that
        # phrase is the visible title and settings controls are present.
        return (
            self._has_exact_text("Camera settings")
            and self._text_contains_any(
                [
                    "always start on front camera",
                    "camera tools",
                    "controls",
                ]
            )
            and not self._has_resource("gallery_recycler_view")
            and not self._has_resource("gallery_grid_item_thumbnail")
        )

    def _is_story_text_editor(self) -> bool:
        has_story_text_controls = self._text_contains_any(["mention", "location"])
        has_keyboard_or_text_toolbar = (
            self._text_contains_any(["modern", "classic", "signature"])
            or self._has_content_desc("Add text")
            or "com.google.android.inputmethod" in (self.parsed.xml_source or "").lower()
        )
        return (
            self._has_exact_content_desc("Done")
            and has_story_text_controls
            and has_keyboard_or_text_toolbar
            and not self._is_create_post_gallery()
        )

    def _is_media_selected(self) -> bool:
        return (
            self._text_contains_any(["next", "crop", "audio"])
            and not self._is_create_post_gallery()
            and not self._is_caption_editor()
            and not self._is_camera_settings()
            and not self._is_home()
            and not self._is_profile()
            and not self._has_exact_resource("root_clips_layout")
            and not self._has_exact_resource("clips_viewer_view_pager")
        )

    def _is_caption_editor(self) -> bool:
        has_caption_prompt = self._text_contains_any(["write a caption", "add a caption"])
        has_caption_options = (
            self._text_contains_any(["tag people", "add location"])
            and self._text_contains_any(["share"])
        )
        has_caption_context = self._text_contains_any(["tag people", "add location", "audience"])
        return (
            ((has_caption_prompt and has_caption_context) or has_caption_options)
            and not self._is_create_post_gallery()
            and not self._is_camera_settings()
            and not self._has_exact_resource("root_clips_layout")
            and not self._has_exact_resource("clips_viewer_view_pager")
        )

    def _is_story_editor(self) -> bool:
        return (
            self._text_contains_any(["close friends", "share to", "add a caption"])
            and not self._is_create_post_gallery()
            and not self._is_caption_editor()
            and not self._is_story_text_editor()
            and not self._is_camera_settings()
            and not self._is_home()
        )

    def _is_popup_or_challenge(self) -> bool:
        has_strong_popup_resource = any(
            self._has_exact_resource(resource_id)
            for resource_id in [
                "dialog_container",
                "igds_promo_dialog_headline",
                "igds_headline_primary_action_button",
                "igds_alert_dialog_primary_button",
                "igds_alert_dialog_secondary_button",
                "primary_button",
                "secondary_button",
            ]
        )
        has_generic_modal_resource = (
            self._has_exact_resource("modal_container")
            or self._has_exact_resource("overlay_layout_container")
        )
        has_popup_text = self._text_contains_any([
            "challenge required",
            "confirm it's you",
            "suspended",
            "help us confirm",
            "save your login info",
            "turn on notifications",
            "try again later",
            "action blocked",
            "not now",
            "allow instagram to",
        ])
        return (
            has_strong_popup_resource
            or has_popup_text
            or (has_generic_modal_resource and has_popup_text)
        ) and not self._is_profile_picker_or_settings()

    def _is_verification_required(self) -> bool:
        activity = normalize_whitespace(
            getattr(self.observation, "activity", None) or ""
        ).lower()
        if "challengeactivity" in activity:
            return True

        normalized_text = " ".join(self.texts).replace("’", "'").replace("‘", "'")
        return any(
            phrase in normalized_text
            for phrase in (
                "confirm you're human",
                "confirm you are human",
            )
        )


def classify_instagram_screen(observation: Optional[ScreenObservation] = None, parsed_state: Optional[ParsedScreenState] = None) -> InstagramScreenClassification:
    return InstagramScreenClassifier(observation=observation, parsed_state=parsed_state).classify()


async def classify_instagram_screen_for_device(device) -> InstagramScreenClassification:
    observation = await device.refresh_screen_observation()
    return classify_instagram_screen(observation=observation)


async def screen_is(device, expected_screen: str) -> bool:
    classification = await classify_instagram_screen_for_device(device)
    return classification.screen_type == expected_screen


async def ensure_instagram_screen(device, expected_screen: str) -> bool:
    """Minimal verified helper for future runtime use.

    Phase v1 intentionally does not navigate or mutate state; it only verifies.
    """
    return await screen_is(device, expected_screen)
