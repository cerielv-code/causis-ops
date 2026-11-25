// Panel team runtime: the second team next to Grok Bot.
// Inbox triage, Follow-up, Hygiene, Daily brief, Consistency check, Warm paths.
// POST /functions/v1/team?action=run&slug=triage   (started by public.start_agent, which routes these slugs here)
// Auth: x-cron-secret header or a signed-in operator's JWT.
// Budget: every run checks the agent's monthly budget plus the global daily and monthly caps first.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

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

// ---------- Claude ----------
// Estimated list prices, USD per million tokens. Search: per 1,000 searches.
const PRICES: Record<string, [number, number]> = { "claude-sonnet-5-5": [3, 15], "claude-haiku-5-5": [1, 5], "claude-opus-5-5": [5, 25] };
const SEARCH_PER_1K = 10;
const WEB_SEARCH_TYPE = "web_search_20250305";

type Usage = { tin: number; tout: number; searches: number };
async function anthropicKey() {
  const env = Deno.env.get("ANTHROPIC_API_KEY"); if (env) return env;
  const { data } = await admin.rpc("get_app_secret", { p_name: "anthropic" });
  return (data as string | null) ?? null;
}

async function claude(o: { model: string; system: string; user: string; schema: Record<string, unknown>; searches?: number; maxTokens?: number }, usage: Usage) {
  const key = await anthropicKey();
  if (!key) throw new Error("Anthropic API key not set. Add it in Settings.");
  const tools: unknown[] = [{ name: "submit", description: "Submit your final result. Call exactly once when done.", input_schema: o.schema }];
  if (o.searches) tools.unshift({ type: WEB_SEARCH_TYPE, name: "web_search", max_uses: o.searches });
  const messages: { role: string; content: unknown }[] = [{ role: "user", content: o.user }];
  for (let i = 0; i < 6; i++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: o.model, max_tokens: o.maxTokens ?? 8000, system: o.system, tools, messages }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Claude API ${r.status}: ${JSON.stringify(j?.error ?? j).slice(0, 400)}`);
    usage.tin += j.usage?.input_tokens ?? 0; usage.tout += j.usage?.output_tokens ?? 0;
    usage.searches += j.usage?.server_tool_use?.web_search_requests ?? 0;
    const submit = (j.content ?? []).find((c: { type: string; name?: string }) => c.type === "tool_use" && c.name === "submit");
    if (submit) return submit.input as Record<string, unknown>;
    messages.push({ role: "assistant", content: j.content });
    if (j.stop_reason === "pause_turn") continue;
    messages.push({ role: "user", content: "Now call the submit tool with your final result." });
  }
  throw new Error("Agent did not submit a result");
}
function cost(model: string, u: Usage) {
  const [pi, po] = PRICES[model] ?? [3, 15];
  return +(u.tin / 1e6 * pi + u.tout / 1e6 * po + u.searches / 1000 * SEARCH_PER_1K).toFixed(4);
}

// ---------- helpers ----------
const today = () => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date());
const noDash = (s: string) => (s ?? "").replace(/\s*[—–]\s*/g, ", ");
const BASE_SYSTEM = (extra: string) =>
  `You are an agent working for Causis Research and its product Anna, reporting to Ceriel van den Adel (commercial co-founder). Today is ${today()}. Be accurate: never invent people, funds, emails, URLs or facts; if unsure, leave a field empty. Never use em dashes or en dashes. ${extra}`;

type Agent = { id: string; slug: string; name: string; model: string; instructions: string; venture_id: string | null; monthly_budget_usd: number };
type Ctx = { agent: Agent; runId: string; usage: Usage };

// =====================================================================
// Panel team (second team, complements Grok Bot): triage, follow-up,
// hygiene, daily brief, consistency check, warm paths.
// Cheap by design: plain database logic first, Haiku only where judgment is needed.
// =====================================================================
let CALLER_HEADERS: Record<string, string> = {};
async function factsSheet() {
  const { data } = await admin.from("facts_versions").select("version,content,created_at").order("version", { ascending: false }).limit(1).single();
  return { version: data?.version ?? 0, content: data?.content ?? "", updated_at: data?.created_at ?? null };
}
const ACTIVE_STAGES = ["lead", "contacted", "replied", "meeting", "diligence", "committed"];
const short = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const personal = /@(gmail|googlemail|outlook|hotmail|icloud|me|yahoo|proton|protonmail|live)\./i;

async function compactContacts(limit = 400) {
  const { data } = await admin.from("contacts").select("id,name,org,email,telegram,x_handle,type,stage").is("merged_into", null).order("updated_at", { ascending: false }).limit(limit);
  return data ?? [];
}

async function recentDraftFor(recipient: string | null, days = 7) {
  if (!recipient) return false;
  const { count } = await admin.from("approvals").select("id", { count: "exact", head: true }).ilike("recipient", recipient).gte("created_at", new Date(Date.now() - days * 864e5).toISOString());
  return (count ?? 0) > 0;
}

// ---------- Inbox triage ----------
async function runTriage(c: Ctx) {
  const since = new Date(Date.now() - 3 * 864e5).toISOString();
  const { data: mails } = await admin.from("email_messages").select("id,account_id,venture_id,message_id,from_name,from_addr,subject,body_text,received_at,contact_id")
    .is("triaged_at", null).gte("received_at", since).order("received_at", { ascending: false }).limit(30);
  const { data: cur } = await admin.from("worker_heartbeat").select("info").eq("name", "triage-cursor").maybeSingle();
  const tgSince = (cur?.info as { tg_since?: string } | null)?.tg_since ?? new Date(Date.now() - 864e5).toISOString();
  const { data: dialogs } = await admin.from("tg_dialogs").select("account_id,id,title,kind,username,unread_count,last_message_at,last_message_preview")
    .gt("last_message_at", tgSince).neq("kind", "channel").gt("unread_count", 0).order("last_message_at", { ascending: false }).limit(40);
  // Only people and deal groups ("X <> Y"); skip big community chats.
  const tg = (dialogs ?? []).filter((d) => d.kind === "user" ? d.id !== 777000 : / <> | x |\*/i.test(d.title ?? "")).slice(0, 20);
  const contacts = await compactContacts();
  const byEmail = new Map(contacts.filter((k) => k.email).map((k) => [k.email!.toLowerCase(), k.id]));
  const byTg = new Map(contacts.filter((k) => k.telegram).map((k) => [k.telegram!.toLowerCase().replace(/^@/, ""), k.id]));
  // Deterministic matches first (free).
  for (const m of mails ?? []) if (!m.contact_id && byEmail.has((m.from_addr ?? "").toLowerCase())) m.contact_id = byEmail.get(m.from_addr.toLowerCase())!;
  if (!(mails ?? []).length && !tg.length) {
    await admin.from("worker_heartbeat").upsert({ name: "triage-cursor", last_seen: new Date().toISOString(), info: { tg_since: new Date().toISOString() } });
    return { summary: "Nothing new to triage", output: { emails: 0, telegram: 0 }, noAi: true };
  }
  const facts = await factsSheet();
  const items = [
    ...(mails ?? []).map((m) => ({ ref: `e:${m.id}`, channel: "email", from: `${m.from_name ?? ""} <${m.from_addr}>`, subject: m.subject, known_contact: m.contact_id, text: short(m.body_text, 1500) })),
    ...tg.map((d) => ({ ref: `t:${d.account_id}:${d.id}`, channel: "telegram", from: d.title, username: d.username, known_contact: d.username ? byTg.get(d.username.toLowerCase()) ?? null : null, unread: d.unread_count, text: short(d.last_message_preview, 400) })),
  ];
  const out = await claude({
    model: c.agent.model,
    system: BASE_SYSTEM("You triage Ceriel's inbox for a fundraise and partner push. Be terse. Match people to existing contacts by email, handle, name or organisation. Only suggest a new contact for a real person relevant to fundraising, partnerships, testers or press, never for newsletters, notifications, tools or cold sales pitches. Draft replies only when a reply is clearly expected, in Ceriel's voice: short, direct, warm, no filler, first person. Use only facts from the facts sheet."),
    user: `# Facts sheet v${facts.version}\n${facts.content}\n\n# Contacts (id | name | org | email | telegram | x | type | stage)\n${contacts.map((k) => [k.id, k.name, k.org, k.email, k.telegram, k.x_handle, k.type, k.stage].map((x) => x ?? "").join(" | ")).join("\n")}\n\n# Items\n${JSON.stringify(items)}`,
    schema: {
      type: "object", required: ["items", "summary"],
      properties: {
        summary: { type: "string" },
        items: { type: "array", items: { type: "object", required: ["ref", "priority", "category", "note", "needs_reply"], properties: {
          ref: { type: "string" }, priority: { type: "string", enum: ["high", "normal", "low"] },
          category: { type: "string", enum: ["investor", "partner", "tester", "press", "program", "newsletter", "notification", "personal", "sales", "other"] },
          note: { type: "string", description: "One line: what it is and what it needs" },
          contact_id: { type: "string", description: "Existing contact id if this is one of them" },
          new_contact: { type: "object", properties: { name: { type: "string" }, org: { type: "string" }, type: { type: "string", enum: ["investor", "partner", "tester", "press", "other"] } } },
          stage_hint: { type: "string", enum: ["", "replied", "meeting", "passed"] },
          needs_reply: { type: "boolean" }, reply_draft: { type: "string" }, why_now: { type: "string" },
        } } },
      },
    },
    maxTokens: 6000,
  }, c.usage);
  const mailById = new Map((mails ?? []).map((m) => [m.id, m]));
  const tgByRef = new Map(tg.map((d) => [`t:${d.account_id}:${d.id}`, d]));
  const validContact = new Set(contacts.map((k) => k.id));
  let drafts = 0, linked = 0, created = 0;
  for (const it of (out.items as Record<string, unknown>[]) ?? []) {
    const ref = String(it.ref ?? "");
    const m = ref.startsWith("e:") ? mailById.get(ref.slice(2)) : null;
    const d = ref.startsWith("t:") ? tgByRef.get(ref) : null;
    if (!m && !d) continue;
    let contactId: string | null = (m?.contact_id as string | null) ?? (typeof it.contact_id === "string" && validContact.has(it.contact_id) ? it.contact_id : null);
    const nc = it.new_contact as { name?: string; org?: string; type?: string } | undefined;
    if (!contactId && nc?.name && ["investor", "partner", "tester", "press"].includes(String(it.category))) {
      const row = { name: nc.name.slice(0, 200), org: nc.org?.slice(0, 200) || (m && !personal.test(m.from_addr) ? m.from_addr.split("@")[1] : null), type: nc.type ?? "other",
        email: m?.from_addr?.toLowerCase() ?? null, telegram: d?.username ?? null, stage: "replied", owner: "me", source: m ? "inbound email" : "inbound telegram", created_by: "triage" };
      const { data: ins, error } = await admin.from("contacts").insert(row).select("id").single();
      if (!error && ins) { contactId = ins.id; created++; }
    }
    if (contactId) {
      linked++;
      await admin.from("contact_activities").insert({ contact_id: contactId, kind: m ? "email" : "telegram", direction: "in", summary: noDash(short(it.note as string, 300)) || "Inbound message", actor: "Inbox triage", happened_at: m?.received_at ?? d?.last_message_at ?? new Date().toISOString() });
      if (it.stage_hint) {
        const { data: k } = await admin.from("contacts").select("stage").eq("id", contactId).single();
        const order = ["lead", "contacted", "replied", "meeting"];
        if (it.stage_hint === "passed" || (k && order.indexOf(String(it.stage_hint)) > order.indexOf(k.stage))) await admin.from("contacts").update({ stage: it.stage_hint }).eq("id", contactId);
      }
    }
    if (m) await admin.from("email_messages").update({ priority: it.priority, category: it.category, ai_note: noDash(it.note as string), triaged_at: new Date().toISOString(), contact_id: contactId, ...(it.priority === "high" ? { status: "todo" } : {}) }).eq("id", m.id);
    if (it.needs_reply && it.reply_draft) {
      const recipient = m ? m.from_addr : (d?.username ? "@" + d.username : d?.title ?? null);
      if (await recentDraftFor(recipient, 1)) continue;
      drafts++;
      await admin.from("approvals").insert({
        agent_id: c.agent.id, run_id: c.runId, venture_id: m?.venture_id ?? null, kind: m ? "email" : "outreach", channel: m ? "email" : "telegram",
        recipient, contact_id: contactId, source: "panel", submitted_by: c.agent.name, risk: it.category === "investor" ? "medium" : "low",
        why_now: noDash(String(it.why_now || it.note || "")).slice(0, 500),
        title: m ? `Reply to ${m.from_name || m.from_addr}: ${m.subject ?? ""}`.slice(0, 200) : `Telegram reply: ${d!.title}`.slice(0, 200), body: noDash(it.reply_draft as string),
        payload: m ? { to: m.from_addr, subject: (m.subject ?? "").startsWith("Re:") ? m.subject : `Re: ${m.subject ?? ""}`, in_reply_to: m.message_id, account_id: m.account_id, email_id: m.id }
          : { account_id: d!.account_id, chat_id: String(d!.id), channel: "telegram" },
      });
    }
  }
  await admin.from("worker_heartbeat").upsert({ name: "triage-cursor", last_seen: new Date().toISOString(), info: { tg_since: new Date().toISOString() } });
  return { summary: `${(mails ?? []).length} emails and ${tg.length} Telegram chats triaged; ${linked} matched to contacts, ${created} new contacts, ${drafts} reply drafts`, output: { emails: (mails ?? []).length, telegram: tg.length, linked, created, drafts } };
}

// ---------- Follow-up ----------
async function runFollowup(c: Ctx) {
  const now = Date.now(), four = 4 * 864e5;
  const cands: { recipient: string; channel: string; name: string; contact_id: string | null; days: number; last_text: string; payload: Record<string, unknown> }[] = [];
  // Email: sent from the panel, no inbound mail from that address since.
  const { data: sent } = await admin.from("outbox").select("payload,sent_at,email_account_id").eq("channel", "email").eq("status", "sent").gte("sent_at", new Date(now - 21 * 864e5).toISOString()).lte("sent_at", new Date(now - four).toISOString());
  const contacts = await compactContacts();
  for (const s of sent ?? []) {
    const to = String((s.payload as Record<string, string>)?.to ?? "").toLowerCase(); if (!to) continue;
    const { count } = await admin.from("email_messages").select("id", { count: "exact", head: true }).ilike("from_addr", to).gte("received_at", s.sent_at);
    if ((count ?? 0) > 0) continue;
    const k = contacts.find((x) => x.email?.toLowerCase() === to);
    cands.push({ recipient: to, channel: "email", name: k?.name ?? to, contact_id: k?.id ?? null, days: Math.floor((now - Date.parse(s.sent_at)) / 864e5), last_text: short((s.payload as Record<string, string>)?.body, 600),
      payload: { to, subject: (s.payload as Record<string, string>)?.subject?.startsWith("Re:") ? (s.payload as Record<string, string>).subject : `Re: ${(s.payload as Record<string, string>)?.subject ?? ""}`, account_id: s.email_account_id } });
  }
  // Telegram: people and deal groups where we wrote last, 4 to 21 days ago.
  const { data: dialogs } = await admin.from("tg_dialogs").select("account_id,id,title,kind,username,last_message_at").neq("kind", "channel")
    .gte("last_message_at", new Date(now - 21 * 864e5).toISOString()).lte("last_message_at", new Date(now - four).toISOString()).order("last_message_at", { ascending: false }).limit(60);
  const tgc = (dialogs ?? []).filter((d) => d.kind === "user" ? d.id !== 777000 : / <> | x |\*/i.test(d.title ?? "")).slice(0, 15);
  for (const d of tgc) {
    await fetch(`${SB_URL}/functions/v1/telegram?action=history`, { method: "POST", headers: { ...CALLER_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ account_id: d.account_id, chat_id: String(d.id) }) }).catch(() => {});
    const { data: last } = await admin.from("tg_msgs").select("is_outgoing,text,sent_at").eq("account_id", d.account_id).eq("chat_id", d.id).order("sent_at", { ascending: false }).limit(1).maybeSingle();
    if (!last?.is_outgoing || now - Date.parse(last.sent_at) < four) continue;
    const k = d.username ? contacts.find((x) => x.telegram?.toLowerCase().replace(/^@/, "") === d.username!.toLowerCase()) : null;
    cands.push({ recipient: d.username ? "@" + d.username : d.title ?? String(d.id), channel: "telegram", name: d.title ?? "", contact_id: k?.id ?? null, days: Math.floor((now - Date.parse(last.sent_at)) / 864e5), last_text: short(last.text, 600), payload: { account_id: d.account_id, chat_id: String(d.id), channel: "telegram" } });
  }
  const todo = [];
  for (const x of cands) if (!(await recentDraftFor(x.recipient, 7))) todo.push(x);
  if (!todo.length) return { summary: `No threads waiting on a reply (${cands.length} checked)`, output: { checked: cands.length, drafts: 0 }, noAi: true };
  const facts = await factsSheet();
  const out = await claude({
    model: c.agent.model,
    system: BASE_SYSTEM("Write follow-up nudges as Ceriel. One or two short sentences, casual and human, no guilt, no 'just circling back', no recap of the whole pitch. Add one fresh reason to reply when the facts sheet gives one. Same language as the original message."),
    user: `# Facts sheet v${facts.version}\n${facts.content}\n\n# Threads with no reply\n${JSON.stringify(todo.map((t, i) => ({ i, to: t.name, channel: t.channel, days_waiting: t.days, our_last_message: t.last_text })))}`,
    schema: { type: "object", required: ["nudges"], properties: { nudges: { type: "array", items: { type: "object", required: ["i", "text"], properties: { i: { type: "integer" }, text: { type: "string" }, skip: { type: "boolean", description: "true if a nudge would be inappropriate" } } } } } },
    maxTokens: 3000,
  }, c.usage);
  let n = 0;
  for (const g of (out.nudges as { i: number; text: string; skip?: boolean }[]) ?? []) {
    const t = todo[g.i]; if (!t || g.skip || !g.text) continue; n++;
    await admin.from("approvals").insert({ agent_id: c.agent.id, run_id: c.runId, kind: t.channel === "email" ? "email" : "outreach", channel: t.channel, recipient: t.recipient, contact_id: t.contact_id,
      source: "panel", submitted_by: c.agent.name, risk: "low", why_now: `No reply for ${t.days} days`, title: `Nudge ${t.name}`.slice(0, 200), body: noDash(g.text), payload: t.payload });
  }
  return { summary: `${n} nudges drafted from ${cands.length} quiet threads`, output: { checked: cands.length, drafts: n } };
}

// ---------- Hygiene ----------
async function runHygiene(c: Ctx) {
  let merged = 0, filled = 0;
  // 1. Clear duplicates (same email or handle): merge into the older record. Nothing is deleted.
  const { data: dups } = await admin.rpc("contact_duplicates");
  for (const d of (dups ?? []) as { a: string; b: string; reason: string }[]) {
    if (d.reason === "name and organisation") continue;
    const { data: pair } = await admin.from("contacts").select("id,created_at").in("id", [d.a, d.b]).order("created_at");
    if (pair?.length === 2) { await admin.rpc("merge_contacts", { p_keep: pair[0].id, p_merge: pair[1].id }); merged++; }
  }
  // 2. Fill missing email and last touch from linked emails.
  const { data: noEmail } = await admin.from("contacts").select("id").is("merged_into", null).is("email", null).limit(200);
  for (const k of noEmail ?? []) {
    const { data: m } = await admin.from("email_messages").select("from_addr,received_at").eq("contact_id", k.id).order("received_at", { ascending: false }).limit(1).maybeSingle();
    if (m?.from_addr) { const { error } = await admin.from("contacts").update({ email: m.from_addr.toLowerCase() }).eq("id", k.id); if (!error) filled++; }
  }
  // 3. Contacts in play with no next step, or an overdue one.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Amsterdam" });
  const { data: open } = await admin.from("contacts").select("id,name,org,type,stage,next_step,next_step_date").is("merged_into", null).in("stage", ACTIVE_STAGES).in("type", ["investor", "partner", "tester", "press"]);
  const missing = (open ?? []).filter((k) => !k.next_step);
  const overdue = (open ?? []).filter((k) => k.next_step && k.next_step_date && k.next_step_date < today);
  const upsertOpp = async (ref: string, row: Record<string, unknown>) => {
    const { data: ex } = await admin.from("opportunities").select("id").eq("external_ref", ref).eq("status", "open").maybeSingle();
    if (ex) await admin.from("opportunities").update(row).eq("id", ex.id); else await admin.from("opportunities").insert({ ...row, external_ref: ref, source: "panel", submitted_by: c.agent.name });
  };
  if (missing.length) await upsertOpp("hygiene:no-next-step", { title: `${missing.length} contacts have no next step`, reason: missing.slice(0, 6).map((k) => k.name + (k.org ? " (" + k.org + ")" : "")).join(", ") + (missing.length > 6 ? " and more" : ""), suggested_action: "Open Pipeline, filter No next step, set one per contact", score: Math.min(40 + missing.length * 3, 80), urgency: "normal", type: "other" });
  if (overdue.length) await upsertOpp("hygiene:overdue", { title: `${overdue.length} next steps are overdue`, reason: overdue.slice(0, 6).map((k) => `${k.name}: ${k.next_step}`).join("; "), suggested_action: "Do them or move the dates", score: Math.min(55 + overdue.length * 4, 90), urgency: overdue.length > 3 ? "urgent" : "normal", type: "other" });
  // 4. Possible duplicates that are not exact (different spelling, email in one, handle in the other). Haiku, only names, cheap.
  const contacts = await compactContacts(400);
  let fuzzy = 0;
  if (contacts.length > 1) {
    const out = await claude({
      model: c.agent.model, system: BASE_SYSTEM("You find contacts that are very likely the same person or organisation entry, written differently. Only flag near certain cases."),
      user: contacts.map((k) => [k.id, k.name, k.org, k.email, k.telegram, k.x_handle].map((x) => x ?? "").join(" | ")).join("\n"),
      schema: { type: "object", required: ["pairs"], properties: { pairs: { type: "array", items: { type: "object", required: ["keep", "merge", "why"], properties: { keep: { type: "string" }, merge: { type: "string" }, why: { type: "string" } } } } } },
      maxTokens: 1500,
    }, c.usage);
    const ids = new Set(contacts.map((k) => k.id));
    for (const p of (out.pairs as { keep: string; merge: string; why: string }[]) ?? []) {
      if (!ids.has(p.keep) || !ids.has(p.merge) || p.keep === p.merge) continue; fuzzy++;
      const a = contacts.find((k) => k.id === p.keep)!, b = contacts.find((k) => k.id === p.merge)!;
      await upsertOpp(`hygiene:dup:${[p.keep, p.merge].sort().join(":")}`, { title: `Possible duplicate: ${a.name} and ${b.name}`, reason: noDash(p.why).slice(0, 300), suggested_action: `merge:${p.keep}:${p.merge}`, score: 35, urgency: "low", type: "other", contact_id: p.keep });
    }
  }
  return { summary: `${merged} merged, ${filled} emails filled, ${missing.length} without next step, ${overdue.length} overdue, ${fuzzy} possible duplicates flagged`, output: { merged, filled, missing: missing.length, overdue: overdue.length, fuzzy } };
}

// ---------- Daily brief ----------
async function runBrief(c: Ctx) {
  const day = new Date(Date.now() - 864e5).toISOString();
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Amsterdam" });
  const in3 = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  const [{ data: acts }, { data: opps }, { data: pend }, { data: reps }, { data: due }, { data: runs }, { data: spend }, facts] = await Promise.all([
    admin.from("contact_activities").select("summary,kind,direction,actor,happened_at,contacts(name,org)").gte("created_at", day).order("happened_at", { ascending: false }).limit(40),
    admin.from("opportunities").select("title,reason,suggested_action,score,urgency,submitted_by").eq("status", "open").order("score", { ascending: false }).limit(10),
    admin.from("approvals").select("title,channel,risk,submitted_by,consistency").eq("status", "pending").order("created_at", { ascending: false }).limit(30),
    admin.from("agent_reports").select("agent_name,summary,metrics").gte("created_at", day).order("created_at", { ascending: false }).limit(10),
    admin.from("contacts").select("name,org,type,stage,next_step,next_step_date").is("merged_into", null).in("stage", ACTIVE_STAGES).lte("next_step_date", in3).order("next_step_date").limit(20),
    admin.from("agent_runs").select("status,summary,error,agents(name)").gte("started_at", day).neq("status", "skipped").limit(30),
    admin.from("spend_summary").select("*").single(),
    factsSheet(),
  ]);
  const flagged = (pend ?? []).filter((p) => (p.consistency as { ok?: boolean } | null)?.ok === false).length;
  const factsAge = facts.updated_at ? Math.floor((Date.now() - Date.parse(facts.updated_at)) / 864e5) : null;
  const out = await claude({
    model: c.agent.model,
    system: BASE_SYSTEM("Write Ceriel's morning brief for the fundraise and partner push. Plain markdown, three sections with these exact headings: ## What happened, ## What needs you, ## What is next. Bullets, specific names, no filler, max 220 words. Put the most important item first in each section."),
    user: JSON.stringify({ today: todayStr, activity_last_24h: acts, open_opportunities: opps, pending_approvals: { count: (pend ?? []).length, high_risk: (pend ?? []).filter((p) => p.risk === "high").length, contradicting_facts: flagged, items: (pend ?? []).slice(0, 12) },
      grok_reports: reps, next_steps_due_within_3_days: due, agent_runs: (runs ?? []).map((r) => ({ agent: (r as { agents?: { name?: string } }).agents?.name, status: r.status, summary: r.summary, error: r.error })),
      spend: spend, facts_sheet: { version: facts.version, days_since_update: factsAge } }),
    schema: { type: "object", required: ["brief"], properties: { brief: { type: "string" } } },
    maxTokens: 1500,
  }, c.usage);
  await admin.from("briefs").insert({ content: noDash(out.brief as string), run_id: c.runId });
  return { summary: "Brief written", output: { pending: (pend ?? []).length, opportunities: (opps ?? []).length } };
}

// ---------- Consistency check ----------
// One draft per call: small, cheap (about $0.002 each) and nothing is skipped silently.
async function runConsistency(c: Ctx) {
  const { data: drafts } = await admin.from("approvals").select("id,channel,recipient,title,body,payload").eq("status", "pending").is("consistency", null).order("created_at").limit(10);
  if (!drafts?.length) return { summary: "No new drafts to check", output: { checked: 0 }, noAi: true };
  const facts = await factsSheet();
  let flagged = 0, checked = 0;
  for (const d of drafts) {
    const out = await claude({
      model: c.agent.model,
      system: BASE_SYSTEM("You check one outbound draft against the approved facts sheet. Flag every real problem: a claim that contradicts the facts sheet, a claim the facts sheet does not support (numbers, customers, partners, availability, round size, comparisons with other models), or anything on the 'never say' list. Quote the exact words. Do not judge style or tone. If there is no problem, return ok true and an empty list."),
      user: `# Facts sheet v${facts.version}\n${facts.content}\n\n# Draft (${d.channel ?? "message"} to ${d.recipient ?? "unknown"})\n${(d.payload as Record<string, unknown>)?.subject ? "Subject: " + (d.payload as Record<string, unknown>).subject + "\n" : ""}${short(d.body, 4000)}`,
      schema: { type: "object", required: ["ok", "issues"], properties: { ok: { type: "boolean" },
        issues: { type: "array", items: { type: "object", required: ["quote", "problem"], properties: { quote: { type: "string" }, problem: { type: "string" }, fact: { type: "string", description: "What the facts sheet says instead" } } } } } },
      maxTokens: 1200,
    }, c.usage);
    const issues = Array.isArray(out.issues) ? out.issues : [];
    const ok = out.ok === true && issues.length === 0; if (!ok) flagged++; checked++;
    await admin.from("approvals").update({ consistency: { ok, issues, facts_version: facts.version, checked_at: new Date().toISOString() }, ...(ok ? {} : { risk: "high" }) }).eq("id", d.id);
  }
  return { summary: `${checked} drafts checked, ${flagged} contradict the facts sheet`, output: { checked, flagged } };
}

// ---------- Warm paths ----------
async function runWarmpaths(c: Ctx) {
  const { data: targets } = await admin.from("contacts").select("id,name,org,role,type,stage").is("merged_into", null).is("warm_path", null)
    .in("type", ["investor", "partner"]).in("stage", ["lead", "contacted"]).order("updated_at", { ascending: false }).limit(15);
  if (!targets?.length) return { summary: "Every open investor and partner already has a warm path", output: { targets: 0 }, noAi: true };
  // Our own network, names only (no message content): contacts, Telegram chat names, email senders.
  const [contacts, { data: dialogs }, { data: senders }] = await Promise.all([
    compactContacts(400),
    admin.from("tg_dialogs").select("title,kind").neq("kind", "channel").order("last_message_at", { ascending: false }).limit(250),
    admin.from("email_messages").select("from_name,from_addr").in("category", ["investor", "partner", "program", "personal", "other"]).order("received_at", { ascending: false }).limit(300),
  ]);
  const network = {
    contacts: contacts.filter((k) => !targets.find((t) => t.id === k.id)).map((k) => `${k.name}${k.org ? " (" + k.org + ")" : ""} [${k.type}/${k.stage}]`),
    telegram_chats: Array.from(new Set((dialogs ?? []).map((d) => d.title).filter(Boolean))),
    email_senders: Array.from(new Set((senders ?? []).filter((s) => !/noreply|no-reply|notify|mailer|news/i.test(s.from_addr)).map((s) => `${s.from_name ?? ""} <${s.from_addr.split("@")[1]}>`))),
  };
  const out = await claude({
    model: c.agent.model,
    system: BASE_SYSTEM("You find warm introduction paths. For each target, look for someone in Ceriel's own network who plausibly knows them: same organisation or email domain, a shared Telegram group with them or their firm, a co-investor, a program or accelerator in common, or a connector (Boardy, angels, founders in the same portfolio). Only suggest paths with a concrete reason from the data. Skip targets with no real path. Never invent relationships."),
    user: `# Targets\n${JSON.stringify(targets)}\n\n# Ceriel's network (names only)\n${JSON.stringify(network)}`,
    schema: { type: "object", required: ["paths"], properties: { paths: { type: "array", items: { type: "object", required: ["target_id", "via", "reason", "confidence"], properties: {
      target_id: { type: "string" }, via: { type: "string" }, reason: { type: "string" }, confidence: { type: "integer", minimum: 0, maximum: 100 } } } } } },
    maxTokens: 2500,
  }, c.usage);
  let n = 0;
  for (const p of (out.paths as { target_id: string; via: string; reason: string; confidence: number }[]) ?? []) {
    const t = targets.find((x) => x.id === p.target_id); if (!t || p.confidence < 40) continue; n++;
    const ref = `warm:${t.id}:${p.via.toLowerCase().slice(0, 60)}`;
    const { data: ex } = await admin.from("opportunities").select("id").eq("external_ref", ref).maybeSingle(); if (ex) continue;
    await admin.from("opportunities").insert({ title: `Warm path to ${t.name}${t.org ? " (" + t.org + ")" : ""} via ${p.via}`.slice(0, 200), reason: noDash(p.reason).slice(0, 300),
      suggested_action: `Ask ${p.via} for an intro`, score: Math.round(30 + p.confidence * 0.6), urgency: "normal", type: "intro", contact_id: t.id, source: "panel", submitted_by: c.agent.name, external_ref: ref });
  }
  return { summary: `${n} warm paths found for ${targets.length} targets`, output: { targets: targets.length, paths: n } };
}

const RUNNERS: Record<string, (c: Ctx) => Promise<{ summary: string; output: unknown; noAi?: boolean }>> = {
  triage: runTriage, followup: runFollowup, hygiene: runHygiene, brief: runBrief, consistency: runConsistency, warmpaths: runWarmpaths };

async function runAgent(slug: string, trigger: string) {
  const { data: agent } = await admin.from("agents").select("*").eq("slug", slug).single();
  if (!agent) throw new Error(`No agent ${slug}`);
  if (!RUNNERS[slug]) throw new Error(`${slug} is not a panel team agent`);
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const { data: spent } = await admin.from("agent_runs").select("cost_usd").eq("agent_id", agent.id).gte("started_at", monthStart.toISOString());
  const used = (spent ?? []).reduce((a, r) => a + Number(r.cost_usd ?? 0), 0);
  const { data: run } = await admin.from("agent_runs").insert({ agent_id: agent.id, trigger }).select().single();
  const { data: sp } = await admin.from("spend_summary").select("*").single();
  const capMsg = used >= Number(agent.monthly_budget_usd) ? `Paused: this agent's monthly budget of $${agent.monthly_budget_usd} is used`
    : sp && Number(sp.month_usd) >= Number(sp.monthly_cap_usd) ? `Paused: monthly cap of $${sp.monthly_cap_usd} reached`
    : sp && Number(sp.today_usd) >= Number(sp.daily_cap_usd) ? `Paused: daily cap of $${sp.daily_cap_usd} reached, resumes tomorrow` : null;
  if (capMsg) {
    await admin.from("agents").update({ last_run_at: new Date().toISOString() }).eq("id", agent.id);
    await admin.from("agent_runs").update({ status: "skipped", summary: capMsg, finished_at: new Date().toISOString() }).eq("id", run!.id);
    return { skipped: true, reason: capMsg };
  }
  await admin.from("agents").update({ last_run_at: new Date().toISOString() }).eq("id", agent.id);
  const usage: Usage = { tin: 0, tout: 0, searches: 0 };
  try {
    const res = await RUNNERS[slug]({ agent, runId: run!.id, usage });
    await admin.from("agent_runs").update({ status: "done", summary: res.summary, output: res.output, tokens_in: usage.tin, tokens_out: usage.tout, searches: usage.searches, cost_usd: cost(agent.model, usage), finished_at: new Date().toISOString() }).eq("id", run!.id);
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from("agent_runs").update({ status: "failed", error: msg.slice(0, 1000), tokens_in: usage.tin, tokens_out: usage.tout, searches: usage.searches, cost_usd: cost(agent.model, usage), finished_at: new Date().toISOString() }).eq("id", run!.id);
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  CALLER_HEADERS = req.headers.get("x-cron-secret") ? { "x-cron-secret": req.headers.get("x-cron-secret")! } : { Authorization: req.headers.get("authorization") ?? "", apikey: ANON };
  const url = new URL(req.url);
  try {
    if (url.searchParams.get("action") === "run") return json(await runAgent(url.searchParams.get("slug") ?? "", url.searchParams.get("trigger") ?? "manual"));
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
