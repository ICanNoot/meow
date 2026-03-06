# YouTube Feed Filter — Firefox Extension

## What this is
Manifest V3 Firefox extension that filters livestreams, low-view videos, Shorts, Mixes, Playables, members-only content, Explore Topics shelves, and topic chips from YouTube. Includes autoplay interception with countdown, end card replacement, and loop prevention.

## Key technical context — DOM structure

### Firefox DOM (primary target)
- Firefox uses `yt-` prefixed elements, NOT `ytd-` elements. There are ZERO `ytd-` elements on Firefox.
- Homepage video cards: `yt-lockup-view-model`
- Titles: inside `yt-lockup-metadata-view-model > h3` (no `#video-title` element)
- Metadata (views, date): inside `yt-content-metadata-view-model` spans
- View counts use **lowercase** suffixes: "14m views", "350k views" — not uppercase
- Badges (LIVE, SHORTS, etc.): inside `badge-shape > .yt-badge-shape__text`
- Thumbnails: `yt-thumbnail-view-model`
- Channel avatar: `yt-decorated-avatar-view-model`
- The `ytd-` selectors are kept as Chrome fallbacks but are not used on Firefox.

### Autoplay overlay (inside YouTube player, NOT yt-lockup elements)
- Container: `.ytp-autonav-endscreen-upnext-container`
- Has `data-is-live="true/false"` attribute — reliable livestream detection
- `.ytp-autonav-endscreen-countdown` does NOT exist on Firefox
- Key child elements:
  - `.ytp-autonav-endscreen-upnext-title` — next video title
  - `.ytp-autonav-endscreen-upnext-author` — channel name
  - `.ytp-autonav-view-and-date` — view count or "X watching" for live
  - `.ytp-autonav-author-and-view` — combined channel + views
  - `.ytp-autonav-live-stamp` — "Live" text badge (exists even for non-live, hidden via CSS)
  - `a.ytp-autonav-endscreen-link-container` — link to next video with href
  - `.ytp-autonav-endscreen-upnext-thumbnail` — background-image style for thumbnail
- Autoplay toggle: `.ytp-autonav-toggle-button` with `aria-checked="true/false"`
- The container has `clientHeight: 0` until the video ends and the overlay appears

### Watch page sidebar
- Container: `#secondary-inner` (found via `document.querySelector("#secondary-inner, #related")`)
- Sidebar recommendations use `yt-lockup-view-model` on Firefox (same as homepage)
- On Chrome they would be `ytd-compact-video-renderer`

## Architecture

### Settings system
- Defaults defined in both `popup.js` and `content.js` as `SETTINGS_DEFAULTS`
- Stored in `browser.storage.local`, loaded on init
- Popup sends `ytf-settings-update` messages to content script for live updates
- On settings change, all `data-ytf-filtered` attributes are cleared and page is rescanned
- All filters independently toggleable

### Settings keys
- `hideLivestreams` (bool, default true)
- `hideLowViews` (bool, default true)
- `viewThreshold` (number, default 50000)
- `hideShorts` (bool, default true)
- `hideMixes` (bool, default true)
- `hidePlayables` (bool, default true)
- `hideMembersOnly` (bool, default true)
- `hideExploreTopics` (bool, default true)
- `hideTopicChips` (bool, default true)
- `autoplayIntercept` (bool, default true)
- `countdownSeconds` (number, default 10, range 3-30)

### Filtering flow
1. `scanAndFilter()` queries `VIDEO_SELECTORS` for individual video elements
2. `processVideoElement()` checks each against `shouldHide()` which runs enabled filters in order: livestream → shorts → mixes → playables → members-only → low views
3. Elements get `data-ytf-filtered` set to: `"1"` (hidden), `"pass"` (OK), `"skip"` (nested yt-lockup inside ytd- container), or left unset (indeterminate, will be rechecked)
4. After individual elements, `scanAndFilterShelves()` hides entire shelf containers (Playables shelf, Shorts shelf, Explore Topics) by matching heading text
5. `filterShortsNav()` hides the Shorts sidebar link
6. `filterTopicChips()` hides the topic chip bar at top of homepage
7. MutationObserver with 250ms debounce triggers rescans on DOM changes
8. Periodic rescan every 2s catches lazily loaded metadata

### Autoplay interception flow
1. On watch pages, polls for `<video>` element inside `#movie_player` (up to 30s)
2. Attaches `ended` event listener as primary trigger
3. MutationObserver on `.ytp-autonav-endscreen-upnext-container` as backup trigger
4. When triggered, `checkAutoplayAndSkip()` checks the up-next video against all enabled filters
5. If skip needed: disables YouTube's native autoplay toggle, updates end card DOM, starts countdown overlay
6. Guard flags prevent infinite loops: `isUpdatingEndCard` (prevents MutationObserver re-entry during DOM writes), `autoplayHandled` (prevents redundant processing)
7. On countdown completion: clicks sidebar alternative link for SPA navigation, falls back to `window.location.href`
8. `restoreYouTubeAutoplay()` re-enables YouTube's autoplay after navigation
9. Recently-played video ID history (Set, max 20) prevents A→B→A loops. If all alternatives exhausted, history is cleared.

### SPA navigation handling
- Listens for `yt-navigate-finish` and `popstate` events
- On navigation: records current video ID, clears all filter marks, cleans up autoplay state, rescans after 500ms delay

## Known issues / incomplete items
- **Shorts sidebar button**: `filterShortsNav()` targets `ytd-guide-entry-renderer` and `ytd-mini-guide-entry-renderer` which may not exist on Firefox. Needs to find the `a[href="/shorts"]` element and walk up to the correct parent. May need CSS fallback approach.
- **Shorts in search results**: May not be caught on Firefox if the shelf elements differ from Chrome.
- **Topic chips bar**: The chips themselves are hidden but the background container may still be visible, leaving empty space at the top of the page. Need to target the outermost wrapper element.

## Files
- `content.js` — main filtering logic (1313 lines), autoplay interception, settings listener, shelf/nav/chip filtering
- `manifest.json` — Manifest V3 with gecko settings, storage permission, popup action
- `styles.css` — `.ytf-hidden` and `.ytf-countdown-overlay` styles
- `popup.html` — settings popup UI with toggle switches and number inputs
- `popup.css` — dark-themed popup styles matching YouTube aesthetic
- `popup.js` — settings load/save via `browser.storage.local`, sends messages to content scripts
