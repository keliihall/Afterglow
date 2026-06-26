const { loadConfig, CONFIG_FILE } = require("./config");
const { getCodexUsage } = require("./providers/codex");
const { getClaudeUsage } = require("./providers/claude");

const LABELS = { codex: "Codex", claude: "Claude" };

async function settleProvider(id, promise) {
  try {
    return await promise;
  } catch (error) {
    return {
      id,
      label: LABELS[id] || id,
      status: "error",
      statusText: "读取失败",
      error: error.message,
      windows: []
    };
  }
}

// Decide which providers participate, honoring both the display mode and each
// provider's `enabled` flag. In "codex" mode we never touch the Claude token,
// so the keychain prompt only appears when Claude is actually shown.
function activeProviders(config) {
  const display = config.display || "all";
  const wantCodex = display !== "claude" && config.providers.codex?.enabled !== false;
  const wantClaude = display !== "codex" && config.providers.claude?.enabled !== false;
  return { wantCodex, wantClaude };
}

async function loadUsageSnapshot() {
  const config = loadConfig();
  const { wantCodex, wantClaude } = activeProviders(config);

  const tasks = [];
  if (wantCodex) {
    tasks.push(settleProvider("codex", getCodexUsage(config.providers.codex || {})));
  }
  if (wantClaude) {
    tasks.push(settleProvider("claude", getClaudeUsage(config.providers.claude || {})));
  }

  const providers = await Promise.all(tasks);

  return {
    generatedAt: new Date().toISOString(),
    refreshSeconds: config.refreshSeconds,
    display: config.display,
    configPath: CONFIG_FILE,
    configError: config.configError || null,
    providers
  };
}

module.exports = {
  loadUsageSnapshot
};
