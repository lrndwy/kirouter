import crypto from "node:crypto";
import { KIRO_DEFAULT_PROFILE_ARNS } from "./constants.js";
import {
  canonicalizeKiroConversation,
  normalizeKiroToolSpecs,
} from "./conversation.js";
import { resolveUpstreamModel } from "./modelAlias.js";

function safeJSONParse(str, fallback) {
  if (typeof str !== "string") return str ?? fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function flattenText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c?.type === "text" || c?.text) return c.text || "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

function parseDataUri(url) {
  const m = String(url || "").match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return null;
  return { mimeType: m[1], base64: m[2] };
}

function convertMessages(messages, model) {
  const history = [];
  let pendingUserContent = [];
  let pendingAssistantContent = [];
  let pendingToolResults = [];
  let pendingImages = [];
  let currentRole = null;

  const flushPending = () => {
    if (currentRole === "user") {
      const content = pendingUserContent.join("\n\n").trim() || "continue";
      const userMsg = {
        userInputMessage: {
          content,
          modelId: "",
        },
      };
      if (pendingImages.length) userMsg.userInputMessage.images = pendingImages;
      if (pendingToolResults.length) {
        userMsg.userInputMessage.userInputMessageContext = { toolResults: pendingToolResults };
      }
      history.push(userMsg);
      pendingUserContent = [];
      pendingToolResults = [];
      pendingImages = [];
    } else if (currentRole === "assistant") {
      history.push({
        assistantResponseMessage: {
          content: pendingAssistantContent.join("\n\n").trim() || "...",
        },
      });
      pendingAssistantContent = [];
    }
  };

  for (const msg of messages || []) {
    let role = msg.role;
    const wasSystem = role === "system";
    if (role === "system" || role === "tool") role = "user";

    if (role !== currentRole && currentRole !== null) flushPending();
    currentRole = role;

    if (role === "user") {
      let content = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts = [];
        for (const c of msg.content) {
          if (c.type === "text" || c.text) textParts.push(c.text || "");
          else if (c.type === "image_url") {
            const url = c.image_url?.url || "";
            const parsed = parseDataUri(url);
            if (parsed) {
              pendingImages.push({
                format: parsed.mimeType.split("/")[1] || parsed.mimeType,
                source: { bytes: parsed.base64 },
              });
            } else if (url.startsWith("http")) {
              textParts.push(`[Image: ${url}]`);
            }
          } else if (c.type === "image" && c.source?.type === "base64" && c.source?.data) {
            const mediaType = c.source.media_type || "image/png";
            pendingImages.push({
              format: mediaType.split("/")[1] || mediaType,
              source: { bytes: c.source.data },
            });
          } else if (c.type === "tool_result") {
            const text = Array.isArray(c.content)
              ? c.content.map((x) => x.text || "").join("\n")
              : typeof c.content === "string"
                ? c.content
                : "";
            pendingToolResults.push({
              toolUseId: c.tool_use_id,
              status: c.is_error ? "error" : "success",
              content: [{ text }],
            });
          }
        }
        content = textParts.join("\n");
      }

      if (msg.role === "tool") {
        pendingToolResults.push({
          toolUseId: msg.tool_call_id,
          status: msg.is_error || msg.status === "error" ? "error" : "success",
          content: [{ text: typeof msg.content === "string" ? msg.content : flattenText(msg.content) }],
        });
      } else if (content) {
        pendingUserContent.push(wasSystem ? `<instructions>\n${content}\n</instructions>` : content);
      }
    } else if (role === "assistant") {
      let textContent = "";
      let toolUses = [];
      if (Array.isArray(msg.content)) {
        textContent = msg.content.filter((c) => c.type === "text").map((b) => b.text).join("\n").trim();
        toolUses = msg.content.filter((c) => c.type === "tool_use");
      } else if (typeof msg.content === "string") {
        textContent = msg.content.trim();
      }
      if (msg.tool_calls?.length) toolUses = msg.tool_calls;
      if (textContent) pendingAssistantContent.push(textContent);
      if (toolUses.length) {
        flushPending();
        const last = history[history.length - 1];
        if (last?.assistantResponseMessage) {
          last.assistantResponseMessage.toolUses = toolUses.map((tc) => {
            if (tc.function) {
              return {
                toolUseId: tc.id || crypto.randomUUID(),
                name: tc.function.name,
                input: safeJSONParse(tc.function.arguments, {}),
              };
            }
            return {
              toolUseId: tc.id || crypto.randomUUID(),
              name: tc.name,
              input: tc.input || {},
            };
          });
        }
        currentRole = null;
      }
    }
  }

  if (currentRole !== null) flushPending();

  let currentMessage = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].userInputMessage) {
      currentMessage = history.splice(i, 1)[0];
      break;
    }
  }

  for (const item of history) {
    if (item.userInputMessage && !item.userInputMessage.modelId) {
      item.userInputMessage.modelId = model;
    }
  }

  // Merge consecutive user turns
  const merged = [];
  for (const current of history) {
    if (current.userInputMessage && merged.length && merged[merged.length - 1].userInputMessage) {
      const prev = merged[merged.length - 1];
      prev.userInputMessage.content += `\n\n${current.userInputMessage.content}`;
      const prevCtx = prev.userInputMessage.userInputMessageContext;
      const curCtx = current.userInputMessage.userInputMessageContext;
      if (curCtx) {
        if (!prevCtx) prev.userInputMessage.userInputMessageContext = curCtx;
        else if (curCtx.toolResults?.length) {
          prevCtx.toolResults = [...(prevCtx.toolResults || []), ...curCtx.toolResults];
        }
      }
    } else {
      merged.push(current);
    }
  }

  if (!currentMessage) {
    currentMessage = { userInputMessage: { content: "", modelId: model } };
  }

  return { history: merged, currentMessage };
}

export function openaiToKiroRequest(model, body, credentials) {
  const upstreamModel = resolveUpstreamModel(model || body.model);
  const { specs: toolSpecs, nameMap } = normalizeKiroToolSpecs(body.tools);
  const { history, currentMessage } = convertMessages(body.messages || [], upstreamModel);

  const authMethod = credentials?.providerSpecificData?.authMethod;
  const accountBound = authMethod === "api_key" || authMethod === "idc" || authMethod === "external_idp";
  const profileArn = accountBound
    ? credentials?.providerSpecificData?.profileArn || ""
    : credentials?.providerSpecificData?.profileArn ||
      KIRO_DEFAULT_PROFILE_ARNS[authMethod] ||
      KIRO_DEFAULT_PROFILE_ARNS["builder-id"];

  const canonical = canonicalizeKiroConversation({
    history,
    currentMessage,
    modelId: upstreamModel,
    toolSpecs,
    nameMap,
  });

  const current = canonical.currentMessage.userInputMessage;
  current.modelId = upstreamModel;
  current.origin = "AI_EDITOR";

  const maxTokens = Math.min(
    32000,
    Math.max(1, Number(body.max_tokens || body.max_completion_tokens) || 32000)
  );

  const payload = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: crypto.randomUUID(),
      agentContinuationId: crypto.randomUUID(),
      agentTaskType: "vibe",
      currentMessage: { userInputMessage: current },
      history: canonical.history,
    },
    agentMode: "vibe",
    inferenceConfig: {
      maxTokens,
    },
  };

  if (profileArn) payload.profileArn = profileArn;
  if (body.temperature !== undefined) payload.inferenceConfig.temperature = body.temperature;
  if (body.top_p !== undefined) payload.inferenceConfig.topP = body.top_p;

  return payload;
}

export function claudeToKiroRequest(model, body, credentials) {
  const messages = [];
  if (body.system) {
    const systemText = Array.isArray(body.system)
      ? body.system.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n")
      : String(body.system);
    if (systemText) messages.push({ role: "system", content: systemText });
  }

  for (const msg of body.messages || []) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const toolCalls = msg.content
        .filter((c) => c.type === "tool_use")
        .map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
        }));
      const textParts = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        // Keep thinking as plain text so turns aren't empty; Kiro has no thinking blocks.
        else if (c.type === "thinking" && c.thinking) textParts.push(c.thinking);
      }
      messages.push({
        role: "assistant",
        content: textParts.join("\n").trim(),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const toolResults = msg.content.filter((c) => c.type === "tool_result");
      const rest = msg.content.filter(
        (c) => c.type !== "tool_result" && c.type !== "tool_use"
      );
      if (toolResults.length) {
        for (const tr of toolResults) {
          messages.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: Array.isArray(tr.content)
              ? tr.content.map((x) => x.text || "").join("\n")
              : typeof tr.content === "string"
                ? tr.content
                : JSON.stringify(tr.content ?? ""),
            is_error: !!tr.is_error,
          });
        }
      }
      if (rest.length) messages.push({ role: "user", content: rest });
      continue;
    }
    messages.push(msg);
  }

  const tools = (body.tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || t.parameters || { type: "object", properties: {} },
    },
  }));

  return openaiToKiroRequest(model || body.model, {
    messages,
    tools,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
  }, credentials);
}
