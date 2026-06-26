const appEl = document.getElementById("app");
const refreshHostEl = document.getElementById("refreshHost");

function formatPercent(value) {
  if (!Number.isFinite(value)) return "--";
  return `${Math.round(value)}%`;
}

function formatResetTime(iso) {
  if (!iso) return "--";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--";
  const msUntilReset = date.getTime() - Date.now();
  if (msUntilReset >= 24 * 60 * 60 * 1000) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function levelClass(percent) {
  if (!Number.isFinite(percent)) return "danger";
  if (percent <= 15) return "danger";
  if (percent <= 35) return "warn";
  return "";
}

function statusDotClass(status) {
  switch (status) {
    case "ok":
      return "ok";
    case "error":
      return "danger";
    case "disabled":
      return "muted";
    default:
      return "warn";
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
  });
}

// Brand logo for a provider; falls back to the text label if none is known.
function providerLogo(provider) {
  const path = (window.PROVIDER_LOGOS || {})[provider.id];
  const label = escapeHtml(provider.label);
  if (!path) return `<span class="pname">${label}</span>`;
  return `<svg class="logo logo--${provider.id}" viewBox="0 0 24 24" role="img" aria-label="${label}"><title>${label}</title><path fill="currentColor" d="${path}"/></svg>`;
}

function renderMeter(window) {
  const hasValue = Number.isFinite(window?.remainingPercent);
  const remaining = hasValue ? Math.max(0, Math.min(100, window.remainingPercent)) : 0;
  const level = levelClass(hasValue ? remaining : NaN);
  // 仅 5h/1w 为主窗口；其余（如 Claude 的按模型 scoped 窗口）标记为 extra，"小"档隐藏。
  const extra = window?.id === "5h" || window?.id === "1w" ? "" : " meter--extra";
  return `
    <div class="meter${extra}">
      <span class="label">${escapeHtml(window?.label ?? "--")}</span>
      <span class="bar"><span class="fill ${level}" style="--value:${remaining}"></span></span>
      <span class="value">${formatPercent(window?.remainingPercent)}</span>
      <span class="reset"><span>↻</span><span>${formatResetTime(window?.resetsAt)}</span></span>
    </div>`;
}

function renderProvider(provider) {
  const status = statusDotClass(provider.status);
  // The plan badge carries the status color on its border; with no plan (e.g.
  // an error before we know the tier) fall back to a plain status dot.
  const badge = provider.planType
    ? `<span class="plan ${status}">${escapeHtml(provider.planType)}</span>`
    : `<span class="dot ${status}"></span>`;

  // Always show the 5h/1w rows. Rather than spelling out an error in words, the
  // state is conveyed by color: a stale source (cached data, e.g. rate-limited)
  // tints its numbers amber, the badge/dot already carries the status color, and
  // the full reason is available on hover.
  let windows = Array.isArray(provider.windows) ? provider.windows : [];
  if (windows.length === 0) {
    windows = [
      { id: "5h", label: "5h", status: "missing" },
      { id: "1w", label: "1w", status: "missing" }
    ];
  }
  const stale = provider.status === "stale";
  const title = provider.statusText ? ` title="${escapeHtml(provider.statusText)}"` : "";
  // 详情行（仅"大"档显示）：状态/口径/新鲜度文案，平时只在 hover 出现。
  const meta = provider.statusText
    ? `<div class="pmeta">${escapeHtml(provider.statusText)}</div>`
    : "";

  return `
    <section class="provider${stale ? " stale" : ""}"${title}>
      <div class="brand">
        ${providerLogo(provider)}
        ${badge}
      </div>
      <div class="side">
        ${windows.map(renderMeter).join("")}
        ${meta}
      </div>
    </section>`;
}

// Clicking the indicator cycles the auto-refresh interval. 0 = no refresh.
const REFRESH_CYCLE = [10, 30, 60, 0];
let currentRefresh = 0;

function drawRefresh() {
  const off = currentRefresh <= 0;
  refreshHostEl.innerHTML = `
    <button class="refresh ${off ? "off" : ""}" id="refreshBtn"
            title="点击切换刷新间隔（10s / 30s / 60s / off）">
      <span class="ricon">${off ? "⏸" : "↻"}</span>
      <span class="rval">${off ? "off" : `${currentRefresh}s`}</span>
    </button>`;
  document.getElementById("refreshBtn").addEventListener("click", cycleRefresh);
}

// Advance optimistically so rapid clicks chain correctly without waiting for
// the async snapshot round-trip; the next snapshot reconciles the value.
function cycleRefresh() {
  const index = REFRESH_CYCLE.indexOf(currentRefresh);
  currentRefresh = REFRESH_CYCLE[(index + 1) % REFRESH_CYCLE.length];
  drawRefresh();
  requestResize();
  window.usageWidget.setRefresh(currentRefresh);
}

function renderRefresh(snapshot) {
  currentRefresh = Number(snapshot?.refreshSeconds) || 0;
  drawRefresh();
}

function renderSnapshot(snapshot) {
  // 档位驱动 CSS：小/中/大。默认中。
  document.body.dataset.size = snapshot?.size || "medium";
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
  if (providers.length === 0) {
    appEl.innerHTML = `<section class="provider"><div class="note">无可显示内容</div></section>`;
  } else {
    appEl.innerHTML = providers.map(renderProvider).join("");
  }
  renderRefresh(snapshot);
  requestResize();
}

// Tell the main process how tall the card actually is, so the window hugs the
// content (Codex + Claude together need more height than a single source).
function requestResize() {
  requestAnimationFrame(() => {
    const shell = document.querySelector(".shell");
    if (!shell) return;
    const height = Math.ceil(shell.getBoundingClientRect().height);
    if (height > 0) window.usageWidget.resize(height);
  });
}

async function refresh() {
  const snapshot = await window.usageWidget.getUsage();
  renderSnapshot(snapshot);
}

window.usageWidget.onSnapshot(renderSnapshot);
refresh();
