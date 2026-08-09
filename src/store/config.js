import crypto from "node:crypto";
import fs from "node:fs";
import { configPath, DEFAULT_HOST, DEFAULT_PORT, ensureDataDir } from "./paths.js";

function defaults() {
  return {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    requireApiKey: true,
    localApiKey: `kr_${crypto.randomBytes(24).toString("hex")}`,
    defaultModel: "claude-sonnet-4.5",
  };
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
    return { ...defaults(), ...raw };
  } catch {
    const cfg = defaults();
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    return cfg;
  }
}

export function saveConfig(updates) {
  const next = { ...loadConfig(), ...updates };
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
