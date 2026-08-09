export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendError(res, status, message, type = "invalid_request_error") {
  sendJson(res, status, { error: { message, type, code: status } });
}

export async function pipeWebResponse(nodeRes, webRes) {
  nodeRes.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
  if (!webRes.body) {
    nodeRes.end();
    return;
  }
  const reader = webRes.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    nodeRes.write(Buffer.from(value));
  }
  nodeRes.end();
}

export function getBearerToken(req) {
  const auth = req.headers.authorization || req.headers["x-api-key"] || "";
  if (typeof auth !== "string") return "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return auth.trim();
}

export function isLoopback(req) {
  const addr = req.socket?.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
