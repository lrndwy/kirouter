import { loadConfig } from "../store/config.js";

/** Claude Code / Anthropic-style IDs → Kiro upstream model IDs */
const STATIC_ALIASES = {
  // Claude Code picker aliases
  default: "claude-sonnet-4.5",
  sonnet: "claude-sonnet-4.5",
  // Opus is often unavailable on Kiro accounts — fall back to Sonnet
  opus: "claude-sonnet-4.5",
  haiku: "claude-haiku-4.5",
  fable: "claude-sonnet-4.5",
  opusplan: "claude-sonnet-4.5",

  // Hyphen / dated Anthropic IDs Claude Code often sends
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  "claude-sonnet-4-5-20250929": "claude-sonnet-4.5",
  "claude-sonnet-4-20250514": "claude-sonnet-4",
  "claude-opus-4-5": "claude-sonnet-4.5",
  "claude-opus-4.5": "claude-sonnet-4.5",
  "claude-opus-4-1": "claude-sonnet-4.5",
  "claude-opus-4.1": "claude-sonnet-4.5",
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-haiku-4-5-20251001": "claude-haiku-4.5",
  "claude-3-5-haiku-latest": "claude-haiku-4.5",
  "claude-3-5-sonnet-latest": "claude-sonnet-4.5",
  "claude-3-opus-latest": "claude-sonnet-4.5",
};

function stripSyntheticSuffix(model) {
  return String(model || "")
    .replace(/-thinking-agentic$/i, "")
    .replace(/-agentic$/i, "")
    .replace(/-thinking$/i, "");
}

/**
 * Normalize client model id to a Kiro-valid upstream model id.
 */
export function resolveUpstreamModel(model) {
  const cfg = loadConfig();
  const fallback = String(cfg.defaultModel || "claude-sonnet-4.5").replace(/^kr\//, "");
  let raw = stripSyntheticSuffix(model || fallback).trim();
  if (!raw) raw = fallback;

  const lower = raw.toLowerCase();
  if (STATIC_ALIASES[lower]) return STATIC_ALIASES[lower];

  // claude-sonnet-4-5-YYYYMMDD → claude-sonnet-4.5
  const dated = lower.match(/^(claude-(?:sonnet|opus|haiku)-)(\d+)-(\d+)(?:-\d+)?$/);
  if (dated) {
    const family = dated[1];
    const converted = `${family}${dated[2]}.${dated[3]}`;
    // Opus → Sonnet fallback (Kiro often rejects opus)
    if (family.startsWith("claude-opus-")) return "claude-sonnet-4.5";
    return converted;
  }

  // claude-sonnet-4-5 → claude-sonnet-4.5 (generic last hyphen → dot for X-Y version)
  const hyp = lower.match(/^(claude-(?:sonnet|opus|haiku)-\d+)-(\d+)$/);
  if (hyp) {
    if (hyp[1].startsWith("claude-opus-")) return "claude-sonnet-4.5";
    return `${hyp[1]}.${hyp[2]}`;
  }

  // Unknown short aliases → configured default
  if (
    !lower.includes("claude-") &&
    !lower.includes("gpt-") &&
    !lower.includes("deepseek") &&
    !lower.includes("minimax") &&
    !lower.includes("qwen") &&
    !lower.includes("glm")
  ) {
    return fallback.startsWith("claude-") ? fallback : "claude-sonnet-4.5";
  }

  // Bare dotted opus → sonnet
  if (/^claude-opus-\d+\.\d+$/i.test(lower)) return "claude-sonnet-4.5";

  return raw;
}

/**
 * Convert a Kiro / config model id into the Anthropic hyphen form Claude Code expects.
 * Claude Code's built-in registry uses `claude-sonnet-4-5`, not `claude-sonnet-4.5`.
 */
export function toClaudeCodeModelId(model) {
  const upstream = resolveUpstreamModel(model);
  return upstream.replace(/^(claude-(?:sonnet|opus|haiku)-\d+)\.(\d+)$/i, "$1-$2");
}
