/**
 * Minimal live dashboard + scrollable log frame (toggle with L).
 * Layout (minimal): ASCII art left · status + activity boxes right.
 */
import { formatContext } from "../kiro/constants.js";
import { formatRequestLogLines } from "../util/logger.js";
import {
  asciiLogoLines,
  boxBottom,
  boxRow,
  boxTop,
  c,
  padVisible,
  stripAnsi,
} from "../util/ui.js";

const MAX_ENTRIES = 400;
const MIN_RIGHT = 36;
const GAP = 3;

function termWidth() {
  return Math.max(60, process.stdout.columns || 80);
}

function termHeight() {
  return Math.max(16, process.stdout.rows || 24);
}

function statusDot(ok) {
  return ok ? c.green("●") : c.yellow("●");
}

function contentWidth() {
  return Math.max(40, Math.min(100, termWidth() - 4));
}

export class LiveDashboard {
  /**
   * @param {{ port: number, host: string, version: string, baseUrl: string, apiKey: string, model: string, accountsLabel: string }} meta
   */
  constructor(meta) {
    this.meta = meta;
    this.entries = [];
    this.mode = "minimal"; // 'minimal' | 'logs'
    this.scroll = 0;
    this.follow = true;
    this.totalRequests = 0;
    this.lastEntry = null;
  }

  setMeta(partial) {
    this.meta = { ...this.meta, ...partial };
  }

  push(entry) {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.totalRequests += 1;
    this.lastEntry = entry;
    if (this.mode === "logs") {
      if (this.follow) this.scroll = 0;
      this.render();
    } else {
      this.renderMinimalActivity();
    }
  }

  isLogsOpen() {
    return this.mode === "logs";
  }

  openLogs() {
    this.mode = "logs";
    this.follow = true;
    this.scroll = 0;
    this.render();
  }

  closeLogs() {
    this.mode = "minimal";
    this.render();
  }

  toggleLogs() {
    if (this.mode === "logs") this.closeLogs();
    else this.openLogs();
  }

  /** @param {'up'|'down'|'pageup'|'pagedown'|'home'|'end'} dir */
  scrollLogs(dir) {
    if (this.mode !== "logs") return;
    const lines = this.#allLogLines();
    const viewH = this.#logViewHeight();
    const maxScroll = Math.max(0, lines.length - viewH);
    const step = dir === "pageup" || dir === "pagedown" ? viewH - 1 : 1;
    if (dir === "up" || dir === "pageup") {
      this.scroll = Math.min(maxScroll, this.scroll + step);
      this.follow = this.scroll === 0;
    } else if (dir === "down" || dir === "pagedown") {
      this.scroll = Math.max(0, this.scroll - step);
      this.follow = this.scroll === 0;
    } else if (dir === "home") {
      this.scroll = maxScroll;
      this.follow = false;
    } else if (dir === "end") {
      this.scroll = 0;
      this.follow = true;
    }
    this.render();
  }

  render() {
    console.clear();
    if (this.mode === "logs") this.#paintLogs();
    else this.#paintMinimal();
  }

  renderMinimalActivity() {
    this.#paintMinimalRedrawSafe();
  }

  #paintMinimalRedrawSafe() {
    if (process.stdout.isTTY) process.stdout.write("\x1b[H\x1b[J");
    else console.clear();
    this.#paintMinimal();
  }

  /** ASCII art (left) + status/activity boxes (right). */
  #paintMinimal() {
    const logo = asciiLogoLines(this.meta.version);
    const logoW = Math.max(...logo.map((l) => stripAnsi(l).length), 28);

    // right box inner width: terminal - indent - logo - gap - box chrome(2)
    const availRight = termWidth() - 2 - logoW - GAP - 2;
    const sideBySide = availRight >= MIN_RIGHT;

    console.log();

    if (!sideBySide) {
      // Narrow terminal: stack
      for (const line of logo) console.log(`  ${line}`);
      console.log();
      const w = contentWidth();
      for (const line of this.#statusBoxLines(w)) console.log(`  ${line}`);
      console.log();
      for (const line of this.#activityBoxLines(w)) console.log(`  ${line}`);
      console.log();
      this.#paintKeyHint(false);
      return;
    }

    const rightW = Math.min(64, availRight);
    const right = [
      ...this.#statusBoxLines(rightW),
      "",
      ...this.#activityBoxLines(rightW),
    ];

    // Vertically center the right column against the logo
    const padTop = Math.max(0, Math.floor((logo.length - right.length) / 2));
    const rightPadded = [...Array(padTop).fill(""), ...right];
    const rows = Math.max(logo.length, rightPadded.length);

    for (let i = 0; i < rows; i++) {
      const left = padVisible(logo[i] || "", logoW);
      const r = rightPadded[i] || "";
      console.log(`  ${left}${" ".repeat(GAP)}${r}`);
    }

    console.log();
    this.#paintKeyHint(false);
  }

  #statusBoxLines(w) {
    const body = [
      ` ${statusDot(true)} ${c.bold("RUNNING")}  ${c.dim("·")}  ${c.cyan(this.meta.baseUrl)}`,
      ` ${c.dim("model")}  ${c.bold(this.meta.model)}`,
      ` ${c.dim("pool")}   ${this.meta.accountsLabel}`,
      ` ${c.dim("key")}    ${c.dim(this.meta.apiKey)}`,
    ];
    return [boxTop("status", w), ...body.map((line) => boxRow(line, w)), boxBottom(w)];
  }

  #activityBoxLines(w) {
    const title = `Activity · ${this.totalRequests} req`;
    const body = [];

    if (!this.lastEntry) {
      body.push(` ${c.dim("waiting for requests…")}`);
      body.push(` ${c.dim("press")} ${c.cyan(c.bold("L"))} ${c.dim("to open scrollable log")}`);
    } else {
      const e = this.lastEntry;
      const path = (e.path || "").replace(/^\/v1\//, "");
      const st =
        e.status >= 200 && e.status < 300
          ? c.green(String(e.status))
          : e.status >= 400
            ? c.red(String(e.status))
            : c.dim(String(e.status || "…"));
      body.push(` ${c.dim("last")}  ${st}  ${c.cyan(path)}  ${String(e.ms || 0)}ms`);
      body.push(` ${c.bold(e.model || "-")}`);
      const inn = e.promptTokens || 0;
      const out = e.completionTokens || 0;
      const ctx = e.maxContext ? formatContext(e.maxContext) : "—";
      body.push(` ${c.dim("tok")}   ${c.cyan("in " + inn)} · ${c.green("out " + out)} · ctx ${ctx}`);
      if (e.savedTokens || e.compacted) {
        const bits = [];
        if (e.savedTokens) bits.push(c.green(`saved ~${e.savedTokens}`));
        if (e.compacted) bits.push(c.yellow("compact"));
        body.push(` ${c.dim("save")}  ${bits.join(" · ")}`);
      }
      body.push(` ${c.dim("press")} ${c.cyan(c.bold("L"))} ${c.dim("for full log")}`);
    }

    return [boxTop(title, w), ...body.map((line) => boxRow(line, w)), boxBottom(w)];
  }

  #paintKeyHint(inLogs) {
    if (inLogs) {
      console.log(
        `  ${c.dim("keys")}  ${c.cyan("↑↓")} scroll  ${c.cyan("PgUp/PgDn")} page  ${c.cyan("g/G")} top/end  ${c.cyan("L/Esc")} close  ${c.cyan("q")} quit`
      );
      return;
    }
    console.log(
      `  ${c.dim("keys")}  ${c.cyan("L")} logs  ${c.cyan("m")} menu  ${c.cyan("h")} help  ${c.cyan("u")} usage  ${c.cyan("s")} stats  ${c.cyan("a")} accounts  ${c.cyan("t")} tools  ${c.cyan("q")} quit`
    );
  }

  #allLogLines() {
    const lines = [];
    for (const e of this.entries) {
      for (const line of formatRequestLogLines(e)) lines.push(line);
    }
    return lines;
  }

  #logViewHeight() {
    return Math.max(8, termHeight() - 8);
  }

  #paintLogs() {
    const w = contentWidth();
    const viewH = this.#logViewHeight();
    const lines = this.#allLogLines();
    const maxScroll = Math.max(0, lines.length - viewH);
    const scroll = Math.min(this.scroll, maxScroll);
    const end = lines.length - scroll;
    const start = Math.max(0, end - viewH);
    const slice = lines.slice(start, end);
    const posLabel = lines.length === 0 ? "0/0" : `${Math.min(end, lines.length)}/${lines.length}`;
    const followTag = this.follow ? c.green("● live") : c.dim("○ paused");

    console.log();
    console.log(
      `  ${c.cyan("◆")} ${c.bold("kirouter")} ${c.dim("log")}  ${followTag}  ${c.dim(this.meta.baseUrl)}`
    );
    console.log();

    const title = `Live Log · ${posLabel}`;
    const footer = `↑↓ scroll · L/Esc close${this.follow ? "" : " · G follow"}`;

    console.log(`  ${boxTop(title, w)}`);
    if (!slice.length) {
      for (let i = 0; i < viewH; i++) {
        const msg = i === Math.floor(viewH / 2) ? c.dim("  (no requests yet)") : "";
        console.log(`  ${boxRow(msg, w)}`);
      }
    } else {
      for (let i = 0; i < viewH; i++) {
        const line = slice[i] || "";
        console.log(`  ${boxRow(line ? ` ${line}` : "", w)}`);
      }
    }
    console.log(`  ${boxBottom(w, c.cyan, footer)}`);
    console.log();
    this.#paintKeyHint(true);
  }
}
