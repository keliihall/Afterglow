const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const { execFile } = require("node:child_process");

// Port of Afterglow_Claude's UsageModel.swift.
//
// Reads the OAuth access token that the Claude desktop app stores
// (Electron safeStorage–encrypted) in config.json, decrypts it with the
// "Claude Safe Storage" macOS keychain key (AES-128-CBC, PBKDF2-SHA1 /
// "saltysalt" / 1003 rounds — the Chromium safeStorage scheme), then calls
// the official `/api/oauth/usage` endpoint — the same data shown in Claude's
// "Plan usage" panel.

const CLAUDE_CONFIG_PATH = path.join(
  os.homedir(),
  "Library/Application Support/Claude/config.json"
);
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

// The safeStorage key is stable for the app's lifetime, so we read the
// keychain at most once per process and cache the derived AES key in memory.
// That means at most one keychain-permission prompt per launch (none after
// "Always Allow"); the periodic refreshes only re-read the free config.json.
let cachedAesKey = null;

function getKeychainPassword() {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Claude Safe Storage", "-w"],
      { timeout: 10000 },
      (error, stdout) => {
        if (error) {
          reject(new Error("无法读取钥匙串 (Claude Safe Storage)"));
          return;
        }
        resolve(stdout.replace(/\n$/, ""));
      }
    );
  });
}

async function derivedKey() {
  if (cachedAesKey) return cachedAesKey;
  const password = await getKeychainPassword();
  cachedAesKey = crypto.pbkdf2Sync(
    Buffer.from(password, "utf8"),
    Buffer.from("saltysalt", "utf8"),
    1003,
    16,
    "sha1"
  );
  return cachedAesKey;
}

function decryptSafeStorage(b64, key) {
  const raw = Buffer.from(b64, "base64");
  if (raw.length <= 3) return null;
  const prefix = raw.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") return null;
  const cipher = raw.subarray(3);
  const iv = Buffer.alloc(16, 0x20); // 16 spaces, as in Chromium safeStorage
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    return Buffer.concat([decipher.update(cipher), decipher.final()]);
  } catch {
    return null;
  }
}

function extractCreds(config, key) {
  for (const cacheKey of ["oauth:tokenCacheV2", "oauth:tokenCache"]) {
    const enc = config[cacheKey];
    if (typeof enc !== "string") continue;
    const plain = decryptSafeStorage(enc, key);
    if (!plain) continue;
    let cache;
    try {
      cache = JSON.parse(plain.toString("utf8"));
    } catch {
      continue;
    }
    if (!cache || typeof cache !== "object") continue;

    // Prefer the entry whose composite key includes the claude_code scope.
    let fallback = null;
    for (const [compositeKey, value] of Object.entries(cache)) {
      if (!value || typeof value.token !== "string") continue;
      const tier = value.subscriptionType || "";
      if (compositeKey.includes("claude_code")) {
        return { token: value.token, tier };
      }
      if (!fallback) fallback = { token: value.token, tier };
    }
    if (fallback) return fallback;
  }
  return null;
}

async function loadCreds() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CLAUDE_CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }

  let key = await derivedKey();
  let creds = extractCreds(config, key);
  if (creds) return creds;

  // Cached key may be stale (app reinstalled / key rotated) — refresh once.
  cachedAesKey = null;
  key = await derivedKey();
  return extractCreds(config, key);
}

function fetchUsage(token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      USAGE_ENDPOINT,
      {
        method: "GET",
        timeout: 15000,
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
          "User-Agent": "claude-cli/2.1.187 (external, cli)"
        }
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    req.end();
  });
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toIso(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function windowFromLimit(id, label, usedPercent, resetsAt, severity, isActive) {
  const used = asNumber(usedPercent);
  const remaining = used === null ? null : Math.max(0, 100 - used);
  return {
    id,
    label,
    status: "ok",
    sourceType: "direct",
    usedPercent: used,
    remainingPercent: remaining,
    resetsAt: toIso(resetsAt),
    severity: severity || "normal",
    isActive: Boolean(isActive)
  };
}

// Translate the `/api/oauth/usage` payload into our window shape. Prefer the
// structured `limits` array (session = 5h, weekly_all = 1w, weekly_scoped =
// per-model); fall back to the named windows when `limits` is absent.
function parseUsage(obj, { showScoped }) {
  const windows = [];
  const limits = Array.isArray(obj.limits) ? obj.limits : null;

  if (limits) {
    for (const limit of limits) {
      const kind = limit.kind || "";
      const pct = asNumber(limit.percent) ?? 0;
      const sev = limit.severity || "normal";
      const active = Boolean(limit.is_active);
      const reset = limit.resets_at;
      if (kind === "session") {
        windows.push(windowFromLimit("5h", "5h", pct, reset, sev, active));
      } else if (kind === "weekly_all") {
        windows.push(windowFromLimit("1w", "1w", pct, reset, sev, active));
      } else if (kind === "weekly_scoped" && showScoped && pct > 0) {
        const model =
          limit.scope?.model?.display_name || "scoped";
        windows.push(
          windowFromLimit(`scoped-${model}`, model, pct, reset, sev, active)
        );
      }
    }
  }

  if (windows.length === 0) {
    const named = (key, id, label) => {
      const w = obj[key];
      const util = w && asNumber(w.utilization);
      if (util === null || util === undefined) return;
      windows.push(windowFromLimit(id, label, util, w.resets_at, "normal", id === "5h"));
    };
    named("five_hour", "5h", "5h");
    named("seven_day", "1w", "1w");
  }

  // Always expose 5h and 1w slots so the UI has a stable layout.
  const ensure = (id, label) => {
    if (!windows.some((w) => w.id === id)) {
      windows.unshift({ id, label, status: "missing", remainingPercent: null });
    }
  };
  ensure("1w", "1w");
  ensure("5h", "5h");
  // Keep 5h, 1w first; scoped windows after.
  windows.sort((a, b) => {
    const order = { "5h": 0, "1w": 1 };
    return (order[a.id] ?? 2) - (order[b.id] ?? 2);
  });

  return windows;
}

// `/api/oauth/usage` is rate-limited behind Cloudflare — a per-account budget we
// also share with the Claude desktop app + CLI — so we poll it conservatively:
//   * throttle network calls to at most once per `minRefreshSeconds`, anchored
//     to the last ATTEMPT (success or failure), so a failing poll is spaced the
//     same as a healthy one instead of being retried on every Codex tick;
//   * on a 429, exponentially back off (with jitter, honoring Retry-After) so an
//     active rate limit actually recovers instead of being hammered;
//   * coalesce concurrent callers (launch / multi-display / renderer) into a
//     single in-flight request;
//   * on any failure keep showing the last good numbers as "stale" (amber).
const DEFAULT_MIN_REFRESH_SECONDS = 90;
const STALE_MAX_MS = 30 * 60 * 1000; // keep showing cached data for up to 30 min
const BACKOFF_BASE_MS = 60 * 1000; // backoff after the first 429
const BACKOFF_CAP_MS = 15 * 60 * 1000; // max spacing between 429 retries

let lastGood = null; // { windows, planType, at } — last successful reading
let lastAttemptAt = 0; // last network attempt (success or failure)
let lastAttemptOk = false; // did the last attempt succeed?
let nextAllowedAt = 0; // earliest next attempt after a 429 backoff
let consecutive429 = 0; // consecutive 429 count, drives the backoff
let inFlight = null; // shared promise while a request is in progress

function provider(extra) {
  return { id: "claude", label: "Claude", ...extra };
}

// Reuse the cached reading, flagged according to why we're not fetching fresh.
function fromCache(status, statusText) {
  return provider({
    status,
    statusText,
    sourceType: "direct",
    source: USAGE_ENDPOINT,
    planType: lastGood.planType || null,
    updatedAt: new Date(lastGood.at).toISOString(),
    fromCache: true,
    windows: lastGood.windows
  });
}

// Degrade to cached data when it's still recent; otherwise report the failure.
// The UI shows staleness via amber numbers + the badge color, so statusText
// stays short — it's only surfaced on hover.
function degraded(statusText) {
  if (lastGood && Date.now() - lastGood.at < STALE_MAX_MS) {
    return fromCache("stale", statusText);
  }
  return provider({ status: "error", statusText, windows: [] });
}

function missingWindows() {
  return [
    { id: "5h", label: "5h", status: "missing" },
    { id: "1w", label: "1w", status: "missing" }
  ];
}

// Retry-After in ms, only when the server gives a useful (> 0) value. The
// observed 429 carries `retry-after: 0`, which we treat as "no guidance".
function retryAfterMs(headers) {
  const seconds = parseInt(headers && headers["retry-after"], 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

// Exponential backoff with full jitter after a 429: ~60s, 120s, 240s … capped at
// 15min, never below a server-provided Retry-After. Jitter avoids syncing with
// the Claude desktop app's own polling of the same endpoint.
function applyBackoff(now, headers) {
  consecutive429 += 1;
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (consecutive429 - 1));
  const jittered = base / 2 + Math.random() * (base / 2);
  nextAllowedAt = now + Math.max(jittered, retryAfterMs(headers));
}

// The network round-trip — only ever reached through the single-flight gate.
// `lastAttemptOk` is updated only when the attempt COMPLETES (via finally), so
// a concurrent caller served from the throttle gate sees the last *completed*
// outcome rather than a transient "in progress" one.
async function fetchAndStore(config, now) {
  lastAttemptAt = now;
  let ok = false;
  try {
    const showScoped = config.showScoped !== false;

    let creds;
    try {
      creds = await loadCreds();
    } catch (error) {
      return degraded(error.message || "读取失败");
    }

    if (!creds) {
      if (lastGood && now - lastGood.at < STALE_MAX_MS) {
        return fromCache("stale", "未找到 Claude 登录信息");
      }
      return provider({ status: "missing", statusText: "未找到 Claude 登录信息", windows: missingWindows() });
    }

    let response;
    try {
      response = await fetchUsage(creds.token);
    } catch {
      return degraded("网络错误");
    }

    if (response.status === 401 || response.status === 403) {
      return degraded("登录过期，请打开 Claude");
    }

    if (response.status === 429) {
      applyBackoff(now, response.headers);
      return degraded("请求过于频繁(429)");
    }

    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch {
      payload = null;
    }

    if (response.status !== 200 || !payload) {
      return degraded(`数据读取失败(${response.status})`);
    }

    // Success: clear the backoff and refresh the cache.
    consecutive429 = 0;
    nextAllowedAt = 0;
    const windows = parseUsage(payload, { showScoped });
    lastGood = { windows, planType: creds.tier || null, at: now };
    ok = true;

    return provider({
      status: "ok",
      statusText: "正常",
      sourceType: "direct",
      source: USAGE_ENDPOINT,
      planType: creds.tier || null,
      updatedAt: new Date(now).toISOString(),
      windows
    });
  } finally {
    lastAttemptOk = ok;
  }
}

async function getClaudeUsage(config = {}) {
  if (config.enabled === false) {
    return provider({ status: "disabled", statusText: "已关闭", windows: [] });
  }

  const minRefreshSeconds = Number(config.minRefreshSeconds);
  const minRefreshMs =
    (Number.isFinite(minRefreshSeconds)
      ? Math.max(0, minRefreshSeconds)
      : DEFAULT_MIN_REFRESH_SECONDS) * 1000;
  const now = Date.now();

  // 1) Backoff gate: after a 429, don't touch the network until nextAllowedAt —
  //    keep showing the cached numbers as stale (amber) in the meantime.
  if (now < nextAllowedAt) {
    return lastGood && now - lastGood.at < STALE_MAX_MS
      ? fromCache("stale", "请求过于频繁，已自动降低刷新")
      : degraded("请求过于频繁(429)");
  }

  // 2) Throttle gate: at most one network ATTEMPT per minRefreshSeconds. Inside
  //    the window, serve the cache (or a loading placeholder before first data).
  if (lastAttemptAt && now - lastAttemptAt < minRefreshMs) {
    if (lastGood) {
      return fromCache(lastAttemptOk ? "ok" : "stale", lastAttemptOk ? "正常" : "数据偏旧");
    }
    return provider({ status: "missing", statusText: "加载中…", windows: missingWindows() });
  }

  // 3) Single-flight: collapse concurrent cold calls (launch / multi-display /
  //    renderer usage:get) into one request.
  if (inFlight) return inFlight;
  inFlight = fetchAndStore(config, now).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

module.exports = {
  getClaudeUsage
};
