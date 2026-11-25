// Agent API for outside agents (Grok Bot CR Team, CR Social).
// Base: https://stbxetfzbssalewbglpg.supabase.co/functions/v1/agent-api/v1
// Auth: Authorization: Bearer cro_... (one token per agent, created in Settings, only its hash is stored)
// Every POST and PATCH needs an Idempotency-Key header. 60 calls a minute per token. Every call is audited.
// Least privilege: no deletes, no inbox or Telegram content, agents only see their own drafts.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};
const CONTACT_FIELDS = "id,name,org,role,type,stage,next_step,next_step_date,warm_path,source,owner,email,telegram,x_handle,linkedin,tags,threads,last_touch_at,merged_into,created_at,updated_at";
const TYPES = ["investor", "partner", "tester", "press", "other"];
const STAGES = ["lead", "contacted", "replied", "meeting", "diligence", "committed", "closed", "passed", "parked"];
const CHANNELS = ["email", "telegram", "x", "linkedin", "other"];
const ACT_KINDS = ["email", "telegram", "x", "linkedin", "call", "meeting", "intro", "note", "other"];
const OPP_TYPES = ["investor", "partner", "tester", "press", "intro", "event", "grant", "other"];

class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const bad = (m: string) => new ApiError(400, m);
const str = (v: unknown, max: number, field: string, required = false): string | null => {
  if (v === undefined || v === null || v === "") { if (required) throw bad(`${field} is required`); return null; }
  if (typeof v !== "string") throw bad(`${field} must be a string`);
  const s = v.trim(); if (s.length > max) throw bad(`${field} is longer than ${max} characters`);
  return s;
};
const oneOf = (v: unknown, list: string[], field: string, fallback: string | null = null) => {
  if (v === undefined || v === null || v === "") return fallback;
  const s = String(v).toLowerCase(); if (!list.includes(s)) throw bad(`${field} must be one of: ${list.join(", ")}`); return s;
};
const dateStr = (v: unknown, field: string) => {
  const s = str(v, 30, field); if (!s) return null;
  if (isNaN(Date.parse(s))) throw bad(`${field} must be a date like 2026-12-01`); return s;
};
const handle = (v: unknown, field: string) => { const s = str(v, 100, field); return s ? s.replace(/^@/, "").replace(/^https?:\/\/(x|twitter)\.com\//i, "") : null; };
const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/\s+/g, "");

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

type Token = { id: string; name: string; team: string; rate_per_min: number };

async function findDuplicate(c: Record<string, string | null>) {
  const esc = (v: string) => v.replace(/[%_\\]/g, "");
  const tries: [string, string | null, string][] = [["email", c.email, "email"], ["telegram", c.telegram, "telegram"], ["x_handle", c.x_handle, "x handle"]];
  for (const [col, val, reason] of tries) {
    if (!val) continue;
    for (const v of col === "email" ? [val] : [val, "@" + val]) {
      const { data } = await admin.from("contacts").select(CONTACT_FIELDS).ilike(col, esc(v)).limit(1);
      if (data?.[0]) return { contact: data[0].merged_into ? await resolveContact(data[0].merged_into) : data[0], reason };
    }
  }
  if (c.name) {
    const first = esc(c.name.trim().split(/\s+/)[0] ?? c.name);
    const { data } = await admin.from("contacts").select(CONTACT_FIELDS).ilike("name", `%${first}%`).limit(200);
    const hit = (data ?? []).find((x) => norm(x.name) === norm(c.name) && norm(x.org) === norm(c.org));
    if (hit) return { contact: hit.merged_into ? await resolveContact(hit.merged_into) : hit, reason: "name and organisation" };
  }
  return null;
}

async function resolveContact(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, "contact not found");
  let { data } = await admin.from("contacts").select(CONTACT_FIELDS).eq("id", id).maybeSingle();
  if (data?.merged_into) ({ data } = await admin.from("contacts").select(CONTACT_FIELDS).eq("id", data.merged_into).maybeSingle());
  if (!data) throw new ApiError(404, "contact not found");
  return data;
}

function contactPatch(b: Record<string, unknown>, creating: boolean) {
  const p: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => { if (v !== null && v !== undefined) p[k] = v; };
  set("name", str(b.name, 200, "name", creating));
  set("org", str(b.org ?? b.organisation ?? b.organization, 200, "org"));
  set("role", str(b.role, 200, "role"));
  set("type", oneOf(b.type, TYPES, "type", creating ? "other" : null));
  set("stage", oneOf(b.stage, STAGES, "stage", creating ? "lead" : null));
  set("next_step", str(b.next_step, 500, "next_step"));
  set("next_step_date", dateStr(b.next_step_date, "next_step_date"));
  set("warm_path", str(b.warm_path, 500, "warm_path"));
  set("source", str(b.source, 300, "source"));
  set("email", str(b.email, 200, "email")?.toLowerCase());
  set("telegram", handle(b.telegram, "telegram"));
  set("x_handle", handle(b.x_handle ?? b.x, "x_handle"));
  set("linkedin", str(b.linkedin, 300, "linkedin"));
  if (b.owner !== undefined) set("owner", str(b.owner, 100, "owner"));
  return p;
}
function threadsFrom(b: Record<string, unknown>) {
  const t = Array.isArray(b.threads) ? b.threads : [];
  return t.slice(0, 20).map((x) => typeof x === "string" ? { url: x.slice(0, 500) } : { label: String((x as Record<string, unknown>)?.label ?? "").slice(0, 120), url: String((x as Record<string, unknown>)?.url ?? "").slice(0, 500) }).filter((x) => x.url);
}

async function route(method: string, path: string, b: Record<string, unknown>, q: URLSearchParams, tok: Token) {
  const seg = path.replace(/^\/+|\/+$/g, "").split("/"); // e.g. ["v1","contacts","<id>","activities"]
  if (seg[0] !== "v1") throw new ApiError(404, "use /v1/...");
  const [, r1, r2, r3] = seg;

  if (method === "GET" && r1 === "me") return { agent: tok.name, team: tok.team, rate_per_min: tok.rate_per_min };

  if (method === "GET" && r1 === "facts") {
    const { data } = await admin.from("facts_versions").select("version,content,note,created_at").order("version", { ascending: false }).limit(1).single();
    const days = data ? Math.floor((Date.now() - Date.parse(data.created_at)) / 864e5) : null;
    return { version: data?.version, updated_at: data?.created_at, days_since_update: days, stale: days !== null && days > 30, content: data?.content };
  }

  if (r1 === "contacts" && !r2 && method === "GET") {
    let qb = admin.from("contacts").select(CONTACT_FIELDS).is("merged_into", null).order("updated_at", { ascending: false }).limit(Math.min(Number(q.get("limit") ?? 25) || 25, 100));
    const s = q.get("q"); if (s) qb = qb.or(`name.ilike.%${s.replace(/[,%()]/g, "")}%,org.ilike.%${s.replace(/[,%()]/g, "")}%`);
    if (q.get("email")) qb = qb.ilike("email", q.get("email")!.replace(/[%_]/g, ""));
    if (q.get("telegram")) qb = qb.ilike("telegram", handle(q.get("telegram"), "telegram")!);
    if (q.get("x_handle")) qb = qb.ilike("x_handle", handle(q.get("x_handle"), "x_handle")!);
    if (q.get("type")) qb = qb.eq("type", oneOf(q.get("type"), TYPES, "type")!);
    if (q.get("stage")) qb = qb.eq("stage", oneOf(q.get("stage"), STAGES, "stage")!);
    const { data, error } = await qb; if (error) throw new ApiError(500, error.message);
    return { contacts: data };
  }
  if (r1 === "contacts" && r2 && !r3 && method === "GET") return { contact: await resolveContact(r2) };

  if (r1 === "contacts" && !r2 && method === "POST") {
    const p = contactPatch(b, true);
    const dup = await findDuplicate(p as Record<string, string | null>);
    if (dup) {
      // Fill only empty fields on the existing contact; never overwrite what is there.
      const fill: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p)) if (["name", "owner", "type", "stage"].includes(k) ? false : (dup.contact as Record<string, unknown>)[k] == null) fill[k] = v;
      const th = threadsFrom(b); if (th.length) fill.threads = [...(dup.contact.threads ?? []), ...th];
      if (Object.keys(fill).length) await admin.from("contacts").update(fill).eq("id", dup.contact.id);
      return { status: 200, body: { id: dup.contact.id, created: false, duplicate_of: dup.contact.id, matched_on: dup.reason, filled: Object.keys(fill) } };
    }
    const row = { ...p, owner: p.owner ?? tok.name, created_by: tok.name, source: p.source ?? tok.name, threads: threadsFrom(b) };
    const { data, error } = await admin.from("contacts").insert(row).select("id").single();
    if (error?.code === "23505") {
      // Another call created the same person a moment ago: return that contact instead.
      const again = await findDuplicate(p as Record<string, string | null>);
      if (again) return { status: 200, body: { id: again.contact.id, created: false, duplicate_of: again.contact.id, matched_on: again.reason, filled: [] } };
    }
    if (error) throw new ApiError(500, error.message);
    return { status: 201, body: { id: data.id, created: true } };
  }

  if (r1 === "contacts" && r2 && !r3 && method === "PATCH") {
    const c = await resolveContact(r2);
    const p = contactPatch(b, false); delete p.name;
    const th = threadsFrom(b); if (th.length) p.threads = [...(c.threads ?? []), ...th];
    if (Array.isArray(b.tags)) p.tags = Array.from(new Set([...(c.tags ?? []), ...b.tags.slice(0, 10).map((t) => String(t).slice(0, 40))]));
    if (!Object.keys(p).length) throw bad("nothing to update");
    const { error } = await admin.from("contacts").update(p).eq("id", c.id);
    if (error?.code === "23505") throw new ApiError(409, "another contact already has this name and organisation, email or handle");
    if (error) throw new ApiError(500, error.message);
    return { id: c.id, updated: Object.keys(p) };
  }

  if (r1 === "contacts" && r2 && r3 === "activities" && method === "POST") {
    const c = await resolveContact(r2);
    const row = {
      contact_id: c.id, kind: oneOf(b.kind, ACT_KINDS, "kind", "note"), direction: oneOf(b.direction, ["in", "out"], "direction"),
      summary: str(b.summary, 2000, "summary", true), url: str(b.url, 500, "url"), actor: tok.name,
      happened_at: dateStr(b.happened_at, "happened_at") ?? new Date().toISOString(),
    };
    const { data, error } = await admin.from("contact_activities").insert(row).select("id").single();
    if (error) throw new ApiError(500, error.message);
    return { status: 201, body: { id: data.id, contact_id: c.id } };
  }

  if (r1 === "drafts" && !r2 && method === "POST") {
    const channel = oneOf(b.channel, CHANNELS, "channel", null); if (!channel) throw bad("channel is required");
    const text = str(b.text ?? b.body, 8000, "text", true)!;
    const contact = b.contact_id ? await resolveContact(String(b.contact_id)) : null;
    const recipient = str(b.recipient ?? b.to, 300, "recipient") ?? contact?.email ?? contact?.telegram ?? contact?.x_handle ?? null;
    if (!recipient && channel !== "x") throw bad("recipient is required (or a contact_id with an address)");
    const subject = str(b.subject, 300, "subject");
    const kind = channel === "email" ? "email" : channel === "x" ? "x_post" : "outreach";
    const row = {
      kind, channel, recipient, contact_id: contact?.id ?? null, body: text,
      title: `${channel === "x" ? "X post" : channel[0].toUpperCase() + channel.slice(1)}${recipient ? " to " + recipient : ""}${contact ? " (" + contact.name + (contact.org ? ", " + contact.org : "") + ")" : ""}`.slice(0, 200),
      why_now: str(b.why_now, 1000, "why_now", true), risk: oneOf(b.risk, ["low", "medium", "high"], "risk", "low"),
      source: "grok", submitted_by: tok.name, token_id: tok.id, external_ref: str(b.external_ref ?? b.ref, 200, "external_ref"),
      payload: { subject, account: handle(b.account, "account"), reply_to: str(b.reply_to, 500, "reply_to"), to: channel === "email" ? recipient : undefined, channel },
    };
    const { data, error } = await admin.from("approvals").insert(row).select("id,status,created_at").single();
    if (error) throw new ApiError(500, error.message);
    if (contact) await admin.from("contact_activities").insert({ contact_id: contact.id, kind: "note", summary: `${tok.name} drafted a ${channel} message for approval`, actor: tok.name });
    return { status: 201, body: { id: data.id, status: "pending", note: "Waiting for Ceriel. Read the decision at GET /v1/drafts/" + data.id } };
  }

  if (r1 === "drafts" && method === "GET") {
    const fields = "id,channel,recipient,contact_id,body,why_now,risk,external_ref,status,decision,final_text,decision_note,consistency,created_at,decided_at";
    const shape = (d: Record<string, unknown>) => ({
      id: d.id, channel: d.channel, recipient: d.recipient, contact_id: d.contact_id, external_ref: d.external_ref,
      submitted_text: d.body, why_now: d.why_now, risk: d.risk, created_at: d.created_at,
      decision: d.status === "pending" ? "pending" : (d.decision ?? (d.status === "rejected" ? "rejected" : "approved")),
      final_text: d.final_text ?? (d.status !== "pending" && d.status !== "rejected" ? d.body : null),
      note: d.decision_note, consistency: d.consistency, decided_at: d.decided_at,
    });
    if (r2) {
      const { data } = await admin.from("approvals").select(fields).eq("id", r2).eq("token_id", tok.id).maybeSingle();
      if (!data) throw new ApiError(404, "draft not found (agents can only read their own drafts)");
      return { draft: shape(data) };
    }
    let qb = admin.from("approvals").select(fields).eq("token_id", tok.id).order("created_at", { ascending: false }).limit(Math.min(Number(q.get("limit") ?? 50) || 50, 200));
    if (q.get("since")) qb = qb.or(`created_at.gte.${dateStr(q.get("since"), "since")},decided_at.gte.${dateStr(q.get("since"), "since")}`);
    const st = q.get("decision");
    if (st === "pending") qb = qb.eq("status", "pending"); else if (st) qb = qb.neq("status", "pending");
    const { data, error } = await qb; if (error) throw new ApiError(500, error.message);
    let out = (data ?? []).map(shape); if (st && st !== "pending" && st !== "decided") out = out.filter((d) => d.decision === st);
    return { drafts: out };
  }

  if (r1 === "opportunities" && !r2 && method === "POST") {
    const contact = b.contact_id ? await resolveContact(String(b.contact_id)) : null;
    const score = Number(b.score ?? 50); if (!Number.isFinite(score) || score < 0 || score > 100) throw bad("score must be 0 to 100");
    const row = {
      title: str(b.title, 200, "title", true), reason: str(b.reason, 300, "reason", true), suggested_action: str(b.suggested_action, 500, "suggested_action"),
      score: Math.round(score), urgency: oneOf(b.urgency, ["low", "normal", "urgent"], "urgency", "normal"), type: oneOf(b.type, OPP_TYPES, "type", "other"),
      url: str(b.url, 500, "url"), contact_id: contact?.id ?? null, source: "grok", submitted_by: tok.name, token_id: tok.id, external_ref: str(b.external_ref ?? b.ref, 200, "external_ref"),
    };
    const { data, error } = await admin.from("opportunities").insert(row).select("id").single();
    if (error) throw new ApiError(500, error.message);
    return { status: 201, body: { id: data.id } };
  }

  if (r1 === "reports" && !r2 && method === "POST") {
    const row = {
      agent_name: tok.name, token_id: tok.id, summary: str(b.summary, 6000, "summary", true),
      day: dateStr(b.day, "day") ?? new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Amsterdam" }),
      metrics: typeof b.metrics === "object" && b.metrics && !Array.isArray(b.metrics) ? b.metrics : {},
      items: Array.isArray(b.items) ? b.items.slice(0, 100) : [],
    };
    if (JSON.stringify(row).length > 60000) throw bad("report is too large");
    const { data, error } = await admin.from("agent_reports").insert(row).select("id").single();
    if (error) throw new ApiError(500, error.message);
    return { status: 201, body: { id: data.id } };
  }

  throw new ApiError(404, `no route for ${method} /${seg.join("/")}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const t0 = Date.now();
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/agent-api/, "") || "/";
  const idem = req.headers.get("idempotency-key")?.slice(0, 200) ?? null;
  let tok: Token | null = null;
  let body: Record<string, unknown> = {};
  let status = 200, out: unknown = null, err: string | null = null;
  try {
    const raw = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!raw.startsWith("cro_")) throw new ApiError(401, "missing or invalid token");
    const { data: t } = await admin.from("agent_tokens").select("id,name,team,rate_per_min,revoked_at").eq("token_hash", await sha256(raw)).maybeSingle();
    if (!t || t.revoked_at) throw new ApiError(401, "missing or invalid token");
    tok = t;
    const { count } = await admin.from("api_audit").select("id", { count: "exact", head: true }).eq("token_id", t.id).gte("created_at", new Date(Date.now() - 60000).toISOString());
    if ((count ?? 0) >= t.rate_per_min) throw new ApiError(429, `rate limit: ${t.rate_per_min} calls a minute`);
    if (req.method === "POST" || req.method === "PATCH") {
      const text = await req.text();
      if (text.length > 64000) throw new ApiError(413, "body too large");
      try { body = text ? JSON.parse(text) : {}; } catch { throw bad("body must be JSON"); }
      if (typeof body !== "object" || Array.isArray(body) || body === null) throw bad("body must be a JSON object");
      if (!idem) throw bad("Idempotency-Key header is required on POST and PATCH");
      // Reserve the key first, so two identical calls at the same moment cannot both run.
      const { error: resErr } = await admin.from("api_idempotency").insert({ token_id: t.id, key: idem, status: 0, response: {} });
      if (resErr) {
        const { data: prev } = await admin.from("api_idempotency").select("status,response").eq("token_id", t.id).eq("key", idem).maybeSingle();
        if (prev?.status === 0) throw new ApiError(409, "a request with this Idempotency-Key is still running; retry in a few seconds");
        if (prev && prev.status < 500) { status = prev.status; out = { ...(prev.response as object), idempotent_replay: true }; }
      }
    } else if (req.method !== "GET") throw new ApiError(405, "only GET, POST and PATCH");
    if (out === null) {
      const r = await route(req.method, path, body, url.searchParams, t) as Record<string, unknown>;
      if (r && typeof r.status === "number" && "body" in r) { status = r.status as number; out = r.body; } else { out = r; }
      if (idem && req.method !== "GET") await admin.from("api_idempotency").update({ status, response: out }).eq("token_id", t.id).eq("key", idem);
    }
    admin.from("agent_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", t.id).then(() => {}, () => {});
  } catch (e) {
    status = e instanceof ApiError ? e.status : 500; err = e instanceof Error ? e.message : String(e); out = { error: err };
    // A failed call frees its key (except 409, which belongs to the call still running), so the agent can retry with the same key.
    if (tok && idem && status !== 409) await admin.from("api_idempotency").update({ status: 500, response: out }).eq("token_id", tok.id).eq("key", idem).eq("status", 0);
  }
  const summary = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 300) : v]));
  await admin.from("api_audit").insert({ token_id: tok?.id ?? null, agent_name: tok?.name ?? "unknown", method: req.method, path: path + (url.search || ""), status, idempotency_key: idem, request: summary, error: err, ms: Date.now() - t0 });
  return new Response(JSON.stringify(out), { status, headers: { ...cors, "Content-Type": "application/json" } });
});
