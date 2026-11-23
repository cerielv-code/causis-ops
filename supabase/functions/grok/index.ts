// Grok Bot bridge.
// POST /functions/v1/grok?action=send   (operator JWT)  body: { bot_id, text, approval_id? }  -> triggers the bot's routine webhook
// POST /functions/v1/grok?action=report (Authorization: Bearer <report token>) body: { bot, summary, posts: [{ text, url }] }
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function isOperator(auth: string | null) {
  if (!auth) return false;
  const u = createClient(SB_URL, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data } = await u.from("operators").select("email").limit(1);
  return !!data && data.length > 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const action = new URL(req.url).searchParams.get("action");
  const auth = req.headers.get("authorization");
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }

  if (action === "report") {
    const token = (auth ?? "").replace(/^Bearer\s+/i, "");
    const { data: ok } = await admin.rpc("grok_report_token_ok", { candidate: token });
    if (!ok) return json({ error: "unauthorized" }, 401);
    const name = String(body.bot ?? body.name ?? "Grok Bot").slice(0, 100);
    const { data: bot } = await admin.from("grok_bots").select("id").or(`name.ilike.${name},handle.ilike.${name.replace(/^@/, "")}`).limit(1).maybeSingle();
    const posts = Array.isArray(body.posts) ? body.posts.slice(0, 50) : [];
    await admin.from("grok_reports").insert({ bot_id: bot?.id ?? null, bot_name: name, summary: String(body.summary ?? "").slice(0, 4000), posts, raw: body });
    if (bot?.id) await admin.from("grok_bots").update({ last_report_at: new Date().toISOString() }).eq("id", bot.id);
    await admin.from("activity").insert({ kind: "grok_report", summary: `${name} reported: ${String(body.summary ?? `${posts.length} posts`).slice(0, 140)}` });
    return json({ ok: true });
  }

  if (action === "send") {
    if (!(await isOperator(auth))) return json({ error: "unauthorized" }, 401);
    const { data: bot } = await admin.from("grok_bots").select("*").eq("id", String(body.bot_id ?? "")).single();
    if (!bot?.webhook_url) return json({ error: "This Grok Bot has no webhook URL yet. Add it in Settings." }, 400);
    const { data: key } = await admin.rpc("get_grok_key", { p_bot_id: bot.id });
    if (!key) return json({ error: "This Grok Bot has no webhook key yet. Add it in Settings." }, 400);
    const payload = {
      from: "Causis ops panel",
      date: new Date().toISOString().slice(0, 10),
      note: String(body.text ?? ""),
      account: bot.handle ? `@${bot.handle}` : null,
    };
    const r = await fetch(bot.webhook_url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const text = await r.text();
    if (!r.ok) return json({ error: `Grok Bot answered ${r.status}: ${text.slice(0, 200)}` }, 502);
    await admin.from("grok_bots").update({ last_sent_at: new Date().toISOString() }).eq("id", bot.id);
    if (body.approval_id) await admin.from("approvals").update({ status: "done", body: payload.note, decided_at: new Date().toISOString() }).eq("id", String(body.approval_id));
    await admin.from("activity").insert({ venture_id: bot.venture_id, kind: "grok_send", summary: `Sent today's note to ${bot.name}` });
    return json({ ok: true });
  }

  return json({ error: "unknown action" }, 400);
});
