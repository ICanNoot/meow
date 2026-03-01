# YouTube Feed Filter — Firefox Extension

## What this is
Manifest V3 Firefox extension that filters livestreams and videos under 50k views from YouTube.

## Key technical context
- Firefox uses `yt-` prefixed elements (yt-lockup-view-model, yt-content-metadata-view-model, etc.), NOT `ytd-` elements. The `ytd-` selectors are kept as Chrome fallbacks.
- View counts use lowercase suffixes: "14m views", "350k views" — not uppercase.
- Homepage video cards are `yt-lockup-view-model` elements.
- Sidebar filtering works. Autoplay interception works using `<video>` ended event + MutationObserver backup.
- The autoplay overlay uses `.ytp-autonav-endscreen-upnext-container` with `data-is-live="true/false"` attribute. `.ytp-autonav-endscreen-countdown` does NOT exist on Firefox.
- The autoplay container has: `.ytp-autonav-live-stamp`, `.ytp-autonav-view-and-date`, `.ytp-autonav-endscreen-upnext-title`, and `a.ytp-autonav-endscreen-link-container`.
- Autoplay interception: polls for `<video>` element (up to 30s), attaches `ended` listener, checks up-next container for livestreams/low views, skips to first sidebar video with `data-ytf-filtered="pass"`. MutationObserver on the container serves as backup trigger. All state resets on SPA navigation.
- When autoplay skips, the end card is updated to show the replacement video's title, channel, thumbnail, views, and link. A 10-second countdown overlay ("Up next in Xs") appears inside #movie_player with a Cancel button. Clicking the player or Cancel stops the countdown.
- Recently-played video ID history (Set, max 20) prevents A→B→A loops. History persists across SPA navigations but resets on full page reload. If all sidebar alternatives are in history, history is cleared and retried.

## Files
- content.js — main filtering logic
- manifest.json — Manifest V3 with gecko settings
- styles.css — .ytf-hidden and .ytf-countdown-overlay styles
