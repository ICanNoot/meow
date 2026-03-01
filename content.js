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
   * Returns the matched substring or null.
   */
  function extractViewString(text) {
    if (!text) return null;
    // Match "123 views", "1.2K views", "14m views", "1,234,567 views", "No views", etc.
    // Use explicit lowercase+uppercase in char class rather than relying on /i for clarity
    const m = text.match(/(?:no views|[\d,]+(?:\.[\d]+)?\s*[KkMmBbTt]?\s*views?)/i);
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

    // 2. Badge renderers with "LIVE" text (legacy layout)
    const badges = el.querySelectorAll(
      "ytd-badge-supported-renderer, .badge-style-type-live-now, .badge-style-type-live-now-alternate"
    );
    for (const badge of badges) {
      const txt = (badge.textContent || "").trim().toUpperCase();
      if (txt === "LIVE" || txt === "LIVE NOW") return true;
    }

    // 3. New layout (Firefox): yt-badge-view-model, yt-thumbnail-badge-view-model,
    //    and badge-shape > .yt-badge-shape__text
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

    // 4. Any element with aria-label containing "live"
    const liveLabeled = el.querySelectorAll('[aria-label*="live" i], [aria-label*="Live" i], [aria-label*="LIVE"]');
    if (liveLabeled.length > 0) return true;

    // 5. "watching now" in any text (live viewers indicator)
    const fullText = el.textContent || "";
    if (/\bwatching\b/i.test(fullText)) return true;

    // 6. Check the aria-label on the title element for "watching" or "streamed"
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
    // Strategy 1: yt-content-metadata-view-model (Firefox / new layout)
    // Contains spans like "14m views" / "350k views"
    const metaViewModel = el.querySelector("yt-content-metadata-view-model");
    if (metaViewModel) {
      const vs = extractViewString(metaViewModel.textContent);
      if (vs) return parseViewCount(vs);
    }

    // Strategy 2: aria-label on #video-title or a#video-title-link (Chrome)
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

    // Strategy 3: ytd-video-meta-block text (Chrome homepage / search)
    const metaBlock = el.querySelector("ytd-video-meta-block");
    if (metaBlock) {
      const vs = extractViewString(metaBlock.textContent);
      if (vs) return parseViewCount(vs);
    }

    // Strategy 4: #metadata-line (Chrome compact renderers / sidebar)
    const metaLine = el.querySelector("#metadata-line");
    if (metaLine) {
      const vs = extractViewString(metaLine.textContent);
      if (vs) return parseViewCount(vs);
    }

    // Strategy 5: #metadata (Chrome fallback)
    const metadata = el.querySelector("#metadata");
    if (metadata) {
      const vs = extractViewString(metadata.textContent);
      if (vs) return parseViewCount(vs);
    }

    // Strategy 6: any span containing "views"
    const allSpans = el.querySelectorAll("span");
    for (const span of allSpans) {
      const txt = (span.textContent || "").trim();
      if (/views?$/i.test(txt)) {
        const count = parseViewCount(txt);
        if (!isNaN(count)) return count;
      }
    }

    // Strategy 7: brute-force search the entire element text
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
      "#video-title, h3 a, yt-formatted-string#video-title, yt-lockup-metadata-view-model h3"
    );
    return titleEl
      ? (titleEl.textContent || "").trim().slice(0, 80)
      : "(unknown)";
  }

  // Selectors for all video element types we want to filter.
  // Includes both ytd- (Chrome / legacy) and yt- (Firefox / new layout) elements.
  const VIDEO_SELECTORS = [
    "ytd-rich-item-renderer",     // Homepage grid items (Chrome)
    "ytd-video-renderer",         // Search results (Chrome)
    "ytd-compact-video-renderer", // Sidebar recommendations (Chrome)
    "ytd-grid-video-renderer",    // Grid views / channel pages (Chrome)
    "ytd-reel-item-renderer",     // Shorts on homepage (Chrome)
    "yt-lockup-view-model",       // Video cards (Firefox / new layout)
  ].join(", ");

  // ytd- selectors used to detect whether a yt-lockup-view-model is nested
  // inside a Chrome-style container (so we skip it and let the parent handle it).
  const YTD_CONTAINER_SELECTORS =
    "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-reel-item-renderer";

  /**
   * Process a single video element: check and hide if necessary.
   * Returns true if the element was definitively resolved (hidden or passed).
   * Returns false if the element is indeterminate (no view data yet).
   */
  function processVideoElement(el) {
    // Already filtered — skip
    if (el.hasAttribute(FILTERED_ATTR)) return true;

    // On Chrome, yt-lockup-view-model is nested inside a ytd- container.
    // Skip the inner element — the outer ytd- container will be processed
    // and hidden instead, which avoids leaving an empty grid slot.
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
  }

  // ---------------------------------------------------------------------------
  // Autoplay intervention
  // ---------------------------------------------------------------------------

  let videoEndedBound = null;   // current bound listener ref
  let videoElement = null;      // current <video> element
  let videoPollingTimer = null; // polling interval for finding <video>
  let autoplayContainerObserver = null; // MutationObserver on up-next container

  /**
   * Check the autoplay up-next container and decide whether to skip.
   * Returns true if a skip navigation was initiated.
   */
  function checkAutoplayAndSkip() {
    if (!location.pathname.startsWith("/watch")) return false;

    const container = document.querySelector(
      ".ytp-autonav-endscreen-upnext-container"
    );
    if (!container) {
      log("Autoplay: up-next container not found");
      return false;
    }

    // Container exists but may not be visible yet (clientHeight 0)
    // Check if it has meaningful content by looking for the title
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

    // Check 1: data-is-live attribute
    if (container.getAttribute("data-is-live") === "true") {
      shouldSkip = true;
      skipReason = "livestream (data-is-live)";
    }

    // Check 2: .ytp-autonav-live-stamp visible
    if (!shouldSkip) {
      const liveStamp = container.querySelector(".ytp-autonav-live-stamp");
      if (liveStamp && liveStamp.textContent.trim()) {
        shouldSkip = true;
        skipReason = "livestream (live stamp)";
      }
    }

    // Check 3: View/date text — "watching" means live, or parse view count
    if (!shouldSkip) {
      const viewDateEl = container.querySelector(
        ".ytp-autonav-view-and-date"
      );
      if (viewDateEl) {
        const viewText = viewDateEl.textContent.trim();
        if (/\bwatching\b/i.test(viewText)) {
          shouldSkip = true;
          skipReason = "livestream (watching)";
        } else {
          const vs = extractViewString(viewText);
          if (vs) {
            const views = parseViewCount(vs);
            if (!isNaN(views) && views < VIEW_THRESHOLD) {
              shouldSkip = true;
              skipReason = `low views (${views.toLocaleString()} < ${VIEW_THRESHOLD.toLocaleString()})`;
            }
          }
        }
      }
    }

    if (!shouldSkip) {
      log("Autoplay: up-next video is OK:", nextTitle);
      return false;
    }

    log("Autoplay: skipping up-next:", nextTitle, "—", skipReason);

    // Find a valid alternative from the sidebar recommendations
    const alternative = findSidebarAlternative();
    if (alternative) {
      log("Autoplay: navigating to alternative:", alternative.title);
      navigateToVideo(alternative.anchor);
      return true;
    }

    log("Autoplay: no valid sidebar alternative found");
    return false;
  }

  /**
   * Find the first sidebar recommendation that passed filtering.
   * Returns { anchor, title } or null.
   */
  function findSidebarAlternative() {
    const secondary =
      document.querySelector("ytd-watch-next-secondary-results-renderer") ||
      document.querySelector("#secondary-inner, #related");
    if (!secondary) return null;

    // Look for items that passed our filter
    const passedItems = secondary.querySelectorAll(
      `ytd-compact-video-renderer[${FILTERED_ATTR}="pass"], yt-lockup-view-model[${FILTERED_ATTR}="pass"]`
    );

    for (const item of passedItems) {
      const anchor = item.querySelector("a[href]");
      if (anchor && anchor.href && anchor.href.includes("/watch")) {
        const title = getVideoTitle(item);
        return { anchor, title };
      }
    }

    return null;
  }

  /**
   * Navigate to a video via its anchor element.
   * Prefers .click() for SPA transition, falls back to location change.
   */
  function navigateToVideo(anchor) {
    const url = anchor.href;
    try {
      anchor.click();
      log("Autoplay: clicked sidebar link for SPA navigation");
      // Verify navigation happened after a short delay
      setTimeout(() => {
        // If we're still on the same page, fall back to location change
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

    // Already attached to this element
    if (video === videoElement && videoEndedBound) return true;

    // Detach from previous element if any
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
   * Polls every 1s for up to 30 seconds, then stops.
   */
  function startVideoPolling() {
    stopVideoPolling();

    if (!location.pathname.startsWith("/watch")) return;

    let elapsed = 0;
    const POLL_INTERVAL = 1000;
    const MAX_POLL_TIME = 30000;

    // Try immediately first
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
   * Watches for attribute changes (data-is-live) and visibility changes.
   */
  function setupAutoplayContainerObserver() {
    teardownAutoplayContainerObserver();

    if (!location.pathname.startsWith("/watch")) return;

    const container = document.querySelector(
      ".ytp-autonav-endscreen-upnext-container"
    );
    if (!container) {
      // Container may not exist yet — try again shortly
      setTimeout(setupAutoplayContainerObserver, 2000);
      return;
    }

    autoplayContainerObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        // Trigger on attribute changes (data-is-live being set, style changes)
        if (
          mutation.type === "attributes" &&
          (mutation.attributeName === "data-is-live" ||
            mutation.attributeName === "style" ||
            mutation.attributeName === "class")
        ) {
          // Check if container is now visible (clientHeight > 0)
          if (container.clientHeight > 0) {
            log("Autoplay: container became visible (attribute change)");
            checkAutoplayAndSkip();
            return;
          }
        }
        // Also trigger on child changes (content being populated)
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

    // Clean up all autoplay state — YouTube creates new video elements on nav
    cleanupAutoplay();

    // Re-scan after a brief delay to let YouTube render new content
    setTimeout(() => {
      scanAndFilter();
      // Start polling for the new video element and set up autoplay interception
      startVideoPolling();
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

    // Start polling for <video> element and set up autoplay interception
    startVideoPolling();

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
