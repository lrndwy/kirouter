import readline from "node:readline";
import { STATIC_MODELS } from "../kiro/constants.js";
import { c, warn } from "./ui.js";

/** Ensure stdin is in cooked line mode for readline prompts. */
function prepareStdinForPrompt() {
  if (!process.stdin.isTTY) return;
  try {
    process.stdin.setRawMode(false);
  } catch {
    /* ignore */
  }
  if (process.stdin.isPaused?.()) process.stdin.resume();
}

export function prompt(question) {
  prepareStdinForPrompt();
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: !!process.stdin.isTTY,
    });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        rl.close();
      } catch {
        /* ignore */
      }
      resolve(String(value || "").trim());
    };
    rl.on("SIGINT", () => finish(""));
    rl.question(c.cyan("? ") + question, (answer) => finish(answer));
  });
}

/**
 * Yes/No confirm. Returns boolean.
 * @param {string} question
 * @param {boolean} [defaultYes=true]
 */
export async function confirm(question, defaultYes = true) {
  const hint = defaultYes ? c.dim("Y/n") : c.dim("y/N");
  const answer = await prompt(`${question} ${hint} › `);
  if (!answer) return defaultYes;
  if (/^y(es)?$/i.test(answer)) return true;
  if (/^n(o)?$/i.test(answer)) return false;
  warn("Please answer y or n");
  return confirm(question, defaultYes);
}

export async function choose(question, options) {
  console.log();
  console.log(c.bold(`▸ ${question}`));
  options.forEach((opt, i) => {
    console.log(`  ${c.cyan(String(i + 1).padStart(2))}  ${opt}`);
  });
  console.log(`  ${c.dim(" 0")}  ${c.dim("cancel")}`);
  console.log();
  const answer = await prompt(c.dim("Select") + " › ");
  if (!answer || answer === "0" || /^c(ancel)?$/i.test(answer)) return null;
  const idx = Number.parseInt(answer, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= options.length) return null;
  return options[idx];
}

export function pause(msg = "Press Enter to continue…") {
  return prompt(c.dim(msg) + " ");
}

/**
 * Interactive model picker from STATIC_MODELS.
 * Returns model id, or null if cancelled.
 */
export async function pickModel(defaultModel = "claude-sonnet-4.5", label = "Select model") {
  const current = String(defaultModel || "claude-sonnet-4.5").replace(/^kr\//, "");
  console.log(c.bold(`${label}:`));
  STATIC_MODELS.forEach((m, i) => {
    const mark = m.id === current ? c.green("●") : c.dim("·");
    console.log(
      `  ${c.cyan(String(i + 1).padStart(2))}  ${mark}  ${m.name.padEnd(28)} ${c.dim(m.id)}`
    );
  });
  const customN = STATIC_MODELS.length + 1;
  const keepN = STATIC_MODELS.length + 2;
  console.log(`  ${c.cyan(String(customN).padStart(2))}  ${c.dim("·")}  Custom id…`);
  console.log(`  ${c.cyan(String(keepN).padStart(2))}  ${c.dim("·")}  Keep default  ${c.dim(current)}`);
  console.log(`  ${c.cyan(" 0")}  ${c.dim("·")}  Cancel`);
  console.log();
  const answer = await prompt(c.dim("Select number") + " › ");
  if (!answer || answer === "0" || /^c(ancel)?$/i.test(answer)) return null;
  const idx = Number.parseInt(answer, 10);
  if (Number.isNaN(idx)) {
    const byId = STATIC_MODELS.find((m) => m.id === answer || m.name.toLowerCase() === answer.toLowerCase());
    return byId?.id || answer;
  }
  if (idx >= 1 && idx <= STATIC_MODELS.length) return STATIC_MODELS[idx - 1].id;
  if (idx === customN) {
    const custom = await prompt(`Model id [${current}]: `);
    return custom || current;
  }
  if (idx === keepN) return current;
  return null;
}

/** Default subagent model per tool (Claude Explore → Haiku). */
export function defaultSubagentForTool(toolId, mainModel) {
  if (toolId === "claude") return "claude-haiku-4.5";
  return mainModel;
}

/**
 * Ask for subagent model. Returns mainModel if user skips / cancels keep-default.
 * Tools without subagent support should not call this.
 */
export async function pickSubagentModel(toolId, mainModel) {
  const fallback = defaultSubagentForTool(toolId, mainModel);
  console.log();
  const choice = await choose("Subagent model:", [
    `Use default (${fallback})`,
    "Same as main model",
    "Pick a different model",
  ]);
  if (!choice || choice.startsWith("Use default")) return fallback;
  if (choice.startsWith("Same")) return mainModel;
  const picked = await pickModel(fallback, "Select subagent model");
  return picked || fallback;
}

export function toolSupportsSubagent(toolId) {
  return toolId === "claude" || toolId === "codex" || toolId === "opencode";
}
