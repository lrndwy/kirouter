/**
 * Heuristic token saver — truncate large tool results / strip fluff before
 * translating to Kiro. No extra model calls.
 */

function stripExcessWhitespace(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(text, maxChars) {
  const s = String(text || "");
  if (s.length <= maxChars) return { text: s, truncated: false };
  const keep = Math.max(0, maxChars - 80);
  const head = Math.floor(keep * 0.7);
  const tail = keep - head;
  const omitted = s.length - head - tail;
  const out =
    s.slice(0, head) +
    `\n\n…[kirouter truncated ${omitted} chars]…\n\n` +
    s.slice(-tail);
  return { text: out, truncated: true };
}

function isImageBlock(block) {
  if (!block || typeof block !== "object") return false;
  if (block.type === "image" || block.type === "input_image") return true;
  if (block.type === "image_url") return true;
  return false;
}

function stripImagePlaceholder(block) {
  return {
    type: "text",
    text: "[kirouter: image omitted to save tokens]",
  };
}

function processContentBlocks(content, opts, stats) {
  if (content == null) return content;
  if (typeof content === "string") {
    const cleaned = stripExcessWhitespace(content);
    const { text, truncated } = truncateText(cleaned, opts.maxToolResultChars);
    if (truncated) stats.truncatedResults++;
    stats.charsAfter += text.length;
    stats.charsBefore += content.length;
    return text;
  }
  if (!Array.isArray(content)) return content;

  const out = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      out.push(block);
      continue;
    }

    if (opts.stripImages && isImageBlock(block)) {
      stats.imagesStripped++;
      const placeholder = stripImagePlaceholder(block);
      stats.charsBefore += JSON.stringify(block).length;
      stats.charsAfter += JSON.stringify(placeholder).length;
      out.push(placeholder);
      continue;
    }

    // Claude tool_result
    if (block.type === "tool_result") {
      const next = { ...block };
      const inner = next.content;
      if (typeof inner === "string") {
        stats.charsBefore += inner.length;
        const cleaned = stripExcessWhitespace(inner);
        const { text, truncated } = truncateText(cleaned, opts.maxToolResultChars);
        if (truncated) stats.truncatedResults++;
        next.content = text;
        stats.charsAfter += text.length;
      } else if (Array.isArray(inner)) {
        next.content = processContentBlocks(inner, opts, stats);
      }
      out.push(next);
      continue;
    }

    // OpenAI / Claude text blocks
    if (block.type === "text" && typeof block.text === "string") {
      const before = block.text;
      stats.charsBefore += before.length;
      const cleaned = stripExcessWhitespace(before);
      // Only hard-truncate very large text blocks (likely tool dumps pasted as text)
      const cap = opts.maxToolResultChars * 2;
      const { text, truncated } = truncateText(cleaned, cap);
      if (truncated) stats.truncatedResults++;
      stats.charsAfter += text.length;
      out.push({ ...block, text });
      continue;
    }

    stats.charsBefore += JSON.stringify(block).length;
    stats.charsAfter += JSON.stringify(block).length;
    out.push(block);
  }
  return out;
}

function processOpenAIMessage(msg, opts, stats) {
  if (!msg || typeof msg !== "object") return msg;
  const next = { ...msg };

  // OpenAI tool role message
  if (next.role === "tool" && typeof next.content === "string") {
    stats.charsBefore += next.content.length;
    const cleaned = stripExcessWhitespace(next.content);
    const { text, truncated } = truncateText(cleaned, opts.maxToolResultChars);
    if (truncated) stats.truncatedResults++;
    next.content = text;
    stats.charsAfter += text.length;
    return next;
  }

  if (next.content != null) {
    next.content = processContentBlocks(next.content, opts, stats);
  }
  return next;
}

function processClaudeMessage(msg, opts, stats) {
  if (!msg || typeof msg !== "object") return msg;
  const next = { ...msg };
  if (next.content != null) {
    next.content = processContentBlocks(next.content, opts, stats);
  }
  return next;
}

/**
 * @param {object} body - OpenAI or Claude request body
 * @param {"openai"|"claude"} format
 * @param {object} [options]
 * @returns {{ body: object, stats: object }}
 */
export function tokenSaverPreprocess(body, format, options = {}) {
  const opts = {
    enabled: options.enabled !== false,
    maxToolResultChars: Math.max(500, Number(options.maxToolResultChars) || 6000),
    stripImages: Boolean(options.stripImages),
  };

  const stats = {
    enabled: opts.enabled,
    truncatedResults: 0,
    imagesStripped: 0,
    charsBefore: 0,
    charsAfter: 0,
    savedChars: 0,
    savedTokensEst: 0,
  };

  if (!opts.enabled || !body || typeof body !== "object") {
    return { body, stats };
  }

  const next = { ...body };
  const messages = Array.isArray(next.messages) ? next.messages : null;
  if (!messages) return { body: next, stats };

  if (format === "claude") {
    next.messages = messages.map((m) => processClaudeMessage(m, opts, stats));
  } else {
    next.messages = messages.map((m) => processOpenAIMessage(m, opts, stats));
  }

  // If we never measured before (no tool results), avoid bogus 0/0
  if (stats.charsBefore === 0 && stats.charsAfter === 0) {
    stats.savedChars = 0;
    stats.savedTokensEst = 0;
  } else {
    stats.savedChars = Math.max(0, stats.charsBefore - stats.charsAfter);
    stats.savedTokensEst = Math.ceil(stats.savedChars / 4);
  }

  return { body: next, stats };
}
