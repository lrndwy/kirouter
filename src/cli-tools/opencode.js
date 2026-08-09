import os from "node:os";
import path from "node:path";
import { normalizeV1, readJsonFile, whichCommand, writeJsonFile } from "./helpers.js";

const configPath = () => path.join(os.homedir(), ".config", "opencode", "opencode.json");

export async function status() {
  const config = await readJsonFile(configPath());
  const installed = (await whichCommand("opencode")) || !!config;
  return {
    id: "opencode",
    name: "OpenCode",
    installed,
    configured: !!config?.provider?.kirouter,
    settingsPath: configPath(),
  };
}

export async function apply({ baseUrl, apiKey, model, subagentModel }) {
  if (!baseUrl || !model) throw new Error("baseUrl and model required");
  const config = (await readJsonFile(configPath())) || {};
  if (!config.provider) config.provider = {};
  // Strip host "localhost" → 127.0.0.1 for Node dual-stack safety
  let normalized = normalizeV1(baseUrl).replace("://localhost", "://127.0.0.1");
  const existing = config.provider.kirouter || {
    npm: "@ai-sdk/openai-compatible",
    options: {},
    models: {},
  };
  existing.name = existing.name || "kirouter";
  existing.npm = "@ai-sdk/openai-compatible";
  existing.options = {
    ...existing.options,
    baseURL: normalized,
    apiKey: apiKey || "sk_kirouter",
  };
  existing.models = existing.models || {};
  const register = (id) => {
    existing.models[id] = {
      name: id,
      modalities: { input: ["text", "image"], output: ["text"] },
    };
  };
  register(model);
  const sub = subagentModel || model;
  if (sub !== model) register(sub);
  config.provider.kirouter = existing;
  config.model = `kirouter/${model}`;
  if (!config.agent) config.agent = {};
  config.agent.explorer = {
    description: "Fast explorer subagent for codebase exploration",
    mode: "subagent",
    model: `kirouter/${sub}`,
  };
  await writeJsonFile(configPath(), config);
  return { success: true, settingsPath: configPath(), model, subagentModel: sub };
}

export async function reset() {
  const config = (await readJsonFile(configPath())) || {};
  if (config.provider?.kirouter) delete config.provider.kirouter;
  if (typeof config.model === "string" && config.model.startsWith("kirouter/")) {
    delete config.model;
  }
  if (config.agent?.explorer?.model?.startsWith("kirouter/")) {
    delete config.agent.explorer;
    if (config.agent && !Object.keys(config.agent).length) delete config.agent;
  }
  await writeJsonFile(configPath(), config);
  return { success: true };
}
