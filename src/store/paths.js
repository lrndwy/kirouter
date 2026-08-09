import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 20129;
export const DEFAULT_HOST = "0.0.0.0";

export function getDataDir() {
  if (process.env.KIROUTER_DATA_DIR) return process.env.KIROUTER_DATA_DIR;
  return path.join(os.homedir(), ".kirouter");
}

export function ensureDataDir() {
  const dir = getDataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function configPath() {
  return path.join(getDataDir(), "config.json");
}

export function credentialsPath() {
  return path.join(getDataDir(), "credentials.json");
}
