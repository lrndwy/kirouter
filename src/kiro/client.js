import { buildHeaders, getOrderedBaseUrls } from "./auth.js";
import { getModelContextLength } from "./constants.js";
import {
  collectOpenAICompletion,
  transformEventStreamToClaude,
  transformEventStreamToOpenAI,
} from "./eventStream.js";
import { claudeToKiroRequest, openaiToKiroRequest } from "./openaiToKiro.js";
import { withAccountFailover } from "./pool.js";
import { preprocessRequest } from "../middleware/preprocess.js";
import {
  estimateAnthropicInputTokens,
  estimateOpenAIInputTokens,
  finalizeUsage,
  toClaudeUsage,
  toOpenAIUsage,
} from "../util/tokens.js";

const URL_FALLBACK_STATUSES = new Set([404, 500, 502, 503]);

async function postKiroOnce(credentials, payload) {
  const urls = getOrderedBaseUrls(credentials);
  let lastError = null;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const headers = buildHeaders(credentials, url);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (
        res.ok ||
        res.status === 401 ||
        res.status === 403 ||
        res.status === 429 ||
        (res.status >= 400 && res.status < 500 && !URL_FALLBACK_STATUSES.has(res.status))
      ) {
        return res;
      }
      const text = await res.text().catch(() => "");
      lastError = new Error(`Kiro HTTP ${res.status}: ${text.slice(0, 500)}`);
      lastError.status = res.status;
      if (!URL_FALLBACK_STATUSES.has(res.status) || i === urls.length - 1) throw lastError;
    } catch (err) {
      lastError = err;
      if (err?.name === "AbortError") throw err;
      if (i === urls.length - 1) throw lastError;
    }
  }
  throw lastError || new Error("Kiro request failed");
}

async function runChat(body, toPayload, estimateFn) {
  const model = body.model || "claude-sonnet-4.5";
  const stream = body.stream !== false;

  const { response: upstream, credentials } = await withAccountFailover((cred) => {
    const payload = toPayload(model, body, cred);
    return postKiroOnce(cred, payload);
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    const err = new Error(`Kiro HTTP ${upstream.status}: ${text.slice(0, 500)}`);
    err.status = upstream.status;
    throw err;
  }

  return {
    model,
    stream,
    upstream,
    account: credentials?.email || credentials?.providerSpecificData?.email || "",
    maxContext: getModelContextLength(model),
    estimatedInput: estimateFn(body),
  };
}

export async function proxyOpenAIChat(rawBody) {
  const { body, preprocess } = preprocessRequest(rawBody, "openai");
  const { model, stream, upstream, account, maxContext, estimatedInput } = await runChat(
    body,
    openaiToKiroRequest,
    estimateOpenAIInputTokens
  );

  let resolveDone;
  const whenDone = new Promise((r) => {
    resolveDone = r;
  });

  const sse = transformEventStreamToOpenAI(upstream, model, {
    contextWindow: maxContext,
    estimatedInput,
    onComplete: (meta) => {
      resolveDone({
        usage: finalizeUsage({
          usage: meta.usage,
          contextUsagePercentage: meta.contextUsagePercentage,
          contextWindow: maxContext,
          estimatedInput,
        }),
        contextUsagePercentage: meta.contextUsagePercentage,
        maxContext,
      });
    },
  });

  if (stream) {
    return {
      stream: true,
      response: sse,
      model,
      account,
      maxContext,
      whenDone,
      preprocess,
    };
  }

  const json = await collectOpenAICompletion(sse, model);
  json.usage = finalizeUsage({
    usage: toOpenAIUsage(json.usage),
    contextWindow: maxContext,
    estimatedInput,
    outputChars: String(json.choices?.[0]?.message?.content || "").length,
  });
  const meta = await whenDone.catch(() => ({
    usage: json.usage,
    contextUsagePercentage: null,
    maxContext,
  }));
  return {
    stream: false,
    json,
    model,
    account,
    maxContext,
    contextUsagePercentage: meta.contextUsagePercentage,
    usage: json.usage,
    preprocess,
  };
}

export async function proxyClaudeMessages(rawBody) {
  const { body, preprocess } = preprocessRequest(rawBody, "claude");
  const { model, stream, upstream, account, maxContext, estimatedInput } = await runChat(
    body,
    claudeToKiroRequest,
    estimateAnthropicInputTokens
  );

  let resolveDone;
  const whenDone = new Promise((r) => {
    resolveDone = r;
  });

  if (stream) {
    const response = transformEventStreamToClaude(upstream, model, {
      contextWindow: maxContext,
      estimatedInput,
      onComplete: (meta) => {
        resolveDone({
          usage: finalizeUsage({
            usage: meta.usage,
            contextUsagePercentage: meta.contextUsagePercentage,
            contextWindow: maxContext,
            estimatedInput,
          }),
          contextUsagePercentage: meta.contextUsagePercentage,
          maxContext,
        });
      },
    });
    return {
      stream: true,
      response,
      model,
      account,
      maxContext,
      whenDone,
      preprocess,
    };
  }

  const openaiSse = transformEventStreamToOpenAI(upstream, model, {
    contextWindow: maxContext,
    estimatedInput,
    onComplete: (meta) => {
      resolveDone({
        usage: finalizeUsage({
          usage: meta.usage,
          contextUsagePercentage: meta.contextUsagePercentage,
          contextWindow: maxContext,
          estimatedInput,
        }),
        contextUsagePercentage: meta.contextUsagePercentage,
        maxContext,
      });
    },
  });
  const completion = await collectOpenAICompletion(openaiSse, model);
  const meta = await whenDone.catch(() => ({ usage: completion.usage }));
  const usage = finalizeUsage({
    usage: completion.usage || meta.usage,
    contextUsagePercentage: meta.contextUsagePercentage,
    contextWindow: maxContext,
    estimatedInput,
    outputChars: String(completion.choices?.[0]?.message?.content || "").length,
  });

  const msg = completion.choices?.[0]?.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function?.name,
        input,
      });
    }
  }
  return {
    stream: false,
    model,
    account,
    maxContext,
    contextUsagePercentage: meta.contextUsagePercentage,
    usage,
    preprocess,
    json: {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: msg.tool_calls?.length ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: toClaudeUsage(usage),
    },
  };
}
