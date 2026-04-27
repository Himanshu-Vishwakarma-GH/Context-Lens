/**
 * ContextLens – Background Service Worker (MV3)
 * Provider : OpenRouter (free-tier only)
 * Strategy : Waterfall fallback — tries PRIMARY model first;
 *            on failure auto-advances to next fallback.
 *            Remembers the last working model so future calls
 *            start there instead of always retrying dead models.
 */

// ─────────────────────────────────────────────────────────────────────────────
// OPENROUTER CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const OR_API_KEY  = "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";
const OR_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * ✅ LIVE-TESTED Free Model Chain (verified working via API on 2026-04-27)
 *
 * Slot 0 – PRIMARY   : Google Gemma 3 27B  — fast, clean format adherence
 * Slot 1 – FALLBACK 1: OpenAI GPT-OSS 120B — highest quality, great reasoning
 * Slot 2 – FALLBACK 2: Ling 2.6 Flash      — lightweight, very fast
 * Slot 3 – FALLBACK 3: Gemma 4 31B         — emergency reserve
 *
 * Models excluded (tested, failing): Llama 3.3 70B (429), Llama 3.1 8B (404),
 * Nemotron 70B (429), MiniMax (404), Nemotron Nano 9B (connection fail),
 * GLM-4.5 (429), Dolphin Mistral (429), LFM Thinking (connection fail).
 */
const MODEL_CHAIN = [
  {
    id:    "google/gemma-3-27b-it:free",
    label: "Gemma 3 27B",
  },
  {
    id:    "openai/gpt-oss-120b:free",
    label: "GPT-OSS 120B",
  },
  {
    id:    "inclusionai/ling-2.6-flash:free",
    label: "Ling 2.6 Flash",
  },
  {
    id:    "google/gemma-4-31b-it:free",
    label: "Gemma 4 31B",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY STATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Index of the model that last succeeded.
 * Persists across calls within the same SW lifetime.
 * Resets to 0 when the service worker restarts.
 */
let activeModelIndex = 0;

const MAX_HISTORY = 100;

// NOTE: Debounce is handled in content_script.js (selectionTimer).
// No setTimeout here — MV3 service workers go idle mid-setTimeout
// which silently drops the sendResponse callback.

// ─────────────────────────────────────────────────────────────────────────────
// INITIALISATION & ACTION
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("history", (data) => {
    if (!data.history) chrome.storage.local.set({ history: [] });
  });
  console.log("[ContextLens] Installed – using OpenRouter free model chain.");
  console.log("[ContextLens] Model chain:", MODEL_CHAIN.map(m => m.label).join(" → "));
});

// Open Dashboard when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({ url: "dashboard.html" });
});

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE ROUTER
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    console.warn("[ContextLens] Blocked message from unknown sender:", sender.id);
    return false;
  }

  const { action, payload } = message;

  switch (action) {
    case "EXPLAIN_TEXT":
      handleExplainText(payload, sender, sendResponse);
      return true; // keep channel open for async response

    case "GET_HISTORY":
      fetchHistory(sendResponse);
      return true;

    case "CLEAR_HISTORY":
      clearHistory(sendResponse);
      return true;

    case "GET_MODEL_STATUS":
      sendResponse({
        models: MODEL_CHAIN.map((m, i) => ({
          label:   m.label,
          active:  i === activeModelIndex,
          index:   i,
        })),
        activeIndex: activeModelIndex,
      });
      return false;

    default:
      sendResponse({ error: "Unknown action" });
      return false;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CORE HANDLER
// ─────────────────────────────────────────────────────────────────────────────

async function handleExplainText({ selectedText, surroundingSentence }, sender, sendResponse) {
  if (!selectedText || selectedText.trim().length < 2) {
    sendResponse({ error: "Selection too short." });
    return;
  }

  try {
    const { result, modelLabel } = await callWithFallback(
      selectedText.trim(),
      surroundingSentence?.trim() ?? ""
    );
    await saveToHistory({
      selectedText,
      surroundingSentence,
      result,
      modelLabel,
      timestamp: Date.now(),
    });
    sendResponse({ result, modelLabel });
  } catch (err) {
    console.error("[ContextLens] All models failed:", err.message);
    sendResponse({ error: err.message });
  }
}

async function fetchHistory(sendResponse) {
  const data = await chrome.storage.local.get("history");
  sendResponse({ history: data.history ?? [] });
}

async function clearHistory(sendResponse) {
  await chrome.storage.local.set({ history: [] });
  sendResponse({ success: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// WATERFALL FALLBACK ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tries models starting from `activeModelIndex`.
 * On success  → saves the winning index as new `activeModelIndex`.
 * On failure  → advances to next model in the chain.
 * If all fail → throws a descriptive error.
 */
async function callWithFallback(selectedText, surroundingSentence) {
  const startIndex = activeModelIndex;
  const total      = MODEL_CHAIN.length;

  // Rotate through: start at current active, wrap around
  for (let offset = 0; offset < total; offset++) {
    const idx   = (startIndex + offset) % total;
    const model = MODEL_CHAIN[idx];

    console.log(`[ContextLens] Trying model [${idx}] ${model.label}…`);

    try {
      const result = await callOpenRouter(model.id, selectedText, surroundingSentence);

      // Remember the winner
      if (activeModelIndex !== idx) {
        console.log(`[ContextLens] Switched active model → [${idx}] ${model.label}`);
        activeModelIndex = idx;
      }

      return { result, modelLabel: model.label };

    } catch (err) {
      const isRetryable = err.retryable === true;
      console.warn(`[ContextLens] Model [${idx}] ${model.label} failed: ${err.message}`);

      // If it's a hard auth/config error, don't bother trying others
      if (err.fatal) throw new Error(err.message);

      // If retryable (rate-limit) and there's a next model, continue
      // Otherwise continue to next model
    }
  }

  throw new Error("All models are currently unavailable. Please try again shortly.");
}

// ─────────────────────────────────────────────────────────────────────────────
// OPENROUTER API CALL
// ─────────────────────────────────────────────────────────────────────────────

async function callOpenRouter(modelId, selectedText, surroundingSentence) {
  const prompt = buildPrompt(selectedText, surroundingSentence);

  const body = {
    model: modelId,
    messages: [
      {
        role:    "system",
        content: "You are a concise vocabulary and concept explainer. Always follow the exact output format given.",
      },
      {
        role:    "user",
        content: prompt,
      },
    ],
    temperature:     0.3,
    max_tokens:      100,
    top_p:           0.85,
  };

  let response;
  try {
    response = await fetch(OR_ENDPOINT, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${OR_API_KEY}`,
        "HTTP-Referer":  "https://github.com/context-lens",
        "X-Title":       "ContextLens",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000) // 12 second timeout before failing over
    });
  } catch (networkErr) {
    // Network failure (offline, DNS, or timeout)
    const err = new Error(networkErr.name === "TimeoutError" ? "Model timed out." : "Network error — check your internet connection.");
    err.retryable = networkErr.name === "TimeoutError"; // If timeout, let it try next model
    err.fatal     = !err.retryable;
    throw err;
  }

  // ── Handle HTTP errors ────────────────────────────────────────────────────
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    const rawMsg  = errBody?.error?.message ?? errBody?.message ?? "";

    const err = new Error(friendlyError(response.status, rawMsg));

    // 429 = rate limited → retryable, try next model
    err.retryable = response.status === 429;
    // 401/403 = bad API key → no point trying other models
    err.fatal     = response.status === 401 || response.status === 403;

    throw err;
  }

  // ── Parse success response ────────────────────────────────────────────────
  const data    = await response.json();
  const rawText = data?.choices?.[0]?.message?.content?.trim() ?? "";

  if (!rawText) {
    const err = new Error("Empty response received.");
    err.retryable = true;
    throw err;
  }

  return parseResponse(rawText);
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT & RESPONSE PARSING
// ─────────────────────────────────────────────────────────────────────────────

function buildPrompt(selectedText, surroundingSentence) {
  return `Explain the highlighted word/phrase: '${selectedText}' within the context of this sentence: '${surroundingSentence}'.
Constraints:
- Maximum 1 sentence.
- Maximum 15 words.
- Tone: Professional and concise.
- Identify Category: Label as [Tech, Medical, Legal, History, or General].
Format your response EXACTLY as (no extra text, no markdown):
[CATEGORY] Explanation sentence here.`;
}

function parseResponse(rawText) {
  // Strip any markdown code fences if model wraps it
  const cleaned = rawText.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim();

  // Expected: [Category] Explanation.
  const match = cleaned.match(/^\[(.+?)\]\s*(.+)/s);
  if (match) {
    return {
      category:    match[1].trim(),
      explanation: match[2].trim().replace(/\s+/g, " "),
    };
  }

  // Fallback: model didn't follow format — use full text
  return { category: "General", explanation: cleaned.slice(0, 120) };
}

// ─────────────────────────────────────────────────────────────────────────────
// ERROR HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function friendlyError(status, rawMsg) {
  if (status === 429)                                   return "Rate limit hit — trying next model…";
  if (status === 401 || status === 403)                 return "Invalid OpenRouter API key.";
  if (status === 402)                                   return "OpenRouter account quota exhausted.";
  if (status >= 500)                                    return "OpenRouter service error — trying next model…";
  if (rawMsg.toLowerCase().includes("context length"))  return "Selection too long for this model.";
  return rawMsg.split(".")[0] || `Request failed (HTTP ${status}).`;
}

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────

async function saveToHistory(entry) {
  const data    = await chrome.storage.local.get("history");
  const history = data.history ?? [];

  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;

  await chrome.storage.local.set({ history });
}
