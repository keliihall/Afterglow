const { loadUsageSnapshot } = require("../src/usage");

function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : "--";
}

loadUsageSnapshot()
  .then((snapshot) => {
    console.log(`Generated: ${snapshot.generatedAt}`);
    console.log(`Config: ${snapshot.configPath}`);
    for (const provider of snapshot.providers) {
      console.log(`\n${provider.label}: ${provider.statusText || provider.status}`);
      for (const window of provider.windows || []) {
        const used = percent(window.usedPercent);
        console.log(`  ${window.label}: remaining ${percent(window.remainingPercent)} / used ${used}`);
      }
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
