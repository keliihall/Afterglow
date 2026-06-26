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
      (error, stdout, stderr) => {
        if (error) {
          // Distinguish "Claude never created the key here" from "the user hasn't
          // allowed us to read it yet" — they need different actions.
          const msg = /could not be found|SecItemNotFound/i.test(stderr || "")
            ? "未检测到 Claude 密钥（请先安装并登录 Claude 桌面端）"
            : "钥匙串访问被拒绝（首次启动请在弹窗点“始终允许”）";
          reject(new Error(msg));
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

function expiryMs(value) {
  if (value == null) return Infinity; // no expiry field → don't treat as expired
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : Infinity;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return Infinity;
  return n > 1e12 ? n : n * 1000; // seconds vs ms
}

// The token cache can hold SEVERAL entries (different sessions/scopes), and when
// Claude rotates its token it may add a new entry while leaving the old one —
// returning the first `claude_code` entry could hand back a stale, server-
// invalidated token (→ 401 "登录过期" even though Claude is running). So collect
// every entry across V2 + V1 and pick the best: not-expired first, then the
// claude_code scope, then the furthest expiry.
function extractCreds(config, key) {
  const now = Date.now();
  const candidates = [];
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

    for (const [compositeKey, value] of Object.entries(cache)) {
      if (!value || typeof value.token !== "string") continue;
      candidates.push({
        token: value.token,
        tier: value.subscriptionType || "",
        isClaudeCode: compositeKey.includes("claude_code"),
        expMs: expiryMs(value.expiresAt ?? value.expires_at),
        v2: cacheKey === "oauth:tokenCacheV2"
      });
    }
  }
  if (candidates.length === 0) return null;

  const SKEW_MS = 60 * 1000; // treat tokens expiring within a minute as expired
  const fresh = candidates.filter((c) => c.expMs > now + SKEW_MS);
  // Prefer a valid pool; if everything looks expired, still try the freshest.
  const pool = fresh.length ? fresh : candidates;
  pool.sort(
    (a, b) =>
      Number(b.isClaudeCode) - Number(a.isClaudeCode) ||
      b.expMs - a.expMs ||
      Number(b.v2) - Number(a.v2)
  );
  const best = pool[0];
  return { token: best.token, tier: best.tier, expired: best.expMs <= now + SKEW_MS };
}

async function loadCreds() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CLAUDE_CONFIG_PATH, "utf8"));
  } catch {
    // No Claude config on this machine at all — the desktop app isn't installed
    // or has never been signed in. Throw a clear, actionable reason rather than
    // a generic null so the widget can show *why* instead of "加载中…".
    throw new Error("未检测到 Claude 桌面端（请先安装并登录）");
  }

  let key = await derivedKey(); // keychain errors propagate with their own message
  let creds = extractCreds(config, key);
  if (creds) return creds;

  // Cached key may be stale (app reinstalled / key rotated) — refresh once.
  cachedAesKey = null;
  key = await derivedKey();
  creds = extractCreds(config, key);
  if (creds) return creds;

  throw new Error("Claude 登录信息为空（请重新登录 Claude）");
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
const DEFAULT_MIN_REFRESH_SECONDS = 120; // 起始下限：高于 90s 以贴近账号可持续读取速率
const STALE_MAX_MS = 30 * 60 * 1000; // keep showing cached data for up to 30 min
const BACKOFF_BASE_MS = 60 * 1000; // backoff after the first 429
const BACKOFF_CAP_MS = 15 * 60 * 1000; // max spacing between 429 retries

// 自适应节流：429 后增大间隔并【跨成功保留】，多次成功后才小幅回探，使读取频率
// 收敛到刚好高于服务端（与 Claude 桌面端共享的）可持续速率，消除"成功/429"来回抖动。
const ADAPTIVE_GROW = 1.6; // 每次 429 间隔放大系数
const ADAPTIVE_DECAY = 0.9; // 连续多次成功后小幅回探系数
const DECAY_AFTER_OK = 3; // 连续成功多少次才回探一次
// 仅当【连续】读取失败达到该次数才把数字显示为陈旧(琥珀)；单次抖动仍按正常色显示缓存值。
const STALE_AMBER_AFTER_FAILURES = 2;

let lastGood = null; // { windows, planType, at } — last successful reading
let lastAttemptAt = 0; // last network attempt (success or failure)
let lastAttemptOk = false; // did the last attempt succeed?
let nextAllowedAt = 0; // earliest next attempt after a 429 backoff
let consecutive429 = 0; // consecutive 429 count, drives the backoff
let consecutiveFailures = 0; // 连续读取失败次数（任何失败）；成功清零，驱动颜色规则
let consecutiveOk = 0; // 连续成功次数，驱动间隔回探
let adaptiveMinMs = 0; // 当前自适应最小读取间隔（>= floorMs），跨成功保留
let floorMs = DEFAULT_MIN_REFRESH_SECONDS * 1000; // 配置给定的间隔下限（每次调用刷新）
let inFlight = null; // shared promise while a request is in progress
let lastErrorText = null; // reason of the last failed attempt; shown instead of "加载中…" when there's no cache yet

// 单次抖动不变色：连续失败未达阈值时仍以"正常(ok)"呈现缓存数据，达到阈值才转"陈旧(stale=琥珀)"。
function colorStatus() {
  return consecutiveFailures >= STALE_AMBER_AFTER_FAILURES ? "stale" : "ok";
}

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
    // Realtime only if the last attempt actually succeeded (a throttled-but-fresh
    // read). After a failure this is cached/stale → drives the orange/red color.
    realtime: lastAttemptOk,
    updatedAt: new Date(lastGood.at).toISOString(),
    fromCache: true,
    windows: lastGood.windows
  });
}

// Degrade to cached data when it's still recent; otherwise report the failure.
// The UI shows staleness via amber numbers + the badge color, so statusText
// stays short — it's only surfaced on hover.
function degraded(statusText) {
  lastErrorText = statusText; // so the throttle gate can show *why*, not "加载中…"
  if (lastGood && Date.now() - lastGood.at < STALE_MAX_MS) {
    // 单次失败不变色：未达连续失败阈值时仍显示为正常(ok)，仅 hover 文案提示原因。
    return fromCache(colorStatus(), statusText);
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
  // 跨成功保留地放大读取间隔，使稳态读取频率收敛到服务端可持续速率之上。
  adaptiveMinMs = Math.min(BACKOFF_CAP_MS, Math.max(adaptiveMinMs, floorMs) * ADAPTIVE_GROW);
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
  // 先按"失败"预记一次（含当前在途读取）；成功时在 finally 清零。这样当前这次失败
  // 也计入连续失败数，使"连续 2 次失败才变色"的判定即时且精确。
  consecutiveFailures += 1;
  let ok = false;
  try {
    const showScoped = config.showScoped !== false;

    let creds;
    try {
      creds = await loadCreds();
    } catch (error) {
      return degraded(error.message || "读取失败");
    }

    let response;
    try {
      response = await fetchUsage(creds.token);
    } catch {
      return degraded("网络错误");
    }

    if (response.status === 401 || response.status === 403) {
      return degraded("登录已过期，请在 Claude 里重新登录");
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

    // Success: clear the 429 backoff. 注意：不再把读取间隔重置到最小值——保留自适应
    // 间隔，仅在连续多次成功后小幅回探（见 finally），避免"成功即恢复 90s → 立刻又 429"。
    consecutive429 = 0;
    nextAllowedAt = 0;
    lastErrorText = null;
    const windows = parseUsage(payload, { showScoped });
    lastGood = { windows, planType: creds.tier || null, at: now };
    ok = true;

    return provider({
      status: "ok",
      statusText: "正常",
      sourceType: "direct",
      source: USAGE_ENDPOINT,
      planType: creds.tier || null,
      realtime: true, // fresh live read → green
      updatedAt: new Date(now).toISOString(),
      windows
    });
  } finally {
    lastAttemptOk = ok;
    if (ok) {
      consecutiveFailures = 0; // 清除入口处的预记失败
      // 连续多次成功后才小幅回探更快的间隔；若回探后又 429，applyBackoff 会再放大。
      consecutiveOk += 1;
      if (consecutiveOk >= DECAY_AFTER_OK) {
        adaptiveMinMs = Math.max(floorMs, (adaptiveMinMs || floorMs) * ADAPTIVE_DECAY);
        consecutiveOk = 0;
      }
    } else {
      consecutiveOk = 0; // 失败已在入口处预记，这里不再重复累加
    }
  }
}

async function getClaudeUsage(config = {}) {
  if (config.enabled === false) {
    return provider({ status: "disabled", statusText: "已关闭", windows: [] });
  }

  const minRefreshSeconds = Number(config.minRefreshSeconds);
  floorMs =
    (Number.isFinite(minRefreshSeconds)
      ? Math.max(0, minRefreshSeconds)
      : DEFAULT_MIN_REFRESH_SECONDS) * 1000;
  // 自适应间隔不低于配置下限；首次或调小配置时同步抬升。
  if (!adaptiveMinMs || adaptiveMinMs < floorMs) adaptiveMinMs = floorMs;
  const now = Date.now();

  // 1) Backoff gate: after a 429, don't touch the network until nextAllowedAt —
  //    期间显示缓存值；是否变琥珀由 colorStatus()（连续失败次数）决定。
  if (now < nextAllowedAt) {
    return lastGood && now - lastGood.at < STALE_MAX_MS
      ? fromCache(colorStatus(), "请求过于频繁，已自动降低刷新")
      : degraded("请求过于频繁(429)");
  }

  // 2) Throttle gate: 至多每 adaptiveMinMs 发起一次网络读取；窗口内提供缓存
  //    （首次出数据前显示加载占位）。
  if (lastAttemptAt && now - lastAttemptAt < adaptiveMinMs) {
    if (lastGood) {
      return fromCache(lastAttemptOk ? "ok" : colorStatus(), lastAttemptOk ? "正常" : "数据偏旧");
    }
    // No good data yet. If the last attempt already failed, surface WHY (e.g.
    // "未检测到 Claude 桌面端" / "钥匙串访问被拒绝") instead of a perpetual
    // "加载中…"; only show the loading placeholder while the first fetch is
    // genuinely still in flight.
    return lastErrorText
      ? provider({ status: "error", statusText: lastErrorText, windows: missingWindows() })
      : provider({ status: "missing", statusText: "加载中…", windows: missingWindows() });
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
