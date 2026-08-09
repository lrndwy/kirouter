/**
 * Token estimation + usage normalization for OpenAI / Anthropic clients.
 * Kiro often omits metricsEvent and only sends contextUsageEvent + meteringEvent.
 */

export function countValueChars(value) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) return value.reduce((n, item) => n + countValueChars(item), 0);
  if (typeof value === "object") {
    return Object.entries(value).reduce((n, [k, v]) => n + k.length + countValueChars(v), 0);
  }
  return 0;
}

function countContentBlockChars(block) {
  if (block == null) return 0;
  if (typeof block === "string") return block.length;
  if (typeof block !== "object") return countValueChars(block);
  switch (block.type) {
    case "text":
      return countValueChars(block.text);
    case "tool_use":
      return countValueChars(block.name) + countValueChars(block.input);
    case "tool_result":
      return countValueChars(block.content);
    case "thinking":
      return countValueChars(block.thinking);
    default:
      return countValueChars(block);
  }
}

function countMessageChars(message) {
  if (!message || typeof message !== "object") return 0;
  const content = message.content;
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((n, block) => n + countContentBlockChars(block), 0);
  }
  return countValueChars(content);
}

/** Rough Anthropic-style input token estimate (chars/4). */
export function estimateAnthropicInputTokens(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let totalChars = countValueChars(body.system) + countValueChars(body.tools);
  for (const msg of messages) totalChars += countMessageChars(msg);
  return Math.max(1, Math.ceil(totalChars / 4));
}

/** Rough OpenAI chat input estimate. */
export function estimateOpenAIInputTokens(body = {}) {
  return estimateAnthropicInputTokens(body);
}

/**
 * Normalize raw Kiro metrics / partial usage into OpenAI-shaped usage.
 */
export function toOpenAIUsage(raw = {}) {
  const prompt =
    Number(raw.prompt_tokens) ||
    Number(raw.input_tokens) ||
    Number(raw.inputTokens) ||
    0;
  const completion =
    Number(raw.completion_tokens) ||
    Number(raw.output_tokens) ||
    Number(raw.outputTokens) ||
    0;
  const cacheRead =
    Number(raw.cache_read_input_tokens) ||
    Number(raw.cacheReadInputTokens) ||
    Number(raw.cached_tokens) ||
    0;
  const cacheCreate =
    Number(raw.cache_creation_input_tokens) ||
    Number(raw.cacheCreationInputTokens) ||
    0;

  const usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  if (cacheRead) {
    usage.cache_read_input_tokens = cacheRead;
    usage.prompt_tokens_details = { ...(usage.prompt_tokens_details || {}), cached_tokens: cacheRead };
  }
  if (cacheCreate) {
    usage.cache_creation_input_tokens = cacheCreate;
    usage.prompt_tokens_details = {
      ...(usage.prompt_tokens_details || {}),
      cache_creation_tokens: cacheCreate,
    };
  }
  if (raw.kiro_credits != null) usage.kiro_credits = raw.kiro_credits;
  return usage;
}

/** Anthropic Messages usage object. */
export function toClaudeUsage(openaiUsage = {}) {
  const u = toOpenAIUsage(openaiUsage);
  const out = {
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
  };
  if (u.cache_read_input_tokens) out.cache_read_input_tokens = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens) out.cache_creation_input_tokens = u.cache_creation_input_tokens;
  return out;
}

/**
 * Build final usage when Kiro omitted metricsEvent.
 * Mirrors 9router: contextUsagePercentage * contextWindow + output chars/4.
 */
export function finalizeUsage({
  usage,
  contextUsagePercentage,
  contextWindow,
  estimatedInput = 0,
  outputChars = 0,
  hasMetering = false,
} = {}) {
  let current = usage ? toOpenAIUsage(usage) : null;
  const hasReal =
    current &&
    ((current.prompt_tokens || 0) > 0 || (current.completion_tokens || 0) > 0);

  if (!hasReal) {
    const completion = outputChars > 0 ? Math.max(1, Math.floor(outputChars / 4)) : 0;
    let prompt = estimatedInput || 0;
    const pct = Number(contextUsagePercentage);
    if (Number.isFinite(pct) && contextWindow) {
      // Prefer context-based prompt when Kiro reported context usage
      prompt = Math.max(prompt, Math.floor((pct / 100) * contextWindow));
    }
    // 9router path: metering + context without metrics
    if (hasMetering && Number.isFinite(pct) && contextWindow) {
      prompt = Math.floor((pct / 100) * contextWindow);
    }
    current = {
      prompt_tokens: prompt || estimatedInput || 0,
      completion_tokens: completion,
      total_tokens: (prompt || estimatedInput || 0) + completion,
    };
  } else {
    if (!current.prompt_tokens && estimatedInput) current.prompt_tokens = estimatedInput;
    current.total_tokens = (current.prompt_tokens || 0) + (current.completion_tokens || 0);
  }
  return current;
}

export const DEFAULT_OUTPUT_LIMIT = 8192;
