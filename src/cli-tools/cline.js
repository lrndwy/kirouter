import os from "node:os";
import path from "node:path";
import { readJsonFile, stripV1, whichCommand, writeJsonFile } from "./helpers.js";

const globalStatePath = () => path.join(os.homedir(), ".cline", "data", "globalState.json");
const secretsPath = () => path.join(os.homedir(), ".cline", "data", "secrets.json");

export async function status() {
  const globalState = await readJsonFile(globalStatePath());
  const installed = (await whichCommand("cline")) || !!globalState;
  const baseUrl = globalState?.openAiBaseUrl || "";
  const configured =
    (globalState?.actModeApiProvider === "openai" || globalState?.planModeApiProvider === "openai") &&
    (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || baseUrl.includes("kirouter"));
  return {
    id: "cline",
    name: "Cline",
    installed,
    configured,
    settingsPath: globalStatePath(),
  };
}

export async function apply({ baseUrl, apiKey, model }) {
  if (!baseUrl || !apiKey || !model) throw new Error("baseUrl, apiKey, model required");
  const globalState = (await readJsonFile(globalStatePath())) || {};
  globalState.actModeApiProvider = "openai";
  globalState.planModeApiProvider = "openai";
  globalState.openAiBaseUrl = stripV1(baseUrl);
  globalState.openAiModelId = model;
  globalState.planModeOpenAiModelId = model;
  await writeJsonFile(globalStatePath(), globalState);

  const secrets = (await readJsonFile(secretsPath())) || {};
  secrets.openAiApiKey = apiKey;
  await writeJsonFile(secretsPath(), secrets);
  return { success: true, settingsPath: globalStatePath() };
}

export async function reset() {
  const globalState = (await readJsonFile(globalStatePath())) || {};
  if (globalState.actModeApiProvider === "openai") {
    delete globalState.openAiBaseUrl;
    delete globalState.openAiModelId;
    delete globalState.planModeOpenAiModelId;
    globalState.actModeApiProvider = "cline";
    globalState.planModeApiProvider = "cline";
  }
  await writeJsonFile(globalStatePath(), globalState);
  const secrets = (await readJsonFile(secretsPath())) || {};
  delete secrets.openAiApiKey;
  await writeJsonFile(secretsPath(), secrets);
  return { success: true };
}
