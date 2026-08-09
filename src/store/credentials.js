import fs from "node:fs";
import { hasAccounts } from "./accounts.js";
import { credentialsPath, ensureDataDir } from "./paths.js";

export function loadCredentials() {
  ensureDataDir();
  const file = credentialsPath();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function saveCredentials(cred) {
  ensureDataDir();
  fs.writeFileSync(credentialsPath(), JSON.stringify(cred, null, 2));
  return cred;
}

export function clearCredentials() {
  const file = credentialsPath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function isLoggedIn() {
  if (hasAccounts()) return true;
  const c = loadCredentials();
  return !!(c?.accessToken || c?.apiKey);
}
