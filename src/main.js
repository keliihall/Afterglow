const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, screen, dialog } = require("electron");
const path = require("node:path");
const { loadUsageSnapshot } = require("./usage");
const { loadConfig, saveConfig, SIZE_MODES, CONFIG_FILE } = require("./usage/config");
const { requestKeychainAccess } = require("./usage/providers/claude");

// Re-trigger Claude's keychain authorization (for users who didn't click
// "Always Allow" the first time), then refresh. User-initiated from the tray so
// the system prompt reliably comes to the front.
async function authorizeClaudeKeychain() {
  const result = await requestKeychainAccess();
  if (result.ok) {
    pushSnapshot();
    dialog.showMessageBox({
      type: "info",
      message: "已授权读取 Claude 余量",
      detail: "钥匙串已允许，正在刷新…（以后不会再询问）",
      buttons: ["好"]
    });
  } else {
    dialog.showMessageBox({
      type: "warning",
      message: "未能读取 Claude 钥匙串",
      detail: `${result.reason}\n\n再次点击此菜单会弹出系统钥匙串授权框，请务必点「始终允许 / Always Allow」。`,
      buttons: ["好"]
    });
  }
}

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
  // Monochrome "afterglow" ring (the orb outline — matches the app icon). A
  // genuinely transparent RGBA PNG, rasterized + encoded ourselves (qlmanage
  // only makes opaque thumbnails, which render as a solid square), embedded
  // inline so loading can't fail. Template image → macOS tints it for the
  // light/dark menu bar and the selected (blue) state. See scripts/make-tray-icon.js.
  const TRAY_ICON = "iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAABQElEQVR42u2XPQqDQBCFDVikstHCQE5gm9bOC3gbD+E5UkcscwfrFDmBIHqCkLzAE8IywZ81yQR88DXLzuzozs7sOs6qVb/VBnggJB7HvqotOIAMlKACF1JxLOOc7ScDcUECCtCC+wAt5ya0XVQ+yEE3IhCTjrb+UsHswOnNYjdQgyupOSbNPdGX9Z+RgmnAEaQgAnsScezIOVJQvk3O5ILTM4gH8sLlnLNgn8/NqUTImeeXBxN8BLQxcyqZc7QL4c8EMz4sEP5UMbUkHIyj3XAL5io2cqrlGqOVCVvlWtYwc+uyKe2gNI52ukD5SI2SUI5tMx5bQG9Y8zjbKqKv3m/FtQYVsi/1hlfWGFvt6av3e+Fa/xeQui1Tl9Tqjr3KwqiudahrriqvH+ouaCqvsCov+SqfQSofimqf0qtWveoB5HgMmN+EddEAAAAASUVORK5CYII=";
  const image = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON, "base64"), { scaleFactor: 2 });
  image.setTemplateImage(true);
  return image;
}
const WINDOW_INSET = 3;
// 三档展示宽度（小/中/大）。中=212 与原版一致。
const SIZE_PANEL_WIDTH = { small: 166, medium: 212, large: 248 };
const MIN_WINDOW_WIDTH = SIZE_PANEL_WIDTH.small + WINDOW_INSET * 2;
const MAX_WINDOW_WIDTH = SIZE_PANEL_WIDTH.large + WINDOW_INSET * 2;
function currentWindowWidth() {
  const size = loadConfig().size;
  return (SIZE_PANEL_WIDTH[size] || SIZE_PANEL_WIDTH.medium) + WINDOW_INSET * 2;
}
const MIN_PANEL_HEIGHT = 32;
const MAX_PANEL_HEIGHT = 400;
const DEFAULT_PANEL_HEIGHT = 120;
const ALWAYS_ON_TOP_LEVEL = "screen-saver";
const ALL_SPACES_OPTIONS = {
  visibleOnFullScreen: true,
  skipTransformProcessType: true
};

const REFRESH_PRESETS = [10, 20, 30, 60, 0];
const refreshLabel = (seconds) => (seconds > 0 ? `${seconds} 秒` : "不刷新");
const DISPLAY_LABELS = { all: "全部显示", codex: "仅 Codex", claude: "仅 Claude" };
const SIZE_LABELS = { small: "小", medium: "中", large: "大" };

function bottomRightBounds(display, windowHeight) {
  const bounds = display.workArea;
  return {
    x: Math.round(bounds.x + bounds.width - currentWindowWidth() - 28 + WINDOW_INSET),
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
    x: Math.min(Math.max(x, wa.x), wa.x + wa.width - currentWindowWidth()),
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
  const windowWidth = currentWindowWidth();
  const [currentWidth, currentHeight] = win.getSize();
  if (currentWidth === windowWidth && currentHeight === windowHeight) return;
  const [x, y] = win.getPosition();
  const anchoredY = y + (currentHeight - windowHeight); // keep bottom edge fixed
  win.setSize(windowWidth, windowHeight, false);
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
  // 立即按新档位调整窗口宽度（高度随后由渲染回报的内容高度自适应）。
  const width = currentWindowWidth();
  for (const win of visibleWindows()) {
    const [, h] = win.getSize();
    const [x, y] = win.getPosition();
    win.setSize(width, h, false);
    const { x: nx, y: ny } = clampToWorkArea(win, x, y, h);
    win.setPosition(nx, ny, false);
  }
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
    { label: "授权读取 Claude 余量…", click: authorizeClaudeKeychain },
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
    {
      label: "显示大小",
      submenu: SIZE_MODES.map((size) => ({
        label: SIZE_LABELS[size] || size,
        type: "radio",
        checked: config.size === size,
        click: () => updateConfig({ size })
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
    width: currentWindowWidth(),
    height: initialHeight,
    minWidth: MIN_WINDOW_WIDTH,
    maxWidth: MAX_WINDOW_WIDTH,
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
  // Left-click toggles the widget; right-click opens the menu (rebuilt each time
  // so its checkmarks reflect the current settings). We deliberately do NOT call
  // setContextMenu — on macOS that binds the menu to LEFT-click, which would
  // collide with the toggle (a single click would both open the menu and
  // hide/show the widget).
  tray.on("click", () => {
    if (visibleWindows().some((win) => win.isVisible())) {
      hideAllWidgets();
    } else {
      showAllWidgets();
    }
  });
  tray.on("right-click", () => tray.popUpContextMenu(buildTrayMenu()));

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
  return alwaysOnTop;
});
