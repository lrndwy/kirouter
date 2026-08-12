import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBaseUrl, getContextCompactConfig, getDefaultModel, getTokenSaverConfig, loadConfig, saveConfig } from "./store/config.js";
import { clearCredentials, isLoggedIn, loadCredentials, saveCredentials } from "./store/credentials.js";
import {
  importKeysFile,
  keysFilePath,
  listAccountStatuses,
  loadAccountsFromFile,
} from "./store/accounts.js";
import { clearStats, getAllPeriodStats, getPeriodStats, getRecent, getTotals, PERIODS } from "./store/stats.js";
import { importRefreshToken, loginWithDeviceCode, validateApiKey } from "./kiro/auth.js";
import { accountLoginState, verifyAccounts } from "./kiro/pool.js";
import { fetchAllAccountsUsage, fetchKiroUsage } from "./kiro/usage.js";
import { applyTool, listToolIds, resetTool, resolveToolId, statusAll } from "./cli-tools/index.js";
import { printGuide as cursorGuide } from "./cli-tools/cursor.js";
import { STATIC_MODELS } from "./kiro/constants.js";
import { runLiveProxy } from "./tui/live.js";
import { runMenu } from "./tui/menu.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "./store/paths.js";
import {
  defaultSubagentForTool,
  pickModel,
  pickSubagentModel,
  prompt,
  toolSupportsSubagent,
} from "./util/input.js";
import {
  printAccountsUsageTable,
  printLocalStats,
  printPeriodDetail,
  printPeriodStatsTable,
  printRequestLog,
  printUsageBlock,
} from "./util/logger.js";
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
} from "./util/ui.js";

function pkgVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")
    );
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

function printHelp() {
  printBanner(pkgVersion());
  console.log(`${c.bold("Usage")}
  kirouter                      Start proxy + live dashboard
  kirouter start                Same as above
  kirouter menu                 Interactive setup menu
  kirouter usage                Show Kiro quota + token periods
  kirouter usage [1d|3d|7d|30d|all]
  kirouter usage clear          Wipe local token history
  kirouter login                Login (kiro_keys.txt / single)
  kirouter logout               Clear single-account credentials
  kirouter status               Endpoint + auth status
  kirouter accounts             List all accounts + usage
  kirouter accounts import <f>  Import/merge keys file
  kirouter accounts verify [n]  Verify tokens (default: all)
  kirouter tools                CLI tools status
  kirouter tools models         List available models
  kirouter tools <name>         Install into a CLI tool (picks model + subagent)
  kirouter tools <name> --model <id> [--subagent-model <id>]
  kirouter tools reset <name>
                                Tools: claude, cowork, codex, opencode, droid, cline, cursor
                                Aliases: desktop|claude-desktop|claude-cowork → cowork
  kirouter config               Show token-saver / context-compact settings
  kirouter config set <k> <v>   Toggle e.g. tokenSaver.enabled true
  kirouter --help

${c.bold("Token saver")}  ${c.dim("default on — truncate large tool results, compact history ≥70% window")}
  No extra Kiro/LLM calls. Stats appear as ${c.green("saved")} / ${c.yellow("compact")} in Activity + log.

${c.bold("Live keys")} (saat proxy jalan)
  L logs (scrollable frame) · m menu · h help · u usage · s stats
  c refresh · a accounts · t tools · q quit

${c.bold("Multi-account")}  ${c.dim("email|refreshToken")} per line
  Default: ~/.kirouter/kiro_keys.txt  or  ./kiro_keys.txt
  Failover on 429 / 401 / 403 (round-robin + cooldown)

${c.bold("Flags")}
  -p, --port <n>     Port (default ${DEFAULT_PORT})
  -H, --host <host>  Host (default ${DEFAULT_HOST})
  --no-auth          Disable local API key check
  --model <id>       Main model when applying CLI tools
  --subagent-model <id>  Subagent model (claude/codex/opencode)

${c.bold("Examples")}
  kirouter
  kirouter accounts import ./kiro_keys.txt
  kirouter usage
  kirouter tools claude --model claude-sonnet-4.5 --subagent-model claude-haiku-4.5
  kirouter tools cowork --model claude-sonnet-4.5
  kirouter tools desktop --model claude-sonnet-4.5
`);
}

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p" || a === "--port") args.flags.port = Number(argv[++i]);
    else if (a === "-H" || a === "--host") args.flags.host = argv[++i];
    else if (a === "--no-auth") args.flags.noAuth = true;
    else if (a === "--model") args.flags.model = argv[++i];
    else if (a === "--subagent-model" || a === "--subagent") args.flags.subagentModel = argv[++i];
    else if (a === "-h" || a === "--help") args.flags.help = true;
    else if (a === "-v" || a === "--version") args.flags.version = true;
    else args._.push(a);
  }
  return args;
}

function findDefaultKeysSource() {
  const candidates = [
    path.resolve("kiro_keys.txt"),
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "kiro_keys.txt"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && loadAccountsFromFile(p).length) return p;
  }
  return null;
}

async function cmdStart(flags) {
  if (flags.port) saveConfig({ port: flags.port });
  if (flags.host) saveConfig({ host: flags.host });
  const login = accountLoginState();
  if (login.mode === "none") {
    const src = findDefaultKeysSource();
    if (src) {
      const result = importKeysFile(src);
      ok(`Auto-imported ${result.imported} account(s) from ${src}`);
    }
  }
  return runLiveProxy(flags);
}

async function cmdUsage(sub = []) {
  printBanner(pkgVersion());
  const arg = (sub[0] || "").toLowerCase();

  if (arg === "clear") {
    clearStats();
    ok("Local token stats + history cleared");
    return;
  }

  const periodIds = new Set(PERIODS.map((p) => p.id));
  if (arg && periodIds.has(arg)) {
    printPeriodDetail(getPeriodStats(arg));
    console.log();
    printPeriodStatsTable(getAllPeriodStats());
    return;
  }

  printPeriodStatsTable(getAllPeriodStats());
  console.log();
  printLocalStats(getTotals());
  console.log();
  const recent = getRecent(10);
  if (recent.length) {
    section("Recent requests");
    for (const e of recent.slice().reverse()) printRequestLog(e);
    console.log();
  }

  const accounts = loadAccountsFromFile();
  if (accounts.length) {
    info(`Fetching usage for all ${accounts.length} account(s)…`);
    const result = await fetchAllAccountsUsage({
      onProgress: (row, i, total) => {
        const mark = row.ok ? c.green("✔") : c.red("✖");
        const credit = row.ok ? c.dim(row.credit) : c.dim(String(row.error || "").slice(0, 40));
        process.stdout.write(`\r  ${mark} ${String(i).padStart(3)}/${total}  ${row.email.padEnd(28)} ${credit}   `);
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
  console.log();
}

async function cmdLogin() {
  printBanner(pkgVersion());
  section("Login");
  const detected = findDefaultKeysSource();
  if (detected) {
    info(`Found keys file: ${detected} (${loadAccountsFromFile(detected).length} accounts)`);
  }

  console.log();
  console.log(`  ${c.cyan("1")}  Import kiro_keys.txt ${c.dim("(multi-account — recommended)")}`);
  console.log(`  ${c.cyan("2")}  Kiro API key`);
  console.log(`  ${c.cyan("3")}  Builder ID device code`);
  console.log(`  ${c.cyan("4")}  Import single refresh token`);
  console.log();
  const choice = await prompt("Choose [1-4]: ");

  if (choice === "1" || choice === "") {
    const def = detected || "./kiro_keys.txt";
    const src = (await prompt(`Path to kiro_keys.txt [${def}]: `)) || def;
    if (!fs.existsSync(src)) throw new Error(`File not found: ${src}`);
    const result = importKeysFile(src);
    ok(`Imported ${result.imported} account(s). Pool size: ${result.count}`);
    kv("Saved", result.path);
    info(`Verifying all ${result.count} account(s)…`);
    const v = await verifyAccounts(Infinity, (row) => {
      const mark = row.ok ? c.green("✔") : c.red("✖");
      process.stdout.write(
        `\r  ${mark} ${String(row.index).padStart(3)}/${row.of}  ${row.email.padEnd(28)}          `
      );
    });
    console.log();
    if (v.ok) ok(`${v.ok}/${v.sampled} verified`);
    if (v.fail) warn(`${v.fail} failed (will rotate on request)`);
    return;
  }

  if (choice === "2") {
    const key = await prompt("API key: ");
    const region = (await prompt("Region [us-east-1]: ")) || "us-east-1";
    saveCredentials(await validateApiKey(key, region));
    ok("Logged in with API key");
    return;
  }

  if (choice === "3") {
    saveCredentials(
      await loginWithDeviceCode({
        onUserCode: async ({ userCode, verificationUriComplete, verificationUri }) => {
          console.log();
          info(`Open: ${verificationUriComplete || verificationUri}`);
          kv("Code", c.bold(userCode));
          console.log();
        },
      })
    );
    ok("Logged in with Builder ID");
    return;
  }

  if (choice === "4") {
    const token = await prompt("Refresh token: ");
    saveCredentials(await importRefreshToken(token));
    ok("Logged in with refresh token");
    return;
  }

  throw new Error("Invalid choice");
}

async function cmdStatus() {
  printBanner(pkgVersion());
  const cfg = loadConfig();
  const cred = loadCredentials();
  const login = accountLoginState();
  section("Status");
  kv("Endpoint", getBaseUrl(cfg));
  kv("API key", cfg.localApiKey);
  kv("Logged in", isLoggedIn() ? c.green("yes") : c.red("no"));
  kv(
    "Mode",
    login.mode === "keys"
      ? `${c.cyan("keys")} ${c.dim(`(${login.count} accounts)`)}`
      : login.mode === "single"
        ? c.cyan("single")
        : c.dim("none")
  );
  if (login.mode === "keys") {
    const statuses = listAccountStatuses();
    printAccountSummary(statuses, keysFilePath());
  } else if (cred?.providerSpecificData?.authMethod) {
    kv("Auth", cred.providerSpecificData.authMethod);
  }
  console.log();
}

async function cmdAccounts(argv) {
  const sub = argv[0];
  if (sub === "import") {
    const src = argv[1];
    if (!src) throw new Error("Usage: kirouter accounts import <kiro_keys.txt>");
    printBanner(pkgVersion());
    const result = importKeysFile(src);
    ok(`Imported ${result.imported} account(s). Total: ${result.count}`);
    kv("Saved", result.path);
    return;
  }

  if (sub === "verify") {
    const n = argv[1] != null ? Number(argv[1]) : Infinity;
    printBanner(pkgVersion());
    const file = keysFilePath();
    const accounts = loadAccountsFromFile(file);
    if (!accounts.length) {
      err(`No accounts at ${file}`);
      info("Import with: kirouter accounts import ./kiro_keys.txt");
      return;
    }
    const count = Number.isFinite(n) && n > 0 ? Math.min(n, accounts.length) : accounts.length;
    section(`Verify all tokens (${count} of ${accounts.length})`);
    const v = await verifyAccounts(n, (row) => {
      const mark = row.ok ? c.green("✔") : c.red("✖");
      process.stdout.write(
        `\r  ${mark} ${String(row.index).padStart(3)}/${row.of}  ${row.email.padEnd(28)}          `
      );
      if (!row.ok && row.error) {
        console.log();
        console.log(`      ${c.dim(row.error.slice(0, 100))}`);
      }
    });
    console.log();
    hr();
    if (v.fail === 0) ok(`All ${v.ok} accounts OK`);
    else warn(`${v.ok} ok · ${v.fail} failed`);
    return;
  }

  if (sub && sub !== "list") {
    throw new Error(`Unknown accounts command: ${sub}. Use: list | import <file> | verify [n]`);
  }

  printBanner(pkgVersion());
  const file = keysFilePath();
  const accounts = loadAccountsFromFile(file);
  if (!accounts.length) {
    warn(`No accounts. Put kiro_keys.txt at ${file}`);
    info("Format: email|refreshToken");
    info("Or: kirouter accounts import ./kiro_keys.txt");
    return;
  }

  const statuses = listAccountStatuses(file);
  printAccountSummary(statuses, file);
  console.log();
  printTable(statuses, [
    {
      key: "email",
      header: "EMAIL",
      width: 28,
    },
    {
      key: "state",
      header: "STATE",
      width: 18,
      format: (_v, row) => accountStateLabel(row).text,
    },
    {
      key: "hasToken",
      header: "TOKEN",
      width: 6,
      format: (v) => (v ? "yes" : "no"),
    },
  ]);
  console.log();
  info(`Fetching usage for all ${accounts.length} account(s)…`);
  const result = await fetchAllAccountsUsage({
    onProgress: (row, i, total) => {
      const mark = row.ok ? c.green("✔") : c.red("✖");
      const credit = row.ok ? c.dim(row.credit) : c.dim("fail");
      process.stdout.write(`\r  ${mark} ${String(i).padStart(3)}/${total}  ${row.email.padEnd(28)} ${credit}   `);
    },
  });
  console.log();
  console.log();
  printAccountsUsageTable(result.rows);
  console.log();
}

async function resolveToolModels(toolId, flags) {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  let model = flags.model ? String(flags.model).replace(/^kr\//, "") : null;
  if (!model) {
    if (interactive) {
      printBanner(pkgVersion());
      section("CLI Tools · model");
      kv("Tool", toolId);
      kv("Default", getDefaultModel());
      console.log();
      model = await pickModel(getDefaultModel(), "Select main model");
      if (!model) throw new Error("Model selection cancelled");
    } else {
      model = getDefaultModel();
    }
  }

  let subagentModel = flags.subagentModel
    ? String(flags.subagentModel).replace(/^kr\//, "")
    : null;
  if (!subagentModel && toolSupportsSubagent(toolId)) {
    subagentModel = interactive
      ? await pickSubagentModel(toolId, model)
      : defaultSubagentForTool(toolId, model);
  }
  return { model, subagentModel };
}

async function cmdTools(argv, flags) {
  const sub = argv[0];
  if (!sub) {
    printBanner(pkgVersion());
    section("CLI Tools");
    kv("Default model", getDefaultModel());
    console.log();
    const rows = await statusAll();
    printTable(rows, [
      { key: "id", header: "TOOL", width: 10 },
      {
        key: "installed",
        header: "BINARY",
        width: 10,
        format: (v) => (v ? "installed" : "missing"),
      },
      {
        key: "configured",
        header: "CONFIG",
        width: 12,
        format: (v, row) => (row.guideOnly ? "guide" : v ? "configured" : "—"),
      },
    ]);
    console.log();
    info("Apply: kirouter tools <name> [--model id] [--subagent-model id]");
    info(`Models: ${STATIC_MODELS.map((m) => m.id).slice(0, 5).join(", ")}…`);
    info("Subagent: claude (haiku) · codex · opencode (explorer)");
    info("Desktop:  cowork / desktop → Claude Desktop Cowork (quit & reopen after apply)");
    console.log();
    return;
  }
  if (sub === "models") {
    printBanner(pkgVersion());
    section("Available models");
    kv("Default", getDefaultModel());
    console.log();
    printTable(STATIC_MODELS, [
      { key: "id", header: "ID", width: 22 },
      { key: "name", header: "NAME", width: 28 },
    ]);
    console.log();
    return;
  }
  if (sub === "reset") {
    const id = argv[1];
    if (!id) throw new Error("Usage: kirouter tools reset <name>");
    const resolved = resolveToolId(id);
    await resetTool(resolved);
    ok(`Reset ${resolved}`);
    return;
  }
  const toolId = resolveToolId(sub);
  if (toolId === "cursor") return cursorGuide();
  if (!listToolIds().includes(toolId)) throw new Error(`Unknown tool: ${sub}`);
  const { model, subagentModel } = await resolveToolModels(toolId, flags);
  saveConfig({ defaultModel: model });
  const result = await applyTool(toolId, { model, subagentModel });
  if (!result.guideOnly) {
    ok(`Applied ${toolId} → ${c.bold(model)}`);
    if (subagentModel || result.subagentModel) {
      kv("Subagent", result.subagentModel || subagentModel);
    }
    if (result.settingsPath) kv("Config", result.settingsPath);
    if (result.model && result.model !== model) kv("Client model", result.model);
    if (result.message) info(result.message);
  }
}

async function cmdConfig(sub = []) {
  printBanner(pkgVersion());
  const action = (sub[0] || "").toLowerCase();

  if (action === "set" && sub[1]) {
    const key = sub[1];
    const raw = sub[2];
    if (raw == null) throw new Error("Usage: kirouter config set <key> <value>");
    let value = raw;
    if (raw === "true") value = true;
    else if (raw === "false") value = false;
    else if (/^\d+$/.test(raw)) value = Number(raw);

    const patch = {};
    if (key.startsWith("tokenSaver.")) {
      const field = key.slice("tokenSaver.".length);
      patch.tokenSaver = { [field]: value };
    } else if (key.startsWith("contextCompact.")) {
      const field = key.slice("contextCompact.".length);
      patch.contextCompact = { [field]: value };
    } else {
      throw new Error(
        `Unknown key: ${key}. Use tokenSaver.enabled|maxToolResultChars|stripImages or contextCompact.enabled|thresholdPct|keepRecentMessages`
      );
    }
    const next = saveConfig(patch);
    ok(`Updated ${key} = ${JSON.stringify(value)}`);
    section("Config");
    kv("tokenSaver", JSON.stringify(next.tokenSaver));
    kv("contextCompact", JSON.stringify(next.contextCompact));
    return;
  }

  section("Token saver / context compact");
  const ts = getTokenSaverConfig();
  const cc = getContextCompactConfig();
  kv("tokenSaver.enabled", String(ts.enabled));
  kv("tokenSaver.maxToolResultChars", String(ts.maxToolResultChars));
  kv("tokenSaver.stripImages", String(ts.stripImages));
  kv("contextCompact.enabled", String(cc.enabled));
  kv("contextCompact.thresholdPct", `${cc.thresholdPct}%`);
  kv("contextCompact.keepRecentMessages", String(cc.keepRecentMessages));
  console.log();
  info("Set: kirouter config set tokenSaver.enabled false");
  info("     kirouter config set contextCompact.thresholdPct 80");
}

export async function runCli(argv) {
  const args = parseArgs(argv);
  if (args.flags.help) return printHelp();
  if (args.flags.version) {
    console.log(pkgVersion());
    return;
  }

  const cmd = args._[0];
  // Default: auto-start proxy with live interactive dashboard
  if (!cmd) return cmdStart(args.flags);

  if (cmd === "start") return cmdStart(args.flags);
  if (cmd === "menu") return runMenu();
  if (cmd === "usage") return cmdUsage(args._.slice(1));
  if (cmd === "login") return cmdLogin();
  if (cmd === "logout") {
    clearCredentials();
    ok("Logged out (single-account credentials cleared)");
    return;
  }
  if (cmd === "status") return cmdStatus();
  if (cmd === "accounts") return cmdAccounts(args._.slice(1));
  if (cmd === "tools") return cmdTools(args._.slice(1), args.flags);
  if (cmd === "config") return cmdConfig(args._.slice(1));
  if (cmd === "help") return printHelp();

  throw new Error(`Unknown command: ${cmd}. Try kirouter --help`);
}
