import os from "node:os";
import path from "node:path";
import { normalizeV1, readJsonFile, whichCommand, writeJsonFile } from "./helpers.js";

const settingsPath = () => path.join(os.homedir(), ".factory", "settings.json");

export async function status() {
  const settings = await readJsonFile(settingsPath());
  const installed = (await whichCommand("droid")) || !!settings;
  const configured = !!(settings?.customModels || []).some((m) => m.id?.startsWith("custom:kirouter"));
  return {
    id: "droid",
    name: "Factory Droid",
    installed,
    configured,
    settingsPath: settingsPath(),
  };
}

export async function apply({ baseUrl, apiKey, model }) {
  if (!baseUrl || !model) throw new Error("baseUrl and model required");
  const settings = (await readJsonFile(settingsPath())) || {};
  settings.customModels = (settings.customModels || []).filter(
    (m) => !m.id?.startsWith("custom:kirouter")
  );
  settings.customModels.unshift({
    model,
    id: "custom:kirouter-0",
    index: 0,
    baseUrl: normalizeV1(baseUrl),
    apiKey: apiKey || "your_api_key",
    displayName: model,
    maxOutputTokens: 131072,
    noImageSupport: false,
    provider: "openai",
  });
  await writeJsonFile(settingsPath(), settings);
  return { success: true, settingsPath: settingsPath() };
}

export async function reset() {
  const settings = (await readJsonFile(settingsPath())) || {};
  if (!settings.customModels) return { success: true };
  settings.customModels = settings.customModels.filter((m) => !m.id?.startsWith("custom:kirouter"));
  if (!settings.customModels.length) delete settings.customModels;
  await writeJsonFile(settingsPath(), settings);
  return { success: true };
}
