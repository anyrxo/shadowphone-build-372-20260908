# Instagram Android UI Map (1080×2400)

> **Device**: Pixel 6, GrapheneOS, Profile 26
> **Screen**: 1080×2400, 420dpi
> **Last extracted**: 2026-02-09
> **Source**: ADB `uiautomator dump` — real device

---

## 1. Home Screen

### Top Action Bar (`action_bar_LinearLayout` `[0,128][1080,275]`)

| Element | resource-id | content-desc | bounds | center |
|---------|------------|-------------|--------|--------|
| **Create (+) button** | `action_bar_buttons_container_left` | — | `[0,128][127,275]` | **(63, 201)** |
| Instagram Logo | `title_logo` | `Instagram Home Feed` | `[398,161][682,242]` | (540, 201) |
| Notifications | `notification` | — | `[953,128][1080,275]` | (1016, 201) |

### Bottom Tab Bar (`tab_bar` `[0,2211][1080,2337]`)

> ⚠️ **CRITICAL**: `content-desc="Home"` matches **BOTH** the Home tab AND the Instagram logo at `(540, 201)`!
> `find_element_by_content_description("Home")` will return the **logo** (first match), NOT the tab.
> **Always use hardcoded coordinates `(108, 2274)` for the Home tab.** Do NOT use content-desc lookup.

| Tab | resource-id | content-desc | bounds | center | Safe to lookup? |
|-----|------------|-------------|--------|--------|----------------|
| Home | `feed_tab` | `Home` ⚠️ | `[0,2211][216,2337]` | **(108, 2274)** | ❌ Use coords only |
| Reels | `clips_tab` | `Reels` | `[216,2211][432,2337]` | **(324, 2274)** | ✅ |
| Message | `direct_tab` | `Message` | `[432,2211][648,2337]` | **(540, 2274)** | ✅ |
| Search | `search_tab` | `Search and explore` | `[648,2211][864,2337]` | **(756, 2274)** | ✅ |
| Profile | `profile_tab` | `Profile` | `[864,2211][1080,2337]` | **(972, 2274)** | ✅ |

### Stories Tray (`reels_tray_container` `[0,275][1080,620]`)

| Element | resource-id | content-desc | text |
|---------|------------|-------------|------|
| Your Story | `avatar_image_view` | `jocelynchenxo's story, 0 of 24, Unseen.` | — |
| Add to Story badge | `reel_empty_badge` | `Add to story` | — |

### Feed Post Elements

| Element | resource-id | content-desc |
|---------|------------|-------------|
| Profile pic | `row_feed_photo_profile_imageview` | `Profile picture of {user}` |
| Username | `row_feed_photo_profile_name` | `{user}` |
| Like button | `row_feed_button_like` | `Like` |
| Comment button | `row_feed_button_comment` | `Comment` |
| Share button | `row_feed_button_share` | `Send post` |
| Save button | `row_feed_button_save` | `Add to Saved` |
| More options | `media_option_button` | `More actions for this post` |
| Follow button | `inline_follow_button` | `Follow {name}` |

---

## 2. Creation Screen (Camera)

> **Entry**: Tap `+` button from Home screen. Opens to camera by default.

### Top Controls

| Element | resource-id | content-desc | bounds |
|---------|------------|-------------|--------|
| Back to Home | `camera_home_button` | `Back to Home` | `[0,139][137,276]` |
| Flash | `camera_flash_button` | `Flash off` | `[471,139][608,276]` |
| Story Settings | `camera_settings_gear` | `Story Settings` | `[943,139][1080,276]` |

### Bottom Controls

| Element | resource-id | content-desc | bounds | center |
|---------|------------|-------------|--------|--------|
| Gallery | `gallery_preview_button` | `Gallery` | `[0,2174][179,2337]` | **(89, 2255)** |
| Shutter | `camera_shutter_button` | `Shutter` | `[440,1930][640,2130]` | (540, 2030) |
| Switch Camera | `camera_switch_button` | `Switch to back camera` | `[901,2174][1080,2337]` | (990, 2255) |

### Destination Tabs (`multi_destination_scroll_view`)

> ⚠️ **Coords shift** when tab picker scrolls — always prefer resource-id or text lookup!

| Tab | resource-id | content-desc | text | bounds (default) | center |
|-----|------------|-------------|------|-------------------|--------|
| POST | `cam_dest_feed` | `POST` | `POST` | `[293,2213][448,2302]` | **(370, 2257)** |
| **STORY** | `cam_dest_story` | `STORY` | `STORY` | `[448,2213][632,2303]` | **(540, 2258)** |
| REEL | `cam_dest_clips` | `REEL` | `REEL` | `[632,2213][781,2302]` | **(706, 2257)** |
| LIVE | `cam_dest_live` | `LIVE` | `LIVE` | `[781,2213][912,2302]` | **(846, 2257)** |

---

## 3. Gallery Screen (Story Mode)

> **Entry**: Tap Gallery button from Creation screen (while STORY tab selected). Title shows "Add to story".

### Header

| Element | resource-id | content-desc | text | bounds |
|---------|------------|-------------|------|--------|
| Cancel/Back | `gallery_cancel_button` | `Back to Home` | — | `[0,139][137,276]` |
| Title | `gallery_title_text` | — | `Add to story` | `[401,177][678,237]` |
| Settings | `gallery_settings_gear` | `Camera settings` | — | `[943,139][1080,276]` |

### Destination Buttons (top row)

| Element | resource-id | text | bounds |
|---------|------------|------|--------|
| Templates | `button_name` | `Templates` | `[100,450][252,491]` |
| Music | `button_name` | `Music` | `[492,450][581,491]` |
| Collage | `button_name` | `Collage` | `[840,450][952,491]` |

### Gallery Grid

| Element | resource-id | content-desc |
|---------|------------|-------------|
| Grid container | `gallery_recycler_view` | — |
| Camera item | `gallery_grid_camera_item_icon` | `Camera` / cd=`Open camera` |
| First media item | `gallery_grid_item_thumbnail` | `Unselected Photo thumbnail created on {date}` |
| Multi-select | `gallery_menu_multi_select_button` | `Select multiple...` |
| Album switcher | `gallery_folder_menu_tv` | `Album switcher, Recents, button...` |

---

## 4. Story Editor (Post-Capture)

> **Entry**: Tap a media item from Gallery (story mode).

### Top Bar

| Element | resource-id | content-desc | bounds |
|---------|------------|-------------|--------|
| Cancel | `cancel_button` | `Cancel` | `[19,170][135,286]` |
| Toolbar | `edit_buttons_toolbar` | — | `[11,160][1069,297]` |

### Right Side Toolbar (`post_capture_compose_view` `[900,128][1080,2337]`)

6 clickable icons in vertical column, **no resource-id or content-desc**:

| Position | bounds | Opens |
|----------|--------|-------|
| Icon 1 (top) | `[927,155][1053,281]` | **Text Mode** |
| Icon 2 | `[927,292][1053,418]` | **Sticker Tray** |
| Icon 3 | `[927,429][1053,555]` | Draw(?) |
| Icon 4 | `[927,566][1053,692]` | ? |
| Icon 5 | `[927,703][1053,819]` | ? |
| Icon 6 (bottom) | `[927,819][1053,945]` | ? |

### Bottom Share Bar

| Element | resource-id | content-desc | text | bounds | center |
|---------|------------|-------------|------|--------|--------|
| Your Story | — | `Your story` | `Your story` | `[32,2198][468,2313]` | **(250, 2255)** |
| Close Friends | — | `Close Friends` | `Close Friends` | `[483,2198][918,2313]` | (700, 2255) |
| Share to | — | `Share to` | — | `[933,2198][1048,2313]` | (990, 2255) |

### Caption

| Element | resource-id | text | bounds |
|---------|------------|------|--------|
| Add caption | `add_caption_textview` | `Add a caption…` | `[0,1923][318,2048]` |

---

## 5. Text Mode (Story)

> **Entry**: Tap Icon 1 (top) in story editor right toolbar.

| Element | resource-id | content-desc | text |
|---------|------------|-------------|------|
| Done button | `done_button` | `Done` | — |
| Text input | `text_overlay_edit_text` | — | (editable) |
| Modern style | — | `Modern text style` | — |
| Classic style | — | `Classic text style` | — |
| Signature style | — | `Signature text style` | — |
| Mention picker | `text_mention_picker` | `Mention` | — |
| Location picker | `text_location_picker` | `Location` | — |
| Font selector | `text_format_short_button` | `Click to view text fonts` | — |
| Text color | `text_color_button` | `Text color` | — |
| Text animation | `postcapture_text_animation_button` | `Text animation` | — |
| Text alignment | `postcapture_text_alignment_button` | `Text alignment center` | — |

---

## 6. Sticker Tray

> **Entry**: Tap Icon 2 in story editor right toolbar. Opens as `asset_picker` bottom sheet.

### Search Bar

| Element | resource-id | text | bounds |
|---------|------------|------|--------|
| Search | `row_search_edit_text` | `Search` | `[42,691][1038,783]` |

### Full Sticker Inventory

All use `rid=sticker_sheet_redesign_item`. Lookup via **content-desc**:

| Sticker | content-desc | bounds | center |
|---------|-------------|--------|--------|
| Location | `Location sticker` | `[112,823][417,964]` | (264, 893) |
| **Mention** | `Mention Sticker` | `[424,824][705,963]` | **(564, 893)** |
| Music | `Music Overlay Sticker` | `[713,824][956,963]` | (834, 893) |
| Photo | `Photo sticker` | `[149,967][397,1102]` | (273, 1034) |
| WhatsApp | `WhatsApp Sticker` | `[405,964][733,1106]` | (569, 1035) |
| GIF | `Gif sticker search` | `[739,964][923,1105]` | (831, 1034) |
| Add Yours | `Add Yours sticker` | `[53,1106][391,1247]` | (222, 1176) |
| Frames | `Frames Sticker` | `[398,1107][674,1246]` | (536, 1176) |
| Question | `Question Sticker` | `[681,1106][1017,1247]` | (849, 1176) |
| Cutout | `Cutout Sticker` | `[110,1247][412,1388]` | (261, 1317) |
| Notify | `Notify sticker` | `[418,1247][675,1388]` | (546, 1317) |
| Avatar | `Avatar Sticker` | `[682,1248][959,1387]` | (820, 1317) |
| Stories Template | `Stories Template Sticker` | `[76,1388][634,1529]` | (355, 1458) |
| Reaction | `Reaction Sticker` | `[643,1391][767,1526]` | (705, 1458) |
| Multi-option Poll | `Multi-option Poll Sticker` | `[775,1388][995,1529]` | (885, 1458) |
| Get Orders | `Get orders sticker` | `[67,1529][421,1670]` | (244, 1599) |
| Slider | `Slider sticker` | `[427,1529][703,1670]` | (565, 1599) |
| Hashtag | `Hashtag sticker` | `[710,1529][1001,1670]` | (855, 1599) |
| **Link** | `Link Sticker` | `[120,1670][326,1810]` | **(223, 1740)** |
| Donation | `Donation sticker` | `[332,1670][642,1811]` | (487, 1740) |
| Product | `Product Sticker` | `[648,1670][950,1811]` | (799, 1740) |
| Countdown | `Countdown sticker` | `[56,1811][420,1952]` | (238, 1881) |
| Text | `Text Sticker` | `[428,1812][625,1950]` | (526, 1881) |
| Food Orders | `Food orders sticker` | `[634,1814][1013,1949]` | (823, 1881) |
| Time | `Time sticker` | `[32,2007][241,2216]` | (136, 2111) |

> ⚠️ **Link Sticker may require scrolling** in the sticker tray to reach — it's in row 7, below the fold.
> Use `find_element_by_content_desc('Link Sticker')` to locate it reliably regardless of scroll position.

## 7. Story Viewer (Watching Other People's Stories)

> **Entry**: Tap a story circle from Home feed stories tray.
> **ADB-VERIFIED**: 2026-02-10 (two separate stories: hiyrose, babebellalynnxx)
> ⚠️ **X coords shift ~40px between stories** depending on story content/stickers. **Y coords are stable.**

### Header (`reel_viewer_header` `[0,245][1039,429]`)

| Element | resource-id | content-desc | bounds | center |
|---------|------------|-------------|--------|--------|
| Profile pic | `reel_viewer_profile_picture` | — | `[19,291][99,375]` | (59, 333) |
| Story info | `reel_viewer_text_container` | `{user}'s story, {time} ago` | `[99,269][914,427]` | (506, 348) |
| Username | `reel_viewer_title` | — | varies | varies |
| Timestamp | `reel_viewer_timestamp` | — | varies | varies |
| More actions | `header_menu_button` | `More actions` | `[914,245][1039,374]` | **(976, 309)** |
| Progress bar | `reel_viewer_progress_bar` | — | `[0,241][1039,270]` | (519, 255) |

### Bottom Toolbar (`viewer_reel_item_toolbar_container`)

| Element | resource-id | content-desc | bounds (sample 1) | bounds (sample 2) | Stable center |
|---------|------------|-------------|-------------------|-------------------|---------------|
| Message composer | `message_composer_container` | `Send message or reaction` | `[8,2076][789,2218]` | `[8,2076][789,2218]` | **(398, 2147)** ✅ |
| **Like Story** | `toolbar_like_button` | `Like Story` | `[810,2103][914,2210]` | `[849,2108][954,2213]` | **~(862–901, 2160)** ⚠️ |
| Send story | `toolbar_reshare_button` | `Send story` | `[914,2105][1018,2213]` | `[954,2108][1059,2213]` | **~(966–1006, 2160)** ⚠️ |

> ⚠️ **Like button X shifts ~40px** between stories. Use `resource-id="toolbar_like_button"` or `content-desc="Like Story"` for reliable lookup — **coordinates are NOT stable** for this element.
> ✅ **Message composer** position IS stable across stories.

### CTA / Story Actions

| Element | resource-id | content-desc | bounds |
|---------|------------|-------------|--------|
| CTA sticker | `cta_sticker` | — | varies (only on sponsored) |
| Sponsored label | `reel_item_sponsored_label_footer_pill` | — | varies |

---

## 8. Mention Sticker Input

> **Entry**: Tap "Mention Sticker" in sticker tray.

| Element | resource-id | content-desc | bounds |
|---------|------------|-------------|--------|
| Search field | `mentions_search_bar` | — | `[42,674][1038,742]` |
| Suggestion list | `mentions_list` | — | (below search) |

---

## 9. Feed Engagement Buttons

> **Entry**: Scroll in Home Feed to a visible post with buttons (below media).
> ⚠️ **Y coords change** based on scroll position. **X coords vary** between ad posts and regular posts (ads insert extra buttons). Always use **resource-ID first**.

### Button Row (`row_feed_view_group_buttons`)

| Button | resource-id | content-desc | X range (fixed) | Notes |
|--------|------------|-------------|-----------------|-------|
| Like | `row_feed_button_like` | `Like` / `Liked` | `[32,_][95,_]` X=63 | ✅ X fixed |
| Comment | `row_feed_button_comment` | `Comment` | X varies (138–258) | ⚠️ Shifts on ads |
| Share | `row_feed_button_share` | `Send post` | X varies (244–386) | ⚠️ Shifts on ads |
| Save | `row_feed_button_save` | `Add to Saved` | `[958,_][1075,_]` X=1017 | ✅ X fixed |

### Ad Detection

| Marker | Attribute | Value |
|--------|-----------|-------|
| Sponsored | `text` or `content-desc` | `Sponsored` |
| Ad | `text` | `Ad` |

### Like State Detection

- `content-desc="Like"` → **not liked** (tappable)
- `content-desc="Liked"` → **already liked** (skip)

---

## 10. Comment Sheet

> **Entry**: Tap comment button on a feed post or reel. Opens as bottom sheet.
> ⚠️ **All Y coords are dynamic** — the sheet position changes. Use **resource-ID only**.

### Without Keyboard (sheet just opened)

| Element | resource-id | bounds (example) | center |
|---------|------------|-------------------|--------|
| Sheet container | `bottom_sheet_container` | `[0,128][1080,2337]` | (540, 1232) |
| Drag handle | `bottom_sheet_drag_handle_frame` | `[0,128][1080,165]` | (540, 146) |
| Title ("Comments") | `title_text_view` | `[262,165][818,269]` | (540, 217) |
| Comment list | `sticky_header_list` | `[0,128][1080,2211]` | (540, 1169) |
| **Comment input** | `layout_comment_thread_edittext` | `[127,1375][975,1496]` | **(551, 1435)** |
| Composer parent | `comment_composer_parent_updated` | `[0,1375][1080,1499]` | (540, 1437) |
| Sticker picker | `comment_composer_animated_image_picker_button` | `[975,1381][1080,1496]` | (1027, 1438) |

### With Keyboard + Text Entered

| Element | resource-id | bounds (example) | center |
|---------|------------|-------------------|--------|
| Input (narrower) | `layout_comment_thread_edittext` | `[127,1375][917,1496]` | (522, 1435) |
| **Post button** | `layout_comment_thread_post_button_icon` | `[917,1404][1038,1478]` | **(977, 1441)** |

> ⚠️ Post button only appears AFTER text is entered in the input field.

---

## 11. Reels Engagement UFI

> **Entry**: Navigate to Reels tab. UFI (User Feedback Icons) on right side.
> ✅ **All coords are EXACT MATCHES** with `ig_selectors.Coords.REELS_*`

| Button | resource-id | content-desc | bounds | center |
|--------|------------|-------------|--------|--------|
| Like | `like_button` | `Like` / `Liked` | `[943,1063][1059,1179]` | **(1001, 1121)** ✅ |
| Like count | `like_count` | — | `[943,1179][1059,1241]` | (1001, 1210) |
| Comment | `comment_button` | `Comment` | `[943,1241][1059,1357]` | **(1001, 1299)** ✅ |
| Comment count | `comment_count` | — | `[943,1357][1059,1419]` | (1001, 1388) |
| Repost count | `repost_count` | — | `[943,1535][1059,1597]` | (1001, 1566) |
| Share | `direct_share_button` | — | `[943,1597][1059,1713]` | **(1001, 1655)** ✅ |
| Save | `save_button` | — | `[943,1775][1059,1891]` | **(1001, 1833)** ✅ |
| Save count | `save_count` | — | `[943,1891][1059,1953]` | (1001, 1922) |
| More | `clips_ufi_more_button_component` | — | `[943,1953][1059,2069]` | **(1001, 2011)** ✅ |
| Audio | `media_album_art_button` | — | `[962,2090][1041,2169]` | (1001, 2129) |

### Author Info (Bottom Left)

| Element | resource-id | bounds | center |
|---------|------------|--------|--------|
| Username | `clips_author_username` | `[137,1963][713,2054]` | (425, 2008) |
| Follow button | `inline_follow_button` | `[729,1994][906,2070]` | (817, 2032) |
| Caption | `clips_caption_component` | `[42,2100][943,2174]` | (492, 2137) |

---

## Lookup Strategy (Priority Order)

1. **resource-id** → Most stable across versions
2. **content-desc** → Next best — descriptive and unique
3. **text** → Visible label — can change with locale
4. **coordinates** → Last resort — shifts with layout changes

> ⚠️ **Home tab**: `content-desc="Home"` matches the Instagram logo too — **always use coords `(108, 2274)`**.
> ⚠️ Tab picker coords (`cam_dest_*`) shift when the picker scrolls. Always use resource-id or text first.
> ⚠️ Feed engagement button X positions shift for ad posts vs regular posts.
> ⚠️ Comment sheet Y positions are fully dynamic — NEVER use hardcoded Y coords for comment elements.

