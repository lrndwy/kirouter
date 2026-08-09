/** Minimal ANSI UI — no deps. Honors NO_COLOR / non-TTY. */

const enabled =
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb" &&
  !!(process.stdout.isTTY || process.env.FORCE_COLOR);

const wrap = (code, s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  dim: (s) => wrap("2", s),
  bold: (s) => wrap("1", s),
  green: (s) => wrap("32", s),
  yellow: (s) => wrap("33", s),
  red: (s) => wrap("31", s),
  cyan: (s) => wrap("36", s),
  magenta: (s) => wrap("35", s),
  white: (s) => wrap("37", s),
};

export function badge(kind, label) {
  const map = {
    ok: c.green,
    warn: c.yellow,
    err: c.red,
    info: c.cyan,
    idle: c.dim,
  };
  const paint = map[kind] || c.dim;
  return paint(c.bold(` ${label} `));
}

export function printBanner(version) {
  const width = 46;
  const title = `kirouter  ·  Kiro proxy CLI${version ? `  v${version}` : ""}`;
  const pad = Math.max(0, width - title.length - 2);
  const line = "─".repeat(width);
  console.log();
  console.log(c.cyan(`  ┌${line}┐`));
  console.log(c.cyan("  │") + c.bold(` ${title}`) + " ".repeat(pad) + c.cyan(" │"));
  console.log(c.cyan(`  └${line}┘`));
  console.log();
}

export function section(title) {
  console.log(c.bold(`▸ ${title}`));
}

export function kv(key, value, keyWidth = 12) {
  console.log(`  ${c.dim(String(key).padEnd(keyWidth))} ${value}`);
}

export function hr() {
  console.log(c.dim("  " + "─".repeat(46)));
}

/** Simple fixed-width table. columns: [{key,header,width,align?,format?}] */
export function printTable(rows, columns) {
  if (!rows.length) {
    console.log(c.dim("  (empty)"));
    return;
  }
  const head = columns
    .map((col) => {
      const h = String(col.header).padEnd(col.width).slice(0, col.width);
      return c.dim(h);
    })
    .join(" ");
  console.log(`  ${head}`);
  console.log(c.dim("  " + columns.map((col) => "─".repeat(col.width)).join("─")));
  for (const row of rows) {
    const cells = columns.map((col) => {
      let raw = col.format ? col.format(row[col.key], row) : row[col.key];
      raw = String(raw ?? "");
      if (raw.length > col.width) raw = raw.slice(0, col.width - 1) + "…";
      return col.align === "right" ? raw.padStart(col.width) : raw.padEnd(col.width);
    });
    console.log(`  ${cells.join(" ")}`);
  }
}

export function accountStateLabel(s) {
  if (s.cooling) return { kind: "warn", text: `cooldown ${Math.ceil(s.cooldownMs / 1000)}s` };
  if (s.ready) return { kind: "ok", text: "ready" };
  return { kind: "idle", text: "idle" };
}

export function summarizeAccounts(statuses) {
  const ready = statuses.filter((s) => s.ready && !s.cooling).length;
  const cooling = statuses.filter((s) => s.cooling).length;
  const idle = statuses.length - ready - cooling;
  return { total: statuses.length, ready, cooling, idle };
}

export function printAccountSummary(statuses, filePath) {
  const sum = summarizeAccounts(statuses);
  section("Accounts");
  kv("File", c.dim(filePath));
  kv(
    "Pool",
    `${c.bold(String(sum.total))} total  ·  ${c.green(String(sum.ready))} ready  ·  ${c.yellow(String(sum.cooling))} cooldown  ·  ${c.dim(String(sum.idle))} idle`
  );
}

export function ok(msg) {
  console.log(`${c.green("✔")} ${msg}`);
}

export function warn(msg) {
  console.log(`${c.yellow("!")} ${msg}`);
}

export function err(msg) {
  console.log(`${c.red("✖")} ${msg}`);
}

export function info(msg) {
  console.log(`${c.cyan("→")} ${msg}`);
}
