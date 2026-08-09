import { finalizeUsage, toClaudeUsage, toOpenAIUsage } from "../util/tokens.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let c = index;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const EVENTSTREAM_MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
const EVENTSTREAM_MAX_HEADERS_BYTES = 128 * 1024;

function parseEventFrame(data) {
  if (!(data instanceof Uint8Array) || data.byteLength < 16) {
    throw new Error("AWS EventStream frame is shorter than 16 bytes");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const totalLength = view.getUint32(0, false);
  const headersLength = view.getUint32(4, false);
  if (totalLength !== data.byteLength) throw new Error("AWS EventStream frame length mismatch");
  if (view.getUint32(8, false) !== crc32(data.subarray(0, 8))) {
    throw new Error("AWS EventStream prelude CRC mismatch");
  }
  if (view.getUint32(totalLength - 4, false) !== crc32(data.subarray(0, totalLength - 4))) {
    throw new Error("AWS EventStream message CRC mismatch");
  }

  const headers = Object.create(null);
  let offset = 12;
  const headerEnd = offset + headersLength;
  while (offset < headerEnd) {
    const nameLength = data[offset++];
    const name = decoder.decode(data.subarray(offset, offset + nameLength));
    offset += nameLength;
    const type = data[offset++];
    if (type === 0 || type === 1) {
      headers[name] = type === 0;
    } else if (type === 2) {
      headers[name] = view.getInt8(offset);
      offset += 1;
    } else if (type === 3) {
      headers[name] = view.getInt16(offset, false);
      offset += 2;
    } else if (type === 4) {
      headers[name] = view.getInt32(offset, false);
      offset += 4;
    } else if (type === 5 || type === 8) {
      offset += 8;
    } else if (type === 6 || type === 7) {
      const valueLength = view.getUint16(offset, false);
      offset += 2;
      const bytes = data.subarray(offset, offset + valueLength);
      headers[name] = type === 7 ? decoder.decode(bytes) : bytes;
      offset += valueLength;
    } else if (type === 9) {
      offset += 16;
    } else {
      throw new Error(`Unknown EventStream header type ${type}`);
    }
  }

  const payloadBytes = data.subarray(headerEnd, totalLength - 4);
  if (!payloadBytes.byteLength) return { headers, payload: null };
  const payloadText = decoder.decode(payloadBytes);
  if (!payloadText.trim()) return { headers, payload: null };
  return { headers, payload: JSON.parse(payloadText) };
}

function normalizeStopReason(reason) {
  if (!reason) return null;
  const r = String(reason).toLowerCase();
  if (r.includes("tool")) return "tool_use";
  if (r.includes("length") || r.includes("max")) return "max_tokens";
  if (r.includes("end") || r.includes("stop")) return "end_turn";
  return r;
}

/**
 * Transform Kiro AWS EventStream response into OpenAI chat.completion SSE.
 * Minimal path: no integrity gate / repair.
 * options: { onComplete, contextWindow, estimatedInput }
 * onComplete({ usage, contextUsagePercentage, maxContext }) when stream ends.
 */
export function transformEventStreamToOpenAI(response, model, options = {}) {
  const onComplete = options.onComplete;
  const contextWindow = options.contextWindow || 0;
  const estimatedInput = options.estimatedInput || 0;
  const responseId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const state = {
    buffer: new Uint8Array(0),
    chunkIndex: 0,
    tools: new Map(),
    toolCounter: 0,
    hasToolCalls: false,
    stopReason: null,
    finished: false,
    usage: null,
    contextUsagePercentage: null,
    hasMetering: false,
    totalContentLength: 0,
  };

  const sseChunk = (delta, finishReason = null, usage) =>
    encoder.encode(
      `data: ${JSON.stringify({
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      })}\n\n`
    );

  const emitDelta = (controller, delta) => {
    if (typeof delta.content === "string") state.totalContentLength += delta.content.length;
    if (typeof delta.reasoning_content === "string") {
      state.totalContentLength += delta.reasoning_content.length;
    }
    if (state.chunkIndex === 0) delta = { role: "assistant", ...delta };
    state.chunkIndex++;
    controller.enqueue(sseChunk(delta));
  };

  const buildFinalUsage = () =>
    finalizeUsage({
      usage: state.usage,
      contextUsagePercentage: state.contextUsagePercentage,
      contextWindow,
      estimatedInput,
      outputChars: state.totalContentLength,
      hasMetering: state.hasMetering,
    });

  const emitTools = (controller) => {
    for (const tool of state.tools.values()) {
      let args = "{}";
      if (tool.inputKind === "object") args = JSON.stringify(tool.inputObject || {});
      else if (tool.inputChunks) {
        const joined = tool.inputChunks.join("");
        try {
          JSON.parse(joined);
          args = joined;
        } catch {
          args = JSON.stringify({ value: joined });
        }
      }
      const index = state.toolCounter++;
      emitDelta(controller, {
        tool_calls: [{ index, id: tool.id, type: "function", function: { name: tool.name, arguments: "" } }],
      });
      emitDelta(controller, {
        tool_calls: [{ index, function: { arguments: args } }],
      });
      state.hasToolCalls = true;
    }
    state.tools.clear();
  };

  const processEvent = (event, controller) => {
    const messageType = event.headers[":message-type"];
    if (messageType === "error" || messageType === "exception") {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            error: {
              message: event.payload?.message || `Kiro ${messageType}`,
              type: "upstream_error",
            },
          })}\n\n`
        )
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      state.finished = true;
      return false;
    }

    const eventType = event.headers[":event-type"] || "";
    if (eventType === "assistantResponseEvent" && typeof event.payload?.content === "string") {
      emitDelta(controller, { content: event.payload.content });
    } else if (eventType === "reasoningContentEvent") {
      const value = event.payload?.reasoningContentEvent || event.payload || {};
      const content = typeof value === "string" ? value : value.text || value.content || "";
      if (content) emitDelta(controller, { reasoning_content: content });
    } else if (eventType === "codeEvent" && typeof event.payload?.content === "string") {
      emitDelta(controller, { content: event.payload.content });
    } else if (eventType === "toolUseEvent") {
      const values = Array.isArray(event.payload) ? event.payload : [event.payload];
      for (const value of values) {
        if (!value?.name) continue;
        const id = value.toolUseId || `call_${created}_${state.tools.size + 1}`;
        let tool = state.tools.get(id);
        if (!tool) {
          tool = { id, name: value.name };
          state.tools.set(id, tool);
        }
        if (typeof value.input === "string") {
          tool.inputKind = "string";
          tool.inputChunks ||= [];
          tool.inputChunks.push(value.input);
          state.totalContentLength += value.input.length;
        } else if (value.input && typeof value.input === "object") {
          tool.inputKind = "object";
          tool.inputObject = value.input;
          try {
            state.totalContentLength += JSON.stringify(value.input).length;
          } catch {
            /* ignore */
          }
        }
      }
    } else if (eventType === "messageStopEvent") {
      state.stopReason = normalizeStopReason(event.payload?.stopReason ?? event.payload?.stop_reason);
    } else if (eventType === "metadataEvent" || eventType === "MetadataEvent") {
      const metadata = event.payload?.metadataEvent || event.payload?.metadata || event.payload;
      state.stopReason =
        normalizeStopReason(metadata?.stopReason ?? metadata?.stop_reason) || state.stopReason;
    } else if (eventType === "contextUsageEvent") {
      const percentage = Number(
        event.payload?.contextUsagePercentage ?? event.payload?.context_usage_percentage
      );
      if (Number.isFinite(percentage)) state.contextUsagePercentage = percentage;
    } else if (eventType === "metricsEvent") {
      const metrics = event.payload?.metricsEvent || event.payload || {};
      const parsed = toOpenAIUsage(metrics);
      if (parsed.prompt_tokens || parsed.completion_tokens) {
        state.usage = { ...(state.usage || {}), ...parsed };
      }
    } else if (eventType === "meteringEvent") {
      state.hasMetering = true;
      const metering = event.payload?.meteringEvent || event.payload || {};
      const credits = Number(metering.usage);
      if (Number.isFinite(credits)) {
        state.usage = { ...(state.usage || {}), kiro_credits: credits };
      }
    }
    return true;
  };

  const finishMeta = () => {
    const usage = buildFinalUsage();
    return {
      usage,
      contextUsagePercentage: state.contextUsagePercentage,
      maxContext: contextWindow || undefined,
    };
  };

  const processBytes = (chunk, controller) => {
    const combinedLength = state.buffer.byteLength + chunk.byteLength;
    if (state.buffer.byteLength === 0) state.buffer = chunk;
    else {
      const joined = new Uint8Array(combinedLength);
      joined.set(state.buffer);
      joined.set(chunk, state.buffer.byteLength);
      state.buffer = joined;
    }

    while (state.buffer.byteLength >= 12) {
      const view = new DataView(state.buffer.buffer, state.buffer.byteOffset);
      if (view.getUint32(8, false) !== crc32(state.buffer.subarray(0, 8))) {
        throw new Error("Kiro EventStream prelude CRC mismatch");
      }
      const totalLength = view.getUint32(0, false);
      const headersLength = view.getUint32(4, false);
      if (
        totalLength < 16 ||
        totalLength > EVENTSTREAM_MAX_MESSAGE_BYTES ||
        headersLength > EVENTSTREAM_MAX_HEADERS_BYTES
      ) {
        throw new Error("Kiro EventStream frame bounds invalid");
      }
      if (state.buffer.byteLength < totalLength) break;
      const frame = state.buffer.slice(0, totalLength);
      state.buffer = state.buffer.slice(totalLength);
      const event = parseEventFrame(frame);
      if (!processEvent(event, controller)) return false;
    }
    return true;
  };

  if (!response.body) {
    return new Response(
      encoder.encode(
        `data: ${JSON.stringify({ error: { message: "Empty Kiro response body" } })}\n\ndata: [DONE]\n\n`
      ),
      { status: 502, headers: { "Content-Type": "text/event-stream" } }
    );
  }

  const reader = response.body.getReader();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (!state.finished) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!processBytes(value, controller)) break;
        }
        if (!state.finished) {
          emitTools(controller);
          const finishReason = state.hasToolCalls
            ? "tool_calls"
            : state.stopReason === "max_tokens"
              ? "length"
              : "stop";
          // Always attach usage on the final chunk so OpenCode / AI SDK can detect tokens.
          const usage = buildFinalUsage();
          state.usage = usage;
          controller.enqueue(sseChunk({}, finishReason, usage));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        try {
          onComplete?.(finishMeta());
        } catch {
          /* ignore */
        }
        controller.close();
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: { message: err.message || String(err) } })}\n\ndata: [DONE]\n\n`
          )
        );
        try {
          onComplete?.(finishMeta());
        } catch {
          /* ignore */
        }
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/** Buffer Kiro toolUseEvent fragments; emit one JSON object at the end. */
function appendClaudeToolInput(tool, input) {
  if (input === undefined || input === null) return;
  if (typeof input === "string") {
    if (!input) return;
    // Kiro often sends placeholder {} then string JSON chunks
    if (tool.inputKind === "object" && tool.inputObject && Object.keys(tool.inputObject).length === 0) {
      delete tool.inputObject;
    }
    tool.inputKind = "string";
    tool.inputChunks ||= [];
    tool.inputChunks.push(input);
    return;
  }
  if (typeof input === "object" && !Array.isArray(input)) {
    // Ignore empty {} once we already have string fragments
    if (Object.keys(input).length === 0) {
      if (!tool.inputKind) {
        tool.inputKind = "object";
        tool.inputObject = {};
      }
      return;
    }
    tool.inputKind = "object";
    tool.inputObject = input;
  }
}

function finalizeClaudeToolInput(tool) {
  if (tool.inputKind === "object") return JSON.stringify(tool.inputObject || {});
  if (tool.inputChunks?.length) {
    const joined = tool.inputChunks.join("");
    try {
      JSON.parse(joined);
      return joined;
    } catch {
      return JSON.stringify({ value: joined });
    }
  }
  return "{}";
}

/**
 * Transform EventStream into Anthropic Messages SSE.
 * options: { onComplete, contextWindow, estimatedInput }
 * Claude Code / Cowork read usage from message_start + message_delta.
 */
export function transformEventStreamToClaude(response, model, options = {}) {
  const onComplete = options.onComplete;
  const contextWindow = options.contextWindow || 0;
  const estimatedInput = options.estimatedInput || 0;
  const messageId = `msg_${Date.now()}`;
  let blockIndex = 0;
  let textStarted = false;
  let textBlockIndex = 0;
  let toolIndex = 0;
  const tools = new Map();
  let buffer = new Uint8Array(0);
  let finished = false;
  let usage = null;
  let contextUsagePercentage = null;
  let hasMetering = false;
  let totalContentLength = 0;

  const write = (controller, event, data) => {
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  const closeText = (controller) => {
    if (!textStarted) return;
    write(controller, "content_block_stop", { type: "content_block_stop", index: textBlockIndex });
    textStarted = false;
  };

  const buildFinalUsage = () =>
    finalizeUsage({
      usage,
      contextUsagePercentage,
      contextWindow,
      estimatedInput,
      outputChars: totalContentLength,
      hasMetering,
    });

  const processEvent = (event, controller) => {
    const messageType = event.headers[":message-type"];
    if (messageType === "error" || messageType === "exception") {
      write(controller, "error", {
        type: "error",
        error: { type: "api_error", message: event.payload?.message || messageType },
      });
      finished = true;
      return false;
    }
    const eventType = event.headers[":event-type"] || "";
    if (eventType === "assistantResponseEvent" && typeof event.payload?.content === "string") {
      if (!textStarted) {
        textBlockIndex = blockIndex;
        write(controller, "content_block_start", {
          type: "content_block_start",
          index: textBlockIndex,
          content_block: { type: "text", text: "" },
        });
        blockIndex++;
        textStarted = true;
      }
      totalContentLength += event.payload.content.length;
      write(controller, "content_block_delta", {
        type: "content_block_delta",
        index: textBlockIndex,
        delta: { type: "text_delta", text: event.payload.content },
      });
    } else if (eventType === "toolUseEvent") {
      closeText(controller);
      const values = Array.isArray(event.payload) ? event.payload : [event.payload];
      for (const value of values) {
        if (!value?.name) continue;
        const id = value.toolUseId || `toolu_${Date.now()}_${toolIndex}`;
        if (!tools.has(id)) {
          tools.set(id, { id, name: value.name, index: blockIndex });
          write(controller, "content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "tool_use", id, name: value.name, input: {} },
          });
          blockIndex++;
          toolIndex++;
        }
        // Buffer only — do NOT stream each fragment (Kiro sends {} then full JSON)
        appendClaudeToolInput(tools.get(id), value.input);
        if (typeof value.input === "string") totalContentLength += value.input.length;
        else if (value.input && typeof value.input === "object") {
          try {
            totalContentLength += JSON.stringify(value.input).length;
          } catch {
            /* ignore */
          }
        }
      }
    } else if (eventType === "messageStopEvent" || eventType === "metadataEvent") {
      // handled at finish
    } else if (eventType === "contextUsageEvent") {
      const percentage = Number(
        event.payload?.contextUsagePercentage ?? event.payload?.context_usage_percentage
      );
      if (Number.isFinite(percentage)) contextUsagePercentage = percentage;
    } else if (eventType === "metricsEvent") {
      const metrics = event.payload?.metricsEvent || event.payload || {};
      const parsed = toOpenAIUsage(metrics);
      if (parsed.prompt_tokens || parsed.completion_tokens) {
        usage = { ...(usage || {}), ...parsed };
      }
    } else if (eventType === "meteringEvent") {
      hasMetering = true;
      const metering = event.payload?.meteringEvent || event.payload || {};
      const credits = Number(metering.usage);
      if (Number.isFinite(credits)) {
        usage = { ...(usage || {}), kiro_credits: credits };
      }
    }
    return true;
  };

  if (!response.body) {
    return new Response(JSON.stringify({ error: { message: "Empty Kiro response" } }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const reader = response.body.getReader();
  const stream = new ReadableStream({
    async start(controller) {
      // Seed input_tokens so Claude Code / Cowork show context immediately.
      write(controller, "message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: estimatedInput || 0, output_tokens: 0 },
        },
      });
      write(controller, "ping", { type: "ping" });

      const emitComplete = (metaUsage) => {
        try {
          onComplete?.({
            usage: metaUsage,
            contextUsagePercentage,
            maxContext: contextWindow || undefined,
          });
        } catch {
          /* ignore */
        }
      };

      try {
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          const combinedLength = buffer.byteLength + value.byteLength;
          if (!buffer.byteLength) buffer = value;
          else {
            const joined = new Uint8Array(combinedLength);
            joined.set(buffer);
            joined.set(value, buffer.byteLength);
            buffer = joined;
          }
          while (buffer.byteLength >= 12) {
            const view = new DataView(buffer.buffer, buffer.byteOffset);
            const totalLength = view.getUint32(0, false);
            if (buffer.byteLength < totalLength) break;
            const frame = buffer.slice(0, totalLength);
            buffer = buffer.slice(totalLength);
            const event = parseEventFrame(frame);
            if (!processEvent(event, controller)) break;
          }
        }

        closeText(controller);
        for (const tool of tools.values()) {
          const args = finalizeClaudeToolInput(tool);
          write(controller, "content_block_delta", {
            type: "content_block_delta",
            index: tool.index,
            delta: { type: "input_json_delta", partial_json: args },
          });
          write(controller, "content_block_stop", { type: "content_block_stop", index: tool.index });
        }

        const stopReason = tools.size ? "tool_use" : "end_turn";
        const finalUsage = buildFinalUsage();
        usage = finalUsage;
        const claudeUsage = toClaudeUsage(finalUsage);
        write(controller, "message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: claudeUsage,
        });
        write(controller, "message_stop", { type: "message_stop" });
        emitComplete(finalUsage);
        controller.close();
      } catch (err) {
        write(controller, "error", {
          type: "error",
          error: { type: "api_error", message: err.message || String(err) },
        });
        emitComplete(buildFinalUsage());
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * Collect streaming OpenAI SSE into a single chat.completion JSON object.
 */
export async function collectOpenAICompletion(sseResponse, model) {
  const reader = sseResponse.body.getReader();
  let content = "";
  let reasoning = "";
  const toolCalls = [];
  let finishReason = "stop";
  let id = `chatcmpl-${Date.now()}`;
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.error) throw new Error(parsed.error.message || "upstream error");
        id = parsed.id || id;
        if (parsed.usage) {
          usage = {
            ...usage,
            ...parsed.usage,
            prompt_tokens:
              parsed.usage.prompt_tokens || parsed.usage.input_tokens || usage.prompt_tokens || 0,
            completion_tokens:
              parsed.usage.completion_tokens ||
              parsed.usage.output_tokens ||
              usage.completion_tokens ||
              0,
          };
          usage.total_tokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
        }
        const delta = parsed.choices?.[0]?.delta || {};
        if (delta.content) content += delta.content;
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            toolCalls[idx] ||= { id: tc.id, type: "function", function: { name: "", arguments: "" } };
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
        if (parsed.choices?.[0]?.finish_reason) finishReason = parsed.choices[0].finish_reason;
      } catch (e) {
        if (e.message && !e.message.includes("JSON")) throw e;
      }
    }
  }

  // Fallback estimate from output text if upstream omitted metrics
  usage = finalizeUsage({
    usage,
    estimatedInput: usage.prompt_tokens || 0,
    outputChars: content.length + reasoning.length,
  });

  const message = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}
