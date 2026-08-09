import crypto from "node:crypto";
import {
  assertValidAwsRegion,
  KIRO_AUTH_SERVICE,
  KIRO_BASE_URLS,
  KIRO_CODEWHISPERER_TARGET,
  KIRO_DEFAULT_PROFILE_ARNS,
  KIRO_OAUTH,
} from "./constants.js";
import { loadCredentials, saveCredentials } from "../store/credentials.js";

export async function registerClient(region = "us-east-1") {
  assertValidAwsRegion(region);
  const res = await fetch(`https://oidc.${region}.amazonaws.com/client/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientName: KIRO_OAUTH.clientName,
      clientType: KIRO_OAUTH.clientType,
      scopes: KIRO_OAUTH.scopes,
      grantTypes: KIRO_OAUTH.grantTypes,
      issuerUrl: KIRO_OAUTH.issuerUrl,
    }),
  });
  if (!res.ok) throw new Error(`Failed to register client: ${await res.text()}`);
  return res.json();
}

export async function startDeviceAuthorization(clientId, clientSecret, startUrl, region = "us-east-1") {
  assertValidAwsRegion(region);
  const res = await fetch(`https://oidc.${region}.amazonaws.com/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret, startUrl }),
  });
  if (!res.ok) throw new Error(`Failed to start device auth: ${await res.text()}`);
  const data = await res.json();
  return {
    deviceCode: data.deviceCode,
    userCode: data.userCode,
    verificationUri: data.verificationUri,
    verificationUriComplete: data.verificationUriComplete,
    expiresIn: data.expiresIn,
    interval: data.interval || 5,
  };
}

export async function pollDeviceToken(clientId, clientSecret, deviceCode, region = "us-east-1") {
  assertValidAwsRegion(region);
  const res = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId,
      clientSecret,
      deviceCode,
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    return {
      success: false,
      pending: data.error === "authorization_pending" || data.error === "slow_down",
      error: data.error,
      errorDescription: data.error_description,
    };
  }
  return {
    success: true,
    tokens: {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresIn: data.expiresIn,
    },
  };
}

export async function refreshToken(refreshTokenValue, providerSpecificData = {}) {
  const { authMethod, clientId, clientSecret, region } = providerSpecificData;

  if (clientId && clientSecret) {
    const safeRegion = region || "us-east-1";
    assertValidAwsRegion(safeRegion);
    const res = await fetch(`https://oidc.${safeRegion}.amazonaws.com/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId,
        clientSecret,
        refreshToken: refreshTokenValue,
        grantType: "refresh_token",
      }),
    });
    if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
    const data = await res.json();
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshTokenValue,
      profileArn: data.profileArn,
      expiresIn: data.expiresIn,
    };
  }

  const res = await fetch(`${KIRO_AUTH_SERVICE}/refreshToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: refreshTokenValue }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  const data = await res.json();
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || refreshTokenValue,
    profileArn: data.profileArn,
    expiresIn: data.expiresIn || 3600,
  };
}

export async function validateApiKey(apiKey, region = "us-east-1") {
  assertValidAwsRegion(region);
  const trimmed = String(apiKey || "").trim();
  if (!trimmed) throw new Error("API key is required");

  const params = new URLSearchParams({ origin: "AI_EDITOR" });
  const res = await fetch(`https://q.${region}.amazonaws.com/ListAvailableModels?${params}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${trimmed}`,
      TokenType: "API_KEY",
      Accept: "application/json",
      "User-Agent": "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0",
      "X-Amz-User-Agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
    },
  });
  if (!res.ok) throw new Error(`API key validation failed: ${await res.text()}`);
  const data = await res.json();
  if (!Array.isArray(data?.models) || data.models.length === 0) {
    throw new Error("API key returned no available models");
  }
  return {
    accessToken: trimmed,
    apiKey: trimmed,
    refreshToken: null,
    expiresAt: null,
    providerSpecificData: {
      authMethod: "api_key",
      region,
      profileArn: null,
    },
  };
}

export async function importRefreshToken(token) {
  const trimmed = String(token || "").trim();
  if (!trimmed.startsWith("aorAAAAAG")) {
    throw new Error("Invalid token format. Token should start with aorAAAAAG...");
  }
  // Prefer full dump (…:signature); bare prefix as fallback.
  const bare = trimmed.includes(":") ? trimmed.slice(0, trimmed.indexOf(":")) : "";
  const candidates = bare && bare.startsWith("aorAAAAAG") ? [trimmed, bare] : [trimmed];
  let result;
  let lastErr;
  for (const t of candidates) {
    try {
      result = await refreshToken(t, { authMethod: "imported" });
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!result) throw lastErr || new Error("Token refresh failed");
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken || trimmed,
    expiresAt: Date.now() + (result.expiresIn || 3600) * 1000,
    providerSpecificData: {
      authMethod: "imported",
      region: "us-east-1",
      profileArn: result.profileArn || KIRO_DEFAULT_PROFILE_ARNS.imported,
    },
  };
}

export async function loginWithDeviceCode({ onUserCode, region = "us-east-1" } = {}) {
  assertValidAwsRegion(region);
  const client = await registerClient(region);
  const device = await startDeviceAuthorization(
    client.clientId,
    client.clientSecret,
    KIRO_OAUTH.startUrl,
    region
  );
  if (onUserCode) {
    await onUserCode({
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      verificationUriComplete: device.verificationUriComplete,
    });
  }

  const deadline = Date.now() + (device.expiresIn || 600) * 1000;
  let intervalMs = (device.interval || 5) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const poll = await pollDeviceToken(
      client.clientId,
      client.clientSecret,
      device.deviceCode,
      region
    );
    if (poll.pending) {
      if (poll.error === "slow_down") intervalMs += 2000;
      continue;
    }
    if (!poll.success) throw new Error(poll.errorDescription || poll.error || "Device auth failed");

    return {
      accessToken: poll.tokens.accessToken,
      refreshToken: poll.tokens.refreshToken,
      expiresAt: Date.now() + (poll.tokens.expiresIn || 3600) * 1000,
      providerSpecificData: {
        authMethod: "builder-id",
        region,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        profileArn: KIRO_DEFAULT_PROFILE_ARNS["builder-id"],
      },
    };
  }
  throw new Error("Device authorization timed out");
}

export function buildHeaders(credentials, url = "") {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/vnd.amazon.eventstream",
    "User-Agent": "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0",
    "X-Amz-User-Agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
    "Amz-Sdk-Request": "attempt=1; max=3",
    "Amz-Sdk-Invocation-Id": crypto.randomUUID(),
  };

  if (url.includes("://codewhisperer.")) {
    headers["X-Amz-Target"] = KIRO_CODEWHISPERER_TARGET;
  }

  const authMethod = credentials?.providerSpecificData?.authMethod;
  const isApiKey = authMethod === "api_key";
  const apiKey = credentials?.apiKey || (isApiKey ? credentials?.accessToken : null);

  if (isApiKey && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers.TokenType = "API_KEY";
  } else if (credentials?.accessToken) {
    headers.Authorization = `Bearer ${credentials.accessToken}`;
  }

  return headers;
}

export function getOrderedBaseUrls(credentials) {
  const baseUrls = [...KIRO_BASE_URLS];
  const authMethod = credentials?.providerSpecificData?.authMethod;
  const isCodeWhispererSurface =
    authMethod === "api_key" || authMethod === "external_idp" || authMethod === "idc";
  if (!isCodeWhispererSurface) return baseUrls;

  const region = (credentials?.providerSpecificData?.region || "us-east-1").trim();
  const regionalize = (u) =>
    region && region !== "us-east-1" && u.includes("amazonaws.com")
      ? u.replace(/([a-z]+)\.[a-z0-9-]+\.amazonaws\.com/, `$1.${region}.amazonaws.com`)
      : u;

  const amazon = baseUrls.filter((u) => u.includes("amazonaws.com")).map(regionalize);
  const others = baseUrls.filter((u) => !u.includes("amazonaws.com"));
  if (authMethod === "api_key") {
    const q = amazon.filter((u) => u.includes("://q."));
    const remaining = amazon.filter((u) => !u.includes("://q."));
    return q.length > 0 ? [...q, ...remaining, ...others] : [...amazon, ...others];
  }
  return amazon.length > 0 ? [...amazon, ...others] : baseUrls;
}

export async function ensureFreshCredentials() {
  let cred = loadCredentials();
  if (!cred) throw new Error("Not logged in. Run: kirouter login");

  const authMethod = cred.providerSpecificData?.authMethod;
  if (authMethod === "api_key") return cred;
  if (!cred.refreshToken) return cred;

  const expiresAt = cred.expiresAt || 0;
  if (expiresAt && Date.now() < expiresAt - 60_000) return cred;

  const refreshed = await refreshToken(cred.refreshToken, cred.providerSpecificData || {});
  cred = {
    ...cred,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken || cred.refreshToken,
    expiresAt: Date.now() + (refreshed.expiresIn || 3600) * 1000,
    providerSpecificData: {
      ...cred.providerSpecificData,
      ...(refreshed.profileArn ? { profileArn: refreshed.profileArn } : {}),
    },
  };
  saveCredentials(cred);
  return cred;
}
