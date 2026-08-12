import crypto from "node:crypto";
import fs from "node:fs";
import { configPath, DEFAULT_HOST, DEFAULT_PORT, ensureDataDir } from "./paths.js";

export const DEFAULT_TOKEN_SAVER = {
  enabled: true,
  maxToolResultChars: 6000,
  stripImages: false,
};

export const DEFAULT_CONTEXT_COMPACT = {
  enabled: true,
  thresholdPct: 70,
  keepRecentMessages: 12,
};

function defaults() {
  return {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    requireApiKey: true,
    localApiKey: `kr_${crypto.randomBytes(24).toString("hex")}`,
    defaultModel: "claude-sonnet-4.5",
    tokenSaver: { ...DEFAULT_TOKEN_SAVER },
    contextCompact: { ...DEFAULT_CONTEXT_COMPACT },
  };
}

function mergeNested(base, patch) {
  if (!patch || typeof patch !== "object") return { ...base };
  return { ...base, ...patch };
}

/** Normalize legacy defaultModel values like `kr/claude-sonnet-4.5`. */
export function getDefaultModel(cfg = loadConfig()) {
  return String(cfg.defaultModel || "claude-sonnet-4.5").replace(/^kr\//, "");
}

export function loadConfig() {
  ensureDataDir();
  const file = configPath();
  if (!fs.existsSync(file)) {
    const cfg = defaults();
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    return cfg;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const base = defaults();
    return {
      ...base,
      ...raw,
      tokenSaver: mergeNested(base.tokenSaver, raw.tokenSaver),
      contextCompact: mergeNested(base.contextCompact, raw.contextCompact),
    };
  } catch {
    const cfg = defaults();
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    return cfg;
  }
}

export function saveConfig(updates) {
  const current = loadConfig();
  const next = {
    ...current,
    ...updates,
  };
  if (updates?.tokenSaver) {
    next.tokenSaver = mergeNested(current.tokenSaver, updates.tokenSaver);
  }
  if (updates?.contextCompact) {
    next.contextCompact = mergeNested(current.contextCompact, updates.contextCompact);
  }
  ensureDataDir();
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  return next;
}

export function getBaseUrl(cfg = loadConfig()) {
  const port = cfg.port || DEFAULT_PORT;
  // Prefer 127.0.0.1 over localhost — Node/OpenCode may resolve localhost to ::1
  // while kirouter listens on IPv4 only (0.0.0.0).
  return `http://127.0.0.1:${port}/v1`;
}

export function getTokenSaverConfig(cfg = loadConfig()) {
  return mergeNested(DEFAULT_TOKEN_SAVER, cfg.tokenSaver);
}

export function getContextCompactConfig(cfg = loadConfig()) {
  return mergeNested(DEFAULT_CONTEXT_COMPACT, cfg.contextCompact);
}
