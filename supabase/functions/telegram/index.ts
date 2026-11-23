// Telegram (personal accounts, MTProto via GramJS). Supports several accounts.
// Operator actions (body.account_id required): login_start {phone}, login_code {code}, login_password {password}, logout, send {chat_id, text}, history {chat_id}, sync
// Cron action: sync (all connected accounts)
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
const secret = async (n: string) => { const { data } = await admin.rpc("get_app_secret", { p_name: n }); return (data as string | null) || null; };
const setSecret = (n: string, v: string) => admin.rpc("set_app_secret", { p_name: n, p_value: v });
type Acct = { id: string; label: string; connected: boolean; legacy: boolean };
const upd = (id: string, patch: Record<string, unknown>) => admin.from("tg_accounts").update(patch).eq("id", id);

async function creds() {
  const apiId = Number(await secret("tg_api_id")); const apiHash = await secret("tg_api_hash");
  if (!apiId || !apiHash) throw new Error("Telegram API ID and hash not set. Add them in Settings.");
  return { apiId, apiHash };
}
async function sessionFor(a: Acct) {
  let s = await secret(`tg_session:${a.id}`);
  if (!s && a.legacy) { s = await secret("tg_session"); if (s) await setSecret(`tg_session:${a.id}`, s); }
  return s ?? "";
}
async function open(sess: string) {
  const { apiId, apiHash } = await creds();
  const c = new TelegramClient(new StringSession(sess), apiId, apiHash, { connectionRetries: 2, deviceModel: "Causis ops", appVersion: "1.0", systemVersion: "web" });
  c.setLogLevel("error" as never);
  await c.connect();
  return c;
}
const save = (c: TelegramClient) => (c.session as StringSession).save();
const idStr = (x: unknown) => (x == null ? null : String(x));
const kindOf = (d: { isUser?: boolean; isGroup?: boolean; isChannel?: boolean }) => (d.isUser ? "user" : d.isGroup ? "group" : d.isChannel ? "channel" : "other");
const senderName = async (m: Api.Message) => {
  try { const s = await m.getSender() as { firstName?: string; lastName?: string; title?: string; username?: string } | undefined;
    return s ? [s.firstName, s.lastName].filter(Boolean).join(" ") || s.title || s.username || null : null; } catch { return null; }
};

async function syncAccount(a: Acct) {
  const c = await open(await sessionFor(a));
  try {
    const dialogs = await c.getDialogs({ limit: 80 });
    const { data: existing } = await admin.from("tg_dialogs").select("id,tracked,last_msg_id").eq("account_id", a.id);
    const ex = new Map((existing ?? []).map((r) => [String(r.id), r]));
    const rows = dialogs.map((d) => ({
      account_id: a.id, id: idStr(d.id), title: d.title || d.name || "Untitled", kind: kindOf(d),
      username: (d.entity as { username?: string })?.username ?? null,
      unread_count: d.unreadCount ?? 0, pinned: !!d.pinned,
      last_message_at: d.date ? new Date(d.date * 1000).toISOString() : null,
      last_message_preview: (d.message?.message ?? "").slice(0, 200), updated_at: new Date().toISOString(),
    })).filter((r) => r.id);
    if (rows.length) await admin.from("tg_dialogs").upsert(rows, { onConflict: "account_id,id" });
    let fetched = 0;
    for (const d of dialogs) {
      const cur = ex.get(String(d.id)); if (!cur?.tracked) continue;
      const msgs = await c.getMessages(d.entity, { limit: 40, minId: Number(cur.last_msg_id ?? 0) });
      if (!msgs.length) continue;
      const mrows = [];
      for (const m of msgs) mrows.push({ account_id: a.id, chat_id: idStr(d.id), tg_msg_id: m.id, sender_id: idStr(m.senderId), sender_name: m.out ? "You" : await senderName(m),
        text: m.message || (m.media ? "[media]" : ""), is_outgoing: !!m.out, sent_at: new Date(m.date * 1000).toISOString() });
      await admin.from("tg_msgs").upsert(mrows, { onConflict: "account_id,chat_id,tg_msg_id", ignoreDuplicates: true });
      await admin.from("tg_dialogs").update({ last_msg_id: Math.max(...msgs.map((m) => m.id)) }).eq("account_id", a.id).eq("id", idStr(d.id));
      fetched += mrows.length;
    }
    await upd(a.id, { last_sync_at: new Date().toISOString(), last_error: null });
    return { account: a.label, chats: rows.length, messages: fetched };
  } catch (e) {
    const msg = (e as { errorMessage?: string }).errorMessage ?? (e instanceof Error ? e.message : String(e));
    await upd(a.id, { last_error: msg.slice(0, 500), ...(/AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED/.test(msg) ? { connected: false } : {}) });
    return { account: a.label, error: msg };
  } finally { await c.disconnect().catch(() => {}); }
}

async function findDialog(c: TelegramClient, chatId: string) {
  const dialogs = await c.getDialogs({ limit: 150 });
  const d = dialogs.find((x) => String(x.id) === chatId);
  if (!d) throw new Error("Chat not found among recent chats");
  return d;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const action = new URL(req.url).searchParams.get("action") ?? "";
  let body: Record<string, string> = {};
  try { body = await req.json(); } catch { /* none */ }
  try {
    if (action === "sync" && !body.account_id) {
      const { data: accts } = await admin.from("tg_accounts").select("*").eq("connected", true);
      const out = []; for (const a of accts ?? []) out.push(await syncAccount(a as Acct));
      return json({ results: out, chats: out.reduce((n, r) => n + ((r as { chats?: number }).chats ?? 0), 0) });
    }
    const { data: a } = await admin.from("tg_accounts").select("*").eq("id", String(body.account_id ?? "")).single();
    if (!a) return json({ error: "Unknown Telegram account" }, 400);
    const acct = a as Acct;

    if (action === "sync") return json(await syncAccount(acct));

    if (action === "login_start") {
      const phone = String(body.phone ?? "").replace(/[^+\d]/g, "");
      if (!/^\+\d{8,15}$/.test(phone)) return json({ error: "Use international format, like +31612345678" }, 400);
      const { apiId, apiHash } = await creds();
      const c = await open("");
      try {
        const r = await c.invoke(new Api.auth.SendCode({ phoneNumber: phone, apiId, apiHash, settings: new Api.CodeSettings({}) })) as { phoneCodeHash: string };
        await setSecret(`tg_pending:${acct.id}`, JSON.stringify({ s: save(c), phone, hash: r.phoneCodeHash }));
        await upd(acct.id, { stage: "code_sent", last_error: null });
        return json({ ok: true });
      } finally { await c.disconnect().catch(() => {}); }
    }

    if (action === "login_code" || action === "login_password") {
      const pending = JSON.parse((await secret(`tg_pending:${acct.id}`)) ?? "{}");
      if (!pending.s) return json({ error: "Start again: request a new code" }, 400);
      const c = await open(pending.s);
      try {
        if (action === "login_code") {
          try {
            await c.invoke(new Api.auth.SignIn({ phoneNumber: pending.phone, phoneCodeHash: pending.hash, phoneCode: String(body.code ?? "").trim() }));
          } catch (e) {
            const m = (e as { errorMessage?: string }).errorMessage ?? String(e);
            if (m.includes("SESSION_PASSWORD_NEEDED")) {
              await setSecret(`tg_pending:${acct.id}`, JSON.stringify({ ...pending, s: save(c) }));
              await upd(acct.id, { stage: "password_needed" });
              return json({ password_needed: true });
            }
            throw e;
          }
        } else {
          const pwd = await c.invoke(new Api.account.GetPassword());
          await c.invoke(new Api.auth.CheckPassword({ password: await computeCheck(pwd, String(body.password ?? "")) }));
        }
        const me = await c.getMe() as { firstName?: string; lastName?: string; username?: string; id?: unknown };
        await setSecret(`tg_session:${acct.id}`, save(c));
        await setSecret(`tg_pending:${acct.id}`, "{}");
        await upd(acct.id, { connected: true, stage: null, last_error: null, label: me.username ? `@${me.username}` : acct.label,
          me: { name: [me.firstName, me.lastName].filter(Boolean).join(" "), username: me.username ?? null, id: idStr(me.id) } });
        return json({ ok: true });
      } finally { await c.disconnect().catch(() => {}); }
    }

    if (action === "logout") {
      try { const c = await open(await sessionFor(acct)); await c.invoke(new Api.auth.LogOut()); await c.disconnect(); } catch { /* ignore */ }
      await setSecret(`tg_session:${acct.id}`, "");
      await upd(acct.id, { connected: false, stage: null, me: null, legacy: false });
      return json({ ok: true });
    }

    if (action === "send" || action === "history") {
      const c = await open(await sessionFor(acct));
      try {
        const chatId = String(body.chat_id);
        const d = await findDialog(c, chatId);
        if (action === "send") {
          const m = await c.sendMessage(d.entity!, { message: String(body.text ?? "") });
          await admin.from("tg_msgs").upsert({ account_id: acct.id, chat_id: chatId, tg_msg_id: m.id, sender_name: "You", text: String(body.text ?? ""), is_outgoing: true, sent_at: new Date().toISOString() }, { onConflict: "account_id,chat_id,tg_msg_id" });
          return json({ ok: true });
        }
        const msgs = await c.getMessages(d.entity, { limit: 40 });
        const rows = [];
        for (const m of msgs) rows.push({ account_id: acct.id, chat_id: chatId, tg_msg_id: m.id, sender_id: idStr(m.senderId), sender_name: m.out ? "You" : await senderName(m),
          text: m.message || (m.media ? "[media]" : ""), is_outgoing: !!m.out, sent_at: new Date(m.date * 1000).toISOString() });
        if (rows.length) await admin.from("tg_msgs").upsert(rows, { onConflict: "account_id,chat_id,tg_msg_id", ignoreDuplicates: true });
        if (msgs.length) await admin.from("tg_dialogs").update({ last_msg_id: Math.max(...msgs.map((m) => m.id)) }).eq("account_id", acct.id).eq("id", chatId);
        return json({ ok: true, count: rows.length });
      } finally { await c.disconnect().catch(() => {}); }
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    const msg = (e as { errorMessage?: string }).errorMessage ?? (e instanceof Error ? e.message : String(e));
    return json({ error: msg }, 500);
  }
});
