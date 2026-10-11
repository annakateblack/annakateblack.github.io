// Anna Kate's portfolio assistant. Paste this whole file into a Cloudflare Worker.
// It needs one secret, ANTHROPIC_API_KEY, added under Settings > Variables and Secrets.
// The bot's rules and knowledge live on the site (bot/rules.md and bot/knowledge.md),
// so updating them is a push to GitHub, not a change here.

const SITE = "https://annakateblack.github.io";
const MODEL = "claude-sonnet-5-5";
const MAX_QUESTION = 500;   // characters per visitor message
const MAX_TURNS = 9;        // messages of history sent to the model
const PER_IP = 40;          // questions per visitor per 10 minutes (best effort)
const hits = new Map();

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": SITE,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Vary": "Origin",
    };
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return reply({ error: "method" }, 405);
    if (origin !== SITE) return reply({ error: "origin" }, 403);

    // Best-effort throttle per visitor. Real cost protection is the spend limit in the Claude Console.
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
    if (recent.length >= PER_IP) return reply({ error: "busy" }, 429);
    recent.push(now);
    hits.set(ip, recent);

    let body;
    try { body = await request.json(); } catch { return reply({ error: "bad request" }, 400); }
    let messages = Array.isArray(body && body.messages) ? body.messages : [];
    messages = messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-MAX_TURNS)
      .map((m) => ({ role: m.role, content: m.content.slice(0, m.role === "user" ? MAX_QUESTION : 1500) }));
    while (messages.length && messages[0].role !== "user") messages.shift();
    if (!messages.length || messages[messages.length - 1].role !== "user" || !messages[messages.length - 1].content.trim()) {
      return reply({ error: "empty" }, 400);
    }

    let rules, knowledge;
    try {
      [rules, knowledge] = await Promise.all([getText(`${SITE}/bot/rules.md`), getText(`${SITE}/bot/knowledge.md`)]);
    } catch {
      return reply({ error: "offline" }, 503);
    }

    const api = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.MODEL || MODEL,
        max_tokens: 400,
        system: [
          { type: "text", text: rules },
          { type: "text", text: knowledge, cache_control: { type: "ephemeral" } },
        ],
        messages,
      }),
    });
    if (!api.ok) return reply({ error: api.status === 429 ? "busy" : "offline" }, 503);

    const data = await api.json();
    let text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    text = text.replace(/\s*—\s*/g, ", ").replace(/\*\*/g, "");
    if (!text) return reply({ error: "offline" }, 503);
    return reply({ reply: text });
  },
};

async function getText(url) {
  const r = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.text();
}
