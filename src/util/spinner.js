/** Terminal spinner / loading — no deps. */

import { c, err, ok } from "./ui.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Start an animated spinner on the current line.
 * @returns {{ update(label: string): void, succeed(msg?: string): void, fail(msg?: string): void, stop(): void }}
 */
export function spinner(label = "Loading…") {
  if (!process.stdout.isTTY) {
    process.stdout.write(`  ${c.dim("…")} ${label}\n`);
    return {
      update() {},
      succeed(msg) {
        if (msg) ok(msg);
      },
      fail(msg) {
        if (msg) err(msg);
      },
      stop() {},
    };
  }

  let i = 0;
  let text = label;
  let alive = true;
  const tick = () => {
    if (!alive) return;
    process.stdout.write(`\r  ${c.cyan(FRAMES[i++ % FRAMES.length])} ${text}   `);
  };
  tick();
  const timer = setInterval(tick, 80);

  const clearLine = () => {
    process.stdout.write("\r\x1b[2K");
  };

  return {
    update(next) {
      text = next;
    },
    succeed(msg) {
      if (!alive) return;
      alive = false;
      clearInterval(timer);
      clearLine();
      ok(msg ?? text);
    },
    fail(msg) {
      if (!alive) return;
      alive = false;
      clearInterval(timer);
      clearLine();
      err(msg ?? text);
    },
    stop() {
      if (!alive) return;
      alive = false;
      clearInterval(timer);
      clearLine();
    },
  };
}

/**
 * Run async work under a spinner.
 * @param {string} label
 * @param {(update: (s: string) => void) => Promise<any>} fn
 * @param {{ success?: string }} [opts]
 */
export async function withSpinner(label, fn, opts = {}) {
  const s = spinner(label);
  try {
    const result = await fn((next) => s.update(next));
    const okMsg =
      opts.success ??
      (typeof label === "string" ? `${label.replace(/[.…]+$/, "").trim()} done` : "Done");
    s.succeed(okMsg);
    return result;
  } catch (e) {
    s.fail(e?.message || String(e));
    throw e;
  }
}
