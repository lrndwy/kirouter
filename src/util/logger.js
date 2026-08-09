import { formatContext } from "../kiro/constants.js";
import { c, hr, kv, printTable, section, warn } from "./ui.js";

function ts(d = new Date()) {
  return d.toTimeString().slice(0, 8);
}

function statusColor(status) {
  if (status >= 200 && status < 300) return c.green(String(status));
  if (status >= 400 && status < 500) return c.yellow(String(status));
  if (status >= 500) return c.red(String(status));
  return c.dim(String(status || "…"));
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString("en-US");
}

export function progressBar(pct, width = 12) {
  const n = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  const fill = "█".repeat(n);
  const empty = "░".repeat(width - n);
  const color = pct > 70 ? c.green : pct >= 30 ? c.yellow : c.red;
  return color(fill + empty);
}

/** Format request log as lines (for scrollable frame). */
export function formatRequestLogLines(entry) {
  const time = c.dim(ts(new Date(entry.at)));
  const method = c.cyan((entry.method || "POST").padEnd(4));
  const path = (entry.path || "").replace(/^\/v1\//, "");
  const model = entry.model ? c.bold(entry.model) : c.dim("-");
  const account = entry.account ? c.dim(entry.account) : "";
  const stream = entry.stream ? c.dim("stream") : c.dim("json  ");
  const errMsg = entry.error ? ` ${c.red(String(entry.error).slice(0, 60))}` : "";

  const lines = [
    `${time}  ${method} ${path.padEnd(18)} ${statusColor(entry.status)}  ${String(entry.ms).padStart(5)}ms  ${stream}  ${model}${account ? `  ${account}` : ""}${errMsg}`,
  ];

  const hasTokens = entry.promptTokens || entry.completionTokens || entry.maxContext;
  if (hasTokens || entry.contextPct != null) {
    const inn = c.cyan(`in ${fmtNum(entry.promptTokens)}`);
    const out = c.green(`out ${fmtNum(entry.completionTokens)}`);
    const total = (entry.promptTokens || 0) + (entry.completionTokens || 0);
    const ctxMax = formatContext(entry.maxContext);
    let ctxPart = c.dim(`ctx max ${ctxMax}`);
    if (entry.contextPct != null && Number.isFinite(Number(entry.contextPct))) {
      const pct = Math.round(Number(entry.contextPct));
      ctxPart = `${c.dim("ctx")} ${progressBar(pct, 10)} ${c.bold(`${pct}%`)} ${c.dim(`/ ${ctxMax}`)}`;
    } else if (entry.maxContext && total) {
      const pct = Math.min(100, Math.round((total / entry.maxContext) * 100));
      ctxPart = `${c.dim("ctx")} ${progressBar(pct, 10)} ${c.bold(`${pct}%`)} ${c.dim(`/ ${ctxMax}`)}`;
    }
    lines.push(`          ${inn}  ·  ${out}  ·  ${ctxPart}`);
  }
  return lines;
}

/** Professional request log with tokens + context. */
export function printRequestLog(entry) {
  for (const line of formatRequestLogLines(entry)) console.log(line);
}

export function printUsageBlock(usage) {
  section("Kiro Usage");
  if (usage.account) kv("Account", usage.account);
  if (usage.plan) kv("Plan", usage.plan);
  if (usage.resetAt) {
    const d = new Date(usage.resetAt);
    kv(
      "Reset",
      Number.isFinite(d.getTime())
        ? d.toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })
        : String(usage.resetAt)
    );
  }
  console.log();
  if (!usage.quotas?.length) {
    warn(usage.message || "No quota data");
    return;
  }
  printTable(
    usage.quotas.map((q) => ({
      name: q.name,
      used: `${Math.round(q.used)}/${Math.round(q.total)}`,
      left: `${q.pct}%`,
      bar: progressBar(q.pct),
    })),
    [
      { key: "name", header: "RESOURCE", width: 22 },
      { key: "used", header: "USED/LIMIT", width: 16 },
      { key: "left", header: "LEFT", width: 6, align: "right" },
      { key: "bar", header: "", width: 14 },
    ]
  );
  hr();
}

/** Print full account table with per-account usage rows. */
export function printAccountsUsageTable(rows) {
  if (!rows?.length) {
    warn("No accounts");
    return;
  }
  section(`Accounts usage (${rows.length})`);
  printTable(rows, [
    { key: "email", header: "EMAIL", width: 26 },
    {
      key: "ok",
      header: "TOKEN",
      width: 6,
      format: (v) => (v ? "ok" : "fail"),
    },
    { key: "plan", header: "PLAN", width: 12 },
    { key: "credit", header: "CREDIT", width: 12 },
    {
      key: "pct",
      header: "LEFT",
      width: 6,
      align: "right",
      format: (v, row) => (row.ok ? `${v}%` : "-"),
    },
    {
      key: "pct",
      header: "",
      width: 12,
      format: (v, row) => (row.ok ? progressBar(v) : c.dim("————")),
    },
  ]);
  const okRows = rows.filter((r) => r.ok);
  const ok = okRows.length;
  const fail = rows.length - ok;
  const usedSum = okRows.reduce((s, r) => s + (Number(r.used) || 0), 0);
  const totalCap = okRows.reduce((s, r) => s + (Number(r.total) || 0), 0);
  const leftSum = Math.max(0, totalCap - usedSum);
  const leftPct = totalCap > 0 ? Math.round((leftSum / totalCap) * 100) : 0;
  const usedPct = totalCap > 0 ? Math.round((usedSum / totalCap) * 100) : 0;

  console.log();
  section("Akumulasi semua akun");
  kv("Accounts", `${c.green(String(ok))} ok  ·  ${c.red(String(fail))} fail  ·  ${rows.length} total`);
  kv(
    "Credit used",
    `${c.bold(fmtNum(Math.round(usedSum)))} / ${fmtNum(Math.round(totalCap))}  (${usedPct}%)`
  );
  kv(
    "Credit left",
    `${c.green(fmtNum(Math.round(leftSum)))} / ${fmtNum(Math.round(totalCap))}  (${leftPct}%)  ${progressBar(leftPct)}`
  );
}

export function printLocalStats(totals) {
  const uptimeSec = Math.max(1, Math.floor((Date.now() - (totals.startedAt || Date.now())) / 1000));
  section("Local usage (all time)");
  kv(
    "Requests",
    `${c.bold(String(totals.requests))}  ${c.green(String(totals.ok))} ok  ${c.red(String(totals.err))} err`
  );
  kv(
    "Tokens",
    `${c.cyan("in " + fmtNum(totals.promptTokens))}  ·  ${c.green("out " + fmtNum(totals.completionTokens))}  ·  total ${fmtNum((totals.promptTokens || 0) + (totals.completionTokens || 0))}`
  );
  kv("Uptime", formatUptime(uptimeSec));
  const models = Object.entries(totals.byModel || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (models.length) {
    console.log();
    console.log(c.dim("  By model"));
    for (const [m, n] of models) console.log(`    ${m.padEnd(24)} ${n}`);
  }
  const accounts = Object.entries(totals.byAccount || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (accounts.length) {
    console.log();
    console.log(c.dim("  By account"));
    for (const [a, n] of accounts) console.log(`    ${a.padEnd(28)} ${n}`);
  }
}

/** Print token usage across 1d / 3d / 7d / 30d / all. */
export function printPeriodStatsTable(periodRows) {
  section("Token usage by period");
  printTable(
    periodRows.map((r) => ({
      period: r.period.label,
      req: String(r.requests),
      inn: fmtNum(r.promptTokens),
      out: fmtNum(r.completionTokens),
      total: fmtNum(r.totalTokens ?? (r.promptTokens || 0) + (r.completionTokens || 0)),
    })),
    [
      { key: "period", header: "PERIOD", width: 10 },
      { key: "req", header: "REQ", width: 8, align: "right" },
      { key: "inn", header: "INPUT", width: 12, align: "right" },
      { key: "out", header: "OUTPUT", width: 12, align: "right" },
      { key: "total", header: "TOTAL", width: 12, align: "right" },
    ]
  );
}

export function printPeriodDetail(stats) {
  section(`Usage · ${stats.period.label}`);
  kv("Requests", `${c.bold(String(stats.requests))}  ${c.green(String(stats.ok))} ok  ${c.red(String(stats.err))} err`);
  kv("Input", c.cyan(fmtNum(stats.promptTokens)));
  kv("Output", c.green(fmtNum(stats.completionTokens)));
  kv("Total", fmtNum(stats.totalTokens ?? (stats.promptTokens || 0) + (stats.completionTokens || 0)));
  const models = Object.entries(stats.byModel || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (models.length) {
    console.log();
    console.log(c.dim("  By model (requests)"));
    for (const [m, n] of models) console.log(`    ${m.padEnd(24)} ${n}`);
  }
}

function formatUptime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
