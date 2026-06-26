const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function listJsonlFiles(rootDir, options = {}) {
  const root = expandHome(rootDir);
  const maxAgeMs = Number(options.maxAgeDays) > 0 ? Number(options.maxAgeDays) * 24 * 60 * 60 * 1000 : Infinity;
  const cutoff = Date.now() - maxAgeMs;
  const files = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoff) continue;
      files.push({ path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }

  walk(root);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readLinesMatching(filePath, marker, onObject) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return { lines: 0, matched: 0, error };
  }

  let lines = 0;
  let matched = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;
    lines += 1;
    if (marker && !line.includes(marker)) continue;
    const parsed = parseJsonLine(line);
    if (!parsed) continue;
    matched += 1;
    onObject(parsed, line);
  }
  return { lines, matched };
}

module.exports = {
  expandHome,
  listJsonlFiles,
  parseJsonLine,
  readLinesMatching
};
