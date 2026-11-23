// Control panel background jobs.
// POST /functions/v1/jobs?job=email-sync | email-send | x-metrics | all
// Auth: header x-cron-secret (from private.config) OR a signed-in operator's JWT.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { ImapFlow } from "npm:imapflow@1.0.164";
import { simpleParser } from "npm:mailparser@3.7.1";
import nodemailer from "npm:nodemailer@6.9.16";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function authorized(req: Request): Promise<boolean> {
  const cron = req.headers.get("x-cron-secret");
  if (cron) {
    const { data } = await admin.rpc("cron_secret_ok", { candidate: cron });
    return data === true;
  }
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  const user = createClient(SB_URL, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data } = await user.from("operators").select("email").limit(1);
  return !!data && data.length > 0;
}

type Account = {
  id: string; venture_id: string | null; address: string; username: string | null;
  imap_host: string; imap_port: number; smtp_host: string; smtp_port: number;
  secret_ref: string; last_uid: number;
};

async function pw(a: Account): Promise<string | null> {
  const env = Deno.env.get(a.secret_ref);
  if (env) return env;
  const { data } = await admin.rpc("get_email_password", { p_account_id: a.id });
  return (data as string | null) ?? null;
}

async function emailSync(): Promise<unknown[]> {
  const { data: accounts } = await admin.from("email_accounts").select("*").eq("active", true);
  const out: unknown[] = [];
  const { data: contacts } = await admin.from("contacts").select("id,email").not("email", "is", null);
  const byEmail = new Map((contacts ?? []).map((c) => [String(c.email).toLowerCase(), c.id]));

  for (const a of (accounts ?? []) as Account[]) {
    const pass = await pw(a);
    if (!pass) {
      await admin.from("email_accounts").update({ last_error: "Mailbox password not set. Add it in Settings." }).eq("id", a.id);
      out.push({ account: a.address, skipped: "no password" });
      continue;
    }
    const client = new ImapFlow({
      host: a.imap_host, port: a.imap_port, secure: true,
      auth: { user: a.username ?? a.address, pass }, logger: false,
    });
    let inserted = 0;
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const mb = client.mailbox as { uidNext: number; exists: number };
        const range = a.last_uid ? `${a.last_uid + 1}:*` : `${Math.max(1, mb.uidNext - 400)}:*`;
        const batch: { uid: number; source: Uint8Array; seen: boolean }[] = [];
        for await (const msg of client.fetch(range, { uid: true, source: true, flags: true }, { uid: true })) {
          if (msg.uid <= (a.last_uid ?? 0)) continue;
          batch.push({ uid: msg.uid, source: msg.source as Uint8Array, seen: (msg.flags as Set<string>)?.has("\\Seen") ?? false });
        }
        const take = a.last_uid ? batch.slice(0, 100) : batch.slice(-50);
        let maxUid = a.last_uid ?? 0;
        for (const m of take) {
          const p = await simpleParser(m.source);
          const from = p.from?.value?.[0];
          const addrs = (x: unknown) =>
            (Array.isArray(x) ? x : x ? [x] : []).flatMap((g: { value?: { address?: string }[] }) => g.value ?? []).map((v) => v.address ?? "").filter(Boolean);
          const text = (p.text ?? "").trim();
          const fromAddr = (from?.address ?? "").toLowerCase();
          const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
          const row = {
            account_id: a.id, venture_id: a.venture_id, uid: m.uid,
            message_id: p.messageId ?? null, in_reply_to: p.inReplyTo ?? null,
            thread_key: refs[0] ?? p.inReplyTo ?? p.messageId ?? null,
            from_addr: fromAddr, from_name: from?.name ?? null,
            to_addrs: addrs(p.to), cc_addrs: addrs(p.cc),
            subject: p.subject ?? "(no subject)",
            snippet: text.replace(/\s+/g, " ").slice(0, 200),
            body_text: text.slice(0, 100000),
            received_at: (p.date ?? new Date()).toISOString(),
            is_read: m.seen,
            contact_id: byEmail.get(fromAddr) ?? null,
          };
          const { error } = await admin.from("email_messages").upsert(row, { onConflict: "account_id,uid", ignoreDuplicates: true });
          if (!error) inserted++;
          maxUid = Math.max(maxUid, m.uid);
        }
        if (!a.last_uid && batch.length) maxUid = Math.max(maxUid, ...batch.map((b) => b.uid));
        await admin.from("email_accounts").update({ last_uid: maxUid, last_synced_at: new Date().toISOString(), last_error: null }).eq("id", a.id);
      } finally {
        lock.release();
      }
      await client.logout();
      out.push({ account: a.address, inserted });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await admin.from("email_accounts").update({ last_error: msg.slice(0, 500), last_synced_at: new Date().toISOString() }).eq("id", a.id);
      out.push({ account: a.address, error: msg });
      try { await client.close(); } catch { /* ignore */ }
    }
  }
  return out;
}

async function emailSend(): Promise<unknown[]> {
  const now = new Date().toISOString();
  const { data: items } = await admin.from("outbox").select("*, email_accounts(*)")
    .eq("channel", "email").eq("status", "queued")
    .or(`scheduled_for.is.null,scheduled_for.lte.${now}`).limit(20);
  const out: unknown[] = [];
  for (const it of items ?? []) {
    const a = it.email_accounts as Account | null;
    if (!a) { await admin.from("outbox").update({ status: "failed", error: "No sending account" }).eq("id", it.id); continue; }
    const pass = await pw(a);
    if (!pass) { await admin.from("outbox").update({ status: "failed", error: "Mailbox password not set. Add it in Settings." }).eq("id", it.id); continue; }
    await admin.from("outbox").update({ status: "sending", attempts: it.attempts + 1 }).eq("id", it.id);
    const p = it.payload as { to: string; cc?: string; subject: string; body: string; in_reply_to?: string; from_name?: string };
    try {
      const tx = nodemailer.createTransport({ host: a.smtp_host, port: a.smtp_port, secure: a.smtp_port === 465, auth: { user: a.username ?? a.address, pass } });
      const mail = {
        from: p.from_name ? `"${p.from_name}" <${a.address}>` : a.address,
        to: p.to, cc: p.cc || undefined, subject: p.subject, text: p.body,
        inReplyTo: p.in_reply_to || undefined, references: p.in_reply_to || undefined,
      };
      const info = await tx.sendMail(mail);
      // Save a copy to Sent so it shows in webmail too
      try {
        const MailComposer = (await import("npm:nodemailer@6.9.16/lib/mail-composer/index.js")).default;
        const raw: Uint8Array = await new MailComposer({ ...mail, messageId: info.messageId }).compile().build();
        const c = new ImapFlow({ host: a.imap_host, port: a.imap_port, secure: true, auth: { user: a.username ?? a.address, pass }, logger: false });
        await c.connect(); await c.append("Sent", raw, ["\\Seen"]); await c.logout();
      } catch { /* non-fatal */ }
      await admin.from("outbox").update({ status: "sent", sent_at: new Date().toISOString(), result: { messageId: info.messageId }, error: null }).eq("id", it.id);
      await admin.from("activity").insert({ venture_id: it.venture_id, kind: "email_sent", summary: `Email to ${p.to}: ${p.subject}`, ref: { outbox_id: it.id } });
      out.push({ id: it.id, sent: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await admin.from("outbox").update({ status: "failed", error: msg.slice(0, 500) }).eq("id", it.id);
      out.push({ id: it.id, error: msg });
    }
  }
  return out;
}

async function xMetrics(): Promise<unknown[]> {
  let bearer = Deno.env.get("X_BEARER_TOKEN");
  if (!bearer) { const { data } = await admin.rpc("get_app_secret", { p_name: "x_bearer" }); bearer = (data as string | null) ?? undefined; }
  if (!bearer) return [{ skipped: "X token not set. Add it in Settings." }];
  const h = { Authorization: `Bearer ${bearer}` };
  const { data: accounts } = await admin.from("x_accounts").select("*");
  const out: unknown[] = [];
  for (const acc of accounts ?? []) {
    try {
      const u = await fetch(`https://api.x.com/2/users/by/username/${acc.handle}?user.fields=public_metrics,name`, { headers: h });
      const uj = await u.json();
      if (!u.ok || !uj.data) throw new Error(JSON.stringify(uj).slice(0, 300));
      const pm = uj.data.public_metrics;
      await admin.from("x_accounts").update({ x_user_id: uj.data.id, display_name: uj.data.name, followers: pm.followers_count, last_synced_at: new Date().toISOString() }).eq("id", acc.id);
      await admin.from("x_account_stats").insert({ account_id: acc.id, followers: pm.followers_count, following: pm.following_count, tweet_count: pm.tweet_count, listed: pm.listed_count });
      await admin.from("metrics").insert({ venture_id: acc.venture_id, source: "x", metric: `followers:@${acc.handle}`, value: pm.followers_count });

      const t = await fetch(`https://api.x.com/2/users/${uj.data.id}/tweets?max_results=25&exclude=retweets&tweet.fields=public_metrics,created_at`, { headers: h });
      const tj = await t.json();
      const rows = (tj.data ?? []).map((tw: { id: string; text: string; created_at: string; public_metrics: Record<string, number> }) => ({
        id: tw.id, account_id: acc.id, text: tw.text, created_at: tw.created_at,
        likes: tw.public_metrics.like_count ?? 0, reposts: tw.public_metrics.retweet_count ?? 0,
        replies: tw.public_metrics.reply_count ?? 0, quotes: tw.public_metrics.quote_count ?? 0,
        bookmarks: tw.public_metrics.bookmark_count ?? 0, impressions: tw.public_metrics.impression_count ?? 0,
        updated_at: new Date().toISOString(),
      }));
      if (rows.length) await admin.from("x_posts").upsert(rows, { onConflict: "id" });
      out.push({ handle: acc.handle, followers: pm.followers_count, posts: rows.length });
    } catch (e) {
      out.push({ handle: acc.handle, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const job = new URL(req.url).searchParams.get("job") ?? "all";
  const result: Record<string, unknown> = {};
  try {
    if (job === "email-sync" || job === "all") result.emailSync = await emailSync();
    if (job === "email-send" || job === "all") result.emailSend = await emailSend();
    if (job === "x-metrics") result.xMetrics = await xMetrics();
    await admin.from("worker_heartbeat").upsert({ name: `jobs:${job}`, last_seen: new Date().toISOString(), info: result });
    return json(result);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
