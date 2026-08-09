/**
 * Minimal self-check (no network). Run: node src/check.js
 */
import assert from "node:assert/strict";
import { openaiToKiroRequest, claudeToKiroRequest } from "./kiro/openaiToKiro.js";
import { STATIC_MODELS, formatContext, getModelContextLength } from "./kiro/constants.js";
import { listToolIds } from "./cli-tools/index.js";
import { parseKeysText, socialRefreshToken } from "./store/accounts.js";
import { resolveUpstreamModel, toClaudeCodeModelId } from "./kiro/modelAlias.js";

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

console.log("check ok");
