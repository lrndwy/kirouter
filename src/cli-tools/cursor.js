import { getBaseUrl, loadConfig } from "../store/config.js";

export async function status() {
  return {
    id: "cursor",
    name: "Cursor",
    installed: true,
    configured: false,
    guideOnly: true,
  };
}

export async function apply() {
  throw new Error("Cursor is guide-only. Use: kirouter tools cursor");
}

export async function reset() {
  return { success: true, message: "Nothing to reset for Cursor guide" };
}

export function printGuide() {
  const cfg = loadConfig();
  const baseUrl = getBaseUrl(cfg);
  console.log(`
Cursor (manual):
  1. Settings → Models → Enable OpenAI API key
  2. Base URL: ${baseUrl}
  3. API Key:  ${cfg.localApiKey}
  4. Add custom model (e.g. ${cfg.defaultModel})

Note: Cursor often requires a public URL (tunnel). Localhost may not work.
`);
}
