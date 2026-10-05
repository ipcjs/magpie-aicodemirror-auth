const URL = "https://models.dev/api.json";
const VENDORS = [
  ["claude-", "anthropic"], ["gpt-", "openai"],
  ["gemini-", "google"], ["grok-", "xai"],
];

// Cache per plugin instance; deduplicate concurrent account refreshes. A failed
// refresh keeps the last successful catalog and backs off for five minutes.
export function reasoningCatalog({ fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
  let cached = {}, next = 0, pending;
  return async () => {
    if (now() < next) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetchImpl(URL, {
          headers: { Accept: "application/json" }, redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (!VENDORS.some(([, vendor]) => data?.[vendor]?.models && typeof data[vendor].models === "object")) throw new Error();
        cached = Object.fromEntries(VENDORS.map(([, vendor]) => [vendor, data[vendor]?.models ?? {}]));
        next = now() + 6 * 60 * 60 * 1000;
      } catch {
        next = now() + 5 * 60 * 1000;
      }
      return cached;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}

export function withReasoning(models, metadata) {
  for (const model of Object.values(models)) {
    const vendor = VENDORS.find(([prefix]) => model.id.startsWith(prefix))?.[1];
    const source = vendor && metadata[vendor]?.[model.id];
    if (!source) continue;
    const options = Array.isArray(source.reasoning_options) ? source.reasoning_options : [];
    const levels = [...new Set(options.filter(o => o?.type === "effort" && Array.isArray(o.values))
      .flatMap(o => o.values).filter(v => typeof v === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(v)))];
    // Budget-only and toggle-only models have no invented low/medium/high levels.
    if (source.reasoning === true || levels.length) {
      model.capabilities = { ...model.capabilities, reasoning: true };
    }
    if (levels.length) model.variants = Object.fromEntries(levels.map(level => [level,
      vendor === "anthropic" ? { effort: level }
        : vendor === "google" ? { thinkingConfig: { includeThoughts: true, thinkingLevel: level } }
          : { reasoningEffort: level },
    ]));
  }
  return models;
}
