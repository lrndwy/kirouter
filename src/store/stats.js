import fs from "node:fs";
import path from "node:path";
import { ensureDataDir, getDataDir } from "./paths.js";

/** @typedef {{
 *   id: string,
 *   at: number,
 *   method: string,
 *   path: string,
 *   model?: string,
 *   account?: string,
 *   status: number,
 *   ms: number,
 *   stream?: boolean,
 *   error?: string,
 *   promptTokens?: number,
 *   completionTokens?: number,
 *   maxContext?: number,
 *   contextPct?: number|null,
 * }} RequestEntry */

const MAX_RECENT = 200;
const MAX_HISTORY = 50_000;
const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** @type {RequestEntry[]} */
const recent = [];
/** @type {RequestEntry[]} */
let history = [];

const totals = {
  requests: 0,
  ok: 0,
  err: 0,
  promptTokens: 0,
  completionTokens: 0,
  byModel: /** @type {Record<string, number>} */ ({}),
  byAccount: /** @type {Record<string, number>} */ ({}),
  startedAt: Date.now(),
};

/** @type {Set<(e: RequestEntry) => void>} */
const listeners = new Set();

export const PERIODS = [
  { id: "1d", label: "1 day", days: 1 },
  { id: "3d", label: "3 days", days: 3 },
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "all", label: "All time", days: null },
];

function statsPath() {
  return path.join(getDataDir(), "stats.json");
}

function historyPath() {
  return path.join(getDataDir(), "request-history.jsonl");
}

function loadPersisted() {
  try {
    const file = statsPath();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data?.totals) {
        totals.requests = data.totals.requests || 0;
        totals.ok = data.totals.ok || 0;
        totals.err = data.totals.err || 0;
        totals.promptTokens = data.totals.promptTokens || 0;
        totals.completionTokens = data.totals.completionTokens || 0;
        totals.byModel = data.totals.byModel || {};
        totals.byAccount = data.totals.byAccount || {};
        totals.startedAt = data.totals.startedAt || totals.startedAt;
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const hf = historyPath();
    if (!fs.existsSync(hf)) return;
    const cutoff = Date.now() - HISTORY_RETENTION_MS;
    const lines = fs.readFileSync(hf, "utf8").split("\n").filter(Boolean);
    const rows = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row?.at && row.at >= cutoff) rows.push(row);
      } catch {
        /* skip bad line */
      }
    }
    history = rows.slice(-MAX_HISTORY);
    // Keep recent from history tail
    for (let i = history.length - 1; i >= 0 && recent.length < MAX_RECENT; i--) {
      recent.push(history[i]);
    }
  } catch {
    /* ignore */
  }
}

let loaded = false;
function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  loadPersisted();
}

function persistTotals() {
  try {
    ensureDataDir();
    fs.writeFileSync(
      statsPath(),
      JSON.stringify({ totals, savedAt: new Date().toISOString() }, null, 2)
    );
  } catch {
    /* ignore */
  }
}

function appendHistory(entry) {
  try {
    ensureDataDir();
    const slim = {
      id: entry.id,
      at: entry.at,
      model: entry.model || "",
      account: entry.account || "",
      status: entry.status,
      ms: entry.ms,
      promptTokens: entry.promptTokens || 0,
      completionTokens: entry.completionTokens || 0,
      path: entry.path || "",
    };
    fs.appendFileSync(historyPath(), JSON.stringify(slim) + "\n");
  } catch {
    /* ignore */
  }
}

function pruneHistoryMemory() {
  const cutoff = Date.now() - HISTORY_RETENTION_MS;
  if (history.length > MAX_HISTORY || (history[0] && history[0].at < cutoff)) {
    history = history.filter((e) => e.at >= cutoff).slice(-MAX_HISTORY);
  }
}

export function onRequest(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function recordRequest(partial) {
  ensureLoaded();
  const entry = {
    id: `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    method: "POST",
    path: "",
    status: 0,
    ms: 0,
    promptTokens: 0,
    completionTokens: 0,
    ...partial,
  };
  recent.unshift(entry);
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;

  history.push(entry);
  pruneHistoryMemory();
  appendHistory(entry);

  totals.requests++;
  if (entry.status >= 200 && entry.status < 400) totals.ok++;
  else totals.err++;
  if (entry.model) totals.byModel[entry.model] = (totals.byModel[entry.model] || 0) + 1;
  if (entry.account) totals.byAccount[entry.account] = (totals.byAccount[entry.account] || 0) + 1;
  totals.promptTokens += entry.promptTokens || 0;
  totals.completionTokens += entry.completionTokens || 0;

  persistTotals();
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      /* ignore */
    }
  }
  return entry;
}

export function getRecent(n = 20) {
  ensureLoaded();
  return recent.slice(0, n);
}

export function getTotals() {
  ensureLoaded();
  return { ...totals, byModel: { ...totals.byModel }, byAccount: { ...totals.byAccount } };
}

function aggregate(entries) {
  let requests = 0;
  let ok = 0;
  let err = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const byModel = {};
  const byAccount = {};
  for (const e of entries) {
    requests++;
    if (e.status >= 200 && e.status < 400) ok++;
    else err++;
    promptTokens += e.promptTokens || 0;
    completionTokens += e.completionTokens || 0;
    if (e.model) byModel[e.model] = (byModel[e.model] || 0) + 1;
    if (e.account) byAccount[e.account] = (byAccount[e.account] || 0) + 1;
  }
  return {
    requests,
    ok,
    err,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    byModel,
    byAccount,
  };
}

/**
 * @param {string} periodId 1d|3d|7d|30d|all
 */
export function getPeriodStats(periodId = "all") {
  ensureLoaded();
  const period = PERIODS.find((p) => p.id === periodId) || PERIODS[PERIODS.length - 1];
  if (period.days == null) {
    return {
      period,
      ...aggregate(history.length ? history : recent),
      // Prefer all-time totals for counts/tokens when available
      requests: totals.requests,
      ok: totals.ok,
      err: totals.err,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      totalTokens: (totals.promptTokens || 0) + (totals.completionTokens || 0),
      byModel: { ...totals.byModel },
      byAccount: { ...totals.byAccount },
      fromHistory: history.length,
    };
  }
  const cutoff = Date.now() - period.days * 24 * 60 * 60 * 1000;
  const slice = history.filter((e) => e.at >= cutoff);
  return { period, ...aggregate(slice), fromHistory: slice.length };
}

export function getAllPeriodStats() {
  return PERIODS.map((p) => getPeriodStats(p.id));
}

/** Clear screen-friendly: wipe in-memory + disk stats/history. */
export function clearStats() {
  ensureLoaded();
  recent.length = 0;
  history = [];
  totals.requests = 0;
  totals.ok = 0;
  totals.err = 0;
  totals.promptTokens = 0;
  totals.completionTokens = 0;
  totals.byModel = {};
  totals.byAccount = {};
  totals.startedAt = Date.now();
  persistTotals();
  try {
    ensureDataDir();
    fs.writeFileSync(historyPath(), "");
  } catch {
    /* ignore */
  }
}

export function resetSessionStats() {
  clearStats();
}
