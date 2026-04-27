/**
 * ContextLens – Dashboard JavaScript
 * Manages: history rendering, search, filtering, stats, copy, clear.
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────────────────────────────────────────

const historyGrid  = document.getElementById("history-grid");
const emptyState   = document.getElementById("empty-state");
const searchInput  = document.getElementById("search-input");
const filterBtn    = document.getElementById("filter-btn");
const filterChips  = document.getElementById("filter-chips");
const clearBtn     = document.getElementById("clear-btn");
const statTotal    = document.getElementById("stat-total");
const statToday    = document.getElementById("stat-today");
const statTopCat   = document.getElementById("stat-top-cat");
const toast        = document.getElementById("toast");

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────

let allHistory   = [];
let activeFilter = "all";
let toastTimer   = null;

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  loadHistory();
  bindEvents();
});

// ─────────────────────────────────────────────────────────────────────────────
// DATA
// ─────────────────────────────────────────────────────────────────────────────

function loadHistory() {
  chrome.runtime.sendMessage({ action: "GET_HISTORY" }, (response) => {
    if (chrome.runtime.lastError) {
      showToast("Could not connect to extension background.");
      return;
    }
    allHistory = response?.history ?? [];
    updateStats(allHistory);
    renderHistory(allHistory);
  });
}

function updateStats(history) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayCount = history.filter(h => h.timestamp >= todayStart.getTime()).length;

  // Tally categories
  const catCounts = {};
  for (const item of history) {
    const cat = (item.result?.category ?? "General").toLowerCase();
    catCounts[cat] = (catCounts[cat] ?? 0) + 1;
  }

  let topCat = "—";
  if (Object.keys(catCounts).length > 0) {
    topCat = Object.entries(catCounts)
      .sort(([, a], [, b]) => b - a)[0][0];
    topCat = topCat.charAt(0).toUpperCase() + topCat.slice(1);
  }

  statTotal.textContent  = history.length;
  statToday.textContent  = todayCount;
  statTopCat.textContent = topCat;
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDERING
// ─────────────────────────────────────────────────────────────────────────────

function renderHistory(history) {
  historyGrid.innerHTML = "";

  if (history.length === 0) {
    emptyState.hidden = false;
    return;
  }

  emptyState.hidden = true;

  history.forEach((item, index) => {
    const card = buildCard(item, index);
    historyGrid.appendChild(card);
  });
}

function buildCard(item, index) {
  const card = document.createElement("article");
  card.className  = "history-card";
  card.setAttribute("role", "listitem");
  card.style.animationDelay = `${index * 30}ms`;

  const category    = item.result?.category    ?? "General";
  const explanation = item.result?.explanation ?? "No explanation available.";
  const selectedText = item.selectedText ?? "";
  const modelLabel   = item.modelLabel ?? "OpenRouter";
  const catKey      = category.toLowerCase();
  const timeStr     = formatTime(item.timestamp);

  card.innerHTML = `
    <div class="card-header">
      <div class="card-selected-text" title="${escapeAttr(selectedText)}">"${escapeHtml(truncate(selectedText, 40))}"</div>
      <span class="card-cat ${catKey}">${escapeHtml(category)}</span>
    </div>
    <p class="card-explanation">${escapeHtml(explanation)}</p>
    <div class="card-footer">
      <span class="card-time">${timeStr}</span>
      <span class="card-model">${escapeHtml(modelLabel)}</span>
      <button class="card-copy" aria-label="Copy explanation" title="Copy explanation">
        <svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
      </button>
    </div>
  `;

  card.querySelector(".card-copy").addEventListener("click", () => {
    navigator.clipboard.writeText(`"${selectedText}" — ${explanation}`)
      .then(() => showToast("Copied to clipboard!"))
      .catch(() => showToast("Copy failed."));
  });

  return card;
}

// ─────────────────────────────────────────────────────────────────────────────
// FILTER & SEARCH
// ─────────────────────────────────────────────────────────────────────────────

function getFilteredHistory() {
  let items = allHistory;

  if (activeFilter !== "all") {
    items = items.filter(h =>
      (h.result?.category ?? "General").toLowerCase() === activeFilter
    );
  }

  const query = searchInput.value.trim().toLowerCase();
  if (query) {
    items = items.filter(h =>
      h.selectedText?.toLowerCase().includes(query) ||
      h.result?.explanation?.toLowerCase().includes(query)
    );
  }

  return items;
}

function applyFilters() {
  const filtered = getFilteredHistory();
  renderHistory(filtered);
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENTS
// ─────────────────────────────────────────────────────────────────────────────

function bindEvents() {
  // Search
  searchInput.addEventListener("input", debounce(applyFilters, 250));

  // Filter toggle button
  filterBtn.addEventListener("click", () => {
    const visible = !filterChips.hidden;
    filterChips.hidden = visible;
    filterBtn.classList.toggle("active", !visible);
  });

  // Filter chips
  filterChips.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      filterChips.querySelectorAll(".chip").forEach(c => c.classList.remove("chip--active"));
      chip.classList.add("chip--active");
      activeFilter = chip.dataset.filter;
      applyFilters();
    });

    chip.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        chip.click();
      }
    });
    chip.setAttribute("tabindex", "0");
    chip.setAttribute("role", "button");
  });

  // Clear all
  clearBtn.addEventListener("click", () => {
    if (!allHistory.length) return;
    if (!confirm("Clear all history? This cannot be undone.")) return;

    chrome.runtime.sendMessage({ action: "CLEAR_HISTORY" }, (response) => {
      if (response?.success) {
        allHistory = [];
        updateStats([]);
        renderHistory([]);
        showToast("History cleared.");
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(str).replace(/[&<>"']/g, c => map[c]);
}

function escapeAttr(str) {
  return String(str).replace(/"/g, "&quot;");
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + "…" : str;
}

function formatTime(ts) {
  if (!ts) return "—";
  const d   = new Date(ts);
  const now = new Date();
  const diffMs  = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffH   = Math.floor(diffMs / 3600000);
  const diffD   = Math.floor(diffMs / 86400000);

  if (diffMin < 1)   return "Just now";
  if (diffMin < 60)  return `${diffMin}m ago`;
  if (diffH   < 24)  return `${diffH}h ago`;
  if (diffD   < 7)   return `${diffD}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2800);
}
