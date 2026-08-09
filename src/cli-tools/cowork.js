/**
 * Claude Desktop · Cowork (third-party inference / 3p deployment).
 *
 * Writes gateway settings into Claude-3p configLibrary and bootstraps
 * deploymentMode=3p in the classic claude_desktop_config.json.
 * Pattern mirrors 9router cowork-settings (without MCP marketplace).
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toClaudeCodeModelId } from "../kiro/modelAlias.js";
import { normalizeV1, readJsonFile, writeJsonFile } from "./helpers.js";

const PROVIDER = "gateway";

/** Relaxed desktop flags applied on every Apply (needed for 3p Cowork). */
const SECURITY_RELAX = {
  coworkEgressAllowedHosts: ["*"],
  disabledBuiltinTools: [],
  isLocalDevMcpEnabled: true,
  isDesktopExtensionEnabled: true,
  isDesktopExtensionDirectoryEnabled: true,
  isDesktopExtensionSignatureRequired: false,
  isClaudeCodeForDesktopEnabled: true,
  disableEssentialTelemetry: true,
  disableNonessentialTelemetry: true,
  disableNonessentialServices: true,
};

function getCandidateRoots() {
  if (os.platform() === "darwin") {
    const base = path.join(os.homedir(), "Library", "Application Support");
    return [path.join(base, "Claude-3p"), path.join(base, "Claude")];
  }
  if (os.platform() === "win32") {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return [
      path.join(localApp, "Claude-3p"),
      path.join(roaming, "Claude-3p"),
      path.join(localApp, "Claude"),
      path.join(roaming, "Claude"),
    ];
  }
  return [
    path.join(os.homedir(), ".config", "Claude-3p"),
    path.join(os.homedir(), ".config", "Claude"),
  ];
}

function getAppInstallPaths() {
  if (os.platform() === "darwin") {
    return ["/Applications/Claude.app", path.join(os.homedir(), "Applications", "Claude.app")];
  }
  if (os.platform() === "win32") {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    return [
      path.join(localApp, "AnthropicClaude"),
      path.join(programFiles, "Claude"),
      path.join(programFiles, "AnthropicClaude"),
    ];
  }
  return [];
}

function get1pRoot() {
  if (os.platform() === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude");
  }
  if (os.platform() === "win32") {
    const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(roaming, "Claude");
  }
  return path.join(os.homedir(), ".config", "Claude");
}

const get1pConfigPath = () => path.join(get1pRoot(), "claude_desktop_config.json");
const getWriteRoot = () => getCandidateRoots()[0];
const getWriteConfigDir = () => path.join(getWriteRoot(), "configLibrary");
const getWriteMetaPath = () => path.join(getWriteConfigDir(), "_meta.json");

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function checkInstalled() {
  for (const dir of [...getCandidateRoots(), ...getAppInstallPaths()]) {
    if (await pathExists(dir)) return true;
  }
  return false;
}

async function resolveAppRootForRead() {
  const candidates = getCandidateRoots();
  for (const dir of candidates) {
    if (await pathExists(path.join(dir, "configLibrary"))) return dir;
  }
  return candidates[0];
}

async function getConfigDir() {
  return path.join(await resolveAppRootForRead(), "configLibrary");
}

async function getMetaPath() {
  return path.join(await getConfigDir(), "_meta.json");
}

async function bootstrapDeploymentMode() {
  const cfg = (await readJsonFile(get1pConfigPath())) || {};
  if (cfg.deploymentMode === "3p") return false;
  cfg.deploymentMode = "3p";
  await writeJsonFile(get1pConfigPath(), cfg);
  return true;
}

async function ensureMeta() {
  const writeMetaPath = getWriteMetaPath();
  let meta = await readJsonFile(writeMetaPath);
  if (!meta?.appliedId) {
    const existingRead = await readJsonFile(await getMetaPath());
    if (existingRead?.appliedId) {
      meta = existingRead;
    } else {
      const newId = crypto.randomUUID();
      meta = { appliedId: newId, entries: [{ id: newId, name: "Default" }] };
    }
    await writeJsonFile(writeMetaPath, meta);
  }
  return meta;
}

async function writeSkipApprovals(managedServers = []) {
  const cfgPath = path.join(getWriteRoot(), "config.json");
  let cfg = (await readJsonFile(cfgPath)) || {};
  const skip = {};
  for (const srv of managedServers) {
    if (srv?.name) skip[srv.name] = true;
  }
  cfg.operonSkipMcpApprovals = skip;
  await writeJsonFile(cfgPath, cfg);
  return { written: Object.keys(skip).length };
}

function looksLikeKirouter(baseUrl) {
  if (!baseUrl) return false;
  return /127\.0\.0\.1:20129|localhost:20129|kirouter/i.test(String(baseUrl));
}

function toClientModels(model, models) {
  const list = Array.isArray(models) && models.length
    ? models
    : model
      ? [model]
      : [];
  return list
    .map((m) => String(m || "").trim())
    .filter(Boolean)
    .map((m) => toClaudeCodeModelId(m));
}

export async function status() {
  const installed = await checkInstalled();
  if (!installed) {
    return {
      id: "cowork",
      name: "Claude Cowork",
      installed: false,
      configured: false,
      settingsPath: getWriteConfigDir(),
      message: "Claude Desktop (Cowork mode) not detected",
    };
  }

  const meta = await readJsonFile(await getMetaPath());
  const appliedId = meta?.appliedId || null;
  const configPath = appliedId
    ? path.join(await getConfigDir(), `${appliedId}.json`)
    : null;
  const config = configPath ? await readJsonFile(configPath) : null;
  const baseUrl = config?.inferenceGatewayBaseUrl || null;
  const configured = !!(config?.inferenceProvider === PROVIDER && baseUrl);

  return {
    id: "cowork",
    name: "Claude Cowork",
    installed: true,
    configured,
    kirouter: looksLikeKirouter(baseUrl),
    settingsPath: configPath || getWriteConfigDir(),
    baseUrl,
    models: Array.isArray(config?.inferenceModels)
      ? config.inferenceModels.map((m) => (typeof m === "string" ? m : m?.name)).filter(Boolean)
      : [],
    config,
  };
}

export async function apply({ baseUrl, apiKey, model, models }) {
  if (!baseUrl || !apiKey) throw new Error("baseUrl and apiKey required");
  const clientModels = toClientModels(model, models);
  if (!clientModels.length) throw new Error("At least one model is required");

  // Cowork gateway expects …/v1 (unlike Claude Code which wants host root).
  const gatewayBase = normalizeV1(baseUrl).replace("://localhost", "://127.0.0.1");

  const bootstrapped = await bootstrapDeploymentMode();
  const meta = await ensureMeta();
  const configPath = path.join(getWriteConfigDir(), `${meta.appliedId}.json`);

  const newConfig = {
    ...SECURITY_RELAX,
    inferenceProvider: PROVIDER,
    inferenceGatewayBaseUrl: gatewayBase,
    inferenceGatewayApiKey: apiKey,
    inferenceModels: clientModels.map((name) => ({ name })),
    // Marker so status can tell kirouter vs other gateways
    kirouter: true,
  };

  await writeJsonFile(configPath, newConfig);
  try {
    await writeSkipApprovals([]);
  } catch {
    /* best-effort */
  }

  return {
    success: true,
    bootstrapped,
    settingsPath: configPath,
    model: clientModels[0],
    models: clientModels,
    message: bootstrapped
      ? "Cowork enabled (3p mode). Quit & reopen Claude Desktop."
      : "Cowork settings applied. Quit & reopen Claude Desktop.",
  };
}

export async function reset() {
  const meta = await readJsonFile(await getMetaPath());
  if (!meta?.appliedId) {
    return { success: true, message: "No active Cowork config to reset" };
  }
  const configPath = path.join(await getConfigDir(), `${meta.appliedId}.json`);
  try {
    await writeJsonFile(configPath, {});
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  try {
    await writeSkipApprovals([]);
  } catch {
    /* ignore */
  }
  return { success: true, settingsPath: configPath };
}

export function printGuide() {
  console.log(`
Claude Desktop · Cowork (manual):
  1. Install Claude Desktop, then open it once
  2. Help → Troubleshooting → Enable Developer mode
  3. Configure third-party inference (or run: kirouter tools cowork)
  4. Quit & reopen Claude Desktop after apply

Config roots:
  macOS: ~/Library/Application Support/Claude-3p/configLibrary/
         ~/Library/Application Support/Claude/claude_desktop_config.json
  Linux: ~/.config/Claude-3p/configLibrary/
  Win:   %LOCALAPPDATA%\\Claude-3p\\configLibrary\\
`);
}
