/**
 * ContextLens – Content Script
 * Handles: text selection detection, Shadow DOM Ghost Popup lifecycle.
 */

(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────────────────
  // STATE
  // ─────────────────────────────────────────────────────────────────────────

  let popupHost   = null;  // The <div> appended to document.body
  let shadowRoot  = null;  // The shadow root
  let activePopup = null;  // The inner popup element inside the shadow
  let selectionTimer = null;

  const SELECTION_DELAY_MS = 350; // Wait for the user to finish selecting

  // ─────────────────────────────────────────────────────────────────────────
  // POPUP STYLESHEET (injected into Shadow DOM)
  // ─────────────────────────────────────────────────────────────────────────

  const POPUP_CSS = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :host {
      all: initial;
      position: absolute;
      top: 0; left: 0;
      z-index: 2147483647;
      pointer-events: none;
    }

    #cl-popup {
      --cl-bg:       #1e1e2e;
      --cl-border:   #45475a;
      --cl-text:     #cdd6f4;
      --cl-muted:    #6c7086;
      --cl-accent:   #89b4fa;
      --cl-success:  #a6e3a1;
      --cl-warning:  #f9e2af;
      --cl-error:    #f38ba8;
      --cl-category-bg: #313244;
      --cl-radius:   10px;
      --cl-shadow:   0 8px 32px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.4);

      position: absolute;
      font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.55;
      color: var(--cl-text);
      background: var(--cl-bg);
      border: 1px solid var(--cl-border);
      border-radius: var(--cl-radius);
      box-shadow: var(--cl-shadow);
      padding: 0;
      width: 280px;
      max-width: 90vw;
      pointer-events: all;
      overflow: hidden;
      transform-origin: top left;
      animation: cl-appear 0.18s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }

    @keyframes cl-appear {
      from { opacity: 0; transform: scale(0.88) translateY(-6px); }
      to   { opacity: 1; transform: scale(1)    translateY(0);    }
    }

    .cl-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 9px 12px 8px;
      background: #181825;
      border-bottom: 1px solid var(--cl-border);
      gap: 8px;
    }

    .cl-logo {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      color: var(--cl-accent);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      user-select: none;
    }

    .cl-logo-icon {
      width: 14px; height: 14px;
      fill: var(--cl-accent);
    }

    .cl-category {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 2px 7px;
      border-radius: 20px;
      background: var(--cl-category-bg);
      color: var(--cl-accent);
      user-select: none;
    }

    .cl-category.tech     { color: #89b4fa; }
    .cl-category.medical  { color: #a6e3a1; }
    .cl-category.legal    { color: #f9e2af; }
    .cl-category.history  { color: #cba6f7; }
    .cl-category.general  { color: #89dceb; }

    .cl-selected-text {
      padding: 8px 12px 0;
      font-size: 11px;
      font-weight: 600;
      color: var(--cl-muted);
      letter-spacing: 0.02em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .cl-selected-text span {
      color: var(--cl-text);
      font-style: italic;
    }

    .cl-body {
      padding: 8px 12px 12px;
    }

    .cl-explanation {
      color: var(--cl-text);
      font-size: 13px;
      line-height: 1.6;
    }

    /* Loading State */
    .cl-skeleton {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px 12px 12px;
    }

    .cl-skeleton-line {
      height: 10px;
      border-radius: 4px;
      background: linear-gradient(90deg, #313244 25%, #45475a 50%, #313244 75%);
      background-size: 200% 100%;
      animation: cl-shimmer 1.4s infinite;
    }

    .cl-skeleton-line:nth-child(2) { width: 75%; }
    .cl-skeleton-line:nth-child(3) { width: 50%; }

    @keyframes cl-shimmer {
      0%   { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    /* Error State */
    .cl-error-msg {
      padding: 10px 12px;
      color: var(--cl-error);
      font-size: 12px;
    }

    /* Divider */
    .cl-divider {
      height: 1px;
      background: var(--cl-border);
      margin: 0 12px 8px;
    }

    /* Close button */
    .cl-close {
      width: 18px; height: 18px;
      border-radius: 50%;
      border: none;
      background: transparent;
      color: var(--cl-muted);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      padding: 0;
      transition: background 0.15s, color 0.15s;
      flex-shrink: 0;
    }

    .cl-close:hover {
      background: #313244;
      color: var(--cl-text);
    }

    .cl-close svg {
      width: 10px; height: 10px;
      fill: currentColor;
    }

    /* Footer */
    .cl-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding: 5px 10px 7px;
      background: #181825;
      border-top: 1px solid var(--cl-border);
      gap: 6px;
    }

    .cl-footer-model {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.03em;
      color: var(--cl-muted);
      background: rgba(255,255,255,0.05);
      padding: 1px 6px;
      border-radius: 20px;
      user-select: none;
    }

    .cl-footer-brand {
      margin-left: auto;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: var(--cl-accent);
      opacity: 0.75;
      user-select: none;
    }

    .cl-pulse {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--cl-success);
      animation: cl-pulse 1.8s ease-in-out infinite;
    }

    @keyframes cl-pulse {
      0%, 100% { opacity: 1;   transform: scale(1);   }
      50%       { opacity: 0.4; transform: scale(0.7); }
    }
  `;

  // ─────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  /** Extract the nearest meaningful surrounding sentence from the parent element. */
  function getSurroundingSentence(selection) {
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const parentEl  = container.nodeType === Node.TEXT_NODE
      ? container.parentElement
      : container;

    const fullText = parentEl?.textContent ?? "";

    // Trim to a reasonable length to avoid huge prompts
    const start = Math.max(0, fullText.indexOf(selection.toString()) - 120);
    const end   = Math.min(fullText.length, start + 280);

    return fullText.slice(start, end).replace(/\s+/g, " ").trim();
  }

  /** Position the popup near the selection without overflowing the viewport. */
  function computePopupPosition(selectionRect) {
    const GAP      = 8;
    const POP_W    = 288;
    const POP_H    = 140; // Estimated
    const vpW      = window.innerWidth;
    const vpH      = window.innerHeight;
    const scrollX  = window.scrollX;
    const scrollY  = window.scrollY;

    // Center horizontally relative to the selected text
    let left = selectionRect.left + scrollX + (selectionRect.width / 2) - (POP_W / 2);
    let top  = selectionRect.bottom + scrollY + GAP;

    // Flip above if not enough room below
    if (selectionRect.bottom + POP_H + GAP > vpH) {
      top = selectionRect.top + scrollY - POP_H - GAP;
    }

    // Keep within horizontal bounds
    if (left + POP_W > vpW + scrollX) {
      left = vpW + scrollX - POP_W - 8;
    }
    if (left < scrollX + 8) left = scrollX + 8;

    return { top, left };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SHADOW DOM CONSTRUCTION
  // ─────────────────────────────────────────────────────────────────────────

  function createPopupHost() {
    popupHost  = document.createElement("div");
    popupHost.setAttribute("id", "context-lens-root");

    shadowRoot = popupHost.attachShadow({ mode: "closed" });

    // Inject styles into shadow DOM
    const style = document.createElement("style");
    style.textContent = POPUP_CSS;
    shadowRoot.appendChild(style);

    document.body.appendChild(popupHost);
  }

  function buildPopupDOM(selectedText, state = "loading") {
    const popup = document.createElement("div");
    popup.id = "cl-popup";
    popup.setAttribute("role",       "tooltip");
    popup.setAttribute("aria-live",  "polite");
    popup.setAttribute("aria-label", "ContextLens explanation");

    popup.innerHTML = `
      <div class="cl-header">
        <span class="cl-logo">
          <svg class="cl-logo-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5C21.27 7.61 17 4.5 12 4.5zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
          </svg>
          ContextLens
        </span>
        <span class="cl-category general" id="cl-cat">···</span>
        <button class="cl-close" id="cl-close-btn" aria-label="Close explanation" title="Close">
          <svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>
        </button>
      </div>
      <div class="cl-selected-text">Explaining: <span id="cl-sel-preview"></span></div>
      <div id="cl-content"></div>
      <div class="cl-footer">
        <div class="cl-pulse" id="cl-pulse"></div>
        <span class="cl-footer-model" id="cl-model-label">Querying…</span>
        <span class="cl-footer-brand">Developed Under MineLabs</span>
      </div>
    `;

    // Set the selected text preview (truncated)
    const preview = selectedText.length > 28
      ? selectedText.slice(0, 28) + "…"
      : selectedText;
    popup.querySelector("#cl-sel-preview").textContent = `"${preview}"`;

    renderLoadingState(popup);
    return popup;
  }

  function renderLoadingState(popup) {
    const content = popup.querySelector("#cl-content");
    content.innerHTML = `
      <div class="cl-skeleton">
        <div class="cl-skeleton-line"></div>
        <div class="cl-skeleton-line"></div>
        <div class="cl-skeleton-line"></div>
      </div>
    `;
  }

  function renderResult(popup, { category, explanation }, modelLabel) {
    const catEl = popup.querySelector("#cl-cat");
    const catKey = (category ?? "General").toLowerCase();

    catEl.textContent = category ?? "General";
    catEl.className   = `cl-category ${catKey}`;

    // Stop pulse when result is in
    const pulse = popup.querySelector("#cl-pulse");
    if (pulse) {
      pulse.style.animation = "none";
      pulse.style.background = "#a6e3a1";
    }

    // Update footer with the model that answered
    const modelLabelEl = popup.querySelector("#cl-model-label");
    if (modelLabelEl && modelLabel) {
      modelLabelEl.textContent = modelLabel;
    }

    const content = popup.querySelector("#cl-content");
    content.innerHTML = "";

    const div = document.createElement("div");
    div.className = "cl-body";

    const p = document.createElement("p");
    p.className   = "cl-explanation";
    p.textContent = explanation; // textContent – no XSS risk
    div.appendChild(p);
    content.appendChild(div);
  }

  function renderError(popup, message) {
    const content = popup.querySelector("#cl-content");
    content.innerHTML = "";

    const div = document.createElement("div");
    div.className    = "cl-error-msg";
    div.textContent  = `⚠ ${message}`;
    content.appendChild(div);

    // Stop pulse
    const pulse = popup.querySelector("#cl-pulse");
    if (pulse) {
      pulse.style.animation = "none";
      pulse.style.background = "#f38ba8";
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POPUP LIFECYCLE
  // ─────────────────────────────────────────────────────────────────────────

  function showPopup(selectedText, selectionRect, surroundingSentence) {
    destroyPopup();

    if (!popupHost) createPopupHost();

    const { top, left } = computePopupPosition(selectionRect);

    activePopup = buildPopupDOM(selectedText);
    activePopup.style.top  = `${top}px`;
    activePopup.style.left = `${left}px`;

    shadowRoot.appendChild(activePopup);

    // Close button
    activePopup.querySelector("#cl-close-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      destroyPopup();
    });

    // Fire API request
    chrome.runtime.sendMessage(
      { action: "EXPLAIN_TEXT", payload: { selectedText, surroundingSentence } },
      (response) => {
        if (chrome.runtime.lastError) {
          if (activePopup) renderError(activePopup, "Extension context unavailable. Reload the page.");
          return;
        }
        if (!activePopup) return; // dismissed before response arrived
        if (response?.error) {
          renderError(activePopup, response.error);
        } else {
          renderResult(activePopup, response.result, response.modelLabel);
        }
      }
    );
  }

  function destroyPopup() {
    if (activePopup) {
      activePopup.remove();
      activePopup = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SELECTION DETECTION
  // ─────────────────────────────────────────────────────────────────────────

  // Track last API call time to avoid hitting free-tier rate limits
  let lastRequestTime = 0;
  const REQUEST_COOLDOWN_MS = 2500; // min 2.5s between API calls

  /**
   * Returns true if the event originated INSIDE our Shadow DOM popup.
   * Uses composedPath() which correctly crosses shadow boundaries.
   * popupHost.contains(e.target) is broken for shadow DOM — the browser
   * retargets e.target to the shadow host itself, making contains() always true.
   */
  function isEventInsidePopup(e) {
    if (!popupHost) return false;
    const path = e.composedPath ? e.composedPath() : [];
    return path.includes(popupHost);
  }

  function handleMouseUp(e) {
    // Ignore mouseup inside our shadow DOM popup
    if (isEventInsidePopup(e)) return;

    if (selectionTimer) clearTimeout(selectionTimer);

    selectionTimer = setTimeout(() => {
      const selection = window.getSelection();
      const text      = selection?.toString().trim() ?? "";

      if (!text || text.length < 2 || text.length > 500) {
        // Short or no selection — don't show popup; but don't hide if already shown
        return;
      }

      if (!selection.rangeCount) return;

      let selectionRect;
      try {
        selectionRect = selection.getRangeAt(0).getBoundingClientRect();
      } catch {
        return;
      }

      // If the rect is zero-size, skip
      if (selectionRect.width === 0 && selectionRect.height === 0) return;

      const surroundingSentence = getSurroundingSentence(selection);

      // Throttle: prevent burst requests that exhaust free-tier rate limits
      const now = Date.now();
      if (now - lastRequestTime < REQUEST_COOLDOWN_MS) {
        console.log(`[ContextLens] Throttled — ${Math.ceil((REQUEST_COOLDOWN_MS - (now - lastRequestTime)) / 1000)}s cooldown remaining.`);
        return;
      }
      lastRequestTime = now;

      showPopup(text, selectionRect, surroundingSentence);
    }, SELECTION_DELAY_MS);
  }

  function handleDocumentClick(e) {
    if (!activePopup) return;
    // Use composedPath() to correctly detect clicks inside Shadow DOM.
    // popupHost.contains() fails because browser retargets shadow events to the host.
    if (!isEventInsidePopup(e)) {
      destroyPopup();
    }
  }

  function handleSelectionClear(e) {
    const selection = window.getSelection();
    if (!selection || !selection.toString().trim()) {
      // User may have cleared selection — handled by mouseup instead
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // KEYBOARD ACCESSIBILITY
  // ─────────────────────────────────────────────────────────────────────────

  function handleKeydown(e) {
    if (e.key === "Escape" && activePopup) {
      destroyPopup();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EVENT REGISTRATION  (using requestIdleCallback for non-critical setup)
  // ─────────────────────────────────────────────────────────────────────────

  function register() {
    document.addEventListener("mouseup",  handleMouseUp,      { passive: true });
    document.addEventListener("mousedown", handleDocumentClick, { passive: true });
    document.addEventListener("keydown",  handleKeydown,      { passive: true });
  }

  if ("requestIdleCallback" in window) {
    requestIdleCallback(register, { timeout: 2000 });
  } else {
    register();
  }

})();
