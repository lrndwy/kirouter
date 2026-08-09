import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../server.js";
import { getBaseUrl, getDefaultModel, loadConfig } from "../store/config.js";
import {
  hasAccounts,
  importKeysFile,
  keysFilePath,
  listAccountStatuses,
  loadAccountsFromFile,
} from "../store/accounts.js";
import { isLoggedIn } from "../store/credentials.js";
import {
  clearStats,
  getAllPeriodStats,
  getPeriodStats,
  getRecent,
  getTotals,
  onRequest,
  PERIODS,
} from "../store/stats.js";
import { fetchAllAccountsUsage, fetchKiroUsage } from "../kiro/usage.js";
import { STATIC_MODELS, formatContext } from "../kiro/constants.js";
import { applyTool, listToolIds, statusAll } from "../cli-tools/index.js";
import { choose, pickModel, pickSubagentModel, prompt, toolSupportsSubagent } from "../util/input.js";
import {
  printAccountsUsageTable,
  printLocalStats,
  printPeriodDetail,
  printPeriodStatsTable,
  printRequestLog,
  printUsageBlock,
} from "../util/logger.js";
import {
  accountStateLabel,
  c,
  err,
  hr,
  info,
  kv,
  ok,
  printAccountSummary,
  printBanner,
  printTable,
  section,
  warn,
} from "../util/ui.js";

function pkgVersion() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")
    ).version;
  } catch {
    return "0.1.0";
  }
}

function ensureKeysImported() {
  if (hasAccounts() || isLoggedIn()) return;
  const cwdKeys = path.resolve("kiro_keys.txt");
  if (fs.existsSync(cwdKeys)) {
    const result = importKeysFile(cwdKeys);
    ok(`Auto-imported ${result.imported} account(s)`);
  }
}

function printHelpPanel() {
  console.log();
  console.log(c.cyan("  ┌─ Help ──────────────────────────────────────────┐"));
  console.log(c.cyan("  │") + c.bold("  Keyboard shortcuts (proxy live)") + "               " + c.cyan("│"));
  console.log(c.cyan("  ├─────────────────────────────────────────────────┤"));
  const rows = [
    ["m", "Open central menu"],
    ["h / ?", "Show this help"],
    ["u", "Usage / quota (all accounts)"],
    ["s", "Local token stats (1d…all)"],
    ["c", "Clear screen"],
    ["a", "Accounts list + usage"],
    ["l", "Recent request log"],
    ["t", "CLI Tools quick apply"],
    ["q", "Quit / stop proxy"],
  ];
  for (const [k, desc] of rows) {
    console.log(
      c.cyan("  │") +
        `  ${c.cyan(c.bold(k.padEnd(6)))} ${desc.padEnd(36)}` +
        c.cyan("│")
    );
  }
  console.log(c.cyan("  └─────────────────────────────────────────────────┘"));
  console.log();
  info("Logs keep streaming while you use shortcuts");
  console.log();
}

function printKeyHint() {
  console.log(
    c.dim("  keys:") +
      `  ${c.cyan("m")} menu  ${c.cyan("h")} help  ${c.cyan("u")} usage  ${c.cyan("s")} stats  ${c.cyan("c")} clear  ${c.cyan("a")} accounts  ${c.cyan("l")} recent  ${c.cyan("t")} tools  ${c.cyan("q")} quit`
  );
  console.log();
}

function printHeader(port, host, cfg) {
  printBanner(pkgVersion());
  section("Proxy running");
  const displayHost = host === "0.0.0.0" ? "localhost" : host;
  kv("Listen", c.bold(`http://${displayHost}:${port}`));
  kv("Base URL", getBaseUrl({ ...cfg, port }));
  kv("API key", cfg.localApiKey);
  kv("Default model", getDefaultModel(cfg));
  if (hasAccounts()) {
    const statuses = listAccountStatuses();
    printAccountSummary(statuses, keysFilePath());
  } else if (isLoggedIn()) {
    kv("Auth", "single account");
  } else {
    warn("No accounts — import kiro_keys.txt");
  }
  hr();
  section("Live request log");
  info("in/out tokens + context appear under each request");
  printKeyHint();
}

async function showUsage() {
  console.log();
  const accounts = loadAccountsFromFile();
  if (accounts.length) {
    info(`Fetching usage for all ${accounts.length} account(s)…`);
    try {
      const result = await fetchAllAccountsUsage({
        onProgress: (row, i, total) => {
          const mark = row.ok ? c.green("✔") : c.red("✖");
          process.stdout.write(
            `\r  ${mark} ${String(i).padStart(3)}/${total}  ${row.email.padEnd(28)} ${row.ok ? row.credit : "fail"}   `
          );
        },
      });
      console.log();
      console.log();
      printAccountsUsageTable(result.rows);
    } catch (e) {
      err(e.message || e);
    }
  } else {
    try {
      info("Fetching Kiro usage…");
      printUsageBlock(await fetchKiroUsage());
    } catch (e) {
      err(e.message || e);
    }
  }
  printKeyHint();
}

function showStats() {
  console.log();
  printPeriodStatsTable(getAllPeriodStats());
  console.log();
  printLocalStats(getTotals());
  console.log();
  printKeyHint();
}

async function showStatsMenu() {
  console.log();
  printPeriodStatsTable(getAllPeriodStats());
  console.log();
  const pick = await choose("Period detail / clear:", [
    ...PERIODS.map((p) => `${p.label} (detail)`),
    "Clear local stats (tokens + history)",
    "Back",
  ]);
  if (!pick || pick.startsWith("Back")) {
    printKeyHint();
    return;
  }
  if (pick.startsWith("Clear")) {
    const conf = (await prompt("Type CLEAR to wipe local token history: ")).trim();
    if (conf === "CLEAR") {
      clearStats();
      ok("Local stats cleared");
    } else {
      warn("Cancelled");
    }
    printKeyHint();
    return;
  }
  const period = PERIODS.find((p) => pick.startsWith(p.label));
  if (period) {
    printPeriodDetail(getPeriodStats(period.id));
  }
  printKeyHint();
}

function clearScreen(ctx) {
  console.clear();
  printHeader(ctx.port, ctx.host, loadConfig());
}

async function showAccounts() {
  console.log();
  const statuses = listAccountStatuses();
  if (!statuses.length) {
    warn(`No accounts at ${keysFilePath()}`);
    printKeyHint();
    return;
  }
  printAccountSummary(statuses, keysFilePath());
  console.log();
  printTable(statuses, [
    { key: "email", header: "EMAIL", width: 28 },
    {
      key: "state",
      header: "STATE",
      width: 18,
      format: (_v, row) => accountStateLabel(row).text,
    },
  ]);
  console.log();
  info(`Fetching usage for all ${statuses.length} account(s)…`);
  const result = await fetchAllAccountsUsage({
    onProgress: (row, i, total) => {
      const mark = row.ok ? c.green("✔") : c.red("✖");
      process.stdout.write(
        `\r  ${mark} ${String(i).padStart(3)}/${total}  ${row.email.padEnd(28)} ${row.ok ? row.credit : "fail"}   `
      );
    },
  });
  console.log();
  console.log();
  printAccountsUsageTable(result.rows);
  printKeyHint();
}

function showRecent() {
  console.log();
  section("Recent requests");
  const rows = getRecent(20);
  if (!rows.length) info("No requests yet");
  else for (const e of rows.slice().reverse()) printRequestLog(e);
  printKeyHint();
}

function showModels() {
  console.log();
  section("Models · max context");
  printTable(
    STATIC_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      ctx: formatContext(m.contextLength),
    })),
    [
      { key: "id", header: "ID", width: 22 },
      { key: "name", header: "NAME", width: 24 },
      { key: "ctx", header: "CTX", width: 8, align: "right" },
    ]
  );
  console.log();
  printKeyHint();
}

async function showToolsQuick() {
  console.log();
  section("CLI Tools");
  info("Type a number + Enter · 0 to cancel · then hotkeys resume");
  const rows = await statusAll();
  printTable(rows, [
    { key: "id", header: "TOOL", width: 10 },
    {
      key: "configured",
      header: "STATUS",
      width: 12,
      format: (v, s) => (s.guideOnly ? "guide" : v ? "configured" : s.installed ? "installed" : "missing"),
    },
  ]);
  console.log();
  const id = await choose(
    "Apply to tool:",
    listToolIds().filter((x) => x !== "cursor")
  );
  if (!id) {
    warn("Cancelled — back to live log");
    printKeyHint();
    return;
  }
  const model = await pickModel(getDefaultModel(), "Select main model");
  if (!model) {
    warn("Cancelled — back to live log");
    printKeyHint();
    return;
  }
  let subagentModel;
  if (toolSupportsSubagent(id)) {
    subagentModel = await pickSubagentModel(id, model);
  }
  const result = await applyTool(id, { model, subagentModel });
  ok(`Applied ${id} → ${model}`);
  if (result.subagentModel || subagentModel) kv("Subagent", result.subagentModel || subagentModel);
  if (result.settingsPath) kv("Config", result.settingsPath);
  if (result.message) info(result.message);
  printKeyHint();
}

/**
 * Central interactive menu while proxy keeps running.
 */
async function openCentralMenu(ctx) {
  console.log();
  hr();
  section("Central menu");
  kv("Proxy", "still running");
  info("Type number + Enter · 0 cancels back to live log");
  console.log();
  const pick = await choose("Select:", [
    "Usage / quota (all accounts)",
    "Local token stats (1d / 3d / 7d / 30d / all)",
    "Clear screen",
    "Accounts + usage",
    "Recent requests",
    "Models (max context)",
    "CLI Tools apply",
    "Help",
    "Back to live log",
    "Quit proxy",
  ]);
  if (!pick || pick.startsWith("Back")) {
    ok("Back to live log");
    printKeyHint();
    return;
  }
  if (pick.startsWith("Quit")) {
    ctx.shutdown();
    return;
  }
  if (pick.startsWith("Usage")) return showUsage();
  if (pick.startsWith("Local")) return showStatsMenu();
  if (pick.startsWith("Clear screen")) {
    clearScreen(ctx);
    return;
  }
  if (pick.startsWith("Accounts")) return showAccounts();
  if (pick.startsWith("Recent")) return showRecent();
  if (pick.startsWith("Models")) return showModels();
  if (pick.startsWith("CLI")) return showToolsQuick();
  if (pick.startsWith("Help")) {
    printHelpPanel();
    return;
  }
  printKeyHint();
}

/**
 * Start proxy and run interactive live console (logs + key commands).
 */
export async function runLiveProxy(flags = {}) {
  ensureKeysImported();
  const cfg = loadConfig();
  const { start, port, host, server } = createServer({
    port: flags.port || cfg.port,
    host: flags.host || cfg.host,
    noAuth: flags.noAuth,
  });

  await start();
  printHeader(port, host, loadConfig());

  const offLog = onRequest((entry) => printRequestLog(entry));

  let busy = false;
  let hotkeysOn = false;
  let resolveLoop;

  const onHotkey = (chunk) => {
    if (busy || !hotkeysOn) return;
    const key = String(chunk);
    if (key === "\u0003" || key === "q" || key === "Q") {
      shutdown();
      resolveLoop?.();
      return;
    }
    if (key === "m" || key === "M") return void runAction(() => openCentralMenu(ctx));
    if (key === "h" || key === "H" || key === "?" || key === "/") {
      printHelpPanel();
      return;
    }
    if (key === "u" || key === "U") return void runAction(showUsage);
    if (key === "s" || key === "S") return void runAction(showStatsMenu);
    if (key === "c" || key === "C") {
      clearScreen(ctx);
      return;
    }
    if (key === "a" || key === "A") return void runAction(showAccounts);
    if (key === "l" || key === "L") {
      showRecent();
      return;
    }
    if (key === "t" || key === "T") return void runAction(showToolsQuick);
  };

  const enableHotkeys = () => {
    if (!process.stdin.isTTY || hotkeysOn) return;
    try {
      process.stdin.setRawMode(true);
    } catch {
      /* ignore */
    }
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", onHotkey);
    hotkeysOn = true;
  };

  /** Detach hotkeys so readline prompts own stdin exclusively. */
  const disableHotkeys = () => {
    if (!hotkeysOn) return;
    process.stdin.removeListener("data", onHotkey);
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    hotkeysOn = false;
  };

  const cleanup = () => {
    offLog();
    disableHotkeys();
    try {
      process.stdin.pause();
    } catch {
      /* ignore */
    }
  };

  const shutdown = () => {
    cleanup();
    console.log();
    ok("Proxy stopped");
    try {
      server.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (!process.stdin.isTTY) {
    await new Promise(() => {});
    return;
  }

  const ctx = { shutdown, port, host };

  const runAction = async (fn) => {
    if (busy) return;
    busy = true;
    disableHotkeys();
    try {
      await fn();
    } catch (e) {
      err(e?.message || e);
      printKeyHint();
    } finally {
      busy = false;
      enableHotkeys();
    }
  };

  enableHotkeys();

  await new Promise((resolve) => {
    resolveLoop = resolve;
  });
}
