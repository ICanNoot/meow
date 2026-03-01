# YouTube Feed Filter — Firefox Extension

## What this is
Manifest V3 Firefox extension that filters livestreams and videos under 50k views from YouTube.

## Key technical context
- Firefox uses `yt-` prefixed elements (yt-lockup-view-model, yt-content-metadata-view-model, etc.), NOT `ytd-` elements. The `ytd-` selectors are kept as Chrome fallbacks.
- View counts use lowercase suffixes: "14m views", "350k views" — not uppercase.
- Homepage video cards are `yt-lockup-view-model` elements.
- Sidebar filtering works. Autoplay interception does NOT work yet.
- The autoplay overlay uses `.ytp-autonav-endscreen-upnext-container` with `data-is-live="true/false"` attribute. `.ytp-autonav-endscreen-countdown` does NOT exist on Firefox.
- The `<video>` element's `ended` event should be used as the primary autoplay trigger.
- The autoplay container has: `.ytp-autonav-live-stamp`, `.ytp-autonav-view-and-date`, `.ytp-autonav-endscreen-upnext-title`, and `a.ytp-autonav-endscreen-link-container`.

## Files
- content.js — main filtering logic
- manifest.json — Manifest V3 with gecko settings
- styles.css — .ytf-hidden { display: none !important }
