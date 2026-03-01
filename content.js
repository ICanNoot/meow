// YouTube Feed Filter — Content Script
// Filters livestreams and videos with < 50,000 views from YouTube.

(function () {
  "use strict";

  const VIEW_THRESHOLD = 50000;
  const LOG_PREFIX = "[YT-Filter]";
  const DEBOUNCE_MS = 250;
  const RESCAN_INTERVAL_MS = 2000;
  const FILTERED_ATTR = "data-ytf-filtered";

  // ---------------------------------------------------------------------------
  // Utility helpers
  // ---------------------------------------------------------------------------

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  /**
   * Parse YouTube's abbreviated view counts into a number.
   * Handles: "1.2M views", "350K views", "50 views", "No views",
   *          "1,234,567 views", "5.1B views", etc.
   * Returns NaN when the string cannot be parsed.
   */
  function parseViewCount(text) {
    if (!text) return NaN;

    const cleaned = text.replace(/,/g, "").trim();

    if (/no views/i.test(cleaned)) return 0;

    const match = cleaned.match(/([\d]+(?:\.[\d]+)?)\s*([KMBT]?)/i);
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
   * Returns the matched substring or null.
   */
  function extractViewString(text) {
    if (!text) return null;
    // Match "123 views", "1.2K views", "1,234,567 views", "No views", etc.
    const m = text.match(/(?:no views|[\d,]+(?:\.[\d]+)?\s*[KMBT]?\s*views?)/i);
    return m ? m[0] : null;
  }

  // ---------------------------------------------------------------------------
  // Detection helpers
  // ---------------------------------------------------------------------------

  /**
   * Check whether a video element carries a LIVE badge / is a livestream.
   */
  function isLiveStream(el) {
    // 1. Thumbnail overlay with overlay-style="LIVE"
    const overlays = el.querySelectorAll(
      "ytd-thumbnail-overlay-time-status-renderer"
    );
    for (const overlay of overlays) {
      const style = overlay.getAttribute("overlay-style");
      if (style === "LIVE") return true;
      const txt = (overlay.textContent || "").trim().toUpperCase();
      if (txt === "LIVE" || txt === "LIVE NOW") return true;
    }

    // 2. Badge renderers with "LIVE" text
    const badges = el.querySelectorAll(
      "ytd-badge-supported-renderer, .badge-style-type-live-now, .badge-style-type-live-now-alternate"
    );
    for (const badge of badges) {
      const txt = (badge.textContent || "").trim().toUpperCase();
      if (txt === "LIVE" || txt === "LIVE NOW") return true;
    }

    // 3. Any element with aria-label containing "live"
    const liveLabeled = el.querySelectorAll('[aria-label*="live" i], [aria-label*="Live" i], [aria-label*="LIVE"]');
    if (liveLabeled.length > 0) return true;

    // 4. "watching now" in any text (live viewers indicator)
    const fullText = el.textContent || "";
    if (/\bwatching\b/i.test(fullText)) return true;

    // 5. Check the aria-label on the title element for "watching" or "streamed"
    const titleEl = el.querySelector("#video-title");
    if (titleEl) {
      const ariaLabel = titleEl.getAttribute("aria-label") || "";
      if (/\bwatching\b/i.test(ariaLabel)) return true;
    }

    return false;
  }

  /**
   * Extract the view count from a video element.
   * Returns the parsed number, or NaN if not found.
   */
  function getViewCount(el) {
    // Strategy 1: aria-label on #video-title or a#video-title-link
    // These contain the full description like:
    // "Title by Channel 123,456 views 2 days ago 10 minutes"
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

    // Strategy 2: metadata block text
    // ytd-video-meta-block is used on homepage and search
    const metaBlock = el.querySelector("ytd-video-meta-block");
    if (metaBlock) {
      const vs = extractViewString(metaBlock.textContent);
      if (vs) return parseViewCount(vs);
    }

    // Strategy 3: #metadata-line (used in compact renderers / sidebar)
    const metaLine = el.querySelector("#metadata-line");
    if (metaLine) {
      const vs = extractViewString(metaLine.textContent);
      if (vs) return parseViewCount(vs);
    }

    // Strategy 4: #metadata (fallback)
    const metadata = el.querySelector("#metadata");
    if (metadata) {
      const vs = extractViewString(metadata.textContent);
      if (vs) return parseViewCount(vs);
    }

    // Strategy 5: any span containing "views"
    const allSpans = el.querySelectorAll("span");
    for (const span of allSpans) {
      const txt = (span.textContent || "").trim();
      if (/views?$/i.test(txt)) {
        const count = parseViewCount(txt);
        if (!isNaN(count)) return count;
      }
    }

    // Strategy 6: brute-force search the entire element text
    const fullText = el.textContent || "";
    const vs = extractViewString(fullText);
    if (vs) return parseViewCount(vs);

    return NaN;
  }

  // ---------------------------------------------------------------------------
  // Filtering logic
  // ---------------------------------------------------------------------------

  /**
   * Decide whether a video element should be hidden.
   * Returns { hide: boolean, reason: string, indeterminate: boolean }
   */
  function shouldHide(el) {
    if (isLiveStream(el)) {
      return { hide: true, reason: "livestream", indeterminate: false };
    }

    const views = getViewCount(el);

    // If we can't determine views, mark as indeterminate so we re-check later
    if (isNaN(views)) {
      return { hide: false, reason: "", indeterminate: true };
    }

    if (views < VIEW_THRESHOLD) {
      return {
        hide: true,
        reason: `low views (${views.toLocaleString()} < ${VIEW_THRESHOLD.toLocaleString()})`,
        indeterminate: false,
      };
    }

    return { hide: false, reason: "", indeterminate: false };
  }

  /**
   * Get a human-readable title for a video element (for logging).
   */
  function getVideoTitle(el) {
    const titleEl = el.querySelector(
      "#video-title, h3 a, yt-formatted-string#video-title"
    );
    return titleEl
      ? (titleEl.textContent || "").trim().slice(0, 80)
      : "(unknown)";
  }

  // Selectors for all video element types we want to filter
  const VIDEO_SELECTORS = [
    "ytd-rich-item-renderer",     // Homepage grid items
    "ytd-video-renderer",         // Search results
    "ytd-compact-video-renderer", // Sidebar recommendations
    "ytd-grid-video-renderer",    // Grid views (channel pages, etc.)
    "ytd-reel-item-renderer",     // Shorts on homepage
  ].join(", ");

  /**
   * Process a single video element: check and hide if necessary.
   * Returns true if the element was definitively resolved (hidden or passed).
   * Returns false if the element is indeterminate (no view data yet).
   */
  function processVideoElement(el) {
    // Already filtered — skip
    if (el.hasAttribute(FILTERED_ATTR)) return true;

    const { hide, reason, indeterminate } = shouldHide(el);

    if (hide) {
      el.setAttribute(FILTERED_ATTR, "1");
      el.classList.add("ytf-hidden");
      log("Hiding:", getVideoTitle(el), "—", reason);
      return true;
    }

    if (indeterminate) {
      // Don't mark as resolved — we'll re-check on next scan
      return false;
    }

    // Passed the filter — mark so we don't re-check expensively
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

      // Already definitively resolved
      if (status === "1" || status === "pass") continue;

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
  }

  // ---------------------------------------------------------------------------
  // Autoplay intervention
  // ---------------------------------------------------------------------------

  let autoplayInterceptUrl = null;
  let autoplayObserver = null;

  function handleAutoplay() {
    if (!location.pathname.startsWith("/watch")) return;

    const secondary = document.querySelector(
      "ytd-watch-next-secondary-results-renderer"
    );
    if (!secondary) return;

    const items = secondary.querySelectorAll("ytd-compact-video-renderer");
    if (items.length === 0) return;

    const first = items[0];

    // If already hidden, we've already handled it
    if (first.getAttribute(FILTERED_ATTR) === "1") return;

    // If already passed, nothing to do
    if (first.getAttribute(FILTERED_ATTR) === "pass") return;

    const { hide, reason } = shouldHide(first);
    if (!hide) return;

    log("Autoplay candidate is filtered:", getVideoTitle(first), "—", reason);
    first.setAttribute(FILTERED_ATTR, "1");
    first.classList.add("ytf-hidden");

    // Find the next valid video
    for (let i = 1; i < items.length; i++) {
      const candidate = items[i];
      const check = shouldHide(candidate);
      if (!check.hide && !check.indeterminate) {
        log("Selecting next valid autoplay:", getVideoTitle(candidate));
        const link = candidate.querySelector("a");
        if (link && link.href) {
          interceptAutoplay(link.href);
        }
        return;
      }
    }
  }

  function interceptAutoplay(validUrl) {
    autoplayInterceptUrl = validUrl;
    if (autoplayObserver) return;

    const playerContainer = document.querySelector(
      "#movie_player, ytd-player"
    );
    if (!playerContainer) return;

    autoplayObserver = new MutationObserver(() => {
      if (!autoplayInterceptUrl) return;

      const countdown = document.querySelector(
        ".ytp-autonav-endscreen-countdown, .ytp-autonav-endscreen-upnext-container"
      );
      if (countdown) {
        log("Autoplay countdown detected — redirecting to valid video");
        const url = autoplayInterceptUrl;
        autoplayInterceptUrl = null;
        window.location.href = url;
      }
    });

    autoplayObserver.observe(playerContainer, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  }

  // ---------------------------------------------------------------------------
  // SPA navigation handling
  // ---------------------------------------------------------------------------

  function onNavigate() {
    log("Navigation detected — rescanning");

    // Clear all filter marks so we re-evaluate on the new page
    document.querySelectorAll(`[${FILTERED_ATTR}]`).forEach((el) => {
      el.removeAttribute(FILTERED_ATTR);
      el.classList.remove("ytf-hidden");
    });

    // Clean up autoplay interception
    autoplayInterceptUrl = null;
    if (autoplayObserver) {
      autoplayObserver.disconnect();
      autoplayObserver = null;
    }

    // Re-scan after a brief delay to let YouTube render new content
    setTimeout(() => {
      scanAndFilter();
      handleAutoplay();
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
      handleAutoplay();
    }, DEBOUNCE_MS);
  }

  const observer = new MutationObserver(() => {
    // Fire on ANY mutation — text changes (metadata loading) matter too
    debouncedScan();
  });

  // ---------------------------------------------------------------------------
  // Periodic re-scan for lazily loaded metadata
  // ---------------------------------------------------------------------------

  function startPeriodicRescan() {
    setInterval(() => {
      // Only re-scan if there are unresolved elements on the page
      const unresolved = document.querySelectorAll(
        VIDEO_SELECTORS.split(", ")
          .map((s) => `${s}:not([${FILTERED_ATTR}])`)
          .join(", ")
      );
      if (unresolved.length > 0) {
        scanAndFilter();
        handleAutoplay();
      }
    }, RESCAN_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  function init() {
    log(
      "Initializing YouTube Feed Filter (threshold:",
      VIEW_THRESHOLD,
      "views)"
    );

    scanAndFilter();
    handleAutoplay();

    // Observe body for all DOM changes (child additions, text, attributes)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Periodic fallback for content that loads without triggering mutations
    startPeriodicRescan();

    log("MutationObserver active, periodic rescan every", RESCAN_INTERVAL_MS, "ms");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
