// YouTube Feed Filter — Content Script
// Filters livestreams, low-view videos, Shorts, Mixes, Playables,
// and members-only content from YouTube.

(function () {
  "use strict";

  const LOG_PREFIX = "[YT-Filter]";
  const DEBOUNCE_MS = 250;
  const RESCAN_INTERVAL_MS = 2000;
  const FILTERED_ATTR = "data-ytf-filtered";

  // ---------------------------------------------------------------------------
  // Settings — loaded from browser.storage.local, updated via popup messages
  // ---------------------------------------------------------------------------

  const SETTINGS_DEFAULTS = {
    hideLivestreams: true,
    hideLowViews: true,
    viewThreshold: 50000,
    hideShorts: true,
    hideMixes: true,
    hidePlayables: true,
    hideMembersOnly: true,
    hideExploreTopics: true,
    hideTopicChips: true,
    autoplayIntercept: true,
    countdownSeconds: 10,
  };

  // Live copy of settings — mutated in place when updates arrive
  const settings = Object.assign({}, SETTINGS_DEFAULTS);

  function loadSettings() {
    return browser.storage.local.get(SETTINGS_DEFAULTS).then((stored) => {
      Object.assign(settings, stored);
      log("Settings loaded:", JSON.stringify(settings));
    });
  }

  /**
   * Clear all filter marks and rescan the page.
   */
  function resetAndRescan() {
    document.querySelectorAll(`[${FILTERED_ATTR}]`).forEach((el) => {
      el.removeAttribute(FILTERED_ATTR);
      el.classList.remove("ytf-hidden");
    });
    scanAndFilter();
  }

  // Listen for live updates from the popup
  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "ytf-settings-update" && msg.settings) {
      const prev = Object.assign({}, settings);
      Object.assign(settings, msg.settings);
      log("Settings updated:", JSON.stringify(msg.settings));

      // If autoplay interception was toggled
      if ("autoplayIntercept" in msg.settings) {
        if (settings.autoplayIntercept) {
          startVideoPolling();
        } else {
          cleanupAutoplay();
        }
      }

      // If countdown seconds changed while a countdown is active, let it
      // finish with the old value — next skip will use the new value.

      // Rescan to apply changed filters
      resetAndRescan();
    }
  });

  // ---------------------------------------------------------------------------
  // Utility helpers
  // ---------------------------------------------------------------------------

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  /**
   * Parse YouTube's abbreviated view counts into a number.
   */
  function parseViewCount(text) {
    if (!text) return NaN;

    const cleaned = text.replace(/,/g, "").trim();

    if (/no views/i.test(cleaned)) return 0;

    const match = cleaned.match(/([\d]+(?:\.[\d]+)?)\s*([KkMmBbTt]?)/);
    if (!match) return NaN;

    const num = parseFloat(match[1]);
    const suffix = match[2].toUpperCase();

    const multipliers = { "": 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
    const multiplier = multipliers[suffix];
    if (multiplier === undefined) return NaN;

    return num * multiplier;
  }

  /**
   * Extract a view-count string from a larger text blob.
   */
  function extractViewString(text) {
    if (!text) return null;
    const m = text.match(/(?:no views|[\d,]+(?:\.[\d]+)?\s*[KkMmBbTt]?\s*views?)/i);
    return m ? m[0] : null;
  }

  // ---------------------------------------------------------------------------
  // Detection helpers
  // ---------------------------------------------------------------------------

  /**
   * Check whether a video element is a livestream.
   */
  function isLiveStream(el) {
    const overlays = el.querySelectorAll(
      "ytd-thumbnail-overlay-time-status-renderer"
    );
    for (const overlay of overlays) {
      const style = overlay.getAttribute("overlay-style");
      if (style === "LIVE") return true;
      const txt = (overlay.textContent || "").trim().toUpperCase();
      if (txt === "LIVE" || txt === "LIVE NOW") return true;
    }

    const badges = el.querySelectorAll(
      "ytd-badge-supported-renderer, .badge-style-type-live-now, .badge-style-type-live-now-alternate"
    );
    for (const badge of badges) {
      const txt = (badge.textContent || "").trim().toUpperCase();
      if (txt === "LIVE" || txt === "LIVE NOW") return true;
    }

    const badgeTexts = el.querySelectorAll(
      [
        "yt-badge-view-model .yt-badge-shape__text",
        "yt-thumbnail-badge-view-model .yt-badge-shape__text",
        "badge-shape .yt-badge-shape__text",
      ].join(", ")
    );
    for (const bt of badgeTexts) {
      const txt = (bt.textContent || "").trim().toUpperCase();
      if (txt === "LIVE" || txt === "LIVE NOW") return true;
    }

    const liveLabeled = el.querySelectorAll('[aria-label*="live" i], [aria-label*="Live" i], [aria-label*="LIVE"]');
    if (liveLabeled.length > 0) return true;

    const fullText = el.textContent || "";
    if (/\bwatching\b/i.test(fullText)) return true;

    const titleEl = el.querySelector("#video-title");
    if (titleEl) {
      const ariaLabel = titleEl.getAttribute("aria-label") || "";
      if (/\bwatching\b/i.test(ariaLabel)) return true;
    }

    return false;
  }

  /**
   * Extract the view count from a video element.
   */
  function getViewCount(el) {
    const metaViewModel = el.querySelector("yt-content-metadata-view-model");
    if (metaViewModel) {
      const vs = extractViewString(metaViewModel.textContent);
      if (vs) return parseViewCount(vs);
    }

    const titleEl = el.querySelector("#video-title");
    if (titleEl) {
      const label = titleEl.getAttribute("aria-label") || "";
      const vs = extractViewString(label);
      if (vs) return parseViewCount(vs);
    }

    const titleLink = el.querySelector("a#video-title-link");
    if (titleLink) {
      const label = titleLink.getAttribute("aria-label") || "";
      const vs = extractViewString(label);
      if (vs) return parseViewCount(vs);
    }

    const metaBlock = el.querySelector("ytd-video-meta-block");
    if (metaBlock) {
      const vs = extractViewString(metaBlock.textContent);
      if (vs) return parseViewCount(vs);
    }

    const metaLine = el.querySelector("#metadata-line");
    if (metaLine) {
      const vs = extractViewString(metaLine.textContent);
      if (vs) return parseViewCount(vs);
    }

    const metadata = el.querySelector("#metadata");
    if (metadata) {
      const vs = extractViewString(metadata.textContent);
      if (vs) return parseViewCount(vs);
    }

    const allSpans = el.querySelectorAll("span");
    for (const span of allSpans) {
      const txt = (span.textContent || "").trim();
      if (/views?$/i.test(txt)) {
        const count = parseViewCount(txt);
        if (!isNaN(count)) return count;
      }
    }

    const fullText = el.textContent || "";
    const vs = extractViewString(fullText);
    if (vs) return parseViewCount(vs);

    return NaN;
  }

  /**
   * Check whether a video element is a YouTube Short.
   */
  function isShort(el) {
    // 1. ytd-reel-item-renderer is always a Short
    if (el.tagName === "YTD-REEL-ITEM-RENDERER") return true;

    // 2. Link containing /shorts/
    const anchors = el.querySelectorAll("a[href]");
    for (const a of anchors) {
      if (a.href && a.href.includes("/shorts/")) return true;
    }

    // 3. Thumbnail overlay with "SHORTS" badge
    const overlays = el.querySelectorAll(
      "ytd-thumbnail-overlay-time-status-renderer"
    );
    for (const overlay of overlays) {
      const style = overlay.getAttribute("overlay-style");
      if (style === "SHORTS") return true;
      const txt = (overlay.textContent || "").trim().toUpperCase();
      if (txt === "SHORTS") return true;
    }

    // 4. Badge text "SHORTS" (Firefox / new layout)
    const badgeTexts = el.querySelectorAll(
      [
        "yt-badge-view-model .yt-badge-shape__text",
        "yt-thumbnail-badge-view-model .yt-badge-shape__text",
        "badge-shape .yt-badge-shape__text",
      ].join(", ")
    );
    for (const bt of badgeTexts) {
      const txt = (bt.textContent || "").trim().toUpperCase();
      if (txt === "SHORTS") return true;
    }

    return false;
  }

  /**
   * Check whether a video element is a YouTube Mix.
   */
  function isMix(el) {
    // 1. ytd-radio-renderer is always a Mix
    if (el.tagName === "YTD-RADIO-RENDERER") return true;

    // 2. Link with &start_radio=1 or &list=RD
    const anchors = el.querySelectorAll("a[href]");
    for (const a of anchors) {
      if (!a.href) continue;
      if (a.href.includes("start_radio=1")) return true;
      if (/[?&]list=RD/.test(a.href)) return true;
    }

    // 3. Title starting with "Mix -" or "Mix –"
    const title = getVideoTitle(el);
    if (/^Mix\s*[-–]/.test(title)) return true;

    // 4. Thumbnail overlay with "MIX" badge
    const overlays = el.querySelectorAll(
      "ytd-thumbnail-overlay-time-status-renderer"
    );
    for (const overlay of overlays) {
      const txt = (overlay.textContent || "").trim().toUpperCase();
      if (txt === "MIX") return true;
    }

    // 5. Badge text "Mix" (Firefox / new layout)
    const badgeTexts = el.querySelectorAll(
      [
        "yt-badge-view-model .yt-badge-shape__text",
        "yt-thumbnail-badge-view-model .yt-badge-shape__text",
        "badge-shape .yt-badge-shape__text",
      ].join(", ")
    );
    for (const bt of badgeTexts) {
      const txt = (bt.textContent || "").trim().toUpperCase();
      if (txt === "MIX") return true;
    }

    return false;
  }

  /**
   * Check whether a video element is a YouTube Playable.
   */
  function isPlayable(el) {
    // 1. Link containing /playables/
    const anchors = el.querySelectorAll("a[href]");
    for (const a of anchors) {
      if (a.href && a.href.includes("/playables/")) return true;
    }

    // 2. Badge text "Playable" or "Play game"
    const badgeTexts = el.querySelectorAll(
      [
        "ytd-badge-supported-renderer",
        "yt-badge-view-model .yt-badge-shape__text",
        "yt-thumbnail-badge-view-model .yt-badge-shape__text",
        "badge-shape .yt-badge-shape__text",
      ].join(", ")
    );
    for (const bt of badgeTexts) {
      const txt = (bt.textContent || "").trim().toUpperCase();
      if (txt === "PLAYABLE" || txt === "PLAY GAME") return true;
    }

    // 3. Thumbnail overlay with "PLAYABLE"
    const overlays = el.querySelectorAll(
      "ytd-thumbnail-overlay-time-status-renderer"
    );
    for (const overlay of overlays) {
      const txt = (overlay.textContent || "").trim().toUpperCase();
      if (txt === "PLAYABLE" || txt === "PLAY GAME") return true;
    }

    return false;
  }

  /**
   * Check whether a video element is members-only content.
   */
  function isMembersOnly(el) {
    // 1. Badge text "Members only"
    const badgeTexts = el.querySelectorAll(
      [
        "ytd-badge-supported-renderer",
        "yt-badge-view-model .yt-badge-shape__text",
        "yt-thumbnail-badge-view-model .yt-badge-shape__text",
        "badge-shape .yt-badge-shape__text",
      ].join(", ")
    );
    for (const bt of badgeTexts) {
      const txt = (bt.textContent || "").trim().toUpperCase();
      if (txt === "MEMBERS ONLY") return true;
    }

    // 2. Aria-labels or metadata containing "Members only"
    const titleEl = el.querySelector("#video-title");
    if (titleEl) {
      const ariaLabel = titleEl.getAttribute("aria-label") || "";
      if (/members only/i.test(ariaLabel)) return true;
    }

    // 3. Membership overlay on thumbnail
    const overlays = el.querySelectorAll(
      "ytd-thumbnail-overlay-time-status-renderer"
    );
    for (const overlay of overlays) {
      const txt = (overlay.textContent || "").trim().toUpperCase();
      if (txt === "MEMBERS ONLY") return true;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Filtering logic
  // ---------------------------------------------------------------------------

  /**
   * Decide whether a video element should be hidden.
   * Returns { hide: boolean, reason: string, indeterminate: boolean }
   */
  function shouldHide(el) {
    if (settings.hideLivestreams && isLiveStream(el)) {
      return { hide: true, reason: "livestream", indeterminate: false };
    }

    if (settings.hideShorts && isShort(el)) {
      return { hide: true, reason: "short", indeterminate: false };
    }

    if (settings.hideMixes && isMix(el)) {
      return { hide: true, reason: "mix", indeterminate: false };
    }

    if (settings.hidePlayables && isPlayable(el)) {
      return { hide: true, reason: "playable", indeterminate: false };
    }

    if (settings.hideMembersOnly && isMembersOnly(el)) {
      return { hide: true, reason: "members-only", indeterminate: false };
    }

    if (settings.hideLowViews) {
      const views = getViewCount(el);

      if (isNaN(views)) {
        return { hide: false, reason: "", indeterminate: true };
      }

      if (views < settings.viewThreshold) {
        return {
          hide: true,
          reason: `low views (${views.toLocaleString()} < ${settings.viewThreshold.toLocaleString()})`,
          indeterminate: false,
        };
      }
    }

    return { hide: false, reason: "", indeterminate: false };
  }

  /**
   * Get a human-readable title for a video element (for logging).
   */
  function getVideoTitle(el) {
    const titleEl = el.querySelector(
      "#video-title, h3 a, yt-formatted-string#video-title, yt-lockup-metadata-view-model h3"
    );
    return titleEl
      ? (titleEl.textContent || "").trim().slice(0, 80)
      : "(unknown)";
  }

  // Selectors for all video element types we want to filter.
  const VIDEO_SELECTORS = [
    "ytd-rich-item-renderer",     // Homepage grid items (Chrome)
    "ytd-video-renderer",         // Search results (Chrome)
    "ytd-compact-video-renderer", // Sidebar recommendations (Chrome)
    "ytd-grid-video-renderer",    // Grid views / channel pages (Chrome)
    "ytd-reel-item-renderer",     // Shorts on homepage (Chrome)
    "ytd-radio-renderer",         // Mixes (Chrome)
    "yt-lockup-view-model",       // Video cards (Firefox / new layout)
  ].join(", ");

  // ytd- selectors used to detect whether a yt-lockup-view-model is nested
  // inside a Chrome-style container (so we skip it and let the parent handle it).
  const YTD_CONTAINER_SELECTORS =
    "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-reel-item-renderer, ytd-radio-renderer";

  /**
   * Process a single video element: check and hide if necessary.
   */
  function processVideoElement(el) {
    if (el.hasAttribute(FILTERED_ATTR)) return true;

    if (
      el.tagName === "YT-LOCKUP-VIEW-MODEL" &&
      el.closest(YTD_CONTAINER_SELECTORS)
    ) {
      el.setAttribute(FILTERED_ATTR, "skip");
      return true;
    }

    const { hide, reason, indeterminate } = shouldHide(el);

    if (hide) {
      el.setAttribute(FILTERED_ATTR, "1");
      el.classList.add("ytf-hidden");
      log("Hiding:", getVideoTitle(el), "—", reason);
      return true;
    }

    if (indeterminate) {
      return false;
    }

    el.setAttribute(FILTERED_ATTR, "pass");
    return true;
  }

  /**
   * Scan the DOM for video elements and filter them.
   */
  function scanAndFilter() {
    const elements = document.querySelectorAll(VIDEO_SELECTORS);
    let newCount = 0;
    let resolvedCount = 0;

    for (const el of elements) {
      const status = el.getAttribute(FILTERED_ATTR);
      if (status === "1" || status === "pass" || status === "skip") continue;

      newCount++;
      if (processVideoElement(el)) {
        resolvedCount++;
      }
    }

    if (newCount > 0) {
      log(
        `Scanned ${newCount} unresolved elements, resolved ${resolvedCount}`
      );
    }

    scanAndFilterShelves();
    filterShortsNav();
    filterTopicChips();
  }

  // Selectors for shelf / section containers on the homepage.
  // These wrap a heading + multiple items + "Show more" button.
  const SHELF_SELECTORS = [
    "ytd-rich-shelf-renderer",     // Shelf sections (Chrome)
    "ytd-reel-shelf-renderer",     // Shorts shelf (Chrome)
    "ytd-rich-section-renderer",   // Section wrappers (Chrome)
    "ytd-shelf-renderer",          // Legacy shelf (Chrome)
  ].join(", ");

  // Maps a heading pattern to { settingKey, reason }
  const SHELF_FILTERS = [
    { pattern: /\bplayable/i,         settingKey: "hidePlayables",    reason: "playables shelf" },
    { pattern: /\bshorts\b/i,         settingKey: "hideShorts",       reason: "shorts shelf" },
    { pattern: /\bexplore\b.*topic/i, settingKey: "hideExploreTopics", reason: "explore topics shelf" },
  ];

  /**
   * Scan for shelf/section containers and hide entire shelves whose
   * heading matches a filtered category (e.g. "YouTube Playables").
   */
  function scanAndFilterShelves() {
    const shelves = document.querySelectorAll(SHELF_SELECTORS);

    for (const shelf of shelves) {
      if (shelf.hasAttribute(FILTERED_ATTR)) continue;

      // Find the heading text inside the shelf
      const heading = shelf.querySelector(
        "#title, #title-text, h2, " +
        "yt-dynamic-text-view-model, " +
        "span.style-scope.ytd-rich-shelf-renderer"
      );
      if (!heading) continue;

      const headingText = heading.textContent.trim();
      if (!headingText) continue;

      for (const filter of SHELF_FILTERS) {
        if (!settings[filter.settingKey]) continue;
        if (filter.pattern.test(headingText)) {
          shelf.setAttribute(FILTERED_ATTR, "1");
          shelf.classList.add("ytf-hidden");
          log("Hiding shelf:", headingText, "—", filter.reason);
          break;
        }
      }

      // Mark as checked even if not hidden, to avoid re-processing
      if (!shelf.hasAttribute(FILTERED_ATTR)) {
        shelf.setAttribute(FILTERED_ATTR, "pass");
      }
    }
  }

  /**
   * Hide the Shorts sidebar entry in the guide panel and mini-guide.
   * Also hides Shorts shelves in search results (ytd-reel-shelf-renderer).
   */
  function filterShortsNav() {
    if (!settings.hideShorts) return;

    // Full guide entries (left sidebar)
    const guideEntries = document.querySelectorAll(
      "ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer"
    );
    for (const entry of guideEntries) {
      if (entry.hasAttribute(FILTERED_ATTR)) continue;
      const link = entry.querySelector('a[href]');
      if (link && /\/shorts\b/.test(link.getAttribute("href"))) {
        entry.setAttribute(FILTERED_ATTR, "1");
        entry.classList.add("ytf-hidden");
        log("Hiding sidebar entry: Shorts");
      }
    }
  }

  /**
   * Hide the topic chips bar at the top of the homepage feed.
   */
  function filterTopicChips() {
    if (!settings.hideTopicChips) return;

    const chipBars = document.querySelectorAll(
      "ytd-feed-filter-chip-bar-renderer, yt-chip-cloud-renderer, " +
      "yt-chip-cloud-view-model, iron-selector#chips"
    );
    for (const bar of chipBars) {
      if (bar.hasAttribute(FILTERED_ATTR)) continue;
      bar.setAttribute(FILTERED_ATTR, "1");
      bar.classList.add("ytf-hidden");
      log("Hiding topic chips bar");
    }
  }

  // ---------------------------------------------------------------------------
  // Autoplay intervention
  // ---------------------------------------------------------------------------

  const HISTORY_MAX = 20;
  const recentVideoIds = new Set(); // persists across SPA navs, resets on full reload

  let videoEndedBound = null;   // current bound listener ref
  let videoElement = null;      // current <video> element
  let videoPollingTimer = null; // polling interval for finding <video>
  let autoplayContainerObserver = null; // MutationObserver on up-next container
  let countdownTimer = null;    // countdown setInterval id
  let countdownOverlay = null;  // countdown DOM element
  let playerClickHandler = null; // player click handler ref for cleanup
  let isUpdatingEndCard = false; // guard: prevents observer re-entry during DOM writes
  let autoplayHandled = false;   // guard: prevents redundant processing after skip initiated
  let ytAutoplayWasOn = false;   // tracks if we toggled YouTube's native autoplay off

  /**
   * Disable YouTube's native autoplay toggle so it doesn't navigate
   * before our countdown finishes.
   */
  function cancelYouTubeAutoplay() {
    const toggle = document.querySelector(".ytp-autonav-toggle-button");
    if (!toggle) {
      log("Autoplay: YouTube autoplay toggle not found");
      return false;
    }
    if (toggle.getAttribute("aria-checked") === "true") {
      toggle.click();
      ytAutoplayWasOn = true;
      log("Autoplay: disabled YouTube native autoplay");
      return true;
    }
    return false;
  }

  /**
   * Re-enable YouTube's native autoplay toggle if we previously disabled it.
   */
  function restoreYouTubeAutoplay() {
    if (!ytAutoplayWasOn) return;
    const toggle = document.querySelector(".ytp-autonav-toggle-button");
    if (toggle && toggle.getAttribute("aria-checked") === "false") {
      toggle.click();
      log("Autoplay: restored YouTube native autoplay");
    }
    ytAutoplayWasOn = false;
  }

  /**
   * Extract video ID from a YouTube URL.
   */
  function extractVideoId(url) {
    try {
      const u = new URL(url, location.origin);
      return u.searchParams.get("v") || null;
    } catch {
      return null;
    }
  }

  /**
   * Record the current video in the recently-played history.
   */
  function recordCurrentVideo() {
    const id = extractVideoId(location.href);
    if (id) {
      recentVideoIds.add(id);
      if (recentVideoIds.size > HISTORY_MAX) {
        const oldest = recentVideoIds.values().next().value;
        recentVideoIds.delete(oldest);
      }
      log("Autoplay: recorded video", id, "in history (" + recentVideoIds.size + " total)");
    }
  }

  /**
   * Get the channel name from a sidebar video element.
   */
  function getVideoChannel(el) {
    const chromeChannel = el.querySelector(
      "ytd-channel-name #text, #channel-name #text, ytd-channel-name yt-formatted-string"
    );
    if (chromeChannel && chromeChannel.textContent.trim()) {
      return chromeChannel.textContent.trim();
    }

    const metaModel = el.querySelector("yt-content-metadata-view-model");
    if (metaModel) {
      const spans = metaModel.querySelectorAll("span");
      for (const span of spans) {
        const text = span.textContent.trim();
        if (
          text &&
          !/views?\s*$/i.test(text) &&
          !/ago\s*$/i.test(text) &&
          !/watching/i.test(text) &&
          !/^\d/.test(text)
        ) {
          return text;
        }
      }
    }

    return "";
  }

  /**
   * Get the metadata text (views + date) from a sidebar video element.
   */
  function getVideoMetaText(el) {
    const metaModel = el.querySelector("yt-content-metadata-view-model");
    if (metaModel) return metaModel.textContent.trim();
    const metaLine = el.querySelector("#metadata-line");
    if (metaLine) return metaLine.textContent.trim();
    return "";
  }

  /**
   * Update the autoplay end card to show the replacement video's info.
   */
  function updateEndCard(info) {
    const container = document.querySelector(
      ".ytp-autonav-endscreen-upnext-container"
    );
    if (!container) return;

    isUpdatingEndCard = true;

    const titleEl = container.querySelector(".ytp-autonav-endscreen-upnext-title");
    if (titleEl) titleEl.textContent = info.title;

    const authorEl = container.querySelector(".ytp-autonav-endscreen-upnext-author");
    if (authorEl && info.channel) authorEl.textContent = info.channel;

    const viewDateEl = container.querySelector(".ytp-autonav-view-and-date");
    if (viewDateEl && info.metaText) viewDateEl.textContent = info.metaText;

    const authorViewEl = container.querySelector(".ytp-autonav-author-and-view");
    if (authorViewEl) {
      if (info.channel && info.metaText) {
        authorViewEl.textContent = info.channel + " \u00B7 " + info.metaText;
      } else if (info.metaText) {
        authorViewEl.textContent = info.metaText;
      }
    }

    if (info.videoId) {
      const thumbEl = container.querySelector(
        ".ytp-autonav-endscreen-upnext-thumbnail"
      );
      if (thumbEl) {
        thumbEl.style.backgroundImage =
          "url(https://i.ytimg.com/vi/" + info.videoId + "/hqdefault.jpg)";
      }
    }

    const linkEl = container.querySelector("a.ytp-autonav-endscreen-link-container");
    if (linkEl) linkEl.href = info.url;

    const liveStamp = container.querySelector(".ytp-autonav-live-stamp");
    if (liveStamp) liveStamp.style.display = "none";

    isUpdatingEndCard = false;

    log("Autoplay: updated end card to show:", info.title);
  }

  /**
   * Start a visual countdown before navigating to the replacement video.
   */
  function startCountdown(info) {
    cancelCountdown();

    let remaining = settings.countdownSeconds;

    countdownOverlay = document.createElement("div");
    countdownOverlay.className = "ytf-countdown-overlay";
    countdownOverlay.innerHTML =
      '<div class="ytf-countdown-content">' +
        '<div class="ytf-countdown-text">Up next in ' +
          '<span class="ytf-countdown-number">' + remaining + "</span>s</div>" +
        '<div class="ytf-countdown-title">' +
          info.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
        "</div>" +
        '<button class="ytf-countdown-cancel">Cancel</button>' +
      "</div>";

    const player = document.querySelector("#movie_player");
    if (player) {
      player.appendChild(countdownOverlay);
    }

    countdownOverlay.querySelector(".ytf-countdown-cancel")
      .addEventListener("click", function (e) {
        e.stopPropagation();
        log("Autoplay: countdown cancelled by user");
        cancelCountdown();
      });

    playerClickHandler = function (e) {
      if (countdownOverlay && countdownOverlay.contains(e.target)) return;
      log("Autoplay: countdown cancelled by player click");
      cancelCountdown();
    };
    if (player) player.addEventListener("click", playerClickHandler);

    const numberEl = countdownOverlay.querySelector(".ytf-countdown-number");
    countdownTimer = setInterval(function () {
      remaining--;
      if (numberEl) numberEl.textContent = remaining;
      if (remaining <= 0) {
        const anchor = info.anchor;
        cancelCountdown();
        navigateToVideo(anchor);
      }
    }, 1000);

    log("Autoplay: countdown started (" + settings.countdownSeconds + "s)");
  }

  /**
   * Cancel the countdown and remove the overlay.
   */
  function cancelCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    if (countdownOverlay) {
      countdownOverlay.remove();
      countdownOverlay = null;
    }
    if (playerClickHandler) {
      const player = document.querySelector("#movie_player");
      if (player) player.removeEventListener("click", playerClickHandler);
      playerClickHandler = null;
    }
    restoreYouTubeAutoplay();
  }

  /**
   * Check the autoplay up-next container and decide whether to skip.
   * All enabled filters (livestreams, low views, shorts, mixes, playables,
   * members-only) apply to the autoplay overlay via the data-is-live
   * attribute, view count, and the link href.
   */
  function checkAutoplayAndSkip() {
    if (autoplayHandled) return false;
    if (!settings.autoplayIntercept) return false;
    if (!location.pathname.startsWith("/watch")) return false;

    const container = document.querySelector(
      ".ytp-autonav-endscreen-upnext-container"
    );
    if (!container) {
      log("Autoplay: up-next container not found");
      return false;
    }

    const titleEl = container.querySelector(
      ".ytp-autonav-endscreen-upnext-title"
    );
    if (!titleEl || !titleEl.textContent.trim()) {
      log("Autoplay: up-next container has no title yet");
      return false;
    }

    const nextTitle = titleEl.textContent.trim();
    let shouldSkip = false;
    let skipReason = "";

    // Check: livestream
    if (settings.hideLivestreams && !shouldSkip) {
      if (container.getAttribute("data-is-live") === "true") {
        shouldSkip = true;
        skipReason = "livestream (data-is-live)";
      }

      if (!shouldSkip) {
        const liveStamp = container.querySelector(".ytp-autonav-live-stamp");
        if (liveStamp && liveStamp.textContent.trim()) {
          shouldSkip = true;
          skipReason = "livestream (live stamp)";
        }
      }

      if (!shouldSkip) {
        const viewDateEl = container.querySelector(".ytp-autonav-view-and-date");
        if (viewDateEl && /\bwatching\b/i.test(viewDateEl.textContent)) {
          shouldSkip = true;
          skipReason = "livestream (watching)";
        }
      }
    }

    // Check: low views
    if (settings.hideLowViews && !shouldSkip) {
      const viewDateEl = container.querySelector(".ytp-autonav-view-and-date");
      if (viewDateEl) {
        const viewText = viewDateEl.textContent.trim();
        if (!/\bwatching\b/i.test(viewText)) {
          const vs = extractViewString(viewText);
          if (vs) {
            const views = parseViewCount(vs);
            if (!isNaN(views) && views < settings.viewThreshold) {
              shouldSkip = true;
              skipReason = "low views (" + views.toLocaleString() + " < " + settings.viewThreshold.toLocaleString() + ")";
            }
          }
        }
      }
    }

    // Check: Shorts — autoplay link contains /shorts/
    if (settings.hideShorts && !shouldSkip) {
      const linkEl = container.querySelector("a.ytp-autonav-endscreen-link-container");
      if (linkEl && linkEl.href && linkEl.href.includes("/shorts/")) {
        shouldSkip = true;
        skipReason = "short";
      }
    }

    // Check: Mixes — autoplay link contains start_radio=1 or list=RD
    if (settings.hideMixes && !shouldSkip) {
      const linkEl = container.querySelector("a.ytp-autonav-endscreen-link-container");
      if (linkEl && linkEl.href) {
        if (linkEl.href.includes("start_radio=1") || /[?&]list=RD/.test(linkEl.href)) {
          shouldSkip = true;
          skipReason = "mix";
        }
      }
      if (!shouldSkip && /^Mix\s*[-–]/.test(nextTitle)) {
        shouldSkip = true;
        skipReason = "mix";
      }
    }

    // Check: Playables — autoplay link contains /playables/
    if (settings.hidePlayables && !shouldSkip) {
      const linkEl = container.querySelector("a.ytp-autonav-endscreen-link-container");
      if (linkEl && linkEl.href && linkEl.href.includes("/playables/")) {
        shouldSkip = true;
        skipReason = "playable";
      }
    }

    // Check: Members-only — not easily detectable in autoplay overlay,
    // but the sidebar alternative search already filters these out.

    if (!shouldSkip) {
      log("Autoplay: up-next video is OK:", nextTitle);
      return false;
    }

    log("Autoplay: skipping up-next:", nextTitle, "—", skipReason);

    const alternative = findSidebarAlternative();
    if (alternative) {
      log("Autoplay: replacement:", alternative.title);
      cancelYouTubeAutoplay();
      autoplayHandled = true;
      updateEndCard(alternative);
      startCountdown(alternative);
      return true;
    }

    log("Autoplay: no valid sidebar alternative found");
    return false;
  }

  /**
   * Find the first sidebar recommendation that passed filtering
   * and hasn't been recently played.
   */
  function findSidebarAlternative() {
    const secondary =
      document.querySelector("ytd-watch-next-secondary-results-renderer") ||
      document.querySelector("#secondary-inner, #related");
    if (!secondary) return null;

    const passedItems = secondary.querySelectorAll(
      `ytd-compact-video-renderer[${FILTERED_ATTR}="pass"], yt-lockup-view-model[${FILTERED_ATTR}="pass"]`
    );

    // First pass: skip recently played videos
    for (const item of passedItems) {
      const anchor = item.querySelector("a[href]");
      if (!anchor || !anchor.href || !anchor.href.includes("/watch")) continue;

      const videoId = extractVideoId(anchor.href);
      if (videoId && recentVideoIds.has(videoId)) continue;

      return {
        anchor,
        title: getVideoTitle(item),
        channel: getVideoChannel(item),
        metaText: getVideoMetaText(item),
        videoId,
        url: anchor.href,
      };
    }

    // All alternatives were recently played — clear history and retry
    if (recentVideoIds.size > 0) {
      log("Autoplay: all alternatives recently played, clearing history");
      recentVideoIds.clear();

      for (const item of passedItems) {
        const anchor = item.querySelector("a[href]");
        if (!anchor || !anchor.href || !anchor.href.includes("/watch")) continue;

        return {
          anchor,
          title: getVideoTitle(item),
          channel: getVideoChannel(item),
          metaText: getVideoMetaText(item),
          videoId: extractVideoId(anchor.href),
          url: anchor.href,
        };
      }
    }

    return null;
  }

  /**
   * Navigate to a video via its anchor element.
   */
  function navigateToVideo(anchor) {
    restoreYouTubeAutoplay();
    const url = anchor.href;
    try {
      anchor.click();
      log("Autoplay: clicked sidebar link for SPA navigation");
      setTimeout(() => {
        if (location.href !== url && !location.href.includes(new URL(url).searchParams.get("v"))) {
          log("Autoplay: click didn't navigate, falling back to location.href");
          window.location.href = url;
        }
      }, 1000);
    } catch (e) {
      log("Autoplay: click failed, using location.href fallback");
      window.location.href = url;
    }
  }

  /**
   * Handler for the <video> ended event.
   */
  function onVideoEnded() {
    log("Autoplay: video ended event fired");
    checkAutoplayAndSkip();
  }

  /**
   * Attach the ended listener to the current <video> element.
   */
  function attachVideoEndedListener() {
    const video = document.querySelector("#movie_player video");
    if (!video) return false;

    if (video === videoElement && videoEndedBound) return true;

    detachVideoEndedListener();

    videoElement = video;
    videoEndedBound = onVideoEnded;
    video.addEventListener("ended", videoEndedBound);
    log("Autoplay: attached ended listener to <video>");
    return true;
  }

  /**
   * Detach the ended listener from the current video element.
   */
  function detachVideoEndedListener() {
    if (videoElement && videoEndedBound) {
      videoElement.removeEventListener("ended", videoEndedBound);
      log("Autoplay: detached ended listener from <video>");
    }
    videoElement = null;
    videoEndedBound = null;
  }

  /**
   * Poll for the <video> element (YouTube loads it dynamically).
   */
  function startVideoPolling() {
    stopVideoPolling();

    if (!settings.autoplayIntercept) return;
    if (!location.pathname.startsWith("/watch")) return;

    let elapsed = 0;
    const POLL_INTERVAL = 1000;
    const MAX_POLL_TIME = 30000;

    if (attachVideoEndedListener()) {
      setupAutoplayContainerObserver();
      return;
    }

    videoPollingTimer = setInterval(() => {
      elapsed += POLL_INTERVAL;

      if (attachVideoEndedListener()) {
        stopVideoPolling();
        setupAutoplayContainerObserver();
        return;
      }

      if (elapsed >= MAX_POLL_TIME) {
        log("Autoplay: gave up polling for <video> after 30s");
        stopVideoPolling();
      }
    }, POLL_INTERVAL);
  }

  /**
   * Stop polling for the video element.
   */
  function stopVideoPolling() {
    if (videoPollingTimer) {
      clearInterval(videoPollingTimer);
      videoPollingTimer = null;
    }
  }

  /**
   * Set up a MutationObserver on the autoplay up-next container as a backup.
   */
  function setupAutoplayContainerObserver() {
    teardownAutoplayContainerObserver();

    if (!settings.autoplayIntercept) return;
    if (!location.pathname.startsWith("/watch")) return;

    const container = document.querySelector(
      ".ytp-autonav-endscreen-upnext-container"
    );
    if (!container) {
      setTimeout(setupAutoplayContainerObserver, 2000);
      return;
    }

    autoplayContainerObserver = new MutationObserver((mutations) => {
      if (isUpdatingEndCard) return;

      for (const mutation of mutations) {
        if (
          mutation.type === "attributes" &&
          (mutation.attributeName === "data-is-live" ||
            mutation.attributeName === "style" ||
            mutation.attributeName === "class")
        ) {
          if (container.clientHeight > 0) {
            log("Autoplay: container became visible (attribute change)");
            checkAutoplayAndSkip();
            return;
          }
        }
        if (mutation.type === "childList" && container.clientHeight > 0) {
          log("Autoplay: container content changed while visible");
          checkAutoplayAndSkip();
          return;
        }
      }
    });

    autoplayContainerObserver.observe(container, {
      attributes: true,
      childList: true,
      subtree: true,
    });

    log("Autoplay: MutationObserver active on up-next container");
  }

  /**
   * Tear down the autoplay container observer.
   */
  function teardownAutoplayContainerObserver() {
    if (autoplayContainerObserver) {
      autoplayContainerObserver.disconnect();
      autoplayContainerObserver = null;
    }
  }

  /**
   * Clean up all autoplay state (for navigation resets).
   */
  function cleanupAutoplay() {
    detachVideoEndedListener();
    stopVideoPolling();
    teardownAutoplayContainerObserver();
    cancelCountdown();
    autoplayHandled = false;
    restoreYouTubeAutoplay();
  }

  // ---------------------------------------------------------------------------
  // SPA navigation handling
  // ---------------------------------------------------------------------------

  function onNavigate() {
    log("Navigation detected — rescanning");

    recordCurrentVideo();

    document.querySelectorAll(`[${FILTERED_ATTR}]`).forEach((el) => {
      el.removeAttribute(FILTERED_ATTR);
      el.classList.remove("ytf-hidden");
    });

    cleanupAutoplay();

    setTimeout(() => {
      scanAndFilter();
      if (settings.autoplayIntercept) {
        startVideoPolling();
      }
    }, 500);
  }

  window.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("popstate", () => setTimeout(onNavigate, 300));

  // ---------------------------------------------------------------------------
  // MutationObserver with debouncing
  // ---------------------------------------------------------------------------

  let debounceTimer = null;

  function debouncedScan() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      scanAndFilter();
    }, DEBOUNCE_MS);
  }

  const observer = new MutationObserver(() => {
    debouncedScan();
  });

  // ---------------------------------------------------------------------------
  // Periodic re-scan for lazily loaded metadata
  // ---------------------------------------------------------------------------

  function startPeriodicRescan() {
    setInterval(() => {
      const unresolved = document.querySelectorAll(
        VIDEO_SELECTORS.split(", ")
          .map((s) => `${s}:not([${FILTERED_ATTR}])`)
          .join(", ")
      );
      if (unresolved.length > 0) {
        scanAndFilter();
      }
    }, RESCAN_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  function init() {
    loadSettings().then(() => {
      log(
        "Initializing YouTube Feed Filter (threshold:",
        settings.viewThreshold,
        "views)"
      );

      scanAndFilter();

      if (settings.autoplayIntercept) {
        startVideoPolling();
      }

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      startPeriodicRescan();

      log("MutationObserver active, periodic rescan every", RESCAN_INTERVAL_MS, "ms");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
