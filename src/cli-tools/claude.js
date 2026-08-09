import os from "node:os";
import path from "node:path";
import { toClaudeCodeModelId } from "../kiro/modelAlias.js";
import { stripV1, readJsonFile, whichCommand, writeJsonFile } from "./helpers.js";

const settingsPath = () => path.join(os.homedir(), ".claude", "settings.json");

export async function status() {
  const installed = (await whichCommand("claude")) || !!(await readJsonFile(settingsPath()));
  const settings = await readJsonFile(settingsPath());
  return {
    id: "claude",
    name: "Claude Code",
    installed,
    configured: !!(settings?.env?.ANTHROPIC_BASE_URL),
    settingsPath: settingsPath(),
    settings,
  };
}

export async function apply({ baseUrl, apiKey, model, subagentModel }) {
  if (!baseUrl || !apiKey || !model) throw new Error("baseUrl, apiKey, model required");
  const current = (await readJsonFile(settingsPath())) || {};
  // Claude Code's registry uses hyphenated Anthropic IDs (claude-sonnet-4-5),
  // not Kiro dotted IDs (claude-sonnet-4.5). kirouter remaps on the way upstream.
  const clientModel = toClaudeCodeModelId(model);
  // Explore / Task subagents use Haiku alias → ANTHROPIC_DEFAULT_HAIKU_MODEL
  const haikuModel = toClaudeCodeModelId(subagentModel || "claude-haiku-4.5");
  // Claude Code joins baseURL + "/v1/messages" (axios-style). If base already
  // ends with /v1 that becomes /v1/v1/messages → 404. Use host root only.
  const base = stripV1(baseUrl).replace("://localhost", "://127.0.0.1");
  const env = {
    ...(current.env || {}),
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_MODEL: clientModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: clientModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: clientModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
    ANTHROPIC_DEFAULT_FABLE_MODEL: clientModel,
  };
  await writeJsonFile(settingsPath(), {
    ...current,
    // Use Claude Code alias "sonnet" — mapped via ANTHROPIC_DEFAULT_SONNET_MODEL
    model: "sonnet",
    hasCompletedOnboarding: true,
    env,
  });
  return {
    success: true,
    settingsPath: settingsPath(),
    model: clientModel,
    subagentModel: haikuModel,
  };
}

export async function reset() {
  const current = (await readJsonFile(settingsPath())) || {};
  if (!current.env) return { success: true };
  for (const key of [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
  ]) {
    delete current.env[key];
  }
  if (Object.keys(current.env).length === 0) delete current.env;
  await writeJsonFile(settingsPath(), current);
  return { success: true };
}
