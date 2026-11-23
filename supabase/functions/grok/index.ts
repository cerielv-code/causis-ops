// Grok Bot bridge.
// POST /functions/v1/grok?action=send   (operator JWT or x-cron-secret)  body: { bot_id, text, approval_id? }  -> triggers the bot's routine webhook
// POST /functions/v1/grok?action=ping   (operator JWT or x-cron-secret)  body: { bot_id }  -> asks the bot to reply, to prove the round trip works
// Every send carries a one-time reply_url (?action=report&ref=...). The bot POSTs to it without any key; that marks the send as answered.
// POST /functions/v1/grok?action=report (Authorization: Bearer <report token>, or ?ref=<one-time reply token>) body: { bot, summary, posts: [{ text, url }] } or { items: [{ type, account, text, target_url, status, permalink, note }] }
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

async function cronOk(req: Request) {
  const c = req.headers.get("x-cron-secret");
  if (!c) return false;
  const { data } = await admin.rpc("cron_secret_ok", { candidate: c });
  return data === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const auth = req.headers.get("authorization");
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }

  if (action === "report") {
    const ref = url.searchParams.get("ref") ?? (typeof body.ref === "string" ? body.ref : null);
    let send: { id: string; bot_id: string; kind: string } | null = null;
    if (ref) {
      const { data } = await admin.from("grok_sends").select("id,bot_id,kind").eq("reply_token", ref).gt("expires_at", new Date().toISOString()).maybeSingle();
      send = data;
    }
    if (!send) {
      const token = (auth ?? "").replace(/^Bearer\s+/i, "");
      const { data: ok } = token ? await admin.rpc("grok_report_token_ok", { candidate: token }) : { data: false };
      if (!ok) return json({ error: ref ? "this reply link is unknown or expired" : "unauthorized" }, 401);
    }
    const { data: bots } = await admin.from("grok_bots").select("id,name,handle");
    let bot = send ? (bots ?? []).find((b) => b.id === send!.bot_id) ?? null : null;
    if (!bot) {
      const low = String(body.bot ?? body.name ?? "").toLowerCase().replace(/^@/, "");
      bot = (bots ?? []).find((b) => low && (b.name.toLowerCase() === low || b.name.toLowerCase().startsWith(low) || (b.handle ?? "").toLowerCase() === low)) ?? ((bots ?? []).length === 1 ? bots![0] : null);
    }
    const name = bot?.name ?? String(body.bot ?? body.name ?? "Grok Bot").slice(0, 100);
    const now = new Date().toISOString();
    if (send) {
      await admin.from("grok_sends").update({ replied_at: now, reply: body }).eq("id", send.id);
      await admin.from("grok_bots").update({ last_reply_at: now }).eq("id", send.bot_id);
    }
    // Accept Anna's item format: { items: [{ type, account, text, target_url, status, permalink, note }] } or a single item at top level
    const items = (Array.isArray(body.items) ? body.items : (body.type ? [body] : [])).slice(0, 50) as Record<string, string>[];
    const posts = (Array.isArray(body.posts) ? body.posts.slice(0, 50) : []) as Record<string, unknown>[];
    let queued = 0;
    const { data: vs } = await admin.from("ventures").select("id,slug");
    const vid = (acct?: string) => acct?.replace("@", "") === "annaos_ai" ? vs?.find((v) => v.slug === "anna")?.id : acct?.replace("@", "") === "causisresearch" ? vs?.find((v) => v.slug === "causis")?.id : null;
    for (const it of items) {
      const acct = (it.account ?? "").replace("@", "");
      const status = (it.status ?? "").toLowerCase();
      if (["posted", "published", "done", "sent"].includes(status)) { posts.push({ text: it.text, url: it.permalink ?? it.target_url ?? null, account: acct, type: it.type }); continue; }
      if ((it.type ?? "").toLowerCase() === "blocker" || status === "blocked") {
        await admin.from("approvals").insert({ kind: "other", title: `${name}: needs you${acct ? " (@" + acct + ")" : ""}`, body: String(it.text ?? it.note ?? ""), venture_id: vid(acct) ?? null, payload: { source: "grok", target_url: it.target_url ?? null } });
        queued++; continue;
      }
      if (["post", "reply", "quote"].includes((it.type ?? "post").toLowerCase())) {
        await admin.from("approvals").insert({ kind: "x_post", title: `@${acct || "x"} ${it.type ?? "post"} from ${name}`, body: String(it.text ?? ""), venture_id: vid(acct) ?? null,
          payload: { account: acct, why: it.note ?? `Drafted by ${name}`, source_url: it.target_url ?? null, reply_to: it.type === "reply" ? it.target_url ?? null : null, source: "grok" } });
        queued++; continue;
      }
      await admin.from("approvals").insert({ kind: "other", title: `${name}: ${it.type ?? "item"}`, body: String(it.text ?? it.note ?? ""), venture_id: vid(acct) ?? null, payload: { source: "grok", ...it } });
      queued++;
    }
    const summary = String(body.summary ?? (items.length ? `${posts.length} posted, ${queued} sent to Approvals` : ""));
    if (posts.length || summary) await admin.from("grok_reports").insert({ bot_id: bot?.id ?? null, bot_name: name, summary: summary.slice(0, 4000), posts, raw: body });
    if (bot?.id) await admin.from("grok_bots").update({ last_report_at: now }).eq("id", bot.id);
    await admin.from("activity").insert({ kind: "grok_report", summary: `${name}: ${summary.slice(0, 140) || (send?.kind === "ping" ? "answered the connection test" : "report")}` });
    return json({ ok: true, posted: posts.length, queued_for_approval: queued });
  }

  if (action === "send" || action === "ping") {
    if (!(await isOperator(auth)) && !(await cronOk(req))) return json({ error: "unauthorized" }, 401);
    const { data: bot } = await admin.from("grok_bots").select("*").eq("id", String(body.bot_id ?? "")).single();
    if (!bot?.webhook_url) return json({ error: "This Grok Bot has no webhook URL yet. Add it in Settings." }, 400);
    const { data: key } = await admin.rpc("get_grok_key", { p_bot_id: bot.id });
    if (!key) return json({ error: "This Grok Bot has no webhook key yet. Add it in Settings." }, 400);
    const ping = action === "ping";
    const note = ping
      ? "Connection check from the Causis ops panel. Do not post anything. Reply right away by sending a POST request to reply_url with the JSON body {\"summary\": \"received\"}."
      : String(body.text ?? "");
    const { data: row, error: insErr } = await admin.from("grok_sends").insert({ bot_id: bot.id, kind: ping ? "ping" : "note", note }).select("id,reply_token").single();
    if (insErr || !row) return json({ error: insErr?.message ?? "could not log the send" }, 500);
    const replyUrl = `${SB_URL}/functions/v1/grok?action=report&ref=${row.reply_token}`;
    const payload = {
      from: "Causis ops panel",
      type: ping ? "ping" : "note",
      date: new Date().toISOString().slice(0, 10),
      note,
      account: bot.handle ? `@${bot.handle}` : null,
      ref: row.id,
      reply_url: replyUrl,
      reply_instructions: "When you have read this, send a POST request to reply_url with Content-Type: application/json. No key is needed for this link. Minimum body: {\"summary\": \"received\"}. To hand back drafts, posted links or blockers, add items: [{\"type\": \"post|reply|quote|blocker|note\", \"account\": \"annaos_ai|notinvariant\", \"text\": \"...\", \"target_url\": \"...\", \"status\": \"draft|posted|blocked\", \"permalink\": \"...\", \"note\": \"...\"}]. The link works for 7 days and can be used more than once.",
    };
    let status = 0, text = "";
    try {
      const r = await fetch(bot.webhook_url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      status = r.status; text = (await r.text()).slice(0, 2000);
    } catch (e) { text = String(e).slice(0, 500); }
    await admin.from("grok_sends").update({ webhook_status: status, webhook_body: text }).eq("id", row.id);
    if (status < 200 || status >= 300) return json({ error: `Grok Bot's webhook answered ${status || "nothing"}: ${text.slice(0, 200)}`, send_id: row.id }, 502);
    await admin.from("grok_bots").update({ last_sent_at: new Date().toISOString() }).eq("id", bot.id);
    if (!ping && body.approval_id) await admin.from("approvals").update({ status: "done", body: note, decided_at: new Date().toISOString() }).eq("id", String(body.approval_id));
    await admin.from("activity").insert({ venture_id: bot.venture_id, kind: "grok_send", summary: ping ? `Connection test sent to ${bot.name}` : `Note delivered to ${bot.name}'s webhook, waiting for a reply` });
    return json({ ok: true, send_id: row.id, webhook_status: status });
  }

  return json({ error: "unknown action" }, 400);
});
