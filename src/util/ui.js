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

/** Strip ANSI CSI sequences (for width math). */
export function stripAnsi(s) {
  return String(s || "").replace(/\x1b\[[0-9;]*m/g, "");
}

/** Pad/truncate by visible (non-ANSI) width. */
export function padVisible(str, width) {
  const s = String(str ?? "");
  const vis = stripAnsi(s).length;
  if (vis === width) return s;
  if (vis < width) return s + " ".repeat(width - vis);
  // Truncate preserving ANSI escapes
  let out = "";
  let n = 0;
  let i = 0;
  const limit = Math.max(0, width - 1);
  while (i < s.length && n < limit) {
    if (s[i] === "\x1b") {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i++];
    n++;
  }
  return out + (width > 0 ? "…" : "");
}

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

/**
 * Aligned Unicode box. `width` = inner content columns (between │ │).
 * Outer width is always width + 2 so corners line up.
 */
export function boxTop(title, width, color = c.cyan) {
  const w = Math.max(8, width);
  if (!title) return color("┌" + "─".repeat(w) + "┐");
  const label = ` ${String(title).trim()} `;
  const labelLen = stripAnsi(label).length;
  const rest = Math.max(0, w - 1 - labelLen); // after leading ┌─
  return color("┌─") + c.bold(label) + color("─".repeat(rest) + "┐");
}

export function boxBottom(width, color = c.cyan, footer = "") {
  const w = Math.max(8, width);
  if (!footer) return color("└" + "─".repeat(w) + "┘");
  const label = ` ${String(footer).trim()} `;
  const labelLen = stripAnsi(label).length;
  const rest = Math.max(0, w - 1 - labelLen);
  return color("└─") + c.dim(label) + color("─".repeat(rest) + "┘");
}

export function boxRow(content, width, color = c.cyan) {
  const w = Math.max(8, width);
  return color("│") + padVisible(content ?? "", w) + color("│");
}

/** Print a full box with optional title; lines are content strings. */
export function printBox(lines, { title = "", width = 56, indent = "  ", color = c.cyan, footer = "" } = {}) {
  const w = Math.max(24, width);
  console.log(indent + boxTop(title, w, color));
  for (const line of lines) console.log(indent + boxRow(line, w, color));
  console.log(indent + boxBottom(w, color, footer));
}

/**
 * Hardcoded ASCII brand mark (compact) + wordmark.
 */
export function asciiLogoLines(version) {
  const ver = version ? `v${version}` : "";
  const art = [
    "           ,--,",
    "     _ ___/ /\\|",
    " ,;'( )__, )  ~",
    "//  //   '--;",
    "'   \\     | ^",
    "     ^    ^",
  ];
  const lines = art.map((line) => c.cyan(line));
  lines.push("");
  lines.push("     " + c.bold("kirouter") + (ver ? c.dim(`  ${ver}`) : ""));
  lines.push("     " + c.dim("Kiro proxy CLI"));
  return lines;
}

export function printAsciiLogo(version) {
  console.log();
  for (const line of asciiLogoLines(version)) console.log(line);
}

export function printBanner(version) {
  printAsciiLogo(version);
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

export function formatAccountsShort(statuses) {
  if (!statuses?.length) return c.dim("no accounts");
  const sum = summarizeAccounts(statuses);
  return `${c.green(String(sum.ready))} ready / ${sum.total}`;
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
