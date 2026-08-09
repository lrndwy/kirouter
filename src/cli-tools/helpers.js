import { exec } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export async function whichCommand(cmd) {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? `where ${cmd}` : `which ${cmd}`;
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

export async function writeJsonFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

export function normalizeV1(baseUrl) {
  if (!baseUrl) return baseUrl;
  return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl.replace(/\/+$/, "")}/v1`;
}

export function stripV1(baseUrl) {
  const n = normalizeV1(baseUrl);
  return n.endsWith("/v1") ? n.slice(0, -3) : n;
}
