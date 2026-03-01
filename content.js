// YouTube Feed Filter — Content Script
// Filters livestreams and videos with < 50,000 views from YouTube.

(function () {
  "use strict";

  const VIEW_THRESHOLD = 50000;
  const LOG_PREFIX = "[YT-Filter]";
  const DEBOUNCE_MS = 300;
  const FILTERED_ATTR = "data-ytf-filtered";
  const CHECKED_ATTR = "data-ytf-checked";

  // ---------------------------------------------------------------------------
  // Utility helpers
  // ---------------------------------------------------------------------------

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  /**
   * Parse YouTube's abbreviated view counts into a number.
   * Examples: "1.2M views" → 1200000, "350K views" → 350000, "50 views" → 50
   * Returns NaN when the string cannot be parsed.
   */
  function parseViewCount(text) {
    if (!text) return NaN;

    // Normalize: remove commas, trim whitespace, lower-case for matching
    const cleaned = text.replace(/,/g, "").trim();

    // Match patterns like "1.2M", "350K", "50", possibly followed by " views"
    // Also handle "No views" → 0
    if (/no views/i.test(cleaned)) return 0;

    const match = cleaned.match(
      /([\d]+(?:\.[\d]+)?)\s*([KMBT]?)(?:\s*views?)?/i
    );
    if (!match) return NaN;

    const num = parseFloat(match[1]);
    const suffix = match[2].toUpperCase();

    const multipliers = { "": 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
    const multiplier = multipliers[suffix];
    if (multiplier === undefined) return NaN;

    return num * multiplier;
  }

  // ---------------------------------------------------------------------------
  // Detection helpers
  // ---------------------------------------------------------------------------

  /**
   * Check whether a video element carries a LIVE badge / is a livestream.
   */
  function isLiveStream(el) {
    // 1. Badge overlays — ytd-badge-supported-renderer with "LIVE" text
    const badges = el.querySelectorAll(
      "ytd-badge-supported-renderer, .badge-style-type-live-now, .badge-style-type-live-now-alternate"
    );
    for (const badge of badges) {
      const txt = (badge.textContent || "").trim().toUpperCase();
      if (txt === "LIVE" || txt === "LIVE NOW") return true;
    }

    // 2. Overlay style badges (thumbnail overlays)
    const overlays = el.querySelectorAll(
      "ytd-thumbnail-overlay-time-status-renderer"
    );
    for (const overlay of overlays) {
      const style = overlay.getAttribute("overlay-style");
      if (style === "LIVE") return true;
      const txt = (overlay.textContent || "").trim().toUpperCase();
      if (txt === "LIVE" || txt === "LIVE NOW") return true;
    }

    // 3. Icon-based live indicator
    const icons = el.querySelectorAll("yt-icon");
    for (const icon of icons) {
      const label = icon.getAttribute("aria-label") || "";
      if (/live/i.test(label)) return true;
    }

    // 4. Text anywhere in the metadata line containing "watching" (live indicator)
    const metaText = getMetaText(el);
    if (/\bwatching\b/i.test(metaText)) return true;

    return false;
  }

  /**
   * Gather the text content of metadata lines (view count, time ago, etc.)
   */
  function getMetaText(el) {
    // ytd-video-meta-block is used on homepage / search
    const metaBlock = el.querySelector("ytd-video-meta-block");
    if (metaBlock) return metaBlock.textContent || "";

    // Compact renderer (sidebar) uses #metadata-line or #metadata
    const metaLine =
      el.querySelector("#metadata-line") || el.querySelector("#metadata");
    if (metaLine) return metaLine.textContent || "";

    return "";
  }

  /**
   * Extract the view count from a video element.
   * Returns the parsed number, or NaN if not found.
   */
  function getViewCount(el) {
    // Try aria-label on the anchor (contains full description including views)
    const anchor = el.querySelector("a#video-title, a#video-title-link, h3 a");
    if (anchor) {
      const label = anchor.getAttribute("aria-label") || "";
      const viewMatch = label.match(
        /([\d,]+(?:\.[\d]+)?)\s*([KMBT]?)\s*views?/i
      );
      if (viewMatch) {
        const raw = viewMatch[1].replace(/,/g, "") + viewMatch[2];
        return parseViewCount(raw + " views");
      }
    }

    // Try metadata text spans
    const metaText = getMetaText(el);
    // Look for patterns like "1.2M views" or "350K views" inside the metadata
    const spans = metaText.match(
      /[\d,]+(?:\.[\d]+)?\s*[KMBT]?\s*views?/gi
    );
    if (spans && spans.length > 0) {
      return parseViewCount(spans[0]);
    }

    // Try individual span elements for more precision
    const allSpans = el.querySelectorAll(
      "span.inline-metadata-item, span.style-scope.ytd-video-meta-block"
    );
    for (const span of allSpans) {
      const txt = (span.textContent || "").trim();
      if (/views?/i.test(txt)) {
        return parseViewCount(txt);
      }
    }

    return NaN;
  }

  // ---------------------------------------------------------------------------
  // Filtering logic
  // ---------------------------------------------------------------------------

  /**
   * Decide whether a video element should be hidden.
   * Returns { hide: boolean, reason: string }
   */
  function shouldHide(el) {
    if (isLiveStream(el)) {
      return { hide: true, reason: "livestream" };
    }

    const views = getViewCount(el);
    if (!isNaN(views) && views < VIEW_THRESHOLD) {
      return {
        hide: true,
        reason: `low views (${views.toLocaleString()} < ${VIEW_THRESHOLD.toLocaleString()})`,
      };
    }

    return { hide: false, reason: "" };
  }

  /**
   * Get a human-readable title for a video element (for logging).
   */
  function getVideoTitle(el) {
    const titleEl = el.querySelector(
      "#video-title, h3 a, .title, yt-formatted-string#video-title"
    );
    return titleEl ? (titleEl.textContent || "").trim().slice(0, 80) : "(unknown)";
  }

  /**
   * Process a single video element: check and hide if necessary.
   */
  function processVideoElement(el) {
    // Skip if already processed
    if (el.hasAttribute(CHECKED_ATTR)) return;
    el.setAttribute(CHECKED_ATTR, "1");

    const { hide, reason } = shouldHide(el);
    if (hide) {
      el.setAttribute(FILTERED_ATTR, "1");
      el.classList.add("ytf-hidden");
      log("Hiding:", getVideoTitle(el), "—", reason);
    }
  }

  // Selectors for all video element types we want to filter
  const VIDEO_SELECTORS = [
    "ytd-rich-item-renderer",        // Homepage grid items
    "ytd-video-renderer",            // Search results
    "ytd-compact-video-renderer",    // Sidebar recommendations
    "ytd-grid-video-renderer",       // Grid views (channel pages, etc.)
    "ytd-reel-item-renderer",        // Shorts on homepage (if applicable)
  ].join(", ");

  /**
   * Scan the DOM (or a subtree) for video elements and filter them.
   */
  function scanAndFilter(root) {
    const elements = (root || document).querySelectorAll(VIDEO_SELECTORS);
    let count = 0;
    for (const el of elements) {
      if (!el.hasAttribute(CHECKED_ATTR)) {
        processVideoElement(el);
        count++;
      }
    }
    if (count > 0) {
      log(`Scanned ${count} new video elements`);
    }
  }

  // ---------------------------------------------------------------------------
  // Autoplay intervention
  // ---------------------------------------------------------------------------

  /**
   * Monitor the autoplay / "Up Next" section.
   * If the top recommendation is a livestream or low-view video, click the
   * next valid one so autoplay picks it instead.
   */
  function handleAutoplay() {
    // Only act on watch pages
    if (!location.pathname.startsWith("/watch")) return;

    const secondary = document.querySelector(
      "ytd-watch-next-secondary-results-renderer"
    );
    if (!secondary) return;

    const items = secondary.querySelectorAll("ytd-compact-video-renderer");
    if (items.length === 0) return;

    // The first item is the "Up Next" / autoplay candidate
    const first = items[0];

    // If already checked and not hidden, nothing to do
    if (
      first.hasAttribute(CHECKED_ATTR) &&
      !first.hasAttribute(FILTERED_ATTR)
    ) {
      return;
    }

    // Check the first item
    const { hide, reason } = shouldHide(first);
    if (!hide) return;

    log("Autoplay candidate is filtered:", getVideoTitle(first), "—", reason);

    // Find the next valid video and "promote" it by clicking
    for (let i = 1; i < items.length; i++) {
      const candidate = items[i];
      const check = shouldHide(candidate);
      if (!check.hide) {
        log("Selecting next valid autoplay:", getVideoTitle(candidate));
        const link = candidate.querySelector("a");
        if (link) {
          // Update the autoplay by setting the link as the up-next target.
          // We simulate a click only when autoplay is about to trigger.
          // For now, mark the invalid first item as hidden so it collapses.
          first.setAttribute(FILTERED_ATTR, "1");
          first.classList.add("ytf-hidden");
          first.setAttribute(CHECKED_ATTR, "1");

          // Watch for the autoplay countdown/timer and redirect
          interceptAutoplay(link.href);
        }
        return;
      }
    }

    // If no valid video found at all, just hide the first one
    first.setAttribute(FILTERED_ATTR, "1");
    first.classList.add("ytf-hidden");
    first.setAttribute(CHECKED_ATTR, "1");
  }

  let autoplayInterceptUrl = null;
  let autoplayObserver = null;

  /**
   * Watch for YouTube's autoplay countdown and redirect to a valid video.
   */
  function interceptAutoplay(validUrl) {
    autoplayInterceptUrl = validUrl;

    // If already observing, don't create a second observer
    if (autoplayObserver) return;

    // Watch the player area for autoplay triggers
    const playerContainer = document.querySelector("#movie_player, ytd-player");
    if (!playerContainer) return;

    autoplayObserver = new MutationObserver(() => {
      if (!autoplayInterceptUrl) return;

      // Detect autoplay countdown overlay or end-of-video state
      const countdown = document.querySelector(
        ".ytp-autonav-endscreen-countdown, .ytp-autonav-endscreen-upnext-container"
      );
      if (countdown) {
        log("Autoplay countdown detected — redirecting to valid video");
        // Cancel autoplay by navigating to the valid URL
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

  /**
   * Reset checked attributes when YouTube performs a SPA navigation
   * so we re-scan elements on the new "page."
   */
  function onNavigate() {
    log("Navigation detected — rescanning");
    // Clear checked flags so we re-evaluate (elements may be reused by YouTube)
    document
      .querySelectorAll(`[${CHECKED_ATTR}]`)
      .forEach((el) => el.removeAttribute(CHECKED_ATTR));
    document
      .querySelectorAll(`[${FILTERED_ATTR}]`)
      .forEach((el) => {
        el.removeAttribute(FILTERED_ATTR);
        el.classList.remove("ytf-hidden");
      });

    // Clean up autoplay interception on navigation
    autoplayInterceptUrl = null;
    if (autoplayObserver) {
      autoplayObserver.disconnect();
      autoplayObserver = null;
    }

    // Re-scan after a brief delay to let YouTube render
    setTimeout(() => {
      scanAndFilter();
      handleAutoplay();
    }, 500);
  }

  // Listen for YouTube's SPA navigation events
  window.addEventListener("yt-navigate-finish", onNavigate);

  // Also handle popstate for browser back/forward
  window.addEventListener("popstate", () => {
    setTimeout(onNavigate, 300);
  });

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

  const observer = new MutationObserver((mutations) => {
    // Quick check: only trigger if mutations involve elements we care about
    let dominated = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        dominated = true;
        break;
      }
    }
    if (dominated) {
      debouncedScan();
    }
  });

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  function init() {
    log("Initializing YouTube Feed Filter (threshold:", VIEW_THRESHOLD, "views)");

    // Initial scan
    scanAndFilter();
    handleAutoplay();

    // Observe the entire body for dynamic content changes
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    log("MutationObserver active");
  }

  // Start when the DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
