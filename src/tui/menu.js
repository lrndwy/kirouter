import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { choose, pause, pickModel, pickSubagentModel, prompt, toolSupportsSubagent } from "../util/input.js";
import { getBaseUrl, getDefaultModel, loadConfig, saveConfig } from "../store/config.js";
import { clearCredentials, isLoggedIn, loadCredentials, saveCredentials } from "../store/credentials.js";
import {
  hasAccounts,
  importKeysFile,
  keysFilePath,
  listAccountStatuses,
  loadAccountsFromFile,
} from "../store/accounts.js";
import { clearStats, getAllPeriodStats, getPeriodStats, getTotals, PERIODS } from "../store/stats.js";
import { importRefreshToken, loginWithDeviceCode, validateApiKey } from "../kiro/auth.js";
import { verifyAccounts } from "../kiro/pool.js";
import { fetchAllAccountsUsage, fetchKiroUsage } from "../kiro/usage.js";
import { applyTool, listToolIds, resetTool, statusAll } from "../cli-tools/index.js";
import { STATIC_MODELS } from "../kiro/constants.js";
import { runLiveProxy } from "./live.js";
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

async function loginFlow() {
  section("Login");
  const cwdKeys = path.resolve("kiro_keys.txt");
  const hasCwd = fs.existsSync(cwdKeys) && loadAccountsFromFile(cwdKeys).length > 0;
  if (hasCwd) info(`Detected ${cwdKeys} (${loadAccountsFromFile(cwdKeys).length} accounts)`);

  const method = await choose("Method:", [
    "Import kiro_keys.txt (multi-account)",
    "Kiro API key",
    "AWS Builder ID (device code)",
    "Import single refresh token",
  ]);
  if (!method) return;

  if (method.startsWith("Import kiro_keys")) {
    const def = hasCwd ? cwdKeys : "./kiro_keys.txt";
    const src = (await prompt(`Path [${def}]: `)) || def;
    if (!fs.existsSync(src)) {
      err(`Not found: ${src}`);
      await pause();
      return;
    }
    const result = importKeysFile(src);
    ok(`Imported ${result.imported}. Pool: ${result.count}`);
    kv("Saved", result.path);
    info(`Verifying all ${result.count} account(s)…`);
    const v = await verifyAccounts(Infinity, (row) => {
      const mark = row.ok ? c.green("✔") : c.red("✖");
      process.stdout.write(
        `\r  ${mark} ${String(row.index).padStart(3)}/${row.of}  ${row.email.padEnd(28)}          `
      );
    });
    console.log();
    if (v.fail === 0) ok(`All ${v.ok} OK`);
    else warn(`${v.ok} ok · ${v.fail} failed`);
  } else if (method.startsWith("Kiro API")) {
    const key = await prompt("Paste Kiro API key: ");
    const region = (await prompt("Region [us-east-1]: ")) || "us-east-1";
    saveCredentials(await validateApiKey(key, region));
    ok("Logged in with API key");
  } else if (method.startsWith("AWS Builder")) {
    const cred = await loginWithDeviceCode({
      onUserCode: async ({ userCode, verificationUriComplete, verificationUri }) => {
        console.log();
        info(`Open: ${verificationUriComplete || verificationUri}`);
        kv("Code", c.bold(userCode));
        console.log();
      },
    });
    saveCredentials(cred);
    ok("Logged in with Builder ID");
  } else {
    const token = await prompt("Paste refresh token: ");
    saveCredentials(await importRefreshToken(token));
    ok("Logged in with imported token");
  }
  await pause();
}

async function toolsFlow() {
  section("CLI Tools");
  kv("Default model", getDefaultModel());
  console.log();
  const statuses = await statusAll();
  printTable(statuses, [
    { key: "name", header: "NAME", width: 16 },
    { key: "id", header: "ID", width: 10 },
    {
      key: "configured",
      header: "STATUS",
      width: 14,
      format: (_v, s) =>
        s.configured ? "configured" : s.installed ? "installed" : s.guideOnly ? "guide" : "missing",
    },
  ]);
  console.log();
  const action = await choose("Action:", [
    "Install/apply to a tool",
    "Reset a tool",
    "Show Cursor guide",
    "Back",
  ]);
  if (!action || action === "Back") return;

  if (action.startsWith("Show Cursor")) {
    await applyTool("cursor");
    await pause();
    return;
  }

  const id = await choose(
    "Select tool:",
    listToolIds().filter((x) => x !== "cursor" || action.startsWith("Show"))
  );
  if (!id) return;

  if (action.startsWith("Reset")) {
    await resetTool(id);
    ok(`Reset ${id}`);
  } else {
    console.log();
    const model = await pickModel(getDefaultModel(), "Select main model");
    if (!model) {
      warn("Cancelled");
      await pause();
      return;
    }
    let subagentModel;
    if (toolSupportsSubagent(id)) {
      subagentModel = await pickSubagentModel(id, model);
    }
    saveConfig({ defaultModel: model });
    const result = await applyTool(id, { model, subagentModel });
    ok(`Applied ${id} → ${c.bold(model)}`);
    if (result.subagentModel || subagentModel) kv("Subagent", result.subagentModel || subagentModel);
    if (result.settingsPath) kv("Config", result.settingsPath);
    if (result.model && result.model !== model) kv("Client model", result.model);
    if (result.message) info(result.message);
  }
  await pause();
}

async function accountsFlow() {
  const action = await choose("Accounts:", [
    "List all + usage",
    "Import kiro_keys.txt",
    "Verify all tokens",
    "Show keys file path",
    "Back",
  ]);
  if (!action || action === "Back") return;

  if (action.startsWith("Show")) {
    kv("Keys file", keysFilePath());
    await pause();
    return;
  }

  if (action.startsWith("Import")) {
    const src = await prompt("Path to kiro_keys.txt: ");
    if (!src) return;
    const result = importKeysFile(src);
    ok(`Imported ${result.imported}. Total ${result.count}`);
    kv("Saved", result.path);
    await pause();
    return;
  }

  if (action.startsWith("Verify")) {
    const accounts = loadAccountsFromFile();
    if (!accounts.length) {
      warn("No accounts");
      await pause();
      return;
    }
    info(`Verifying all ${accounts.length} account(s)…`);
    const v = await verifyAccounts(Infinity, (row) => {
      const mark = row.ok ? c.green("✔") : c.red("✖");
      process.stdout.write(
        `\r  ${mark} ${String(row.index).padStart(3)}/${row.of}  ${row.email.padEnd(28)}          `
      );
    });
    console.log();
    if (v.fail === 0) ok(`All ${v.ok} OK`);
    else warn(`${v.ok} ok · ${v.fail} failed`);
    await pause();
    return;
  }

  const statuses = listAccountStatuses();
  if (!statuses.length) {
    warn(`No accounts. Expected: ${keysFilePath()}`);
    info("Format: email|refreshToken");
  } else {
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
  }
  await pause();
}

async function statusFlow() {
  const cfg = loadConfig();
  const cred = loadCredentials();
  section("Status");
  kv("Endpoint", getBaseUrl(cfg));
  kv("API key", cfg.localApiKey);
  kv("Logged in", isLoggedIn() ? c.green("yes") : c.red("no"));
  if (hasAccounts()) {
    printAccountSummary(listAccountStatuses(), keysFilePath());
  } else if (cred?.providerSpecificData?.authMethod) {
    kv("Auth", cred.providerSpecificData.authMethod);
  }
  kv("Models", `${STATIC_MODELS.length} static`);
  await pause();
}

async function usageFlow() {
  printPeriodStatsTable(getAllPeriodStats());
  console.log();
  const detail = await choose("Period / clear:", [
    ...PERIODS.map((p) => `${p.label} detail`),
    "Clear local stats",
    "Skip to Kiro quota",
  ]);
  if (detail?.startsWith("Clear")) {
    const conf = (await prompt("Type CLEAR to wipe: ")).trim();
    if (conf === "CLEAR") {
      clearStats();
      ok("Local stats cleared");
    } else warn("Cancelled");
  } else if (detail && !detail.startsWith("Skip")) {
    const period = PERIODS.find((p) => detail.startsWith(p.label));
    if (period) printPeriodDetail(getPeriodStats(period.id));
  }
  console.log();
  printLocalStats(getTotals());
  console.log();
  const accounts = loadAccountsFromFile();
  if (accounts.length) {
    info(`Fetching usage for all ${accounts.length} account(s)…`);
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
  } else {
    try {
      info("Fetching Kiro usage…");
      const usage = await fetchKiroUsage();
      printUsageBlock(usage);
    } catch (e) {
      warn(e.message || String(e));
    }
  }
  await pause();
}

export async function runMenu() {
  while (true) {
    console.clear?.();
    printBanner(pkgVersion());
    if (hasAccounts()) {
      const statuses = listAccountStatuses();
      const ready = statuses.filter((s) => s.ready && !s.cooling).length;
      console.log(
        `  ${c.dim("pool")}  ${c.bold(String(statuses.length))} accounts  ·  ${c.green(String(ready))} ready  ·  ${c.dim(keysFilePath())}`
      );
      console.log();
    } else if (isLoggedIn()) {
      console.log(`  ${c.dim("auth")}  ${c.green("single account")}`);
      console.log();
    } else {
      console.log(`  ${c.yellow("!")}  ${c.dim("not logged in — import kiro_keys.txt")}`);
      console.log();
    }

    const pick = await choose("Menu:", [
      "Start proxy (live log)",
      "Login / import keys",
      "Accounts pool",
      "Usage / quota",
      "Logout",
      "CLI Tools",
      "Status",
      "Exit",
    ]);
    if (!pick || pick === "Exit") break;

    try {
      if (pick.startsWith("Start")) {
        await runLiveProxy();
      } else if (pick.startsWith("Login")) {
        await loginFlow();
      } else if (pick.startsWith("Accounts")) {
        await accountsFlow();
      } else if (pick.startsWith("Usage")) {
        await usageFlow();
      } else if (pick === "Logout") {
        clearCredentials();
        ok("Logged out (single-account credentials)");
        await pause();
      } else if (pick.startsWith("CLI")) {
        await toolsFlow();
      } else if (pick === "Status") {
        await statusFlow();
      }
    } catch (e) {
      err(e.message || e);
      await pause();
    }
  }
}
