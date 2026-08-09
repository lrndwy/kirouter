import fs from "node:fs";
import path from "node:path";
import { ensureDataDir, getDataDir } from "./paths.js";

/** Runtime cache: email -> { accessToken, refreshToken, expiresAt, cooldownUntil, profileArn } */
const runtime = new Map();
let rrIndex = 0;
let cacheLoaded = false;

function cachePath() {
  return path.join(getDataDir(), "accounts-cache.json");
}

function loadCacheFromDisk() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const file = cachePath();
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [email, row] of Object.entries(data || {})) {
      if (row?.accessToken) runtime.set(email, row);
    }
  } catch {
    /* ignore corrupt cache */
  }
}

function persistCacheToDisk() {
  ensureDataDir();
  const out = {};
  for (const [email, row] of runtime.entries()) {
    out[email] = {
      accessToken: row.accessToken,
      refreshToken: row.refreshToken,
      expiresAt: row.expiresAt,
      profileArn: row.profileArn,
      // don't persist cooldown
    };
  }
  fs.writeFileSync(cachePath(), JSON.stringify(out, null, 2));
}

/** Social refresh token is the aorAAAAAG… prefix; dumps may append `:signature`. */
export function socialRefreshToken(raw) {
  const token = String(raw || "").trim();
  if (!token) return "";
  if (token.includes(":")) {
    const bare = token.slice(0, token.indexOf(":"));
    if (bare.startsWith("aorAAAAAG")) return bare;
  }
  return token;
}

export function keysFilePath(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.KIROUTER_KEYS_FILE) return path.resolve(process.env.KIROUTER_KEYS_FILE);
  const inData = path.join(getDataDir(), "kiro_keys.txt");
  const inCwd = path.resolve("kiro_keys.txt");
  if (fs.existsSync(inData)) return inData;
  if (fs.existsSync(inCwd)) return inCwd;
  return inData;
}

/**
 * Parse kiro_keys.txt lines: email|refreshToken
 * Token may contain ':' — everything after first '|' is the token.
 */
export function parseKeysText(text) {
  const accounts = [];
  const seen = new Set();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sep = line.indexOf("|");
    if (sep < 0) continue;
    const email = line.slice(0, sep).trim();
    const refreshToken = line.slice(sep + 1).trim();
    if (!email || !refreshToken) continue;
    if (!refreshToken.startsWith("aorAAAAAG")) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    accounts.push({ email, refreshToken });
  }
  return accounts;
}

export function loadAccountsFromFile(filePath = keysFilePath()) {
  loadCacheFromDisk();
  if (!fs.existsSync(filePath)) return [];
  return parseKeysText(fs.readFileSync(filePath, "utf8"));
}

export function saveAccountsToFile(accounts, filePath = keysFilePath()) {
  ensureDataDir();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const body = accounts.map((a) => `${a.email}|${a.refreshToken}`).join("\n") + (accounts.length ? "\n" : "");
  fs.writeFileSync(filePath, body);
}

export function importKeysFile(sourcePath, destPath) {
  // Always persist pool under data dir unless caller overrides — cwd source ≠ dest.
  const dest = destPath || path.join(getDataDir(), "kiro_keys.txt");
  const incoming = loadAccountsFromFile(sourcePath);
  if (!incoming.length) throw new Error(`No valid accounts in ${sourcePath}`);
  const existing = fs.existsSync(dest) ? loadAccountsFromFile(dest) : [];
  const byEmail = new Map(existing.map((a) => [a.email, a]));
  for (const a of incoming) byEmail.set(a.email, a);
  const merged = [...byEmail.values()];
  saveAccountsToFile(merged, dest);
  // Drop runtime entries for replaced tokens
  for (const a of incoming) runtime.delete(a.email);
  return { count: merged.length, imported: incoming.length, path: dest };
}

export function updateAccountToken(email, refreshToken, filePath = keysFilePath()) {
  const accounts = loadAccountsFromFile(filePath);
  const idx = accounts.findIndex((a) => a.email === email);
  if (idx < 0) return;
  if (accounts[idx].refreshToken === refreshToken) return;
  accounts[idx].refreshToken = refreshToken;
  saveAccountsToFile(accounts, filePath);
}

export function getRuntime(email) {
  loadCacheFromDisk();
  return runtime.get(email) || null;
}

export function setRuntime(email, data) {
  loadCacheFromDisk();
  runtime.set(email, { ...(runtime.get(email) || {}), ...data });
  persistCacheToDisk();
}

export function markCooldown(email, ms = 60_000) {
  setRuntime(email, { cooldownUntil: Date.now() + ms });
}

export function listAccountStatuses(filePath = keysFilePath()) {
  const accounts = loadAccountsFromFile(filePath);
  const now = Date.now();
  return accounts.map((a) => {
    const rt = runtime.get(a.email);
    return {
      email: a.email,
      hasToken: !!a.refreshToken,
      ready: !!(rt?.accessToken && (!rt.expiresAt || rt.expiresAt > now + 60_000)),
      cooling: !!(rt?.cooldownUntil && rt.cooldownUntil > now),
      cooldownMs: rt?.cooldownUntil && rt.cooldownUntil > now ? rt.cooldownUntil - now : 0,
    };
  });
}

export function hasAccounts(filePath = keysFilePath()) {
  return loadAccountsFromFile(filePath).length > 0;
}

/**
 * Pick next healthy account (round-robin), skipping cooldowns.
 */
export function pickAccount(filePath = keysFilePath()) {
  const accounts = loadAccountsFromFile(filePath);
  if (!accounts.length) return null;
  const now = Date.now();
  for (let i = 0; i < accounts.length; i++) {
    const idx = (rrIndex + i) % accounts.length;
    const acc = accounts[idx];
    const rt = runtime.get(acc.email);
    if (rt?.cooldownUntil && rt.cooldownUntil > now) continue;
    rrIndex = (idx + 1) % accounts.length;
    return acc;
  }
  // All cooling — pick soonest cooldown
  let best = accounts[0];
  let bestUntil = Infinity;
  for (const acc of accounts) {
    const until = runtime.get(acc.email)?.cooldownUntil || 0;
    if (until < bestUntil) {
      bestUntil = until;
      best = acc;
    }
  }
  rrIndex = (accounts.findIndex((a) => a.email === best.email) + 1) % accounts.length;
  return best;
}

export function pickAccountsOrdered(filePath = keysFilePath()) {
  const accounts = loadAccountsFromFile(filePath);
  if (!accounts.length) return [];
  const now = Date.now();
  const start = rrIndex % accounts.length;
  const ordered = [];
  for (let i = 0; i < accounts.length; i++) {
    ordered.push(accounts[(start + i) % accounts.length]);
  }
  // Prefer non-cooling first
  ordered.sort((a, b) => {
    const ac = runtime.get(a.email)?.cooldownUntil || 0;
    const bc = runtime.get(b.email)?.cooldownUntil || 0;
    const aCool = ac > now ? 1 : 0;
    const bCool = bc > now ? 1 : 0;
    return aCool - bCool;
  });
  rrIndex = (start + 1) % accounts.length;
  return ordered;
}
