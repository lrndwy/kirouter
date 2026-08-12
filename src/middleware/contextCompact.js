import { getModelContextLength } from "../kiro/constants.js";
import {
  estimateAnthropicInputTokens,
  estimateOpenAIInputTokens,
} from "../util/tokens.js";

/**
 * Heuristic context compaction — when estimated input exceeds threshold % of
 * model window, keep system + recent messages (tool pairs intact) and replace
 * dropped middle with a local summary. No LLM call.
 */

function claudeToolUseIds(msg) {
  const ids = new Set();
  const content = msg?.content;
  if (!Array.isArray(content)) return ids;
  for (const b of content) {
    if (b?.type === "tool_use" && b.id) ids.add(b.id);
  }
  return ids;
}

function claudeToolResultIds(msg) {
  const ids = new Set();
  const content = msg?.content;
  if (!Array.isArray(content)) return ids;
  for (const b of content) {
    if (b?.type === "tool_result" && b.tool_use_id) ids.add(b.tool_use_id);
  }
  return ids;
}

function openaiToolCallIds(msg) {
  const ids = new Set();
  const calls = msg?.tool_calls;
  if (!Array.isArray(calls)) return ids;
  for (const c of calls) {
    if (c?.id) ids.add(c.id);
  }
  return ids;
}

/**
 * Expand a keep-window so we never orphan tool_use / tool_result pairs.
 * startIdx is inclusive index into messages array where "recent" begins.
 */
function expandForToolPairs(messages, startIdx, format) {
  let start = Math.max(0, startIdx);

  if (format === "claude") {
    // If first kept message has tool_results, include prior assistant tool_use
    for (;;) {
      if (start <= 0) break;
      const first = messages[start];
      const need = claudeToolResultIds(first);
      if (need.size === 0) break;
      // look back for matching tool_use
      let found = false;
      for (let i = start - 1; i >= 0; i--) {
        const have = claudeToolUseIds(messages[i]);
        let hit = false;
        for (const id of need) {
          if (have.has(id)) {
            hit = true;
            break;
          }
        }
        if (hit) {
          start = i;
          found = true;
          break;
        }
      }
      if (!found) break;
    }

    // If last kept has tool_use without following tool_result in window, extend
    for (;;) {
      const last = messages[messages.length - 1];
      // within window, check unpaired tool_uses at end of window start..end
      const window = messages.slice(start);
      const pending = new Set();
      for (const m of window) {
        for (const id of claudeToolUseIds(m)) pending.add(id);
        for (const id of claudeToolResultIds(m)) pending.delete(id);
      }
      if (pending.size === 0) break;
      // already includes everything to end — nothing to extend
      break;
    }
  } else {
    // OpenAI: tool messages reference tool_call_id; keep prior assistant with tool_calls
    for (;;) {
      if (start <= 0) break;
      const first = messages[start];
      if (first?.role !== "tool") break;
      const needId = first.tool_call_id;
      let found = false;
      for (let i = start - 1; i >= 0; i--) {
        const have = openaiToolCallIds(messages[i]);
        if (needId && have.has(needId)) {
          start = i;
          found = true;
          break;
        }
        // also pull consecutive tool msgs
        if (messages[i]?.role === "tool") {
          start = i;
          found = true;
          continue;
        }
        break;
      }
      if (!found) break;
    }
  }

  return start;
}

function buildCompactNotice(droppedCount, droppedTokensEst) {
  return `[kirouter compact] Dropped ${droppedCount} earlier turns (~${droppedTokensEst} tokens). Keep working from recent context.`;
}

function estimateMessageTokens(msg, format) {
  try {
    if (format === "claude") {
      return estimateAnthropicInputTokens({ messages: [msg], system: undefined });
    }
    return estimateOpenAIInputTokens({ messages: [msg] });
  } catch {
    return Math.ceil(JSON.stringify(msg || {}).length / 4);
  }
}

/**
 * @param {object} body
 * @param {"openai"|"claude"} format
 * @param {object} [options]
 * @returns {{ body: object, stats: object }}
 */
export function contextCompactMaybe(body, format, options = {}) {
  const opts = {
    enabled: options.enabled !== false,
    thresholdPct: Math.min(95, Math.max(1, Number(options.thresholdPct) || 70)),
    keepRecentMessages: Math.max(2, Number(options.keepRecentMessages) || 12),
  };

  const model = body?.model || "claude-sonnet-4.5";
  const maxContext = getModelContextLength(model);
  const estimateFn =
    format === "claude" ? estimateAnthropicInputTokens : estimateOpenAIInputTokens;

  const stats = {
    enabled: opts.enabled,
    compacted: false,
    thresholdPct: opts.thresholdPct,
    estimatedBefore: 0,
    estimatedAfter: 0,
    droppedMessages: 0,
    maxContext,
  };

  if (!opts.enabled || !body || typeof body !== "object") {
    return { body, stats };
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  stats.estimatedBefore = estimateFn(body);

  const thresholdTokens = Math.floor((maxContext * opts.thresholdPct) / 100);
  if (stats.estimatedBefore < thresholdTokens) {
    return { body, stats };
  }
  if (messages.length <= opts.keepRecentMessages + 1) {
    return { body, stats };
  }

  // Separate leading system messages (OpenAI) — Claude uses top-level system
  let sysPrefix = [];
  let rest = messages;
  if (format === "openai") {
    let i = 0;
    while (i < rest.length && rest[i]?.role === "system") {
      sysPrefix.push(rest[i]);
      i++;
    }
    rest = rest.slice(i);
  }

  if (rest.length <= opts.keepRecentMessages) {
    return { body, stats };
  }

  let startRecent = rest.length - opts.keepRecentMessages;
  startRecent = expandForToolPairs(rest, startRecent, format);

  const dropped = rest.slice(0, startRecent);
  const kept = rest.slice(startRecent);

  if (dropped.length === 0) {
    return { body, stats };
  }

  let droppedTokens = 0;
  for (const m of dropped) droppedTokens += estimateMessageTokens(m, format);

  const noticeText = buildCompactNotice(dropped.length, droppedTokens);
  let noticeMsg;
  if (format === "claude") {
    noticeMsg = {
      role: "user",
      content: [{ type: "text", text: noticeText }],
    };
  } else {
    noticeMsg = { role: "user", content: noticeText };
  }

  const nextMessages = [...sysPrefix, noticeMsg, ...kept];
  const next = { ...body, messages: nextMessages };

  stats.compacted = true;
  stats.droppedMessages = dropped.length;
  stats.estimatedAfter = estimateFn(next);
  stats.savedTokensEst = Math.max(0, stats.estimatedBefore - stats.estimatedAfter);

  return { body: next, stats };
}
