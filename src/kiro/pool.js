import {
  getRuntime,
  hasAccounts,
  loadAccountsFromFile,
  markCooldown,
  pickAccountsOrdered,
  setRuntime,
  socialRefreshToken,
  updateAccountToken,
} from "../store/accounts.js";
import { KIRO_DEFAULT_PROFILE_ARNS } from "./constants.js";
import { ensureFreshCredentials, refreshToken } from "./auth.js";
import { loadCredentials } from "../store/credentials.js";

const MAX_ACCOUNT_ATTEMPTS = Number(process.env.KIROUTER_MAX_ACCOUNT_ATTEMPTS || 5);

export async function refreshAccount(account) {
  const rt = getRuntime(account.email) || {};
  if (rt.accessToken && rt.expiresAt && Date.now() < rt.expiresAt - 60_000) {
    return toCredentials(account, rt);
  }

  // Dump form is usually aorAAAAAG…:signature — full token works; bare may 401.
  const bare = socialRefreshToken(account.refreshToken);
  const candidates =
    bare && bare !== account.refreshToken
      ? [account.refreshToken, bare]
      : [account.refreshToken];

  let refreshed;
  let lastErr;
  for (const token of candidates) {
    try {
      refreshed = await refreshToken(token, { authMethod: "imported" });
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!refreshed) throw lastErr || new Error(`Refresh failed for ${account.email}`);

  // Keep original dump form in kiro_keys.txt unless upstream rotates the token.
  const nextRefresh = refreshed.refreshToken
    ? refreshed.refreshToken
    : account.refreshToken;
  if (refreshed.refreshToken && refreshed.refreshToken !== account.refreshToken) {
    updateAccountToken(account.email, refreshed.refreshToken);
    account.refreshToken = refreshed.refreshToken;
  }

  const data = {
    accessToken: refreshed.accessToken,
    refreshToken: nextRefresh,
    expiresAt: Date.now() + (refreshed.expiresIn || 3600) * 1000,
    profileArn: refreshed.profileArn || KIRO_DEFAULT_PROFILE_ARNS.imported,
    cooldownUntil: 0,
  };
  setRuntime(account.email, data);
  return toCredentials(account, data);
}

function toCredentials(account, rt) {
  return {
    email: account.email,
    accessToken: rt.accessToken,
    refreshToken: rt.refreshToken || account.refreshToken,
    expiresAt: rt.expiresAt,
    providerSpecificData: {
      authMethod: "imported",
      region: "us-east-1",
      profileArn: rt.profileArn || KIRO_DEFAULT_PROFILE_ARNS.imported,
      email: account.email,
    },
  };
}

/**
 * Resolve credentials: multi-account pool from kiro_keys.txt, else single login.
 */
export async function resolveCredentials() {
  if (hasAccounts()) {
    const ordered = pickAccountsOrdered().slice(0, MAX_ACCOUNT_ATTEMPTS);
    let lastErr;
    for (const account of ordered) {
      try {
        return await refreshAccount(account);
      } catch (err) {
        lastErr = err;
        markCooldown(account.email, 60_000);
      }
    }
    throw lastErr || new Error("All accounts in kiro_keys.txt failed to refresh");
  }
  return ensureFreshCredentials();
}

/**
 * Try request across accounts (failover on 429/401/403).
 * `fn(credentials) => Response`
 */
export async function withAccountFailover(fn) {
  if (!hasAccounts()) {
    const cred = await ensureFreshCredentials();
    return { response: await fn(cred), credentials: cred };
  }

  const ordered = pickAccountsOrdered().slice(0, MAX_ACCOUNT_ATTEMPTS);
  let lastErr;
  for (const account of ordered) {
    let cred;
    try {
      cred = await refreshAccount(account);
    } catch (err) {
      lastErr = err;
      markCooldown(account.email, 60_000);
      continue;
    }
    try {
      const response = await fn(cred);
      if (response?.ok) return { response, credentials: cred };
      const status = response?.status;
      if (status === 429 || status === 401 || status === 403) {
        markCooldown(account.email, status === 429 ? 120_000 : 60_000);
        lastErr = new Error(`Kiro HTTP ${status} on ${account.email}`);
        lastErr.status = status;
        await response.text().catch(() => {});
        continue;
      }
      // Payload errors (e.g. 400 TOOL_SCHEMA_INVALID) — stop rotating accounts
      return { response, credentials: cred };
    } catch (err) {
      lastErr = err;
      if (err?.name === "AbortError") throw err;
      markCooldown(account.email, 30_000);
    }
  }
  throw lastErr || new Error("All kiro_keys accounts failed");
}

export function accountLoginState() {
  if (hasAccounts()) {
    return { mode: "keys", count: loadAccountsFromFile().length, single: !!loadCredentials() };
  }
  const c = loadCredentials();
  return { mode: c ? "single" : "none", count: c ? 1 : 0, single: !!c };
}

/**
 * Probe accounts (refresh). Default: all. Pass finite `limit` to cap.
 * Returns { ok, fail, results[], total, sampled }.
 */
export async function verifyAccounts(limit = Infinity, onProgress) {
  const accounts = loadAccountsFromFile();
  if (!accounts.length) return { ok: 0, fail: 0, results: [], total: 0, sampled: 0 };
  const n =
    !Number.isFinite(limit) || limit <= 0
      ? accounts.length
      : Math.min(Math.max(1, Math.floor(limit)), accounts.length);
  const sample = accounts.slice(0, n);
  const results = [];
  let ok = 0;
  let fail = 0;
  let i = 0;
  for (const account of sample) {
    i++;
    try {
      await refreshAccount(account);
      ok++;
      const row = { email: account.email, ok: true, index: i, of: sample.length };
      results.push(row);
      onProgress?.(row);
    } catch (err) {
      fail++;
      markCooldown(account.email, 60_000);
      const row = {
        email: account.email,
        ok: false,
        error: err?.message || String(err),
        index: i,
        of: sample.length,
      };
      results.push(row);
      onProgress?.(row);
    }
  }
  return { ok, fail, results, total: accounts.length, sampled: sample.length };
}
