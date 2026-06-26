const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, screen } = require("electron");
const path = require("node:path");
const { loadUsageSnapshot } = require("./usage");
const { loadConfig, saveConfig, CONFIG_FILE } = require("./usage/config");

// Only one instance — a second launch should surface the existing widgets
// instead of spawning a duplicate tray icon and window set.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

const widgetWindows = new Map();
let tray;
let alwaysOnTop = true;
let refreshTimer;
let widgetsVisible = true;

function createTrayIcon() {
  // A monochrome "afterglow" glyph — half-sun setting on the horizon with three
  // rays. Shipped as a black-on-transparent PNG (+ @2x) and flagged as a
  // template image so macOS tints it for the light/dark menu bar (and the
  // selected/blue state) itself. PNG is more reliable in the tray than an SVG
  // data URL; fall back to an inline SVG if the asset can't be loaded.
  const iconPath = path.join(__dirname, "..", "assets", "trayTemplate.png");
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">
        <g fill="#000" stroke="#000" stroke-linecap="round">
          <path d="M9 31 A13 13 0 0 1 35 31 Z" stroke="none"/>
          <rect x="3.5" y="29.7" width="37" height="3.2" rx="1.6" stroke="none"/>
          <line x1="22" y1="16.5" x2="22" y2="9" stroke-width="3.1"/>
          <line x1="11.4" y1="21.4" x2="6.2" y2="16.2" stroke-width="3.1"/>
          <line x1="32.6" y1="21.4" x2="37.8" y2="16.2" stroke-width="3.1"/>
        </g>
      </svg>`;
    image = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  }
  image.setTemplateImage(true);
  return image;
}

const PANEL_WIDTH = 212;
const WINDOW_INSET = 3;
const WINDOW_WIDTH = PANEL_WIDTH + WINDOW_INSET * 2;
const MIN_PANEL_HEIGHT = 40;
const MAX_PANEL_HEIGHT = 360;
const DEFAULT_PANEL_HEIGHT = 120;
const ALWAYS_ON_TOP_LEVEL = "screen-saver";
const ALL_SPACES_OPTIONS = {
  visibleOnFullScreen: true,
  skipTransformProcessType: true
};

const REFRESH_PRESETS = [10, 20, 30, 60, 0];
const refreshLabel = (seconds) => (seconds > 0 ? `${seconds} 秒` : "不刷新");
const DISPLAY_LABELS = { all: "全部显示", codex: "仅 Codex", claude: "仅 Claude" };

function bottomRightBounds(display, windowHeight) {
  const bounds = display.workArea;
  return {
    x: Math.round(bounds.x + bounds.width - WINDOW_WIDTH - 28 + WINDOW_INSET),
    y: Math.round(bounds.y + bounds.height - windowHeight - 72 + WINDOW_INSET)
  };
}

function positionBottomRight(win, display) {
  if (!win || win.isDestroyed()) return;
  const [, height] = win.getSize();
  const { x, y } = bottomRightBounds(display, height);
  win.setPosition(x, y, false);
}

function displayForWindow(win) {
  return screen.getDisplayMatching(win.getBounds());
}

function clampToWorkArea(win, x, y, height) {
  const wa = displayForWindow(win).workArea;
  return {
    x: Math.min(Math.max(x, wa.x), wa.x + wa.width - WINDOW_WIDTH),
    y: Math.min(Math.max(y, wa.y), wa.y + wa.height - height)
  };
}

// Grow/shrink a widget to fit its content WITHOUT yanking it back to the
// corner — anchor the bottom edge so it grows upward, keep the user's x, and
// only nudge it back on screen if it would spill off. A no-op when the height
// is unchanged, so periodic refreshes never disturb a dragged position.
function resizeWidget(win, panelHeight) {
  if (!win || win.isDestroyed() || !Number.isFinite(panelHeight)) return;
  const clamped = Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, Math.round(panelHeight)));
  const windowHeight = clamped + WINDOW_INSET * 2;
  const [, currentHeight] = win.getSize();
  if (currentHeight === windowHeight) return;
  const [x, y] = win.getPosition();
  const anchoredY = y + (currentHeight - windowHeight); // keep bottom edge fixed
  win.setSize(WINDOW_WIDTH, windowHeight, false);
  const { x: nx, y: ny } = clampToWorkArea(win, x, anchoredY, windowHeight);
  win.setPosition(nx, ny, false);
}

// Pull a window back to the bottom-right ONLY if it's (partly) off the work
// area — used after display changes so a dragged widget is left in place.
function ensureOnScreen(win) {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getSize();
  const [x, y] = win.getPosition();
  const wa = displayForWindow(win).workArea;
  const offScreen =
    x < wa.x || y < wa.y || x + w > wa.x + wa.width || y + h > wa.y + wa.height;
  if (offScreen) positionBottomRight(win, displayForWindow(win));
}

function visibleWindows() {
  return Array.from(widgetWindows.values()).filter((win) => !win.isDestroyed());
}

function showAllWidgets() {
  widgetsVisible = true;
  for (const win of visibleWindows()) {
    win.show();
    win.moveTop();
  }
}

function hideAllWidgets() {
  widgetsVisible = false;
  for (const win of visibleWindows()) {
    win.hide();
  }
}

function setWidgetAlwaysOnTop(enabled) {
  alwaysOnTop = enabled;
  for (const win of visibleWindows()) {
    applyWindowSpaceBehavior(win);
  }
}

function applyWindowSpaceBehavior(win) {
  if (!win || win.isDestroyed()) return;
  win.setVisibleOnAllWorkspaces(true, ALL_SPACES_OPTIONS);
  win.setAlwaysOnTop(alwaysOnTop, alwaysOnTop ? ALWAYS_ON_TOP_LEVEL : "normal");
  win.setVisibleOnAllWorkspaces(true, ALL_SPACES_OPTIONS);
}

async function pushSnapshot() {
  const snapshot = await loadUsageSnapshot();
  for (const win of visibleWindows()) {
    win.webContents.send("usage:snapshot", snapshot);
  }
  updateTrayTitle(snapshot);
}

function updateTrayTitle(snapshot) {
  const preferred =
    snapshot.providers.find((provider) => provider.id === "codex") || snapshot.providers[0];
  const primary = preferred?.windows?.find((window) => window.id === "5h");
  if (primary && Number.isFinite(primary.remainingPercent)) {
    tray?.setToolTip(`余晖 Afterglow  ${preferred.label} 5h 剩余 ${Math.round(primary.remainingPercent)}%`);
    return;
  }
  tray?.setToolTip("余晖 Afterglow");
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  const config = loadConfig();
  const seconds = Number(config.refreshSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return; // "不刷新"
  refreshTimer = setInterval(pushSnapshot, Math.max(5, seconds) * 1000);
}

// Merge a partial change into config.json, then re-apply timer + UI.
function updateConfig(patch) {
  const current = loadConfig();
  const next = saveConfig({ ...current, ...patch });
  scheduleRefresh();
  tray?.setContextMenu(buildTrayMenu());
  pushSnapshot();
  return next;
}

function buildTrayMenu() {
  const config = loadConfig();
  return Menu.buildFromTemplate([
    {
      label: "显示/隐藏",
      click: () => {
        const shouldHide = visibleWindows().some((win) => win.isVisible());
        if (shouldHide) {
          hideAllWidgets();
        } else {
          showAllWidgets();
        }
      }
    },
    { label: "立即刷新", click: pushSnapshot },
    { type: "separator" },
    {
      label: "显示内容",
      submenu: Object.entries(DISPLAY_LABELS).map(([mode, label]) => ({
        label,
        type: "radio",
        checked: config.display === mode,
        click: () => updateConfig({ display: mode })
      }))
    },
    {
      label: "刷新间隔",
      submenu: REFRESH_PRESETS.map((seconds) => ({
        label: refreshLabel(seconds),
        type: "radio",
        checked: Number(config.refreshSeconds) === seconds,
        click: () => updateConfig({ refreshSeconds: seconds })
      }))
    },
    { type: "separator" },
    {
      label: "窗口置顶",
      type: "checkbox",
      checked: alwaysOnTop,
      click: (item) => setWidgetAlwaysOnTop(item.checked)
    },
    {
      label: "开机启动",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked })
    },
    { type: "separator" },
    { label: "打开配置文件", click: () => shell.openPath(CONFIG_FILE) },
    { label: "退出", role: "quit" }
  ]);
}

function createWindow(display) {
  const initialHeight = DEFAULT_PANEL_HEIGHT + WINDOW_INSET * 2;
  const { x, y } = bottomRightBounds(display, initialHeight);
  const win = new BrowserWindow({
    x,
    y,
    width: WINDOW_WIDTH,
    height: initialHeight,
    minWidth: WINDOW_WIDTH,
    maxWidth: WINDOW_WIDTH,
    frame: false,
    transparent: true,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  widgetWindows.set(display.id, win);
  applyWindowSpaceBehavior(win);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => {
    positionBottomRight(win, display);
    if (widgetsVisible) {
      win.show();
      win.moveTop();
    }
    applyWindowSpaceBehavior(win);
    pushSnapshot();
  });
  win.on("closed", () => {
    widgetWindows.delete(display.id);
  });
}

function syncWindowsToDisplays() {
  const displays = screen.getAllDisplays();
  const displayIds = new Set(displays.map((display) => display.id));

  for (const [displayId, win] of widgetWindows.entries()) {
    if (!displayIds.has(displayId) && !win.isDestroyed()) {
      win.close();
      widgetWindows.delete(displayId);
    }
  }

  for (const display of displays) {
    const existing = widgetWindows.get(display.id);
    if (existing && !existing.isDestroyed()) {
      ensureOnScreen(existing); // leave a dragged widget where the user put it
      if (widgetsVisible && !existing.isVisible()) {
        existing.show();
        existing.moveTop();
      }
      continue;
    }
    createWindow(display);
  }
}

// Second instance never resolves this, so it sets up nothing and just quits.
const ready = gotSingleInstanceLock ? app.whenReady() : new Promise(() => {});
ready.then(() => {
  app.setActivationPolicy("accessory");
  tray = new Tray(createTrayIcon());
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => {
    const shouldHide = visibleWindows().some((win) => win.isVisible());
    if (shouldHide) {
      hideAllWidgets();
    } else {
      showAllWidgets();
    }
  });

  syncWindowsToDisplays();
  screen.on("display-added", syncWindowsToDisplays);
  screen.on("display-removed", syncWindowsToDisplays);
  screen.on("display-metrics-changed", syncWindowsToDisplays);
  scheduleRefresh();
});

app.on("second-instance", () => {
  showAllWidgets();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  if (refreshTimer) clearInterval(refreshTimer);
});

ipcMain.handle("usage:get", loadUsageSnapshot);
ipcMain.handle("config:get", () => loadConfig());
ipcMain.handle("config:save", (_event, nextConfig) => {
  const saved = saveConfig(nextConfig);
  scheduleRefresh();
  tray?.setContextMenu(buildTrayMenu());
  pushSnapshot();
  return saved;
});
ipcMain.handle("config:open", () => shell.openPath(CONFIG_FILE));
ipcMain.handle("refresh:set", (_event, seconds) => {
  const next = updateConfig({ refreshSeconds: Number(seconds) });
  return next.refreshSeconds;
});
ipcMain.handle("window:hide", () => hideAllWidgets());
ipcMain.on("window:resize", (event, height) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  resizeWidget(win, Number(height));
});
ipcMain.handle("window:setAlwaysOnTop", (_event, enabled) => {
  setWidgetAlwaysOnTop(Boolean(enabled));
  tray?.setContextMenu(buildTrayMenu());
  return alwaysOnTop;
});
