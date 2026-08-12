import { getContextCompactConfig, getTokenSaverConfig } from "../store/config.js";
import { contextCompactMaybe } from "./contextCompact.js";
import { tokenSaverPreprocess } from "./tokenSaver.js";

/**
 * Run token saver then context compact. Returns mutated body + combined stats.
 * @param {object} body
 * @param {"openai"|"claude"} format
 */
export function preprocessRequest(body, format) {
  const saverCfg = getTokenSaverConfig();
  const compactCfg = getContextCompactConfig();

  const saver = tokenSaverPreprocess(body, format, saverCfg);
  const compact = contextCompactMaybe(saver.body, format, compactCfg);

  const savedTokens =
    (saver.stats.savedTokensEst || 0) + (compact.stats.savedTokensEst || 0);

  return {
    body: compact.body,
    preprocess: {
      savedTokens,
      savedChars: saver.stats.savedChars || 0,
      truncatedResults: saver.stats.truncatedResults || 0,
      imagesStripped: saver.stats.imagesStripped || 0,
      compacted: Boolean(compact.stats.compacted),
      droppedMessages: compact.stats.droppedMessages || 0,
      estimatedBefore: compact.stats.estimatedBefore || 0,
      estimatedAfter: compact.stats.estimatedAfter || 0,
      tokenSaver: saver.stats,
      contextCompact: compact.stats,
    },
  };
}
