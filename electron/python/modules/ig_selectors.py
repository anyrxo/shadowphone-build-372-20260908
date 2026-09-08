"""
🎯 INSTAGRAM GOLDEN SELECTORS - Master Reference
Verified Resource IDs extracted from UI Hierarchy Dumps.
Resolution-independent. Stable across Instagram versions.

Last Updated: 2024-12-24 (VERIFIED with live device testing)
Device: 1080x2400 (Pixel-family, but these IDs are universal)

⚠️ CRITICAL NOTES (Dec 24, 2024 Testing):
- Create button is at TOP-LEFT (63, 201), NOT bottom nav center
- FIRST Next button (media→edit): TOP-RIGHT (1000, 201)
- SECOND Next button (edit→share): BOTTOM-RIGHT (961, 2280) ← IMPORTANT!
- POST/STORY/REEL tabs use content-desc, fallback to coordinates
"""


class InstagramSelectors:
    """
    Golden IDs for Instagram UI Elements.
    These are robust, resolution-independent Android Resource IDs.
    """

    # ═══════════════════════════════════════════════════════════════════
    # BOTTOM NAVIGATION BAR (Updated Dec 2024 - 5 tabs, no create in nav)
    # ═══════════════════════════════════════════════════════════════════
    HOME_TAB = "com.instagram.android:id/feed_tab"
    REELS_TAB = "com.instagram.android:id/clips_tab"
    MESSAGE_TAB = "com.instagram.android:id/direct_tab"  # NEW - center position
    SEARCH_TAB = "com.instagram.android:id/search_tab"
    PROFILE_TAB = "com.instagram.android:id/profile_tab"
    TAB_BAR = "com.instagram.android:id/tab_bar"
    TAB_ICON = "com.instagram.android:id/tab_icon"  # Generic tab icon
    TAB_AVATAR = "com.instagram.android:id/tab_avatar"  # Profile tab avatar
    # Top Action Bar
    NEW_POST_BUTTON = "com.instagram.android:id/action_bar_buttons_container_left"  # Top-left + button
    NOTIFICATIONS_BUTTON = "com.instagram.android:id/notification"  # Top-right heart

    # Create button (works regardless of position - top-left or bottom nav)
    CREATION_TAB = "com.instagram.android:id/creation_tab"  # GOLDEN ID - always works!

    # Tab avatar (profile picture in nav bar - VERIFIED Dec 2024)
    TAB_AVATAR = "com.instagram.android:id/tab_avatar"

    # Accessibility IDs for tabs
    HOME_TAB_DESC = "Home"
    REELS_TAB_DESC = "Reels"
    MESSAGE_TAB_DESC = "Message"
    SEARCH_TAB_DESC = "Search and explore"
    PROFILE_TAB_DESC = "Profile"
    CREATE_TAB_DESC = "Create"  # Only visible on Home tab

    # ═══════════════════════════════════════════════════════════════════
    # BOTTOM NAVIGATION COORDINATES (1080x2400 resolution)
    # OLD Layout: Home | Search | Create(+) | Reels | Profile
    # NEW Layout: Home | Search | Messages | Reels | Profile (Create moved to top-left)
    # ═══════════════════════════════════════════════════════════════════

    class OldLayout:
        """Instagram OLD layout - Create button in bottom nav (before Dec 2024)"""

        # Bottom nav bar coordinates (1080px width, 5 tabs = 216px each)
        # Tab bar Y position: ~2330 for most devices
        HOME_TAB = (108, 2330)  # Position 1
        SEARCH_TAB = (324, 2330)  # Position 2
        CREATE_TAB = (540, 2330)  # Position 3 (center - the + button)
        REELS_TAB = (756, 2330)  # Position 4
        PROFILE_TAB = (972, 2330)  # Position 5

        # Tab bar Y can vary - provide alternate coordinates
        HOME_TAB_ALT = (108, 2350)
        SEARCH_TAB_ALT = (324, 2350)
        CREATE_TAB_ALT = (540, 2350)
        REELS_TAB_ALT = (756, 2350)
        PROFILE_TAB_ALT = (972, 2350)

    class NewLayout:
        """Instagram NEW layout - Messages in bottom nav, Create moved to top-left"""

        # Bottom nav bar coordinates (1080px width, 5 tabs = 216px each)
        # XML dump: tab_bar bounds="[0,2211][1080,2337]" → center Y = 2274
        HOME_TAB = (108, 2274)  # Position 1 - feed_tab
        SEARCH_TAB = (756, 2274)  # Position 4 - search_tab
        MESSAGES_TAB = (540, 2274)  # Position 3 (center - direct_tab)
        REELS_TAB = (324, 2274)  # Position 2 - clips_tab
        PROFILE_TAB = (972, 2274)  # Position 5 - profile_tab

        # Create button moved to TOP-LEFT action bar
        # XML dump: bounds="[0,128][127,275]" → center (63, 201)
        CREATE_BUTTON_TOP = (63, 201)

        # Tab bar Y can vary
        HOME_TAB_ALT = (108, 2350)
        SEARCH_TAB_ALT = (324, 2350)
        MESSAGES_TAB_ALT = (540, 2350)
        REELS_TAB_ALT = (756, 2350)
        PROFILE_TAB_ALT = (972, 2350)

    @staticmethod
    def get_nav_coordinates(layout_type="new"):
        """Get navigation coordinates based on layout type (old/new)"""
        if layout_type.lower() == "old":
            return {
                "home": InstagramSelectors.OldLayout.HOME_TAB,
                "search": InstagramSelectors.OldLayout.SEARCH_TAB,
                "create": InstagramSelectors.OldLayout.CREATE_TAB,
                "reels": InstagramSelectors.OldLayout.REELS_TAB,
                "profile": InstagramSelectors.OldLayout.PROFILE_TAB,
                "layout": "old",
            }
        else:  # new layout
            return {
                "home": InstagramSelectors.NewLayout.HOME_TAB,
                "search": InstagramSelectors.NewLayout.SEARCH_TAB,
                "messages": InstagramSelectors.NewLayout.MESSAGES_TAB,
                "reels": InstagramSelectors.NewLayout.REELS_TAB,
                "profile": InstagramSelectors.NewLayout.PROFILE_TAB,
                "create": InstagramSelectors.NewLayout.CREATE_BUTTON_TOP,
                "layout": "new",
            }

    @staticmethod
    def load_profile_layout(profile_id):
        """Load IG layout preference for a specific profile from config"""
        import os
        import json

        try:
            # Try multiple possible config locations
            possible_paths = [
                os.path.join(
                    os.path.dirname(os.path.dirname(__file__)),
                    "config",
                    f"ig_layout_profile_{profile_id}.json",
                ),
                os.path.join(
                    os.getcwd(), "config", f"ig_layout_profile_{profile_id}.json"
                ),
            ]

            for config_file in possible_paths:
                if os.path.exists(config_file):
                    with open(config_file, "r") as f:
                        data = json.load(f)
                        return data.get("ig_layout", "new")

            # Default to 'new' layout if no config found
            return "new"
        except Exception as e:
            print(f"⚠️ Error loading IG layout for profile {profile_id}: {e}")
            return "new"

    @staticmethod
    def get_nav_for_profile(profile_id):
        """Get navigation coordinates for a specific profile based on its layout preference"""
        layout_type = InstagramSelectors.load_profile_layout(profile_id)
        print(f"📱 Profile {profile_id} using IG layout: {layout_type.upper()}")
        return InstagramSelectors.get_nav_coordinates(layout_type)

    # ═══════════════════════════════════════════════════════════════════
    # REELS SCREEN - UFI (User Feedback Icons)
    # ═══════════════════════════════════════════════════════════════════
    # Main containers
    REELS_ROOT_LAYOUT = "com.instagram.android:id/root_clips_layout"
    REELS_VIEWER_CONTAINER = "com.instagram.android:id/clips_viewer_container"
    REELS_VIEW_PAGER = "com.instagram.android:id/clips_viewer_view_pager"
    REELS_VIDEO_CONTAINER = "com.instagram.android:id/clips_video_container"
    REELS_VIDEO_LAYOUT = "com.instagram.android:id/clips_viewer_video_layout"
    REELS_SINGLE_MEDIA = "com.instagram.android:id/clips_single_media_component"
    REELS_MEDIA_COMPONENT = "com.instagram.android:id/clips_media_component"

    # Engagement buttons (Right side)
    REELS_LIKE_BTN = "com.instagram.android:id/like_button"
    REELS_LIKE_COUNT = "com.instagram.android:id/like_count"
    REELS_COMMENT_BTN_ID = "com.instagram.android:id/comment_button"
    REELS_COMMENT_BTN_XPATH = '//android.widget.ImageView[@content-desc="Comment"]'
    REELS_COMMENT_COUNT = "com.instagram.android:id/comment_count"
    REELS_SHARE_BTN = "com.instagram.android:id/direct_share_button"
    REELS_SAVE_BTN = "com.instagram.android:id/save_button"
    REELS_SAVE_COUNT = "com.instagram.android:id/save_count"
    REELS_MORE_BTN = "com.instagram.android:id/clips_ufi_more_button_component"
    REELS_AUDIO_BTN = "com.instagram.android:id/media_album_art_button"
    REELS_REPOST_COUNT = "com.instagram.android:id/repost_count"
    REELS_UFI_COMPONENT = "com.instagram.android:id/clips_ufi_component"
    REELS_UFI_TEXT = "com.instagram.android:id/ufi_text_component"

    # Author info (Bottom left)
    REELS_AUTHOR_INFO = "com.instagram.android:id/clips_author_info_component"
    REELS_AUTHOR_PIC = "com.instagram.android:id/clips_author_profile_pic"
    REELS_AUTHOR_USERNAME = "com.instagram.android:id/clips_author_username"
    REELS_INLINE_FOLLOW_BTN = "com.instagram.android:id/inline_follow_button"
    REELS_CAPTION = "com.instagram.android:id/clips_caption_component"
    REELS_MEDIA_INFO = "com.instagram.android:id/clips_media_info_component"

    # Top action bar
    REELS_ACTION_BAR = "com.instagram.android:id/clips_viewer_action_bar"
    REELS_ACTION_BAR_TITLE = (
        "com.instagram.android:id/clips_viewer_action_bar_title_container"
    )
    REELS_ACTION_BAR_BUTTONS = (
        "com.instagram.android:id/clips_action_bar_end_action_buttons"
    )

    # ═══════════════════════════════════════════════════════════════════
    # HOME FEED POSTS (VERIFIED Dec 2024)
    # ═══════════════════════════════════════════════════════════════════
    # Post container and header
    FEED_POST_HEADER = "com.instagram.android:id/row_feed_profile_header"
    FEED_POST_PROFILE_IMAGE = (
        "com.instagram.android:id/row_feed_photo_profile_imageview"
    )
    FEED_POST_PROFILE_NAME = "com.instagram.android:id/row_feed_photo_profile_name"
    FEED_POST_SECONDARY_LABEL = "com.instagram.android:id/secondary_label"
    FEED_POST_MENU = "com.instagram.android:id/media_option_button"

    # Engagement buttons (bottom of post)
    FEED_BUTTON_GROUP = "com.instagram.android:id/row_feed_view_group_buttons"
    FEED_LIKE_BTN = "com.instagram.android:id/row_feed_button_like"  # Heart icon
    FEED_COMMENT_BTN = (
        "com.instagram.android:id/row_feed_button_comment"  # Comment bubble
    )
    FEED_SHARE_BTN = "com.instagram.android:id/row_feed_button_share"  # Paper airplane
    FEED_SAVE_BTN = "com.instagram.android:id/row_feed_button_save"  # Bookmark icon

    # Media containers
    FEED_VIDEO_CONTAINER = "com.instagram.android:id/video_container"
    FEED_MEDIA_GROUP = "com.instagram.android:id/media_group"

    # Feed scrolling
    FEED_LIST = "android:id/list"  # RecyclerView for feed content
    FEED_REFRESHABLE = "com.instagram.android:id/refreshable_container"

    # ═══════════════════════════════════════════════════════════════════
    # HOME FEED COORDINATES (ADB-VERIFIED Feb 2026)
    # Based on uiautomator dump on 1080x2400 device
    # ⚠️  Y coords for ALL feed buttons are SCROLL-DEPENDENT — they shift
    #     as the user scrolls through the feed. Use resource-ID lookup first!
    # ⚠️  COMMENT and SHARE X coords vary between ad and non-ad posts
    #     (ads insert extra buttons that shift X positions).
    # ═══════════════════════════════════════════════════════════════════
    class FeedCoords:
        # ADB-VERIFIED Feb 2026 — X is stable for Like/Save, Y varies with scroll
        # row_feed_button_like [32,426][95,487] → X=63 (STABLE)
        LIKE_BTN = (63, 456)  # Y is approximate — scroll-dependent
        # ⚠️ COMMENT X varies: 226 (regular) vs 169 (ad) — UNRELIABLE
        COMMENT_BTN = (226, 456)  # Use resource-ID; X shifts on ads
        # ⚠️ SHARE X varies: 517 (regular) vs 466 (ad) — UNRELIABLE
        SHARE_BTN = (517, 456)  # Use resource-ID; X shifts on ads
        # row_feed_button_save X=1017 (STABLE across all post types)
        SAVE_BTN = (1017, 456)  # Y is approximate — scroll-dependent

        # Double-tap to like (center of media area)
        # ADB: media bounds [0,756][1080,2074] → center (540, 1415)
        DOUBLE_TAP_LIKE = (540, 1415)

        # Scroll gesture (for home feed - shorter swipe than reels)
        SCROLL_START = (540, 1800)
        SCROLL_END = (540, 700)

    # ═══════════════════════════════════════════════════════════════════
    # COMMENT SHEET (Bottom Sheet when opened)
    # ═══════════════════════════════════════════════════════════════════
    COMMENT_INPUT = "com.instagram.android:id/layout_comment_thread_edittext"
    COMMENT_COMPOSER_PARENT = "com.instagram.android:id/comment_composer_parent_updated"
    COMMENT_COMPOSER_AVATAR = (
        "com.instagram.android:id/comment_composer_left_image_view"
    )
    COMMENT_TEXT_PARENT = "com.instagram.android:id/comment_composer_text_parent"
    COMMENT_EDITTEXT_CONTAINER = "com.instagram.android:id/edittext_container"
    COMMENT_STICKER_BTN = (
        "com.instagram.android:id/comment_composer_animated_image_picker_button"
    )
    COMMENT_POST_BTN = "com.instagram.android:id/layout_comment_thread_post_button_icon"
    COMMENT_SHEET_TITLE = "com.instagram.android:id/title_text_view"
    COMMENT_LIST = "com.instagram.android:id/sticky_header_list"
    COMMENT_EMOJI_ITEM = "com.instagram.android:id/item_emoji"
    COMMENT_ABOVE_COMPOSER = "com.instagram.android:id/above_composer_views"
    COMMENT_LIST_CONTAINER = "com.instagram.android:id/list_view_container"

    # Bottom sheet containers
    BOTTOM_SHEET_CONTAINER = "com.instagram.android:id/bottom_sheet_container"
    BOTTOM_SHEET_DRAG_HANDLE = "com.instagram.android:id/bottom_sheet_drag_handle_frame"
    BOTTOM_SHEET_VIEW = "com.instagram.android:id/bottom_sheet_container_view"

    class CommentCoords:
        # ⚠️ ADB-VERIFIED Feb 2026: Comment sheet position is DYNAMIC.
        # Y coords depend on whether keyboard is open and sheet expansion.
        # ADB dump (no keyboard): input [148,1390][938,1480] → (543, 1435)
        # ADB dump (with keyboard): input [148,927][938,1017] → (543, 972)
        # These fallbacks are approximate — ALWAYS prefer resource-ID lookup.
        INPUT_FIELD = (543, 1435)  # DYNAMIC Y — resource-ID is only reliable method
        # Post button: only visible AFTER text is typed
        # ADB: post_button_icon [953,1393][1001,1489] → (977, 1441)
        POST_BTN = (977, 1441)  # DYNAMIC Y — resource-ID is only reliable method

    # ═══════════════════════════════════════════════════════════════════
    # HOME FEED
    # ═══════════════════════════════════════════════════════════════════
    # Story tray (on home feed)
    STORY_TRAY_CONTAINER = "com.instagram.android:id/reels_tray_container"
    STORY_TRAY_CONTAINER_DESC = "reels tray container"
    STORY_TRAY_XPATH = '//androidx.recyclerview.widget.RecyclerView[@content-desc="reels tray container"]'
    STORY_OUTER_CONTAINER = "com.instagram.android:id/outer_container"
    STORY_AVATAR_VIEW = "com.instagram.android:id/avatar_view"
    STORY_AVATAR_CONTAINER = "com.instagram.android:id/avatar_container"
    STORY_AVATAR = "com.instagram.android:id/avatar_image_view"
    STORY_USERNAME = "com.instagram.android:id/username"
    STORY_TITLE_CONTAINER = "com.instagram.android:id/title_container"
    STORY_SEEN_STATE = "com.instagram.android:id/seen_state"
    STORY_ADD_BADGE = "com.instagram.android:id/reel_empty_badge"
    YOUR_STORY_TEXT = "Your story"

    # ═══════════════════════════════════════════════════════════════════
    # STORY VIEWING SCREEN (VERIFIED Dec 2024)
    # When viewing a story - these are the interactive elements
    # ═══════════════════════════════════════════════════════════════════
    # Main containers
    STORY_VIEWER_ROOT = "com.instagram.android:id/reel_viewer_root"
    STORY_VIEW_GROUP = "com.instagram.android:id/reel_view_group"
    STORY_MEDIA_CONTAINER = "com.instagram.android:id/reel_viewer_media_container"
    STORY_MEDIA_LAYOUT = "com.instagram.android:id/reel_viewer_media_layout"
    STORY_IMAGE_VIEW = "com.instagram.android:id/reel_viewer_image_view"

    # Header elements
    STORY_VIEWER_HEADER = "com.instagram.android:id/reel_viewer_header"
    STORY_VIEWER_HEADER_CONTAINER = (
        "com.instagram.android:id/reel_viewer_header_container"
    )
    STORY_VIEWER_PROFILE_PIC = "com.instagram.android:id/reel_viewer_profile_picture"
    STORY_PROFILE_PIC_CONTAINER = "com.instagram.android:id/profile_picture_container"
    STORY_VIEWER_FRONT_AVATAR = "com.instagram.android:id/reel_viewer_front_avatar"
    STORY_VIEWER_TEXT_CONTAINER = "com.instagram.android:id/reel_viewer_text_container"
    STORY_VIEWER_TITLE = "com.instagram.android:id/reel_viewer_title"
    STORY_VIEWER_TIMESTAMP = "com.instagram.android:id/reel_viewer_timestamp"
    STORY_HEADER_MENU_BUTTON = "com.instagram.android:id/header_menu_button"
    STORY_HEADER_EXTRAS = "com.instagram.android:id/reel_header_extras_container"

    # Progress bar
    STORY_PROGRESS_BAR = "com.instagram.android:id/reel_viewer_progress_bar"

    # Footer/toolbar elements (IMPORTANT - interactive buttons)
    STORY_TOOLBAR_CONTAINER = "com.instagram.android:id/reel_item_toolbar_container"
    STORY_TOOLBAR_FOOTER = "com.instagram.android:id/reel_item_toolbar_footer_container"
    STORY_VIEWER_TOOLBAR = "com.instagram.android:id/viewer_reel_item_toolbar_container"
    STORY_BUTTONS_CONTAINER = "com.instagram.android:id/toolbar_buttons_container"
    STORY_LIKE_BUTTON = "com.instagram.android:id/toolbar_like_button"
    STORY_LIKE_CONTAINER = "com.instagram.android:id/toolbar_like_container"
    STORY_RESHARE_BUTTON = "com.instagram.android:id/toolbar_reshare_button"
    STORY_CTA_CONTAINER = "com.instagram.android:id/story_item_cta_container"

    # Message composer (reply to story)
    STORY_MESSAGE_COMPOSER = "com.instagram.android:id/message_composer_container"
    STORY_COMPOSER_TEXT = "com.instagram.android:id/composer_text"

    # Shadow overlays
    STORY_TOP_SHADOW = "com.instagram.android:id/reel_viewer_top_shadow"
    STORY_BOTTOM_SHADOW = "com.instagram.android:id/reel_viewer_bottom_shadow"
    STORY_AVATAR_STICKER = (
        "com.instagram.android:id/reel_avatar_accessibility_sticker_container"
    )

    # Feed elements
    FEED_LIST = "android:id/list"
    FEED_PROFILE_HEADER = "com.instagram.android:id/row_feed_profile_header"
    FEED_PROFILE_PIC = "com.instagram.android:id/row_feed_photo_profile_imageview"
    FEED_PROFILE_NAME = "com.instagram.android:id/row_feed_photo_profile_name"
    FEED_SECONDARY_LABEL = "com.instagram.android:id/secondary_label"
    FEED_MORE_BTN = "com.instagram.android:id/media_option_button"
    FEED_VIDEO_CONTAINER = "com.instagram.android:id/video_container"
    FEED_MEDIA_GROUP = "com.instagram.android:id/media_group"
    FEED_BUTTON_GROUP = "com.instagram.android:id/row_feed_view_group_buttons"
    FEED_LIKE_BUTTON = "com.instagram.android:id/row_feed_button_like"
    FEED_COMMENT_BUTTON = "com.instagram.android:id/row_feed_button_comment"
    FEED_SHARE_BUTTON = "com.instagram.android:id/row_feed_button_share"
    FEED_SAVE_BUTTON = "com.instagram.android:id/row_feed_button_save"
    FEED_PREVIEW_KEEP_WATCHING = (
        "com.instagram.android:id/feed_preview_keep_watching_button"
    )

    # Top action bar (VERIFIED Dec 2024 - Home Screen)
    ACTION_BAR_CONTAINER = "com.instagram.android:id/action_bar_LinearLayout"
    ACTION_BAR_TITLE_LOGO = "com.instagram.android:id/title_logo"
    ACTION_BAR_TITLE_VIEW = "com.instagram.android:id/action_bar_title_view"
    ACTION_BAR_TITLE_LOGO_CHEVRON = (
        "com.instagram.android:id/title_logo_chevron_container"
    )
    ACTION_BAR_LEFT_BUTTONS = (
        "com.instagram.android:id/action_bar_buttons_container_left"
    )
    ACTION_BAR_RIGHT_BUTTONS = (
        "com.instagram.android:id/action_bar_buttons_container_right"
    )
    ACTION_BAR_INBOX = "com.instagram.android:id/action_bar_inbox_button"  # legacy
    DIRECT_INBOX_ACTION_BAR = "com.instagram.android:id/direct_inbox_action_bar"
    ACTION_BAR_NOTIFICATION = "com.instagram.android:id/notification"
    ACTION_BAR_LED_BADGE = "com.instagram.android:id/led_badge"
    MAIN_FEED_ACTION_BAR = "com.instagram.android:id/main_feed_action_bar"

    # ═══════════════════════════════════════════════════════════════════
    # SEARCH / EXPLORE
    # ═══════════════════════════════════════════════════════════════════
    # Action bar elements
    EXPLORE_ACTION_BAR = "com.instagram.android:id/explore_action_bar"
    SEARCH_ACTION_BAR = "com.instagram.android:id/action_bar"
    SEARCH_ACTION_BAR_CONTAINER = "com.instagram.android:id/action_bar_container"
    SEARCH_ACTION_BAR_WRAPPER = "com.instagram.android:id/action_bar_wrapper"
    SEARCH_ACTION_BAR_BACK = "com.instagram.android:id/action_bar_button_back"
    SEARCH_TITLE_CONTAINER = (
        "com.instagram.android:id/action_bar_textview_custom_title_container"
    )
    SEARCH_NEW_TITLE_CONTAINER = (
        "com.instagram.android:id/action_bar_new_title_container"
    )

    # Search input
    SEARCH_EDIT_TEXT = "com.instagram.android:id/action_bar_search_edit_text"
    SEARCH_HINTS_LAYOUT = "com.instagram.android:id/action_bar_search_hints_text_layout"

    # Search results
    SEARCH_RECYCLER = "com.instagram.android:id/recycler_view"
    SEARCH_GRID_CARD = "com.instagram.android:id/grid_card_layout_container"
    SEARCH_IMAGE_BTN = "com.instagram.android:id/image_button"
    SEARCH_RESULT_ROW = "com.instagram.android:id/row_search_user_username"
    SEARCH_RESULT_PROFILE_IMG = "com.instagram.android:id/row_search_profile_image"
    SEARCH_RESULT_KEYWORD_CONTAINER = "com.instagram.android:id/search_keyword_title"
    SEARCH_RESULT_KEYWORD_TITLE = "com.instagram.android:id/row_search_keyword_title"
    SEARCH_RESULT_KEYWORD_SUBTITLE = (
        "com.instagram.android:id/row_search_keyword_subtitle"
    )
    SEARCH_SECTION_CONTAINER = "com.instagram.android:id/search_section_container"
    SEARCH_SEE_ALL = "com.instagram.android:id/see_all_action_view"
    SEARCH_DISMISS_BTN = "com.instagram.android:id/dismiss_button"
    SEARCH_ROW_BTN_CONTAINER = "com.instagram.android:id/row_button_container"

    # Search result user row (for clicking on user results)
    SEARCH_USER_CONTAINER = "com.instagram.android:id/row_search_user_container"
    SEARCH_USER_INFO_CONTAINER = (
        "com.instagram.android:id/row_search_user_info_container"
    )
    SEARCH_USER_AVATAR_RING = "com.instagram.android:id/row_search_avatar_with_ring"
    SEARCH_USER_AVATAR = "com.instagram.android:id/row_search_avatar_in_ring"
    SEARCH_USER_USERNAME = "com.instagram.android:id/row_search_user_username"
    SEARCH_USER_FULLNAME = "com.instagram.android:id/row_search_user_fullname"
    SEARCH_USER_FOLLOW_BTN = "com.instagram.android:id/row_search_user_follow_button"  # Follow in search results!
    SEARCH_ACCOUNTS_TAB_XPATH = "//android.widget.TextView[@text='Accounts']"
    SEARCH_FOLLOW_BUTTON_XPATH = "//*[@text='Follow']"

    # ═══════════════════════════════════════════════════════════════════
    # PROFILE SCREEN
    # ═══════════════════════════════════════════════════════════════════
    # Containers
    PROFILE_FRAGMENT = "com.instagram.android:id/user_detail_fragment"
    PROFILE_COORDINATOR = "com.instagram.android:id/coordinator_root_layout"
    PROFILE_TAB_APPBAR = "com.instagram.android:id/tab_appbar"
    PROFILE_HEADER_CONTAINER = "com.instagram.android:id/profile_header_container"
    PROFILE_HEADER_FIXED = "com.instagram.android:id/profile_header_fixed_list"
    PROFILE_ROW_HEADER = "com.instagram.android:id/row_profile_header"

    # Avatar and notes
    PROFILE_AVATAR_CONTAINER = (
        "com.instagram.android:id/profile_header_avatar_container_top_left_stub"
    )
    PROFILE_IMAGE_FRAME = (
        "com.instagram.android:id/row_profile_header_imageview_frame_layout"
    )
    PROFILE_IMAGE = "com.instagram.android:id/row_profile_header_imageview"
    PROFILE_NOTE_CONTAINER = "com.instagram.android:id/pog_note_bubble_container"
    PROFILE_NOTE_VIEW = "com.instagram.android:id/pog_note_bubble_view"
    PROFILE_NOTE_TEXT = "com.instagram.android:id/pog_bubble_text"

    # Metrics
    PROFILE_FULL_NAME = "com.instagram.android:id/profile_header_full_name_above_vanity"
    PROFILE_METRICS = "com.instagram.android:id/profile_header_metrics_full_width"
    PROFILE_POST_COUNT = (
        "com.instagram.android:id/profile_header_post_count_front_familiar"
    )
    PROFILE_POST_VALUE = (
        "com.instagram.android:id/profile_header_familiar_post_count_value"
    )
    PROFILE_POST_LABEL = (
        "com.instagram.android:id/profile_header_familiar_post_count_label"
    )
    PROFILE_FOLLOWERS = (
        "com.instagram.android:id/profile_header_followers_stacked_familiar"
    )
    PROFILE_FOLLOWERS_VALUE = (
        "com.instagram.android:id/profile_header_familiar_followers_value"
    )
    PROFILE_FOLLOWERS_LABEL = (
        "com.instagram.android:id/profile_header_familiar_followers_label"
    )
    PROFILE_FOLLOWING = (
        "com.instagram.android:id/profile_header_following_stacked_familiar"
    )
    PROFILE_FOLLOWING_VALUE = (
        "com.instagram.android:id/profile_header_familiar_following_value"
    )
    PROFILE_FOLLOWING_LABEL = (
        "com.instagram.android:id/profile_header_familiar_following_label"
    )

    # Bio and links
    PROFILE_USER_INFO = "com.instagram.android:id/profile_user_info_compose_view"
    PROFILE_LINKS = "com.instagram.android:id/profile_links_view"
    PROFILE_LINK_ICON = "com.instagram.android:id/icon_view"
    PROFILE_LINK_TEXT = "com.instagram.android:id/text_view"

    # Action buttons (self profile)
    PROFILE_ACTIONS_ROW = "com.instagram.android:id/profile_header_actions_top_row"
    PROFILE_BUTTON_CONTAINER = "com.instagram.android:id/button_container"

    # Action buttons (other profile)
    PROFILE_HEADER_FOLLOW_BTN = "com.instagram.android:id/profile_header_follow_button"
    PROFILE_HEADER_MESSAGE_BTN = (
        "com.instagram.android:id/profile_header_message_button"
    )
    ROW_USER_FOLLOW_BTN = "com.instagram.android:id/row_user_access_follow_button"

    # Tabs
    PROFILE_TABS_CONTAINER = "com.instagram.android:id/profile_tabs_container"
    PROFILE_TAB_LAYOUT = "com.instagram.android:id/profile_tab_layout"
    PROFILE_TAB_ICON = "com.instagram.android:id/profile_tab_icon_view"
    PROFILE_TABS_DIVIDER = "com.instagram.android:id/profile_tabs_bottom_divider"
    PROFILE_VIEWPAGER = "com.instagram.android:id/profile_viewpager"

    # Empty state
    PROFILE_EMPTY_ROOT = "com.instagram.android:id/empty_state_view_root"
    PROFILE_EMPTY_IMAGE = "com.instagram.android:id/igds_empty_state_image"
    PROFILE_EMPTY_TITLE = "com.instagram.android:id/igds_empty_state_title"
    PROFILE_EMPTY_BODY = "com.instagram.android:id/igds_empty_state_body_text"
    PROFILE_EMPTY_ACTION = (
        "com.instagram.android:id/igds_empty_state_primary_action_button"
    )

    # Top action bar
    PROFILE_ACTION_BAR = "com.instagram.android:id/profile_action_bar"
    PROFILE_ACTION_BAR_LAYOUT = "com.instagram.android:id/action_bar_layout"
    PROFILE_USERNAME_CONTAINER = (
        "com.instagram.android:id/action_bar_username_container"
    )
    PROFILE_USERNAME_TITLE = "com.instagram.android:id/action_bar_title"
    PROFILE_CHEVRON = "com.instagram.android:id/action_bar_title_chevron"
    PROFILE_RIGHT_BUTTONS = "com.instagram.android:id/right_action_bar_buttons"

    # ═══════════════════════════════════════════════════════════════════
    # EDIT PROFILE (Prism)
    # ═══════════════════════════════════════════════════════════════════
    EDIT_PROFILE_BUTTON_TEXT = "Edit profile"
    EDIT_PROFILE_NAME_BTN = "com.instagram.android:id/full_name"
    EDIT_PROFILE_USERNAME_BTN = "com.instagram.android:id/username"
    EDIT_PROFILE_BIO_BTN = "com.instagram.android:id/bio"

    # Universal Input (Name, Username, Bio, Links)
    PRISM_INPUT_FIELD_ID = "com.instagram.android:id/prism_form_field_container"
    PRISM_INPUT_FIELD_XPATH = '//android.widget.EditText[@resource-id="com.instagram.android:id/prism_form_field_container"]/android.widget.EditText'

    # ═══════════════════════════════════════════════════════════════════
    # CREATE / CAMERA SCREEN (Verified Dec 2024 via XML dumps)
    # ═══════════════════════════════════════════════════════════════════
    # Main containers
    CREATE_MULTI_DEST_CONTAINER = "com.instagram.android:id/multi_destination_container"
    CREATE_QUICK_CAPTURE_ROOT = "com.instagram.android:id/quick_capture_root_container"
    CREATE_QUICK_CAPTURE_OUTER = (
        "com.instagram.android:id/quick_capture_outer_container"
    )
    CREATE_QUICK_CAPTURE_DRAWER = (
        "com.instagram.android:id/quick_capture_drawer_content"
    )
    CREATE_FEED_DEST_CONTAINER = (
        "com.instagram.android:id/feed_destination_curation_container"
    )

    # Action bar (Gallery/Create screen)
    CREATE_ACTION_BAR_CANCEL = "com.instagram.android:id/action_bar_cancel"  # bounds [0,128][147,275] -> (73, 201)
    CREATE_NEW_POST_TITLE = "com.instagram.android:id/new_post_title"  # "New post"
    CREATE_NEXT_BTN = "com.instagram.android:id/next_button_textview"  # bounds [920,128][1080,275] -> (1000, 201)

    # Camera controls
    CREATE_CAMERA_HOME_BTN = (
        "com.instagram.android:id/camera_home_button"  # content-desc="Back to Home"
    )
    CREATE_CAMERA_FLASH_BTN = "com.instagram.android:id/camera_flash_button"
    CREATE_CAMERA_SETTINGS = "com.instagram.android:id/camera_settings_gear"
    CREATE_CAMERA_SWITCH = "com.instagram.android:id/camera_switch_button"
    CREATE_SHUTTER_CONTAINER = (
        "com.instagram.android:id/camera_shutter_button_container"
    )
    CREATE_SHUTTER_BTN = (
        "com.instagram.android:id/camera_shutter_button"  # content-desc="Shutter"
    )
    CREATE_GALLERY_BTN = (
        "com.instagram.android:id/gallery_preview_button"  # content-desc="Gallery"
    )

    # Destination tabs (POST, STORY, REEL, LIVE)
    CREATE_DEST_POST = "com.instagram.android:id/cam_dest_feed"  # ADB-VERIFIED Feb 2026: bounds [293,2213][448,2302] -> (370, 2257)
    CREATE_DEST_STORY = "com.instagram.android:id/cam_dest_story"  # ADB-VERIFIED Feb 2026: bounds [448,2213][632,2303] -> (540, 2258)
    CREATE_DEST_REEL = "com.instagram.android:id/cam_dest_clips"  # ADB-VERIFIED Feb 2026: bounds [632,2213][781,2302] -> (706, 2257)
    CREATE_DEST_LIVE = "com.instagram.android:id/cam_dest_live"  # ADB-VERIFIED Feb 2026: bounds [781,2213][912,2302] -> (846, 2257)

    # Gallery picker elements
    CREATE_GALLERY_PICKER_VIEW = "com.instagram.android:id/gallery_picker_view"
    CREATE_GALLERY_COORDINATOR = "com.instagram.android:id/gallery_coordinator"
    CREATE_GALLERY_APP_BAR = "com.instagram.android:id/feed_gallery_app_bar"
    CREATE_PREVIEW_CONTAINER = "com.instagram.android:id/preview_container"
    CREATE_CROP_IMAGE_VIEW = "com.instagram.android:id/crop_image_view"  # content-desc="Photo preview thumbnail"
    CREATE_CROPTYPE_TOGGLE = (
        "com.instagram.android:id/croptype_toggle_button"  # content-desc="Change crop"
    )
    CREATE_FOLDER_MENU = "com.instagram.android:id/gallery_folder_menu_tv"  # "Recents"
    CREATE_MULTI_SELECT_BTN = (
        "com.instagram.android:id/multi_select_slide_button_alt"  # "Select multiple"
    )
    CREATE_MEDIA_PICKER_CONTAINER = "com.instagram.android:id/media_picker_container"
    CREATE_MEDIA_PICKER_GRID = "com.instagram.android:id/media_picker_grid_view"
    CREATE_GRID_ITEM_CONTAINER = (
        "com.instagram.android:id/gallery_picker_grid_item_container"
    )
    CREATE_GRID_ITEM_THUMBNAIL = "com.instagram.android:id/gallery_grid_item_thumbnail"
    CREATE_GRID_ITEM_OVERLAY = (
        "com.instagram.android:id/gallery_grid_item_selection_overlay"
    )

    # AR/Effects
    CREATE_AR_PICKER = "com.instagram.android:id/ar_effect_picker_pager"
    CREATE_AR_EFFECT_ICON = "com.instagram.android:id/ar_effect_in_tray_icon"
    CREATE_TOOL_MENU = "com.instagram.android:id/camera_tool_menu_item_holder"

    # ═══════════════════════════════════════════════════════════════════
    # SHARING/CAPTION SCREEN (Verified Dec 2024 via XML dumps)
    # ═══════════════════════════════════════════════════════════════════
    # Main containers
    SHARE_SCROLL_VIEW = "com.instagram.android:id/scroll_view"
    SHARE_CONTENT_ROWS = "com.instagram.android:id/content_rows_container"
    SHARE_FOLLOWERS_CONTENT = "com.instagram.android:id/followers_share_content"

    # Media preview
    SHARE_MEDIA_PREVIEW_RECYCLER = "com.instagram.android:id/media_preview_recycler_view"  # content-desc="Photo thumbnail"
    SHARE_PHOTO_PREVIEW = "com.instagram.android:id/photo_media_preview_image_view"

    # Caption input - VERIFIED WORKING
    SHARE_CAPTION_INPUT = "com.instagram.android:id/caption_input_text_view"  # bounds [42,990][1038,1116] -> (540, 1053)
    SHARE_CAPTION_ADDON_RECYCLER = (
        "com.instagram.android:id/caption_add_on_recyclerview"
    )

    # Audio/Music row
    SHARE_MUSIC_ROW_ICON = "com.instagram.android:id/music_row_icon"
    SHARE_MUSIC_ROW_TITLE = "com.instagram.android:id/music_row_title"  # "Add audio" bounds [137,1304][337,1357]
    SHARE_MUSIC_ROW_CHEVRON = "com.instagram.android:id/music_row_chevron_icon"

    # Tag people row
    SHARE_TAG_PEOPLE_ROW = "com.instagram.android:id/metadata_row_people"
    SHARE_TAG_PEOPLE_ICON = "com.instagram.android:id/tag_people_row_icon"
    SHARE_TAG_PEOPLE_STRING = "com.instagram.android:id/tag_people_string"  # "Tag people" bounds [137,1550][954,1603]

    # Location row
    SHARE_LOCATION_ROW = (
        "com.instagram.android:id/metadata_location_row"  # content-desc="Add location"
    )
    SHARE_LOCATION_ICON = "com.instagram.android:id/location_balloon"
    SHARE_LOCATION_LABEL = "com.instagram.android:id/location_label"  # "Add location" bounds [137,1640][975,1766]
    SHARE_MAP_EDUCATION = "com.instagram.android:id/map_content_education"

    # AI label toggle row
    SHARE_AI_LABEL_TITLE = "com.instagram.android:id/title"  # "Add AI label"
    SHARE_AI_LABEL_SUBTITLE = "com.instagram.android:id/subtitle"
    SHARE_AI_LABEL_TOGGLE = (
        "com.instagram.android:id/toggle"  # bounds [901,1929][1038,2013]
    )

    # Audience row
    SHARE_AUDIENCE_TITLE = "com.instagram.android:id/title"  # "Audience"
    SHARE_AUDIENCE_SUBTITLE = "com.instagram.android:id/inline_subtitle"  # "Everyone"

    # Share/Footer button - VERIFIED WORKING
    SHARE_FOOTER_CONTAINER = "com.instagram.android:id/footer_button_container"
    SHARE_FOOTER_DIVIDER = "com.instagram.android:id/footer_button_divider"
    SHARE_FOOTER_BUTTON = "com.instagram.android:id/share_footer_button"  # content-desc="Share" bounds [42,2221][1038,2337] -> (540, 2279)

    # Action bar (sharing screen)
    SHARE_ACTION_BAR_WRAPPER = "com.instagram.android:id/media_edit_action_bar_wrapper"
    SHARE_ACTION_BAR = "com.instagram.android:id/media_edit_action_bar"
    SHARE_BACK_BUTTON = "com.instagram.android:id/button_back"  # content-desc="Back" bounds [0,128][147,275] -> (73, 201)
    SHARE_ACTION_BAR_TITLE = "com.instagram.android:id/action_bar_textview_title"  # "New post" bounds [147,128][1059,275]

    # Legacy aliases for backwards compatibility
    CREATE_CAPTION_INPUT = "com.instagram.android:id/caption_input_text_view"
    CREATE_SHARE_BTN = "com.instagram.android:id/share_footer_button"
    CREATE_SAVE_DRAFT_BTN = "com.instagram.android:id/save_draft_button"
    CREATE_TOP_RIGHT_BTN = "com.instagram.android:id/action_bar_button_action"

    # ═══════════════════════════════════════════════════════════════════
    # MODERNIZED REAL-DEVICE SHARED SURFACES (small normalized set)
    # ═══════════════════════════════════════════════════════════════════
    NAV_PRIMARY_TABS = {
        'home': HOME_TAB,
        'search': SEARCH_TAB,
        'messages': MESSAGE_TAB,
        'reels': REELS_TAB,
        'profile': PROFILE_TAB,
    }
    NAV_PRIMARY_TAB_DESCRIPTIONS = {
        'home': HOME_TAB_DESC,
        'search': SEARCH_TAB_DESC,
        'messages': MESSAGE_TAB_DESC,
        'reels': REELS_TAB_DESC,
        'profile': PROFILE_TAB_DESC,
    }
    PROFILE_HEADER_IDS = {
        'username_title': PROFILE_USERNAME_TITLE,
        'username_container': PROFILE_USERNAME_CONTAINER,
        'chevron': PROFILE_CHEVRON,
        'tab_avatar': TAB_AVATAR,
    }
    PROFILE_HEADER_CONTENT_DESC_PATTERNS = {
        'profile_picture_suffix': 'profile picture',
    }
    CREATE_EDITOR_MARKERS = {
        'gallery_recycler': CREATE_GRID_ITEM_THUMBNAIL,
        'caption_input': SHARE_CAPTION_INPUT,
        'share_footer_button': SHARE_FOOTER_BUTTON,
        'story_share_controls': 'com.instagram.android:id/story_share_controls_action_bar',
        'story_add_caption': 'com.instagram.android:id/add_caption_textview',
        'story_reply_bar': 'com.instagram.android:id/reel_viewer_reply_bar',
    }

    # Edit Profile additional
    EDIT_PROFILE_BTN = "com.instagram.android:id/row_profile_header_edit_profile_button"
    LINK_OPTION_TEXT = "com.instagram.android:id/link_option_text"

    # Tab bar shadow
    TAB_BAR_SHADOW = "com.instagram.android:id/tab_bar_shadow"

    # ═══════════════════════════════════════════════════════════════════
    # POPUPS / DIALOGS / PROMOS
    # ═══════════════════════════════════════════════════════════════════
    # Main dialog containers
    DIALOG_CONTAINER = "com.instagram.android:id/dialog_container"
    PROMO_DIALOG_HEADLINE = "com.instagram.android:id/igds_promo_dialog_headline"
    HEADLINE_IMAGE = "com.instagram.android:id/igds_headline_image"
    HEADLINE_TITLE = "com.instagram.android:id/igds_headline_headline"
    HEADLINE_BODY = "com.instagram.android:id/igds_headline_body"

    # Promo/Info dialog buttons
    HEADLINE_PRIMARY_BTN = "com.instagram.android:id/igds_headline_primary_action_button"  # "Got it", "OK", etc.
    HEADLINE_SECONDARY_BTN = (
        "com.instagram.android:id/igds_headline_secondary_action_button"
    )

    # Alert dialog buttons (confirmations)
    ALERT_PRIMARY_BTN = "com.instagram.android:id/igds_alert_dialog_primary_button"
    ALERT_SECONDARY_BTN = "com.instagram.android:id/igds_alert_dialog_secondary_button"

    # Common popup dismiss patterns (accessibility IDs / text)
    POPUP_DISMISS_TEXT = [
        "Got it",
        "OK",
        "Dismiss",
        "Close",
        "Not Now",
        "Skip",
        "Cancel",
        "Maybe Later",
    ]

    # ═══════════════════════════════════════════════════════════════════
    # AD / SPONSORED DETECTION (for skipping ads in engagement)
    # ═══════════════════════════════════════════════════════════════════
    # Text markers found in XML dumps for sponsored content
    AD_TEXT_MARKERS = ["Sponsored", "Ad", "Paid for by", "Paid partnership"]
    AD_CONTENT_DESC_MARKERS = ["Sponsored"]

    # Like button state detection (content-desc values)
    # resource-id contains "like_button" + content-desc="Like" → not liked
    # resource-id contains "like_button" + content-desc="Liked" → already liked
    LIKE_STATE_NOT_LIKED = "Like"
    LIKE_STATE_LIKED = "Liked"
    REELS_LIKE_BUTTON = "com.instagram.android:id/like_button"
    REELS_COMMENT_BUTTON = "com.instagram.android:id/comment_button"
    REELS_SHARE_BUTTON = "com.instagram.android:id/direct_share_button"
    REELS_SAVE_BUTTON = "com.instagram.android:id/save_button"
    REELS_MORE_BUTTON = "com.instagram.android:id/clips_ufi_more_button_component"
    REELS_AUTHOR_USERNAME = "com.instagram.android:id/clips_author_username"
    REELS_INLINE_FOLLOW_BUTTON = "com.instagram.android:id/inline_follow_button"
    REELS_ROOT_LAYOUT = "com.instagram.android:id/root_clips_layout"

    # Story viewer / story tray
    STORY_REPLY_BAR = "com.instagram.android:id/reel_viewer_reply_bar"
    STORY_MESSAGE_COMPOSER = "com.instagram.android:id/message_composer_container"
    STORY_VIEW_ROOT = "com.instagram.android:id/reel_viewer_root"
    STORY_TRAY_CONTAINER = "com.instagram.android:id/reels_tray_container"
    STORY_TRAY_ITEM = "com.instagram.android:id/outer_container"
    STORY_AVATAR = "com.instagram.android:id/avatar_image_view"
    STORY_EMPTY_BADGE = "com.instagram.android:id/reel_empty_badge"

    # ═══════════════════════════════════════════════════════════════════
    # DIRECT MESSAGES (DM)
    # ═══════════════════════════════════════════════════════════════════
    DM_TAB = "com.instagram.android:id/direct_tab"
    DM_INBOX_ACTION_BAR = "com.instagram.android:id/direct_inbox_action_bar"
    DM_LEGACY_INBOX_ACTION_BAR = "com.instagram.android:id/action_bar_inbox_button"
    DM_THREAD_LIST = "com.instagram.android:id/inbox_refreshable_thread_list_recyclerview"
    DM_MESSAGE_COMPOSER = "com.instagram.android:id/row_thread_composer_edittext"
    DM_SEND_BUTTON = (
        "com.instagram.android:id/row_thread_composer_send_button_container"
    )
    DM_NEW_MESSAGE_BTN = "com.instagram.android:id/creation_entrypoint"
    DM_LEGACY_NEW_MESSAGE_BTN = "com.instagram.android:id/action_bar_button_action"
    DM_SEARCH_RECIPIENT = "com.instagram.android:id/action_bar_search_edit_text"

    # ═══════════════════════════════════════════════════════════════════
    # UNIVERSAL ELEMENTS
    # ═══════════════════════════════════════════════════════════════════
    # Internal Layouts
    SWIPE_NAV_CONTAINER = "com.instagram.android:id/swipe_navigation_container"
    LAYOUT_CONTAINER_MAIN = "com.instagram.android:id/layout_container_main"
    LAYOUT_CONTAINER_WRAPPER = "com.instagram.android:id/layout_container_main_wrapper"
    LAYOUT_CONTAINER_PANEL = "com.instagram.android:id/layout_container_main_panel"
    MODAL_CONTAINER = "com.instagram.android:id/modal_container"
    OVERLAY_CONTAINER = "com.instagram.android:id/overlay_layout_container"
    ACTION_BAR_ROOT = "com.instagram.android:id/action_bar_root"
    ANDROID_CONTENT = "android:id/content"

    # Action buttons
    ACTION_BAR_SAVE_BTN = (
        "com.instagram.android:id/action_bar_button_action"  # Checkmark
    )
    ACTION_BAR_BACK_BTN = "com.instagram.android:id/action_bar_button_back"
    DIALOG_CONFIRM_BTN = "com.instagram.android:id/igds_alert_dialog_primary_button"
    DIALOG_CANCEL_BTN = "com.instagram.android:id/igds_alert_dialog_secondary_button"

    # ═══════════════════════════════════════════════════════════════════
    # COORDINATE CENTERS (1080x2400 resolution, scale for others)
    # ═══════════════════════════════════════════════════════════════════
    class Coords:
        """Pre-calculated center coordinates for common elements

        UPDATED 2024-12-24: Instagram new layout
        - 5 tabs: Home, Reels, Message, Search, Profile
        - Create button moved to top-left (not in bottom nav anymore)
        """

        # New 5-tab bottom nav (left to right)
        HOME_TAB = (108, 2274)  # feed_tab
        REELS_TAB = (324, 2274)  # clips_tab
        MESSAGE_TAB = (540, 2274)  # direct_tab (NEW - center position)
        SEARCH_TAB = (756, 2274)  # search_tab
        PROFILE_TAB = (972, 2274)  # profile_tab

        # Top Action Bar
        NEW_POST_BUTTON = (
            63,
            201,
        )  # Top-left + button (approx center of [0,128][127,275])

        # Legacy alias for backwards compatibility
        CREATE_TAB = None  # DEPRECATED - Create no longer in bottom nav

        # Reels UFI (right side)
        REELS_LIKE = (1001, 1121)
        REELS_COMMENT = (1001, 1299)
        REELS_SHARE = (1001, 1655)
        REELS_SAVE = (1001, 1833)
        REELS_MORE = (1001, 2011)

        # Screen center
        CENTER = (540, 1200)

        # Swipe coordinates
        SWIPE_START_Y = 1900
        SWIPE_END_Y = 500

        # Create screen destination tabs (ADB-VERIFIED Feb 2026)
        CREATE_POST_TAB = (370, 2257)  # cam_dest_feed bounds [293,2213][448,2302]
        CREATE_STORY_TAB = (540, 2258)  # cam_dest_story bounds [448,2213][632,2303]
        CREATE_REEL_TAB = (706, 2257)  # cam_dest_clips bounds [632,2213][781,2302]
        CREATE_LIVE_TAB = (846, 2257)  # cam_dest_live bounds [781,2213][912,2302]
        CREATE_GALLERY = (89, 2255)  # Gallery button
        CREATE_SHUTTER = (540, 2030)  # Shutter button

        # Gallery/Create screen action bar (verified Dec 2024)
        CREATE_CANCEL_BUTTON = (73, 201)  # action_bar_cancel bounds [0,128][147,275]
        CREATE_NEXT_BUTTON = (
            1000,
            201,
        )  # next_button_textview bounds [920,128][1080,275] - FIRST Next (media→edit)
        EDIT_NEXT_BUTTON = (
            961,
            2280,
        )  # SECOND Next (edit→share) - BOTTOM RIGHT, NOT top right!

        # Gallery picker (verified Dec 2024)
        GALLERY_FIRST_THUMBNAIL = (
            136,
            1629,
        )  # First item in grid bounds [3,1496][269,1762]
        FIRST_MEDIA = (540, 1005)  # First media in gallery for story/post selection
        GALLERY_CROP_TOGGLE = (
            79,
            1275,
        )  # croptype_toggle_button bounds [32,1228][127,1323]
        GALLERY_FOLDER_MENU = (
            159,
            1423,
        )  # gallery_folder_menu_tv bounds [0,1393][318,1453]
        GALLERY_MULTI_SELECT = (
            862,
            1423,
        )  # multi_select_slide_button_alt bounds [676,1381][1048,1465]

        # Caption/Sharing Screen (VERIFIED Dec 2024)
        CAPTION_INPUT = (
            540,
            1053,
        )  # caption_input_text_view bounds [42,990][1038,1116]
        SHARE_BUTTON = (540, 2279)  # share_footer_button bounds [42,2221][1038,2337]
        SHARE_BACK_BUTTON = (73, 201)  # button_back bounds [0,128][147,275]

        # Sharing screen options (verified Dec 2024)
        ADD_AUDIO_ROW = (237, 1330)  # music_row_title bounds [137,1304][337,1357]
        TAG_PEOPLE_ROW = (545, 1576)  # tag_people_string bounds [137,1550][954,1603]
        ADD_LOCATION_ROW = (556, 1703)  # location_label bounds [137,1640][975,1766]
        AI_LABEL_TOGGLE = (969, 1971)  # toggle bounds [901,1929][1038,2013]
        AUDIENCE_ROW = (540, 2151)  # inline_subtitle "Everyone" area

        # ═══════════════════════════════════════════════════════════════════
        # BOTTOM NAVIGATION BAR (VERIFIED Dec 2024 XML Dumps)
        # Tab bar bounds: [0,2211][1080,2337] → Y center = 2274
        # ═══════════════════════════════════════════════════════════════════
        NAV_HOME_TAB = (108, 2274)  # feed_tab [0,2211][216,2337]
        NAV_REELS_TAB = (324, 2274)  # clips_tab [216,2211][432,2337]
        NAV_MESSAGES_TAB = (540, 2274)  # direct_tab [432,2211][648,2337]
        NAV_SEARCH_TAB = (756, 2274)  # search_tab [648,2211][864,2337]
        NAV_PROFILE_TAB = (972, 2274)  # profile_tab [864,2211][1080,2337]

        # Story viewing controls
        STORY_HEART = (
            901,
            2160,
        )  # ADB-VERIFIED Feb 2026: toolbar_like_button ~[849,2108][954,2213]
        # SAFE TAP ZONE: top corners, above link stickers/CTAs/shop tags.
        # Link stickers appear at Y 600-1800. Top area (Y 300-500) is safe.
        STORY_NEXT = (950, 450)      # Top-right — safe from link stickers
        STORY_PREVIOUS = (130, 450)  # Top-left — safe from link stickers

        # Story tray positions (on home feed)
        STORY_YOUR = (147, 415)  # Your story - skip for viewing
        STORY_FIRST = (441, 415)  # First other person's story
        STORY_SECOND = (735, 415)  # Second story
        STORY_THIRD = (981, 415)  # Third story (partial)

        # ═══════════════════════════════════════════════════════════════════
        # STORY VIEWING SCREEN COORDINATES (ADB-VERIFIED Feb 2026)
        # ⚠️ Like/reshare X shifts ~40px between stories — Y is stable
        # ═══════════════════════════════════════════════════════════════════
        # Header elements (top of story)
        STORY_PROFILE_PIC = (59, 333)  # reel_viewer_profile_picture [19,291][99,375]
        STORY_USERNAME = (311, 279)  # reel_viewer_title (varies)
        STORY_TIMESTAMP = (541, 279)  # reel_viewer_timestamp (varies)
        STORY_MENU_BUTTON = (976, 309)  # header_menu_button [914,245][1039,374]
        STORY_PROGRESS = (519, 255)  # reel_viewer_progress_bar [0,241][1039,270]

        # Footer elements (interactive buttons at bottom)
        # ADB-VERIFIED Feb 2026: Y=2160, X shifts ~40px between stories
        STORY_LIKE_BUTTON = (901, 2160)  # toolbar_like_button ~[849,2108][954,2213]
        STORY_RESHARE = (1006, 2160)  # toolbar_reshare_button ~[954,2108][1059,2213]
        STORY_COMPOSER = (398, 2147)  # message_composer_container [8,2076][789,2218]
        STORY_CTA = (540, 2093)  # story_item_cta_container [0,2077][1080,2109]

        # Media area (for tapping to navigate)
        STORY_MEDIA_CENTER = (540, 1148)  # reel_viewer_image_view center

        # ═══════════════════════════════════════════════════════════════════
        # STORY NAVIGATION (VERIFIED Dec 2024)
        # Based on reel_view_group bounds [0,188][1080,2337]
        # Media area bounds [0,188][1080,2108] (excludes footer)
        # ═══════════════════════════════════════════════════════════════════
        STORY_TAP_NEXT = (900, 1000)  # Right side tap → next story
        STORY_TAP_PREV = (180, 1000)  # Left side tap → prev story
        STORY_TAP_CENTER = (540, 1000)  # Center tap → pause/resume

        # Safe Y range for navigation (above footer, below header)
        # Y: 400 to 1900 is safe tapping zone
        STORY_SAFE_Y_MIN = 400
        STORY_SAFE_Y_MAX = 1900

    # ═══════════════════════════════════════════════════════════════════
    # ACCESSIBILITY IDS (content-desc values)
    # ═══════════════════════════════════════════════════════════════════
    class AccessibilityIDs:
        """Content-desc values for accessibility-based finding"""

        LIKE = "Like"
        COMMENT = "Comment"
        SHARE = "Share"
        SAVE = "Save"
        MORE = "More"
        AUDIO = "Audio"
        REPOST = "Repost"
        CREATE_REEL = "Create a reel"
        PROFILE_PICTURE_PREFIX = "Profile picture of "
        REEL_BY_PREFIX = "Reel by "


class ProtonVPNSelectors:
    """
    ProtonVPN Android App Selectors
    Uses Jetpack Compose UI - most elements use text instead of resource-IDs
    Verified via UI dump of ch.protonvpn.android
    """

    # Package info
    PACKAGE = "ch.protonvpn.android"
    ACTION_BAR_ROOT = "ch.protonvpn.android:id/action_bar_root"

    # Text-based selectors (ProtonVPN uses Compose UI)
    class Text:
        # Navigation
        HOME = "Home"
        COUNTRIES = "Countries"
        PROFILES = "Profiles"
        SETTINGS = "Settings"

        # Connection status
        PROTECTED = "Protected"
        UNPROTECTED = "Unprotected"
        CONNECTING = "Connecting"
        CONNECTED = "Connected"
        DISCONNECT = "Disconnect"
        CONNECT = "Connect"

        # Profile names
        STREAMING_US = "Streaming US"
        US_STREAMING = "US Streaming"
        UNITED_STATES = "United States"

        # Features
        NETSHIELD = "NetShield"
        KILL_SWITCH = "Kill Switch"
        RECENTS = "Recents"
        BROWSING_SAFELY = "Browsing safely from"

    # Coordinates (1080x2400 resolution)
    class Coords:
        # Bottom navigation bar
        NAV_HOME = (127, 2232)
        NAV_COUNTRIES = (403, 2232)
        NAV_PROFILES = (678, 2232)
        NAV_SETTINGS = (953, 2232)

        # Main actions
        DISCONNECT_BTN = (540, 1895)
        CONNECT_BTN = (540, 1895)  # Same position

        # Connection panel (when connected)
        CONNECTION_PANEL = (540, 1819)
        CONNECTION_DETAILS = (965, 1712)

        # NetShield panel
        NETSHIELD = (540, 429)

    # XPath patterns for text matching
    class XPath:
        PROFILES_TAB = "//android.widget.TextView[@text='Profiles']"
        CONNECT_BTN = "//android.widget.TextView[@text='Connect']"
        DISCONNECT_BTN = "//android.widget.TextView[@text='Disconnect']"
        PROTECTED = "//android.widget.TextView[@text='Protected']"
        STREAMING_US = "//android.widget.TextView[@text='Streaming US']"
        US_STREAMING = "//android.widget.TextView[contains(@text, 'US Streaming') or contains(@text, 'Streaming US')]"


class AndroidSettingsSelectors:
    """
    Android Settings App Selectors
    For system settings like Airplane Mode, Wi-Fi, etc.
    Verified via UI dump of com.android.settings
    """

    # Package info
    PACKAGE = "com.android.settings"

    # Common resource IDs
    TITLE = "android:id/title"
    SUMMARY = "android:id/summary"
    ICON = "android:id/icon"
    SWITCH_WIDGET = "com.android.settings:id/switchWidget"
    RECYCLER_VIEW = "com.android.settings:id/recycler_view"
    CONTENT_FRAME = "com.android.settings:id/content_frame"

    # Airplane mode specific
    class AirplaneMode:
        # Text-based selectors
        TITLE_TEXT = "Airplane mode"

        # XPath patterns
        TITLE = "//android.widget.TextView[@text='Airplane mode']"
        SWITCH = "//android.widget.Switch[@resource-id='com.android.settings:id/switchWidget']"
        ROW = "//android.widget.LinearLayout[.//android.widget.TextView[@text='Airplane mode']]"

        # Coordinates (1080x2400 resolution)
        # Airplane mode row bounds: [0,804][1080,959]
        ROW_CENTER = (540, 881)
        SWITCH_CENTER = (969, 881)

    # Intent actions
    class Intents:
        AIRPLANE_MODE = "android.settings.AIRPLANE_MODE_SETTINGS"
        WIFI = "android.settings.WIFI_SETTINGS"
        NETWORK = "android.settings.NETWORK_OPERATOR_SETTINGS"
        VPN = "android.settings.VPN_SETTINGS"
