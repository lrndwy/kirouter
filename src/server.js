import http from "node:http";
import { loadConfig } from "./store/config.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "./store/paths.js";
import { recordRequest } from "./store/stats.js";
import { handleHealth } from "./routes/health.js";
import { handleModels } from "./routes/models.js";
import { handleChatCompletions } from "./routes/chatCompletions.js";
import { handleMessages } from "./routes/messages.js";
import { getBearerToken, isLoopback, readJson, sendError, sendJson } from "./util/http.js";
import { estimateAnthropicInputTokens } from "./util/tokens.js";

function normalizePath(url) {
  let path = (url || "/").split("?")[0];
  path = path.replace(/\/+$/, "") || "/";
  // Claude Code (axios) joins ".../v1" + "/v1/messages" → "/v1/v1/messages"
  while (path.startsWith("/v1/v1/")) path = path.slice(3);
  return path;
}

function checkAuth(req, cfg, noAuth) {
  if (noAuth) return true;
  if (!cfg.requireApiKey) return true;
  if (isLoopback(req) && process.env.KIROUTER_LOOPBACK_OPEN === "1") return true;
  const token = getBearerToken(req);
  return !!token && token === cfg.localApiKey;
}

export function createServer(options = {}) {
  const cfg = loadConfig();
  const port = options.port ?? cfg.port ?? DEFAULT_PORT;
  const host = options.host ?? cfg.host ?? DEFAULT_HOST;
  const noAuth = options.noAuth === true;

  const server = http.createServer(async (req, res) => {
    const path = normalizePath(req.url);
    const method = (req.method || "GET").toUpperCase();
    const t0 = Date.now();

    // CORS for local tools
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, x-api-key, anthropic-version");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Health / Claude Code connectivity probes (no auth)
      if (
        (method === "GET" || method === "HEAD") &&
        (path === "/health" ||
          path === "/" ||
          path === "/api/hello" ||
          path === "/v1/api/hello")
      ) {
        return handleHealth(req, res, method);
      }

      const needsAuth =
        path === "/v1/models" ||
        path === "/v1/chat/completions" ||
        path === "/v1/messages" ||
        path === "/messages" ||
        path.startsWith("/v1/messages/");

      if (needsAuth && !checkAuth(req, cfg, noAuth)) {
        recordRequest({
          method,
          path,
          status: 401,
          ms: Date.now() - t0,
          error: "invalid api key",
        });
        return sendError(res, 401, "Invalid API key. Use Authorization: Bearer <localApiKey>");
      }

      if (method === "GET" && path === "/v1/models") return handleModels(req, res);
      // Chat/messages handlers record their own detailed logs
      if (method === "POST" && path === "/v1/chat/completions") return handleChatCompletions(req, res);
      if (method === "POST" && (path === "/v1/messages" || path === "/messages")) {
        return handleMessages(req, res);
      }
      // Claude Code / Cowork call this for context bar before sending
      if (method === "POST" && path === "/v1/messages/count_tokens") {
        const body = await readJson(req);
        const input_tokens = estimateAnthropicInputTokens(body);
        return sendJson(res, 200, { input_tokens });
      }

      recordRequest({
        method,
        path,
        status: 404,
        ms: Date.now() - t0,
        error: "not found",
      });
      return sendError(res, 404, `Not found: ${method} ${path}`);
    } catch (err) {
      recordRequest({
        method,
        path,
        status: 500,
        ms: Date.now() - t0,
        error: err.message || String(err),
      });
      return sendError(res, 500, err.message || String(err));
    }
  });

  return {
    server,
    port,
    host,
    start() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve({ port, host });
        });
      });
    },
  };
}
