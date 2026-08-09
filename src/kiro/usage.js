import { loadAccountsFromFile, markCooldown } from "../store/accounts.js";
import { KIRO_DEFAULT_PROFILE_ARNS } from "./constants.js";
import { refreshAccount, resolveCredentials } from "./pool.js";

const DEFAULT_CONCURRENCY = Number(process.env.KIROUTER_USAGE_CONCURRENCY || 8);

const CW_HOST = "https://codewhisperer.us-east-1.amazonaws.com";
const Q_HOST = "https://q.us-east-1.amazonaws.com";
const LIMITS_PATH = "/getUsageLimits";

function normalizeResetAt(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  const n = Number(value);
  if (Number.isFinite(n) && String(value).trim() !== "" && !String(value).includes("-")) {
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms).toISOString();
  }
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(value);
}

function parseQuotaData(data) {
  const usageList = data.usageBreakdownList || [];
  const quotas = [];
  const resetAt = normalizeResetAt(data.nextDateReset || data.resetDate || null);

  for (const breakdown of usageList) {
    const name = breakdown.resourceType || "UNKNOWN";
    const used = breakdown.currentUsageWithPrecision ?? breakdown.currentUsage ?? 0;
    const total = breakdown.usageLimitWithPrecision ?? breakdown.usageLimit ?? 0;
    quotas.push({
      name,
      used,
      total,
      remaining: Math.max(0, total - used),
      pct: total > 0 ? Math.round(((total - used) / total) * 100) : 0,
      resetAt,
    });
    if (breakdown.freeTrialInfo) {
      const freeUsed = breakdown.freeTrialInfo.currentUsageWithPrecision ?? 0;
      const freeTotal = breakdown.freeTrialInfo.usageLimitWithPrecision ?? 0;
      quotas.push({
        name: `${name} (free trial)`,
        used: freeUsed,
        total: freeTotal,
        remaining: Math.max(0, freeTotal - freeUsed),
        pct: freeTotal > 0 ? Math.round(((freeTotal - freeUsed) / freeTotal) * 100) : 0,
        resetAt: normalizeResetAt(breakdown.freeTrialInfo.freeTrialExpiry) || resetAt,
      });
    }
  }

  return {
    plan: data.subscriptionInfo?.subscriptionTitle || data.subscriptionTitle || "Kiro",
    email: data.userInfo?.email || data.email || null,
    resetAt,
    quotas,
    raw: data,
  };
}

async function tryFetch(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`${res.status}: ${text.slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Fetch Kiro usage/quota for current pool account (or single login).
 */
export async function fetchKiroUsage(credentials) {
  const cred = credentials || (await resolveCredentials());
  const accessToken = cred.accessToken || cred.apiKey;
  if (!accessToken) throw new Error("No access token for usage lookup");

  const authMethod = cred.providerSpecificData?.authMethod || "imported";
  const isApiKey = authMethod === "api_key";
  const profileArn =
    cred.providerSpecificData?.profileArn ||
    (!isApiKey ? KIRO_DEFAULT_PROFILE_ARNS.imported : "");

  const baseHeaders = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "aws-sdk-js/1.0.0 KiroIDE",
    "x-amz-user-agent": "aws-sdk-js/1.0.0 KiroIDE",
    ...(isApiKey ? { TokenType: "API_KEY", tokentype: "API_KEY" } : {}),
  };

  const params = new URLSearchParams({
    isEmailRequired: "true",
    origin: "AI_EDITOR",
    resourceType: "AGENTIC_REQUEST",
  });

  const attempts = [
    () =>
      tryFetch(`${CW_HOST}${LIMITS_PATH}?${params}`, {
        method: "GET",
        headers: baseHeaders,
      }),
    () =>
      tryFetch(CW_HOST, {
        method: "POST",
        headers: {
          ...baseHeaders,
          "Content-Type": "application/x-amz-json-1.0",
          "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
        },
        body: JSON.stringify({
          origin: "AI_EDITOR",
          resourceType: "AGENTIC_REQUEST",
          ...(profileArn ? { profileArn } : {}),
        }),
      }),
    () => {
      const qParams = new URLSearchParams({
        origin: "AI_EDITOR",
        resourceType: "AGENTIC_REQUEST",
        ...(profileArn ? { profileArn } : {}),
      });
      return tryFetch(`${Q_HOST}${LIMITS_PATH}?${qParams}`, {
        method: "GET",
        headers: baseHeaders,
      });
    },
  ];

  const errors = [];
  for (const run of attempts) {
    try {
      const data = await run();
      const parsed = parseQuotaData(data);
      return {
        ...parsed,
        account: cred.email || cred.providerSpecificData?.email || parsed.email,
      };
    } catch (err) {
      errors.push(err.message || String(err));
    }
  }

  throw new Error(`Usage fetch failed: ${errors[errors.length - 1] || "unknown"}`);
}

function primaryCredit(usage) {
  const q =
    usage?.quotas?.find((x) => /credit/i.test(x.name) && !/free/i.test(x.name)) ||
    usage?.quotas?.[0];
  if (!q) return { used: 0, total: 0, pct: 0, label: "-" };
  return {
    used: q.used,
    total: q.total,
    pct: q.pct,
    remaining: q.remaining,
    label: `${Math.round(q.used)}/${Math.round(q.total)}`,
  };
}

/**
 * Refresh + fetch usage for every account in kiro_keys.txt (concurrent).
 */
export async function fetchAllAccountsUsage({
  concurrency = DEFAULT_CONCURRENCY,
  onProgress,
} = {}) {
  const accounts = loadAccountsFromFile();
  if (!accounts.length) return { rows: [], ok: 0, fail: 0, total: 0 };

  const rows = new Array(accounts.length);
  let ok = 0;
  let fail = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < accounts.length) {
      const idx = cursor++;
      const account = accounts[idx];
      try {
        const cred = await refreshAccount(account);
        const usage = await fetchKiroUsage(cred);
        const credit = primaryCredit(usage);
        const row = {
          email: account.email,
          ok: true,
          plan: usage.plan || "-",
          credit: credit.label,
          used: credit.used,
          total: credit.total,
          pct: credit.pct,
          resetAt: usage.resetAt,
          quotas: usage.quotas,
        };
        rows[idx] = row;
        ok++;
        onProgress?.(row, idx + 1, accounts.length);
      } catch (err) {
        markCooldown(account.email, 60_000);
        const row = {
          email: account.email,
          ok: false,
          plan: "-",
          credit: "-",
          used: 0,
          total: 0,
          pct: 0,
          error: err?.message || String(err),
        };
        rows[idx] = row;
        fail++;
        onProgress?.(row, idx + 1, accounts.length);
      }
    }
  }

  const n = Math.max(1, Math.min(concurrency, accounts.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return { rows, ok, fail, total: accounts.length };
}
