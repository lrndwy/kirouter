import { proxyOpenAIChat } from "../kiro/client.js";
import { recordRequest } from "../store/stats.js";
import { pipeWebResponse, readJson, sendError, sendJson } from "../util/http.js";

function tokenFields(result, meta) {
  const usage = meta?.usage || result.usage || result.json?.usage || {};
  const p = result.preprocess || {};
  return {
    promptTokens: usage.prompt_tokens || usage.input_tokens || 0,
    completionTokens: usage.completion_tokens || usage.output_tokens || 0,
    maxContext: result.maxContext || meta?.maxContext || 0,
    contextPct: meta?.contextUsagePercentage ?? result.contextUsagePercentage ?? null,
    savedTokens: p.savedTokens || 0,
    compacted: Boolean(p.compacted),
    truncatedResults: p.truncatedResults || 0,
  };
}

export async function handleChatCompletions(req, res) {
  const t0 = Date.now();
  let model = "";
  let account = "";
  let stream = false;
  try {
    const body = await readJson(req);
    model = body.model || "";
    if (!body.messages || !Array.isArray(body.messages)) {
      recordRequest({
        method: "POST",
        path: "/v1/chat/completions",
        model,
        status: 400,
        ms: Date.now() - t0,
        error: "messages required",
      });
      return sendError(res, 400, "messages is required");
    }
    const result = await proxyOpenAIChat(body);
    stream = !!result.stream;
    account = result.account || "";
    model = result.model || model;

    if (result.stream) {
      await pipeWebResponse(res, result.response);
      const meta = await result.whenDone.catch(() => ({}));
      const tokens = tokenFields(result, meta);
      recordRequest({
        method: "POST",
        path: "/v1/chat/completions",
        model,
        account,
        status: 200,
        ms: Date.now() - t0,
        stream: true,
        ...tokens,
      });
      return;
    }

    const tokens = tokenFields(result, {
      usage: result.usage,
      contextUsagePercentage: result.contextUsagePercentage,
      maxContext: result.maxContext,
    });
    recordRequest({
      method: "POST",
      path: "/v1/chat/completions",
      model,
      account,
      status: 200,
      ms: Date.now() - t0,
      stream: false,
      ...tokens,
    });
    return sendJson(res, 200, result.json);
  } catch (err) {
    recordRequest({
      method: "POST",
      path: "/v1/chat/completions",
      model,
      account,
      status: err.status || 500,
      ms: Date.now() - t0,
      stream,
      error: err.message || String(err),
    });
    return sendError(res, err.status || 500, err.message || String(err), "upstream_error");
  }
}
