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
  getTotals,
  onRequest,
  PERIODS,
} from "../store/stats.js";
import { fetchAllAccountsUsage, fetchKiroUsage } from "../kiro/usage.js";
import { STATIC_MODELS, formatContext } from "../kiro/constants.js";
import { applyTool, listToolIds, statusAll } from "../cli-tools/index.js";
import {
  choose,
  confirm,
  pickModel,
  pickSubagentModel,
  toolSupportsSubagent,
} from "../util/input.js";
import { withSpinner } from "../util/spinner.js";
import {
  printAccountsUsageTable,
  printLocalStats,
  printPeriodDetail,
  printPeriodStatsTable,
  printUsageBlock,
} from "../util/logger.js";
import {
  accountStateLabel,
  c,
  err,
  formatAccountsShort,
  hr,
  info,
  kv,
  ok,
  printAccountSummary,
  printBox,
  printTable,
  section,
  warn,
} from "../util/ui.js";
import { LiveDashboard } from "./dashboard.js";

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

function accountsLabel() {
  if (hasAccounts()) return formatAccountsShort(listAccountStatuses());
  if (isLoggedIn()) return c.dim("single account");
  return c.yellow("no accounts");
}

function printHelpPanel() {
  const rows = [
    ["L", "Toggle scrollable log frame"],
    ["m", "Open central menu"],
    ["h / ?", "Show this help"],
    ["u", "Usage / quota (all accounts)"],
    ["s", "Local token stats (1d…all)"],
    ["c", "Refresh minimal dashboard"],
    ["a", "Accounts list + usage"],
    ["t", "CLI Tools quick apply"],
    ["q", "Quit / stop proxy"],
  ];
  const lines = [
    ` ${c.bold("Keyboard shortcuts")}`,
    ` ${c.dim("─".repeat(44))}`,
    ...rows.map(
      ([k, desc]) => ` ${c.cyan(c.bold(k.padEnd(7)))} ${desc}`
    ),
    ` ${c.dim("─".repeat(44))}`,
    ` ${c.dim("In log frame:")} ${c.cyan("↑↓")} ${c.cyan("PgUp/PgDn")} ${c.cyan("g/G")} ${c.cyan("Esc")}`,
  ];
  console.log();
  printBox(lines, { title: "Help", width: 50 });
  console.log();
}

function returnToDashboard(dash) {
  dash.render();
}

async function showUsage(dash) {
  console.log();
  const accounts = loadAccountsFromFile();
  if (accounts.length) {
    try {
      const result = await withSpinner(`Fetching usage (${accounts.length} accounts)…`, async (update) =>
        fetchAllAccountsUsage({
          onProgress: (row, i, total) => {
            update(`Fetching ${i}/${total}  ${row.email}`);
          },
        })
      );
      console.log();
      printAccountsUsageTable(result.rows);
    } catch (e) {
      err(e.message || e);
    }
  } else {
    try {
      const usage = await withSpinner("Fetching Kiro usage…", () => fetchKiroUsage());
      printUsageBlock(usage);
    } catch (e) {
      err(e.message || e);
    }
  }
  console.log();
  await confirm("Back to dashboard?", true);
  returnToDashboard(dash);
}

async function showStatsMenu(dash) {
  console.log();
  printPeriodStatsTable(getAllPeriodStats());
  console.log();
  const pick = await choose("Period detail / clear:", [
    ...PERIODS.map((p) => `${p.label} (detail)`),
    "Clear local stats (tokens + history)",
    "Back",
  ]);
  if (!pick || pick.startsWith("Back")) {
    returnToDashboard(dash);
    return;
  }
  if (pick.startsWith("Clear")) {
    const yes = await confirm("Wipe local token history?", false);
    if (yes) {
      clearStats();
      ok("Local stats cleared");
    } else {
      warn("Cancelled");
    }
    returnToDashboard(dash);
    return;
  }
  const period = PERIODS.find((p) => pick.startsWith(p.label));
  if (period) printPeriodDetail(getPeriodStats(period.id));
  console.log();
  printLocalStats(getTotals());
  console.log();
  await confirm("Back to dashboard?", true);
  returnToDashboard(dash);
}

async function showAccounts(dash) {
  console.log();
  const statuses = listAccountStatuses();
  if (!statuses.length) {
    warn(`No accounts at ${keysFilePath()}`);
    await confirm("Back to dashboard?", true);
    returnToDashboard(dash);
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
  try {
    const result = await withSpinner(`Fetching usage (${statuses.length} accounts)…`, async (update) =>
      fetchAllAccountsUsage({
        onProgress: (row, i, total) => update(`Fetching ${i}/${total}  ${row.email}`),
      })
    );
    console.log();
    printAccountsUsageTable(result.rows);
  } catch (e) {
    err(e.message || e);
  }
  console.log();
  await confirm("Back to dashboard?", true);
  returnToDashboard(dash);
}

function showModels(dash) {
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
}

async function showToolsQuick(dash) {
  console.log();
  section("CLI Tools");
  info("Type a number + Enter · 0 to cancel");
  const rows = await withSpinner("Checking tool status…", () => statusAll());
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
    warn("Cancelled");
    returnToDashboard(dash);
    return;
  }
  const model = await pickModel(getDefaultModel(), "Select main model");
  if (!model) {
    warn("Cancelled");
    returnToDashboard(dash);
    return;
  }
  let subagentModel;
  if (toolSupportsSubagent(id)) {
    subagentModel = await pickSubagentModel(id, model);
  }
  const yes = await confirm(`Apply ${id} → ${model}?`, true);
  if (!yes) {
    warn("Cancelled");
    returnToDashboard(dash);
    return;
  }
  const result = await withSpinner(
    `Applying ${id}…`,
    () => applyTool(id, { model, subagentModel }),
    { success: `Applied ${id} → ${model}` }
  );
  if (result.subagentModel || subagentModel) kv("Subagent", result.subagentModel || subagentModel);
  if (result.settingsPath) kv("Config", result.settingsPath);
  if (result.message) info(result.message);
  console.log();
  await confirm("Back to dashboard?", true);
  returnToDashboard(dash);
}

async function openCentralMenu(ctx, dash) {
  console.log();
  hr();
  section("Central menu");
  kv("Proxy", c.green("running"));
  console.log();
  const pick = await choose("Select:", [
    "Usage / quota (all accounts)",
    "Local token stats (1d / 3d / 7d / 30d / all)",
    "Refresh dashboard",
    "Accounts + usage",
    "Open log frame (L)",
    "Models (max context)",
    "CLI Tools apply",
    "Help",
    "Back to dashboard",
    "Quit proxy",
  ]);
  if (!pick || pick.startsWith("Back")) {
    returnToDashboard(dash);
    return;
  }
  if (pick.startsWith("Quit")) {
    const yes = await confirm("Stop proxy and quit?", false);
    if (yes) ctx.shutdown();
    else returnToDashboard(dash);
    return;
  }
  if (pick.startsWith("Usage")) return showUsage(dash);
  if (pick.startsWith("Local")) return showStatsMenu(dash);
  if (pick.startsWith("Refresh")) {
    returnToDashboard(dash);
    return;
  }
  if (pick.startsWith("Accounts")) return showAccounts(dash);
  if (pick.startsWith("Open log")) {
    dash.openLogs();
    return;
  }
  if (pick.startsWith("Models")) {
    showModels(dash);
    await confirm("Back to dashboard?", true);
    returnToDashboard(dash);
    return;
  }
  if (pick.startsWith("CLI")) return showToolsQuick(dash);
  if (pick.startsWith("Help")) {
    printHelpPanel();
    await confirm("Back to dashboard?", true);
    returnToDashboard(dash);
    return;
  }
  returnToDashboard(dash);
}

/**
 * Start proxy and run interactive live console (minimal dashboard + log frame).
 */
export async function runLiveProxy(flags = {}) {
  ensureKeysImported();
  const cfg = loadConfig();

  const boot = withSpinner("Starting proxy…", async () => {
    const created = createServer({
      port: flags.port || cfg.port,
      host: flags.host || cfg.host,
      noAuth: flags.noAuth,
    });
    await created.start();
    return created;
  });

  const { start: _start, port, host, server } = await boot;
  const liveCfg = loadConfig();

  const dash = new LiveDashboard({
    port,
    host,
    version: pkgVersion(),
    baseUrl: getBaseUrl({ ...liveCfg, port }),
    apiKey: liveCfg.localApiKey,
    model: getDefaultModel(liveCfg),
    accountsLabel: accountsLabel(),
  });
  dash.render();

  const offLog = onRequest((entry) => {
    dash.push(entry);
  });

  let busy = false;
  let hotkeysOn = false;
  let resolveLoop;
  let escSeq = "";

  const shutdown = async () => {
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

  const ctx = { shutdown, port, host };

  const onHotkey = (chunk) => {
    if (busy || !hotkeysOn) return;
    const key = String(chunk);

    // Parse ANSI escape sequences for arrows / page keys
    if (key === "\x1b" || escSeq) {
      escSeq += key;
      if (escSeq === "\x1b") return; // wait for rest
      // Esc alone (close logs) — after short grace handled by incomplete seq timeout
      if (escSeq === "\x1b[" || escSeq === "\x1bO") return;
      const seq = escSeq;
      escSeq = "";
      if (seq === "\x1b[A" || seq === "\x1bOA") {
        if (dash.isLogsOpen()) dash.scrollLogs("up");
        return;
      }
      if (seq === "\x1b[B" || seq === "\x1bOB") {
        if (dash.isLogsOpen()) dash.scrollLogs("down");
        return;
      }
      if (seq === "\x1b[5~") {
        if (dash.isLogsOpen()) dash.scrollLogs("pageup");
        return;
      }
      if (seq === "\x1b[6~") {
        if (dash.isLogsOpen()) dash.scrollLogs("pagedown");
        return;
      }
      if (seq === "\x1b" || seq === "\x1b\x1b") {
        if (dash.isLogsOpen()) {
          dash.closeLogs();
          return;
        }
      }
      // Unknown escape — ignore
      return;
    }

    if (key === "\u0003") {
      void runAction(async () => {
        const yes = await confirm("Stop proxy and quit?", false);
        if (yes) await shutdown();
        else returnToDashboard(dash);
      });
      return;
    }

    if (key === "q" || key === "Q") {
      if (dash.isLogsOpen()) {
        dash.closeLogs();
        return;
      }
      void runAction(async () => {
        const yes = await confirm("Stop proxy and quit?", false);
        if (yes) await shutdown();
        else returnToDashboard(dash);
      });
      return;
    }

    // Log frame navigation
    if (dash.isLogsOpen()) {
      if (key === "l" || key === "L" || key === "\r" || key === "\n") {
        dash.closeLogs();
        return;
      }
      if (key === "k" || key === "K") {
        dash.scrollLogs("up");
        return;
      }
      if (key === "j" || key === "J") {
        dash.scrollLogs("down");
        return;
      }
      if (key === "g") {
        dash.scrollLogs("home");
        return;
      }
      if (key === "G") {
        dash.scrollLogs("end");
        return;
      }
      // While logs open, ignore other action keys except m/h
      if (key === "m" || key === "M") return void runAction(() => openCentralMenu(ctx, dash));
      if (key === "h" || key === "H" || key === "?") {
        printHelpPanel();
        return;
      }
      return;
    }

    if (key === "l" || key === "L") {
      dash.toggleLogs();
      return;
    }
    if (key === "m" || key === "M") return void runAction(() => openCentralMenu(ctx, dash));
    if (key === "h" || key === "H" || key === "?" || key === "/") {
      void runAction(async () => {
        printHelpPanel();
        await confirm("Back to dashboard?", true);
        returnToDashboard(dash);
      });
      return;
    }
    if (key === "u" || key === "U") return void runAction(() => showUsage(dash));
    if (key === "s" || key === "S") return void runAction(() => showStatsMenu(dash));
    if (key === "c" || key === "C") {
      dash.setMeta({ accountsLabel: accountsLabel(), model: getDefaultModel(loadConfig()) });
      dash.render();
      return;
    }
    if (key === "a" || key === "A") return void runAction(() => showAccounts(dash));
    if (key === "t" || key === "T") return void runAction(() => showToolsQuick(dash));
  };

  // Flush lone Esc after timeout (close log frame)
  let escTimer = null;
  const onHotkeyWrapped = (chunk) => {
    if (String(chunk) === "\x1b") {
      clearTimeout(escTimer);
      escTimer = setTimeout(() => {
        if (escSeq === "\x1b") {
          escSeq = "";
          if (dash.isLogsOpen()) dash.closeLogs();
        }
      }, 50);
    }
    onHotkey(chunk);
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
    process.stdin.on("data", onHotkeyWrapped);
    hotkeysOn = true;
  };

  const disableHotkeys = () => {
    if (!hotkeysOn) return;
    process.stdin.removeListener("data", onHotkeyWrapped);
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
    clearTimeout(escTimer);
    try {
      process.stdin.pause();
    } catch {
      /* ignore */
    }
  };

  process.on("SIGINT", () => {
    void runAction(async () => {
      const yes = await confirm("Stop proxy and quit?", false);
      if (yes) await shutdown();
      else returnToDashboard(dash);
    });
  });
  process.on("SIGTERM", () => void shutdown());

  if (!process.stdin.isTTY) {
    await new Promise(() => {});
    return;
  }

  const runAction = async (fn) => {
    if (busy) return;
    busy = true;
    disableHotkeys();
    try {
      await fn();
    } catch (e) {
      err(e?.message || e);
      returnToDashboard(dash);
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
