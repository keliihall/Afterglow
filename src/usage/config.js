const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CONFIG_DIR = path.join(os.homedir(), ".ai-usage-widget");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

// display: 哪些数据源参与显示。
//   "all"    同时显示 Codex 与 Claude
//   "codex"  仅显示 Codex
//   "claude" 仅显示 Claude
const DISPLAY_MODES = ["all", "codex", "claude"];

const DEFAULT_CONFIG = {
  refreshSeconds: 20,
  display: "all",
  providers: {
    codex: {
      enabled: true,
      sessionDir: "~/.codex/sessions",
      maxFiles: 80,
      maxAgeDays: 8
    },
    claude: {
      enabled: true,
      showScoped: true,
      minRefreshSeconds: 90
    }
  }
};

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mergeDeep(base, override) {
  const result = { ...base };
  if (!isPlainObject(override)) return result;

  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      result[key] = mergeDeep(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function ensureConfigFile() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
  }
}

function loadConfig() {
  ensureConfigFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return normalizeConfig(mergeDeep(DEFAULT_CONFIG, parsed));
  } catch (error) {
    return {
      ...DEFAULT_CONFIG,
      configError: `配置读取失败: ${error.message}`
    };
  }
}

function normalizeConfig(config) {
  if (!DISPLAY_MODES.includes(config.display)) {
    config.display = DEFAULT_CONFIG.display;
  }
  // refreshSeconds: 0 (or negative) means "no auto-refresh"; otherwise min 5s.
  const seconds = Number(config.refreshSeconds);
  if (!Number.isFinite(seconds)) {
    config.refreshSeconds = DEFAULT_CONFIG.refreshSeconds;
  } else {
    config.refreshSeconds = seconds <= 0 ? 0 : Math.max(5, seconds);
  }
  return config;
}

function saveConfig(nextConfig) {
  ensureConfigFile();
  const merged = normalizeConfig(mergeDeep(DEFAULT_CONFIG, nextConfig));
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  DISPLAY_MODES,
  loadConfig,
  saveConfig
};
