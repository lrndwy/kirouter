import { STATIC_MODELS } from "../kiro/constants.js";
import { DEFAULT_OUTPUT_LIMIT } from "../util/tokens.js";
import { sendJson } from "../util/http.js";

/** Also expose Anthropic hyphen form so Claude Code /model picker accepts them. */
function withClaudeAliases(models) {
  const out = [];
  const seen = new Set();
  for (const m of models) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
    }
    const hyphen = String(m.id).replace(/^(claude-(?:sonnet|opus|haiku)-\d+)\.(\d+)$/i, "$1-$2");
    if (hyphen !== m.id && !seen.has(hyphen)) {
      seen.add(hyphen);
      out.push({ ...m, id: hyphen, name: m.name });
    }
  }
  return out;
}

function modelPayload(m) {
  const ctx = m.contextLength || 200000;
  return {
    id: m.id,
    object: "model",
    created: 0,
    owned_by: "kiro",
    name: m.name,
    // Multiple aliases — OpenCode / LiteLLM / OpenAI-compat clients differ
    context_length: ctx,
    context_window: ctx,
    max_model_len: ctx,
    max_tokens: DEFAULT_OUTPUT_LIMIT,
    max_output_tokens: DEFAULT_OUTPUT_LIMIT,
    max_input_tokens: ctx,
  };
}

export function handleModels(_req, res) {
  sendJson(res, 200, {
    object: "list",
    data: withClaudeAliases(STATIC_MODELS).map(modelPayload),
  });
}
