export const KIRO_AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev";
export const KIRO_CODEWHISPERER_TARGET =
  "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";

export const KIRO_BASE_URLS = [
  "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
  "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
  "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
];

export const KIRO_DEFAULT_PROFILE_ARNS = {
  "builder-id": "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX",
  social: "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
  imported: "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
};

export const KIRO_OAUTH = {
  startUrl: "https://view.awsapps.com/start",
  clientName: "kiro-oauth-client",
  clientType: "public",
  scopes: [
    "codewhisperer:completions",
    "codewhisperer:analysis",
    "codewhisperer:conversations",
  ],
  grantTypes: [
    "urn:ietf:params:oauth:grant-type:device_code",
    "refresh_token",
  ],
  issuerUrl: "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6",
};

export const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

export function assertValidAwsRegion(region) {
  if (typeof region !== "string" || !AWS_REGION_PATTERN.test(region)) {
    throw new Error("Invalid region");
  }
  return region;
}

const CTX_200K = 200_000;
const CTX_272K = 272_000;

export const STATIC_MODELS = [
  { id: "claude-opus-5", name: "Claude Opus 5", contextLength: CTX_200K },
  { id: "claude-opus-4.8", name: "Claude Opus 4.8", contextLength: CTX_200K },
  { id: "claude-opus-4.5", name: "Claude Opus 4.5", contextLength: CTX_200K },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: CTX_200K },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", contextLength: CTX_200K },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", contextLength: CTX_200K },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", contextLength: CTX_200K },
  { id: "deepseek-3.2", name: "DeepSeek 3.2", contextLength: CTX_200K },
  { id: "qwen3-coder-next", name: "Qwen3 Coder Next", contextLength: CTX_200K },
  { id: "glm-5", name: "GLM 5", contextLength: CTX_200K },
  { id: "MiniMax-M2.5", name: "MiniMax M2.5", contextLength: CTX_200K },
  { id: "gpt-5.6-sol", name: "GPT 5.6 Sol", contextLength: CTX_272K },
  { id: "gpt-5.6-terra", name: "GPT 5.6 Terra", contextLength: CTX_272K },
  { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", contextLength: CTX_272K },
  { id: "simple-task", name: "Qwen3 Coder Next (simple-task)", contextLength: CTX_200K },
];

export function getModelContextLength(modelId) {
  const id = String(modelId || "").replace(/^kr\//, "");
  const found = STATIC_MODELS.find((m) => m.id === id);
  if (found) return found.contextLength || CTX_200K;
  const dotted = id.replace(/^(claude-(?:sonnet|opus|haiku)-\d+)-(\d+)$/i, "$1.$2");
  const byDot = STATIC_MODELS.find((m) => m.id === dotted);
  return byDot?.contextLength || CTX_200K;
}

export function formatContext(n) {
  if (!n) return "-";
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
