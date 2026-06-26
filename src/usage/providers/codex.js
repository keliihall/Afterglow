const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { listJsonlFiles, readLinesMatching, expandHome } = require("../file-utils");

// ===== 实时账号用量（首选）：驱动 `codex app-server` 的 account/rateLimits/read =====
// 这是 Codex 桌面端/`/status` 获取实时账号 5h·周用量的同款机制（app-server 内部 GET
// /backend-api/wham/usage，并自行处理鉴权与令牌刷新——比我们手搓请求头可靠）。失败则回落到
// 会话日志（日志在仅用子模型期间不含账号事件，会偏旧）。节流 + 缓存以降低 app-server 启动开销。
const LIVE_MIN_MS = 90 * 1000;
const APP_SERVER_TIMEOUT_MS = 15000;

let liveCache = null; // { windows, planType, at }
let liveAttemptAt = 0;
let liveOk = false;
let liveInFlight = null; // 单飞：并发调用共享同一次拉取，避免首屏先回落到旧日志值

// GUI 应用的 PATH 往往不含 /opt/homebrew/bin，需显式定位 codex 可执行文件。
function resolveCodexBin() {
  const candidates = [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(os.homedir(), ".codex/bin/codex")
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "codex";
}

function isLoggedIn() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex/auth.json"), "utf8"));
    return !!(d.tokens && d.tokens.access_token);
  } catch {
    return false;
  }
}

function resetsToIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const ms = n > 1e12 ? n : n * 1000; // 兼容秒/毫秒
  return new Date(ms).toISOString();
}

function liveWindow(id, label, w) {
  if (!w) return { id, label, status: "missing", remainingPercent: null, usedPercent: null };
  const usedRaw = w.usedPercent ?? w.used_percent;
  const used = Number.isFinite(Number(usedRaw)) ? Number(usedRaw) : null;
  return {
    id,
    label,
    status: "ok",
    sourceType: "direct",
    usedPercent: used,
    remainingPercent: used === null ? null : Math.max(0, 100 - used),
    windowMinutes: Number(w.windowDurationMins ?? w.window_minutes ?? w.windowMinutes) || null,
    resetsAt: resetsToIso(w.resetsAt ?? w.resets_at)
  };
}

// 驱动 `codex app-server`（stdio JSON-RPC，行分隔）：initialize → account/rateLimits/read。
// 解析 GetAccountRateLimitsResponse（{ rateLimits, rateLimitsByLimitId }）。任何异常返回 null。
function appServerRateLimits() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolveCodexBin(), ["app-server"], {
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}` }
      });
    } catch {
      resolve(null);
      return;
    }
    let buf = "";
    let done = false;
    let timer;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(val);
    };
    const send = (o) => {
      try {
        child.stdin.write(JSON.stringify(o) + "\n");
      } catch {
        /* ignore */
      }
    };
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result) {
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} });
        } else if (msg.id === 2) {
          finish(msg.result || null);
        }
      }
    });
    timer = setTimeout(() => finish(null), APP_SERVER_TIMEOUT_MS);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "afterglow", version: "0.2.0" } }
    });
  });
}

// 从 GetAccountRateLimitsResponse 取账号总额快照：优先单桶 rateLimits，其次 byLimitId.codex。
function pickAccountSnapshot(result) {
  if (!result || typeof result !== "object") return null;
  const rl = result.rateLimits;
  if (rl && (rl.primary || rl.secondary)) return rl;
  const map = result.rateLimitsByLimitId;
  if (map && typeof map === "object") {
    return (
      map.codex ||
      Object.values(map).find((s) => s && !s.limitName && (s.primary || s.secondary)) ||
      null
    );
  }
  return null;
}

async function doFetchLive() {
  if (!isLoggedIn()) {
    liveOk = false;
    return null;
  }
  const result = await appServerRateLimits();
  const snap = pickAccountSnapshot(result);
  if (!snap || (!snap.primary && !snap.secondary)) {
    liveOk = false;
    return null;
  }
  liveCache = {
    windows: [liveWindow("5h", "5h", snap.primary), liveWindow("1w", "1w", snap.secondary)],
    planType: snap.planType || snap.plan_type || null,
    at: Date.now()
  };
  liveOk = true;
  return liveCache;
}

// 实时拉取账号用量（单飞 + 节流 + 缓存）。
// 单飞关键：首屏多个并发快照调用会共享同一次在途拉取并一起等待其结果，避免某个并发调用
// 在拉取完成前抢先返回旧的【日志】值（93%）造成"先显示旧值、几秒后才跳到正确值"的闪烁。
function fetchLiveUsage() {
  const now = Date.now();
  if (now - liveAttemptAt < LIVE_MIN_MS) {
    if (liveInFlight) return liveInFlight; // 在途则等它，别回落日志
    return Promise.resolve(liveOk ? liveCache : null);
  }
  liveAttemptAt = now;
  liveInFlight = doFetchLive().finally(() => {
    liveInFlight = null;
  });
  return liveInFlight;
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toIsoFromEpochSeconds(value) {
  const seconds = asNumber(value);
  if (seconds === null) return null;
  return new Date(seconds * 1000).toISOString();
}

function windowFromLimit(id, label, limit) {
  if (!limit) {
    return {
      id,
      label,
      status: "missing",
      remainingPercent: null,
      usedPercent: null
    };
  }

  const usedPercent = asNumber(limit.used_percent);
  const remainingPercent = usedPercent === null ? null : Math.max(0, 100 - usedPercent);
  return {
    id,
    label,
    status: "ok",
    sourceType: "direct",
    usedPercent,
    remainingPercent,
    windowMinutes: asNumber(limit.window_minutes),
    resetsAt: toIsoFromEpochSeconds(limit.resets_at)
  };
}

// Codex writes per-pool limit events to the session logs: the ACCOUNT-wide pool
// (limit_id "codex", no model name) and separate per-model pools — e.g.
// "GPT-5.3-Codex-Spark" (limit_id "codex_bengalfox"), which carry their own
// near-empty windows. The number the user cares about (and that Codex's own
// /status shows) is the ACCOUNT limit, so we always display the account pool.
// Sub-model pools are misleading (~100% remaining) and are NOT shown as the
// headline. While you work only on a sub-model, Codex stops emitting account
// events, so the account figure legitimately stays put until the next
// main-model turn — correct, just not advancing (see statusText for freshness).
function isAccountPool(rateLimits) {
  if (!rateLimits) return false;
  if (rateLimits.limit_id && rateLimits.limit_id !== "codex") return false;
  const name = rateLimits.limit_name;
  return name === undefined || name === null || name === "";
}

function extractCodexEvent(entry) {
  if (entry?.type !== "event_msg") return null;
  if (entry?.payload?.type !== "token_count") return null;
  const rateLimits = entry.rate_limits || entry.payload.rate_limits;
  if (!rateLimits) return null;

  const timestamp = Date.parse(entry.timestamp);
  return {
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    isoTimestamp: entry.timestamp,
    isAccount: isAccountPool(rateLimits),
    rateLimits,
    tokenInfo: entry.payload.info || null
  };
}

async function getCodexUsage(config) {
  if (config.enabled === false) {
    return {
      id: "codex",
      label: "Codex",
      status: "disabled",
      statusText: "已关闭",
      windows: []
    };
  }

  // 首选实时账号用量（与 Codex /status 一致，子模型期间也准确）。失败再回落到会话日志。
  if (config.live !== false) {
    let live = null;
    try {
      live = await fetchLiveUsage();
    } catch {
      live = null;
    }
    if (live) {
      return {
        id: "codex",
        label: "Codex",
        status: "ok",
        statusText: "正常 · 账号总额 · 实时",
        sourceType: "direct",
        source: "codex app-server · account/rateLimits/read",
        planType: live.planType,
        accountPool: true,
        realtime: true, // live app-server reading → green
        updatedAt: new Date(live.at).toISOString(),
        windows: live.windows
      };
    }
  }

  const files = listJsonlFiles(config.sessionDir, { maxAgeDays: config.maxAgeDays }).slice(0, config.maxFiles || 80);
  let latestAccount = null; // newest entry for the account-wide limit
  let latestAny = null; // newest entry of any pool (fallback)

  for (const file of files) {
    readLinesMatching(file.path, "\"rate_limits\"", (entry) => {
      const event = extractCodexEvent(entry);
      if (!event) return;
      if (!latestAny || event.timestamp > latestAny.timestamp) {
        latestAny = { ...event, file: file.path };
      }
      if (event.isAccount && (!latestAccount || event.timestamp > latestAccount.timestamp)) {
        latestAccount = { ...event, file: file.path };
      }
    });
  }

  // Prefer the ACCOUNT-wide limit (the number the user wants & Codex /status
  // shows); fall back to the newest of any pool only if no account event exists.
  const latest = latestAccount || latestAny;

  if (!latest) {
    return {
      id: "codex",
      label: "Codex",
      status: "missing",
      statusText: "未找到 Codex rate_limits",
      source: expandHome(config.sessionDir),
      scannedFiles: files.length,
      windows: [
        { id: "5h", label: "5h", status: "missing" },
        { id: "1w", label: "1w", status: "missing" }
      ]
    };
  }

  const primary = latest.rateLimits.primary;
  const secondary = latest.rateLimits.secondary;
  const lastUsage = latest.tokenInfo?.last_token_usage || null;

  // 口径与新鲜度提示（hover 显示）：账号额仅在主模型轮次后更新；用子模型期间它保持
  // 不变（数值正确、但不前进），此时提示"子模型使用中"，避免被误判为卡死。
  const reached = latest.rateLimits.rate_limit_reached_type ? "已触限" : "正常";
  const acctTime = new Date(latest.isoTimestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const onSubmodel = latestAny && latestAccount && latestAny.ts > latestAccount.ts;
  let statusText;
  if (!latest.isAccount) {
    statusText = `${reached} · ${latest.rateLimits.limit_name || "子模型"}（日志）`;
  } else if (onSubmodel) {
    statusText = `${reached} · 账号总额（日志 ${acctTime}·实时不可用，子模型期间偏旧）`;
  } else {
    statusText = `${reached} · 账号总额（日志 ${acctTime}·实时不可用）`;
  }

  return {
    id: "codex",
    label: "Codex",
    status: "ok",
    statusText,
    sourceType: "direct",
    source: latest.file,
    planType: latest.rateLimits.plan_type || null,
    accountPool: latest.isAccount,
    realtime: false, // session-log fallback (非实时) → 颜色按数据新鲜度走橙/红
    updatedAt: latest.isoTimestamp,
    scannedFiles: files.length,
    lastUsage,
    windows: [
      windowFromLimit("5h", "5h", primary),
      windowFromLimit("1w", "1w", secondary)
    ]
  };
}

module.exports = {
  getCodexUsage
};
