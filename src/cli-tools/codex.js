import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeV1, readJsonFile, whichCommand, writeJsonFile } from "./helpers.js";

const configPath = () => path.join(os.homedir(), ".codex", "config.toml");
const authPath = () => path.join(os.homedir(), ".codex", "auth.json");

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

function upsertTomlSimple(content, model, baseUrl, subagentModel) {
  let text = content || "";
  // Remove previous kirouter provider / subagent blocks
  text = text.replace(/\[model_providers\.kirouter\][\s\S]*?(?=\n\[|\s*$)/g, "");
  text = text.replace(/\[agents\.subagent\][\s\S]*?(?=\n\[|\s*$)/g, "");
  text = text.replace(/^model_provider\s*=\s*".*"$/gm, "");
  text = text.replace(/^model\s*=\s*".*"$/gm, "");

  const sub = subagentModel || model;
  const header = [
    `model = "${model}"`,
    `model_provider = "kirouter"`,
    "",
    "[model_providers.kirouter]",
    `name = "kirouter"`,
    `base_url = "${baseUrl}"`,
    `wire_api = "chat"`,
    "",
    "[agents.subagent]",
    `model = "${sub}"`,
    "",
  ].join("\n");

  return `${header}${text.trim()}\n`;
}

export async function status() {
  const cfg = await readText(configPath());
  const installed = (await whichCommand("codex")) || !!cfg;
  return {
    id: "codex",
    name: "OpenAI Codex CLI",
    installed,
    configured: !!(cfg && cfg.includes("model_provider = \"kirouter\"")),
    settingsPath: configPath(),
  };
}

export async function apply({ baseUrl, apiKey, model, subagentModel }) {
  if (!baseUrl || !apiKey || !model) throw new Error("baseUrl, apiKey, model required");
  const dir = path.join(os.homedir(), ".codex");
  await fs.mkdir(dir, { recursive: true });
  const existing = await readText(configPath());
  const sub = subagentModel || model;
  const next = upsertTomlSimple(existing, model, normalizeV1(baseUrl), sub);
  await fs.writeFile(configPath(), next);

  const auth = (await readJsonFile(authPath())) || {};
  auth.OPENAI_API_KEY = apiKey;
  auth.auth_mode = "apikey";
  await writeJsonFile(authPath(), auth);
  return { success: true, settingsPath: configPath(), model, subagentModel: sub };
}

export async function reset() {
  const existing = await readText(configPath());
  if (!existing) return { success: true };
  let text = existing
    .replace(/\[model_providers\.kirouter\][\s\S]*?(?=\n\[|\s*$)/g, "")
    .replace(/\[agents\.subagent\][\s\S]*?(?=\n\[|\s*$)/g, "")
    .replace(/^model_provider\s*=\s*"kirouter"$/gm, "");
  await fs.writeFile(configPath(), text.trim() + (text.trim() ? "\n" : ""));
  return { success: true };
}
