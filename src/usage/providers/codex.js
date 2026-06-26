const { listJsonlFiles, readLinesMatching, expandHome } = require("../file-utils");

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
    statusText = `${reached} · ${latest.rateLimits.limit_name || "子模型"}`;
  } else if (onSubmodel) {
    statusText = `${reached} · 账号总额（更新于 ${acctTime}；子模型使用中暂不变化）`;
  } else {
    statusText = `${reached} · 账号总额（更新于 ${acctTime}）`;
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
