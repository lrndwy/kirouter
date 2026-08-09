import * as claude from "./claude.js";
import * as cowork from "./cowork.js";
import * as codex from "./codex.js";
import * as opencode from "./opencode.js";
import * as droid from "./droid.js";
import * as cline from "./cline.js";
import * as cursor from "./cursor.js";
import { getBaseUrl, getDefaultModel, loadConfig } from "../store/config.js";

export const TOOLS = {
  claude,
  cowork,
  codex,
  opencode,
  droid,
  cline,
  cursor,
};

/** User-facing aliases → canonical tool id */
const ALIASES = {
  "claude-code": "claude",
  desktop: "cowork",
  "claude-desktop": "cowork",
  "claude-cowork": "cowork",
  "core-work": "cowork",
  corework: "cowork",
};

export function resolveToolId(id) {
  if (!id) return id;
  const key = String(id).toLowerCase();
  return ALIASES[key] || key;
}

export function listToolIds() {
  return Object.keys(TOOLS);
}

export async function statusAll() {
  const out = [];
  for (const id of listToolIds()) {
    out.push(await TOOLS[id].status());
  }
  return out;
}

export function resolveInstallArgs(overrides = {}) {
  const cfg = loadConfig();
  const model = overrides.model || getDefaultModel(cfg);
  return {
    baseUrl: overrides.baseUrl || getBaseUrl(cfg),
    apiKey: overrides.apiKey || cfg.localApiKey,
    model,
    models: overrides.models,
    subagentModel: overrides.subagentModel,
  };
}

export async function applyTool(id, overrides = {}) {
  const resolved = resolveToolId(id);
  const tool = TOOLS[resolved];
  if (!tool) throw new Error(`Unknown tool: ${id}`);
  if (resolved === "cursor") {
    cursor.printGuide();
    return { success: true, guideOnly: true };
  }
  return tool.apply(resolveInstallArgs(overrides));
}

export async function resetTool(id) {
  const resolved = resolveToolId(id);
  const tool = TOOLS[resolved];
  if (!tool) throw new Error(`Unknown tool: ${id}`);
  return tool.reset();
}
