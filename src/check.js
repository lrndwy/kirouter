/**
 * Minimal self-check (no network). Run: node src/check.js
 */
import assert from "node:assert/strict";
import { openaiToKiroRequest, claudeToKiroRequest } from "./kiro/openaiToKiro.js";
import { STATIC_MODELS, formatContext, getModelContextLength } from "./kiro/constants.js";
import { listToolIds } from "./cli-tools/index.js";
import { parseKeysText, socialRefreshToken } from "./store/accounts.js";
import { resolveUpstreamModel, toClaudeCodeModelId } from "./kiro/modelAlias.js";
import { tokenSaverPreprocess } from "./middleware/tokenSaver.js";
import { contextCompactMaybe } from "./middleware/contextCompact.js";
import { asciiLogoLines } from "./util/ui.js";
import { validateKiroConversation, normalizeKiroToolSpecs } from "./kiro/conversation.js";
import {
  estimateAnthropicInputTokens,
  finalizeUsage,
  toClaudeUsage,
} from "./util/tokens.js";

const sampleKeys = `
# comment
dng153@geusil.com|aorAAAAAGrrF1EmU-MruvMqVmXC3SgJUfwhMdRgoh38ph6Ux5XQkcQ5mJtUKlrHuOfkZSe-p-t9iqxLPYRK_7TjCwCkc0:MGQCMFQCtest
dng151@geusil.com|aorAAAAAGrrF1ASFX1xBjWHbc7thfV0laW919f2CNnPVR5OZb_8bzDqg-XSsLsMCBATwiGnSoE-VdBaNZ2Rvh6J1cCkc0:MGYCMQDtest
dng163@geusil.com|
invalid-line-without-pipe
`;
const parsed = parseKeysText(sampleKeys);
assert.equal(parsed.length, 2);
assert.equal(parsed[0].email, "dng153@geusil.com");
assert.ok(parsed[0].refreshToken.includes(":"));
assert.ok(socialRefreshToken(parsed[0].refreshToken).startsWith("aorAAAAAG"));
assert.equal(socialRefreshToken(parsed[0].refreshToken).includes(":"), false);
assert.equal(parsed[1].email, "dng151@geusil.com");
// Full dump (token:signature) must be preferred over bare prefix for refresh candidates
const full = parsed[0].refreshToken;
const bare = socialRefreshToken(full);
assert.ok(full.includes(":"));
assert.notEqual(full, bare);

const cred = {
  accessToken: "test",
  providerSpecificData: { authMethod: "builder-id", profileArn: "arn:test" },
};

const openaiPayload = openaiToKiroRequest(
  "claude-sonnet-4.5",
  {
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "ping",
          description: "ping",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  },
  cred
);

assert.equal(openaiPayload.conversationState.currentMessage.userInputMessage.content.includes("hello"), true);
assert.ok(openaiPayload.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools.length);
assert.deepEqual(
  openaiPayload.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0]
    .toolSpecification.inputSchema.json.type,
  "object"
);
assert.equal(openaiPayload.profileArn, "arn:test");

const claudePayload = claudeToKiroRequest(
  "claude-sonnet-4.5",
  {
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }],
  },
  cred
);
assert.ok(claudePayload.conversationState.history.length || claudePayload.conversationState.currentMessage);
assert.ok(STATIC_MODELS.length > 0);
assert.deepEqual(
  listToolIds().sort(),
  ["claude", "cline", "codex", "cowork", "cursor", "droid", "opencode"].sort()
);
assert.ok(STATIC_MODELS.some((m) => m.id === "claude-sonnet-4.5"));
assert.ok(STATIC_MODELS.every((m) => m.id && m.name && m.contextLength > 0));
assert.equal(getModelContextLength("claude-sonnet-4.5"), 200000);
assert.equal(getModelContextLength("gpt-5.6-sol"), 272000);
assert.equal(formatContext(200000), "200k");
assert.equal(resolveUpstreamModel("haiku"), "claude-haiku-4.5");
assert.equal(resolveUpstreamModel("sonnet"), "claude-sonnet-4.5");
assert.equal(resolveUpstreamModel("opus"), "claude-sonnet-4.5");
assert.equal(resolveUpstreamModel("claude-sonnet-4-5"), "claude-sonnet-4.5");
assert.equal(resolveUpstreamModel("claude-sonnet-4-5-20250929"), "claude-sonnet-4.5");
assert.equal(resolveUpstreamModel("claude-sonnet-4.5"), "claude-sonnet-4.5");
assert.equal(toClaudeCodeModelId("claude-sonnet-4.5"), "claude-sonnet-4-5");
assert.equal(toClaudeCodeModelId("sonnet"), "claude-sonnet-4-5");

// Token estimation + Kiro fallback (context% × window)
const est = estimateAnthropicInputTokens({
  system: "hi",
  messages: [{ role: "user", content: "hello world" }],
});
assert.ok(est >= 1);
const fromContext = finalizeUsage({
  contextUsagePercentage: 10,
  contextWindow: 200000,
  estimatedInput: est,
  outputChars: 40,
  hasMetering: true,
});
assert.equal(fromContext.prompt_tokens, 20000);
assert.equal(fromContext.completion_tokens, 10);
const claudeU = toClaudeUsage(fromContext);
assert.equal(claudeU.input_tokens, 20000);
assert.equal(claudeU.output_tokens, 10);

// --- v0.2: short ASCII logo ---
const logo = asciiLogoLines("0.2.0");
assert.ok(logo.length <= 12, `logo should be short, got ${logo.length} lines`);
assert.ok(logo.some((l) => l.includes(",--,") || l.includes("kirouter")));

// --- v0.2: token saver truncates large tool_result ---
const big = "x".repeat(20_000);
const saver = tokenSaverPreprocess(
  {
    model: "claude-sonnet-4.5",
    messages: [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: big }],
      },
    ],
  },
  "claude",
  { enabled: true, maxToolResultChars: 6000 }
);
const tr = saver.body.messages[0].content[0].content;
assert.ok(tr.length < big.length);
assert.ok(tr.includes("kirouter truncated"));
assert.ok(saver.stats.truncatedResults >= 1);
assert.ok(saver.stats.savedTokensEst > 0);

const saverOff = tokenSaverPreprocess(
  { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] }] },
  "claude",
  { enabled: false, maxToolResultChars: 6000 }
);
assert.equal(saverOff.body.messages[0].content[0].content.length, big.length);

// OpenAI tool role
const oaiSaver = tokenSaverPreprocess(
  {
    messages: [
      { role: "system", content: "sys" },
      { role: "tool", tool_call_id: "c1", content: "y".repeat(12_000) },
    ],
  },
  "openai",
  { enabled: true, maxToolResultChars: 4000 }
);
assert.ok(oaiSaver.body.messages[1].content.length < 12_000);
assert.ok(oaiSaver.stats.truncatedResults >= 1);

// --- v0.2: context compact over threshold + preserve tool pairs ---
const pad = "p".repeat(9000); // ~2250 tokens each
const history = [];
for (let i = 0; i < 8; i++) {
  history.push({ role: "user", content: [{ type: "text", text: `turn ${i} ${pad}` }] });
  history.push({
    role: "assistant",
    content: [{ type: "text", text: `reply ${i}` }],
  });
}
// tool pair near the end that would be split if we naively keep last 3 msgs
history.push({
  role: "assistant",
  content: [{ type: "tool_use", id: "tool_keep", name: "read", input: { path: "a" } }],
});
history.push({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: "tool_keep", content: "ok data" }],
});
history.push({ role: "user", content: [{ type: "text", text: "continue" }] });

const compact = contextCompactMaybe(
  { model: "claude-sonnet-4.5", messages: history },
  "claude",
  { enabled: true, thresholdPct: 1, keepRecentMessages: 3 }
);
assert.equal(compact.stats.compacted, true);
assert.ok(compact.stats.droppedMessages > 0);
const compacted = compact.body.messages;
assert.ok(
  String(JSON.stringify(compacted[0])).includes("kirouter compact") ||
    String(JSON.stringify(compacted[0]?.content)).includes("kirouter compact")
);
// tool_use must still be present alongside tool_result
const ids = JSON.stringify(compacted);
assert.ok(ids.includes("tool_keep"));
assert.ok(ids.includes("tool_use"));
assert.ok(ids.includes("tool_result"));

const noCompact = contextCompactMaybe(
  { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] },
  "claude",
  { enabled: true, thresholdPct: 70, keepRecentMessages: 12 }
);
assert.equal(noCompact.stats.compacted, false);

// --- v0.2.1: canonicalize invalid Claude/Kiro tool conversations ---
function assertValidKiro(body) {
  const payload = claudeToKiroRequest(body.model || "claude-sonnet-4.5", body, cred);
  const { specs } = normalizeKiroToolSpecs(body.tools || []);
  const v = validateKiroConversation(
    payload.conversationState.history,
    payload.conversationState.currentMessage,
    specs
  );
  assert.equal(v.valid, true, `expected valid kiro body, got ${JSON.stringify(v.errors)}`);
  return payload;
}

assertValidKiro({
  tools: [{ name: "Bash", description: "d", input_schema: { type: "object", properties: {} } }],
  messages: [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
    },
  ],
});

assertValidKiro({
  tools: [{ name: "Bash", description: "d", input_schema: { type: "object", properties: {} } }],
  messages: [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "missing", content: "data" },
        { type: "text", text: "go" },
      ],
    },
  ],
});

assertValidKiro({
  tools: [{ name: "Bash", description: "d", input_schema: { type: "object", properties: {} } }],
  messages: [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "OldTool", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }],
    },
  ],
});

const happy = assertValidKiro({
  tools: [
    {
      name: "Bash",
      description: "d",
      input_schema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  ],
  messages: [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "run" },
        { type: "tool_use", id: "toolu_ok", name: "Bash", input: { command: "ls" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_ok", content: "ok" }],
    },
  ],
});
assert.ok(
  happy.conversationState.history.some((h) => h.assistantResponseMessage?.toolUses?.length)
);

console.log("check ok");
