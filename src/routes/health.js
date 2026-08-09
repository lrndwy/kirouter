import { sendJson } from "../util/http.js";
import { isLoggedIn } from "../store/credentials.js";

export function handleHealth(_req, res, method = "GET") {
  const body = {
    ok: true,
    service: "kirouter",
    loggedIn: isLoggedIn(),
  };
  if (method === "HEAD") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end();
    return;
  }
  sendJson(res, 200, body);
}
