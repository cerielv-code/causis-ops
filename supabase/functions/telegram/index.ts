// Telegram (personal account, MTProto via GramJS).
// Operator actions: ping, login_start {phone}, login_code {code}, login_password {password}, logout, send {chat_id, text}, history {chat_id}
// Cron action: sync
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { TelegramClient, Api } from "npm:telegram@2.26.22";
import { StringSession } from "npm:telegram@2.26.22/sessions/index.js";
import { computeCheck } from "npm:telegram@2.26.22/Password.js";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function authorized(req: Request) {
  const cron = req.headers.get("x-cron-secret");
  if (cron) { const { data } = await admin.rpc("cron_secret_ok", { candidate: cron }); return data === true; }
  const auth = req.headers.get("authorization"); if (!auth) return false;
  const u = createClient(SB_URL, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data } = await u.from("operators").select("email").limit(1);
  return !!data && data.length > 0;
}
const secret = async (n: string) => { const { data } = await admin.rpc("get_app_secret", { p_name: n }); return (data as string | null) ?? null; };
const setSecret = (n: string, v: string) => admin.rpc("set_app_secret", { p_name: n, p_value: v });
const status = (patch: Record<string, unknown>) => admin.from("tg_status").update(patch).eq("id", 1);

async function client(sessionName: "tg_session" | "tg_pending" | null) {
  const apiId = Number(await secret("tg_api_id")); const apiHash = await secret("tg_api_hash");
  if (!apiId || !apiHash) throw new Error("Telegram API ID and hash not set. Add them in Settings.");
  const sess = sessionName ? (await secret(sessionName)) ?? "" : "";
  const c = new TelegramClient(new StringSession(sess), apiId, apiHash, { connectionRetries: 2, deviceModel: "Causis ops", appVersion: "1.0", systemVersion: "web" });
  c.setLogLevel("error" as never);
  await c.connect();
  return c;
}
const save = (c: TelegramClient) => (c.session as StringSession).save();
const idStr = (x: unknown) => (x == null ? null : String(x));
const kindOf = (d: { isUser?: boolean; isGroup?: boolean; isChannel?: boolean }) => (d.isUser ? "user" : d.isGroup ? "group" : d.isChannel ? "channel" : "other");

async function sync() {
  const { data: st } = await admin.from("tg_status").select("*").eq("id", 1).single();
  if (!st?.connected) return { skipped: "not connected" };
  const c = await client("tg_session");
  try {
    const dialogs = await c.getDialogs({ limit: 80 });
    const { data: existing } = await admin.from("tg_chats").select("id,tracked,last_msg_id,venture_id");
    const ex = new Map((existing ?? []).map((r) => [String(r.id), r]));
    const rows = dialogs.map((d) => ({
      id: idStr(d.id), title: d.title || d.name || "Untitled", kind: kindOf(d),
      username: (d.entity as { username?: string })?.username ?? null,
      unread_count: d.unreadCount ?? 0, pinned: !!d.pinned,
      last_message_at: d.date ? new Date(d.date * 1000).toISOString() : null,
      last_message_preview: (d.message?.message ?? "").slice(0, 200),
      updated_at: new Date().toISOString(),
    })).filter((r) => r.id);
    if (rows.length) await admin.from("tg_chats").upsert(rows, { onConflict: "id" });
    let fetched = 0;
    for (const d of dialogs) {
      const cur = ex.get(String(d.id)); if (!cur?.tracked) continue;
      const msgs = await c.getMessages(d.entity, { limit: 40, minId: Number(cur.last_msg_id ?? 0) });
      if (!msgs.length) continue;
      const mrows = [];
      for (const m of msgs) {
        let senderName: string | null = null;
        try { const s = await m.getSender() as { firstName?: string; lastName?: string; title?: string; username?: string } | undefined; senderName = s ? [s.firstName, s.lastName].filter(Boolean).join(" ") || s.title || s.username || null : null; } catch { /* ignore */ }
        mrows.push({ chat_id: idStr(d.id), tg_msg_id: m.id, sender_id: idStr(m.senderId), sender_name: m.out ? "You" : senderName,
          text: m.message || (m.media ? "[media]" : ""), is_outgoing: !!m.out, sent_at: new Date(m.date * 1000).toISOString() });
      }
      await admin.from("tg_messages").upsert(mrows, { onConflict: "chat_id,tg_msg_id", ignoreDuplicates: true });
      await admin.from("tg_chats").update({ last_msg_id: Math.max(...msgs.map((m) => m.id)) }).eq("id", idStr(d.id));
      fetched += mrows.length;
    }
    await status({ last_sync_at: new Date().toISOString(), last_error: null });
    return { chats: rows.length, messages: fetched };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await status({ last_error: msg.slice(0, 500), ...(/AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED/.test(msg) ? { connected: false } : {}) });
    throw e;
  } finally { await c.disconnect().catch(() => {}); }
}

async function findEntity(c: TelegramClient, chatId: string) {
  const dialogs = await c.getDialogs({ limit: 150 });
  const d = dialogs.find((x) => String(x.id) === chatId);
  if (!d) throw new Error("Chat not found among your recent chats");
  return d;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const action = new URL(req.url).searchParams.get("action") ?? "";
  let body: Record<string, string> = {};
  try { body = await req.json(); } catch { /* none */ }
  try {
    if (action === "ping") {
      const t0 = Date.now();
      const c = new TelegramClient(new StringSession(""), 1, "x", { connectionRetries: 1 }); c.setLogLevel("error" as never);
      await c.connect(); const ok = c.connected; await c.disconnect(); return json({ ok, ms: Date.now() - t0 });
    }
    if (action === "login_start") {
      const phone = String(body.phone ?? "").replace(/\s/g, "");
      if (!/^\+\d{8,15}$/.test(phone)) return json({ error: "Use international format, like +31612345678" }, 400);
      const c = await client(null);
      try {
        const r = await c.invoke(new Api.auth.SendCode({ phoneNumber: phone, apiId: Number(await secret("tg_api_id")), apiHash: (await secret("tg_api_hash"))!, settings: new Api.CodeSettings({}) })) as { phoneCodeHash: string };
        await setSecret("tg_pending", JSON.stringify({ s: save(c), phone, hash: r.phoneCodeHash }));
        await status({ stage: "code_sent", last_error: null });
        return json({ ok: true });
      } finally { await c.disconnect().catch(() => {}); }
    }
    if (action === "login_code" || action === "login_password") {
      const pending = JSON.parse((await secret("tg_pending")) ?? "{}");
      if (!pending.s) return json({ error: "Start again: request a new code" }, 400);
      const apiId = Number(await secret("tg_api_id")); const apiHash = (await secret("tg_api_hash"))!;
      const c = new TelegramClient(new StringSession(pending.s), apiId, apiHash, { connectionRetries: 2, deviceModel: "Causis ops", appVersion: "1.0", systemVersion: "web" });
      c.setLogLevel("error" as never); await c.connect();
      try {
        if (action === "login_code") {
          try {
            await c.invoke(new Api.auth.SignIn({ phoneNumber: pending.phone, phoneCodeHash: pending.hash, phoneCode: String(body.code ?? "").trim() }));
          } catch (e) {
            const m = (e as { errorMessage?: string }).errorMessage ?? String(e);
            if (m.includes("SESSION_PASSWORD_NEEDED")) {
              await setSecret("tg_pending", JSON.stringify({ ...pending, s: save(c) }));
              await status({ stage: "password_needed" });
              return json({ password_needed: true });
            }
            throw e;
          }
        } else {
          const pwd = await c.invoke(new Api.account.GetPassword());
          await c.invoke(new Api.auth.CheckPassword({ password: await computeCheck(pwd, String(body.password ?? "")) }));
        }
        const me = await c.getMe() as { firstName?: string; lastName?: string; username?: string; id?: unknown };
        await setSecret("tg_session", save(c));
        await setSecret("tg_pending", "{}");
        await status({ connected: true, stage: null, last_error: null, me: { name: [me.firstName, me.lastName].filter(Boolean).join(" "), username: me.username ?? null, id: idStr(me.id) } });
        return json({ ok: true });
      } finally { await c.disconnect().catch(() => {}); }
    }
    if (action === "logout") {
      try { const c = await client("tg_session"); await c.invoke(new Api.auth.LogOut()); await c.disconnect(); } catch { /* ignore */ }
      await setSecret("tg_session", ""); await status({ connected: false, stage: null, me: null });
      return json({ ok: true });
    }
    if (action === "sync") return json(await sync());
    if (action === "send") {
      const c = await client("tg_session");
      try {
        const d = await findEntity(c, String(body.chat_id));
        const m = await c.sendMessage(d.entity!, { message: String(body.text ?? "") });
        await admin.from("tg_messages").upsert({ chat_id: String(body.chat_id), tg_msg_id: m.id, sender_name: "You", text: String(body.text ?? ""), is_outgoing: true, sent_at: new Date().toISOString() }, { onConflict: "chat_id,tg_msg_id" });
        return json({ ok: true });
      } finally { await c.disconnect().catch(() => {}); }
    }
    if (action === "history") {
      const c = await client("tg_session");
      try {
        const d = await findEntity(c, String(body.chat_id));
        const msgs = await c.getMessages(d.entity, { limit: 40 });
        const rows = msgs.map((m) => ({ chat_id: String(body.chat_id), tg_msg_id: m.id, sender_id: idStr(m.senderId), sender_name: m.out ? "You" : (d.isUser ? d.title : null),
          text: m.message || (m.media ? "[media]" : ""), is_outgoing: !!m.out, sent_at: new Date(m.date * 1000).toISOString() }));
        if (rows.length) await admin.from("tg_messages").upsert(rows, { onConflict: "chat_id,tg_msg_id", ignoreDuplicates: true });
        if (msgs.length) await admin.from("tg_chats").update({ last_msg_id: Math.max(...msgs.map((m) => m.id)) }).eq("id", String(body.chat_id));
        return json({ ok: true, count: rows.length });
      } finally { await c.disconnect().catch(() => {}); }
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    const msg = (e as { errorMessage?: string }).errorMessage ?? (e instanceof Error ? e.message : String(e));
    return json({ error: msg }, 500);
  }
});
