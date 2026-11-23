// Agents runtime for the control panel.
// POST /functions/v1/agents?action=tick            (cron, every 15 min: starts due agents)
// POST /functions/v1/agents?action=run&slug=scout   (runs one agent now)
// Auth: x-cron-secret header or a signed-in operator's JWT.
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
async function kb(keys: string[]) {
  const { data } = await admin.from("knowledge").select("key,title,content").in("key", keys);
  return (data ?? []).map((k) => `## ${k.title}\n${k.content}`).join("\n\n");
}
const ventureIds = async () => {
  const { data } = await admin.from("ventures").select("id,slug");
  return Object.fromEntries((data ?? []).map((v) => [v.slug, v.id])) as Record<string, string>;
};
const today = () => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date());
const noDash = (s: string) => (s ?? "").replace(/\s*[—–]\s*/g, ", ");
const BASE_SYSTEM = (extra: string) =>
  `You are an agent working for Causis Research and its product Anna, reporting to Ceriel van den Adel (commercial co-founder). Today is ${today()}. Be accurate: never invent people, funds, emails, URLs or facts; if unsure, leave a field empty. Never use em dashes or en dashes. ${extra}`;

type Agent = { id: string; slug: string; name: string; model: string; instructions: string; venture_id: string | null; monthly_budget_usd: number };
type Ctx = { agent: Agent; runId: string; usage: Usage };

// ---------- Chief of staff ----------
async function runChief(c: Ctx) {
  const since = new Date(Date.now() - 3 * 864e5).toISOString();
  const { data: mails } = await admin.from("email_messages").select("id,account_id,venture_id,message_id,from_name,from_addr,subject,body_text,received_at")
    .is("triaged_at", null).gte("received_at", since).order("received_at", { ascending: false }).limit(40);
  const d2 = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
  const [{ data: deals }, { data: tasks }, { count: pending }, { data: runs }, { data: xs }] = await Promise.all([
    admin.from("deals").select("title,stage,pipeline,next_step,next_step_date").not("stage", "in", "(won,lost,parked)").lte("next_step_date", d2).limit(20),
    admin.from("tasks").select("title,due_date,priority").neq("status", "done").lte("due_date", d2).limit(20),
    admin.from("approvals").select("id", { count: "exact", head: true }).eq("status", "pending"),
    admin.from("agent_runs").select("summary,started_at,agents(name)").gte("started_at", new Date(Date.now() - 864e5).toISOString()).eq("status", "done").limit(10),
    admin.from("x_accounts").select("handle,followers"),
  ]);
  const mailText = (mails ?? []).map((m) => `[${m.id}] ${m.received_at} From: ${m.from_name ?? ""} <${m.from_addr}> Subject: ${m.subject}\n${(m.body_text ?? "").slice(0, 1200)}`).join("\n\n---\n\n");
  const out = await claude({
    model: c.agent.model,
    system: BASE_SYSTEM("You are the chief of staff. Write for a busy founder: short, specific, prioritised."),
    user: `${await kb(["causis", "anna", "voice"])}\n\n# Extra instructions\n${c.agent.instructions}\n\n# New emails (${(mails ?? []).length})\n${mailText || "None"}\n\n# Deals with next steps due\n${JSON.stringify(deals)}\n\n# Tasks due\n${JSON.stringify(tasks)}\n\n# Pending approvals: ${pending ?? 0}\n\n# Agent results last 24h\n${(runs ?? []).map((r) => `- ${(r as { agents?: { name?: string } }).agents?.name}: ${r.summary}`).join("\n")}\n\n# X followers\n${JSON.stringify(xs)}\n\nTriage every email. Draft replies (as Ceriel, first person, short) only where a reply is clearly needed and not a newsletter or notification. Then write today's brief in markdown: Top 3 for today, Inbox highlights, Pipeline, Agents, Numbers. Max 250 words.`,
    schema: {
      type: "object", required: ["triage", "brief", "summary"],
      properties: {
        triage: { type: "array", items: { type: "object", required: ["id", "priority", "category", "note", "needs_reply"], properties: {
          id: { type: "string" }, priority: { type: "string", enum: ["high", "normal", "low"] },
          category: { type: "string", enum: ["investor", "partner", "pilot", "customer", "program", "newsletter", "notification", "personal", "other"] },
          note: { type: "string" }, needs_reply: { type: "boolean" }, reply_draft: { type: "string" } } } },
        brief: { type: "string" }, summary: { type: "string", description: "One line summary of this run" },
      },
    },
  }, c.usage);
  const byId = new Map((mails ?? []).map((m) => [m.id, m]));
  let drafts = 0;
  for (const t of (out.triage as Record<string, unknown>[]) ?? []) {
    const m = byId.get(t.id as string); if (!m) continue;
    await admin.from("email_messages").update({ priority: t.priority, category: t.category, ai_note: noDash(t.note as string), triaged_at: new Date().toISOString(), ...(t.priority === "high" ? { status: "todo" } : {}) }).eq("id", m.id);
    if (t.needs_reply && t.reply_draft) {
      drafts++;
      await admin.from("approvals").insert({ agent_id: c.agent.id, run_id: c.runId, venture_id: m.venture_id, kind: "email",
        title: `Reply to ${m.from_name || m.from_addr}: ${m.subject}`, body: noDash(t.reply_draft as string),
        payload: { to: m.from_addr, subject: (m.subject ?? "").startsWith("Re:") ? m.subject : `Re: ${m.subject}`, in_reply_to: m.message_id, account_id: m.account_id, email_id: m.id } });
    }
  }
  await admin.from("briefs").insert({ content: noDash(out.brief as string), run_id: c.runId });
  return { summary: noDash(out.summary as string) || `Triaged ${(mails ?? []).length} emails, ${drafts} reply drafts`, output: { triaged: (mails ?? []).length, drafts } };
}

// ---------- Scout ----------
async function runScout(c: Ctx) {
  const v = await ventureIds();
  const { data: contacts } = await admin.from("contacts").select("name,org").limit(500);
  const known = [...new Set((contacts ?? []).map((x) => x.org || x.name).filter(Boolean))].join(", ");
  const out = await claude({
    model: c.agent.model, searches: 8, maxTokens: 10000,
    system: BASE_SYSTEM("You are the scout. You find real, current, verifiable opportunities using web search, and you write outreach Ceriel can send as is."),
    user: `${await kb(["causis", "anna", "fundraising", "voice"])}\n\n# Instructions\n${c.agent.instructions}\n\n# Already in the CRM, do not suggest\n${known || "None yet"}\n\nSearch the web, verify each opportunity is active, then submit. Each message: under 90 words, personal to the recipient, one clear ask, signed Ceriel. Subject line under 8 words.`,
    schema: {
      type: "object", required: ["leads", "summary"],
      properties: {
        leads: { type: "array", items: { type: "object", required: ["name", "kind", "venture", "why_fit", "route", "url", "message"], properties: {
          name: { type: "string", description: "Person or program name" }, org: { type: "string" },
          kind: { type: "string", enum: ["vc", "angel", "grant", "credits", "accelerator", "partner", "community"] },
          venture: { type: "string", enum: ["causis", "anna", "both"] },
          why_fit: { type: "string" }, route: { type: "string", description: "How to reach them: email, form, X DM, intro via..." },
          url: { type: "string" }, email: { type: "string" }, x_handle: { type: "string" },
          message_subject: { type: "string" }, message: { type: "string" } } } },
        summary: { type: "string" },
      },
    },
  }, c.usage);
  let added = 0;
  for (const l of (out.leads as Record<string, string>[]) ?? []) {
    const venture_id = l.venture === "anna" ? v.anna : v.causis;
    const pipeline = ["vc", "angel"].includes(l.kind) ? "fundraise" : ["grant", "credits", "accelerator"].includes(l.kind) ? "grant" : "partnership";
    const { data: contact } = await admin.from("contacts").insert({ venture_id, name: l.name, org: l.org || null, email: l.email || null, x_handle: l.x_handle || null,
      tags: [l.kind, "scout"], notes: `${noDash(l.why_fit)}\n\nRoute: ${l.route}\n${l.url}` }).select().single();
    const { data: deal } = await admin.from("deals").insert({ venture_id, contact_id: contact?.id, title: l.org ? `${l.org}${l.name !== l.org ? ", " + l.name : ""}` : l.name,
      pipeline, stage: "lead", next_step: `Send intro (${l.route})`, notes: noDash(l.why_fit) }).select().single();
    await admin.from("approvals").insert({ agent_id: c.agent.id, run_id: c.runId, venture_id, kind: "outreach",
      title: `${l.org || l.name}: ${l.kind}`, body: noDash(l.message),
      payload: { subject: l.message_subject, to: l.email || null, route: l.route, url: l.url, why: noDash(l.why_fit), deal_id: deal?.id, contact_id: contact?.id, x_handle: l.x_handle || null } });
    added++;
  }
  await admin.from("activity").insert({ kind: "scout", summary: `Scout found ${added} new leads` });
  return { summary: noDash(out.summary as string) || `${added} new leads`, output: { added } };
}

// ---------- Marketing ----------
async function runMarketing(c: Ctx) {
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const [{ data: past }, { data: top }] = await Promise.all([
    admin.from("approvals").select("body,status,payload").eq("kind", "x_post").gte("created_at", since).limit(40),
    admin.from("x_posts").select("text,likes,reposts,replies,impressions,x_accounts(handle)").gte("created_at", since).order("impressions", { ascending: false }).limit(10),
  ]);
  const out = await claude({
    model: c.agent.model, searches: 6, maxTokens: 6000,
    system: BASE_SYSTEM("You are the marketing lead for X. Posts must be specific, useful and timely; no hashtags, no emojis unless natural, never cringe."),
    user: `${await kb(["anna", "causis", "voice"])}\n\n# Instructions\n${c.agent.instructions}\n\n# Our best recent posts\n${JSON.stringify(top)}\n\n# Recent drafts (approved = liked, rejected = not liked)\n${(past ?? []).map((p) => `[${p.status}] ${p.body}`).join("\n")}\n\nSearch for the most relevant AI news of the last 48 hours first. Each post max 270 characters. For @causisresearch only post if there is real lab news in the knowledge above; otherwise skip it. The grok_note is 3 to 5 lines Ceriel can paste to Grok Bot to steer today's autonomous posting.`,
    schema: {
      type: "object", required: ["posts", "grok_note", "summary"],
      properties: {
        posts: { type: "array", items: { type: "object", required: ["account", "text", "why"], properties: {
          account: { type: "string", enum: ["annaos_ai", "causisresearch", "notinvariant"] }, text: { type: "string" }, why: { type: "string" }, source_url: { type: "string" } } } },
        grok_note: { type: "string" }, summary: { type: "string" },
      },
    },
  }, c.usage);
  const v = await ventureIds();
  for (const p of (out.posts as Record<string, string>[]) ?? []) {
    const text = noDash(p.text);
    await admin.from("approvals").insert({ agent_id: c.agent.id, run_id: c.runId, kind: "x_post",
      venture_id: p.account === "annaos_ai" ? v.anna : p.account === "causisresearch" ? v.causis : null,
      title: `@${p.account}`, body: text, payload: { account: p.account, why: p.why, source_url: p.source_url ?? null } });
  }
  await admin.from("approvals").insert({ agent_id: c.agent.id, run_id: c.runId, kind: "grok_note", title: "Daily note for Grok Bot", body: noDash(out.grok_note as string) });
  return { summary: noDash(out.summary as string) || `${(out.posts as unknown[]).length} post drafts`, output: { posts: (out.posts as unknown[]).length } };
}

// ---------- SEO + AEO ----------
const SITES = ["https://causisresearch.com", "https://annaos.ai"];
const COMPETITORS = ["Grok Bot", "Hermes", "OpenClaw", "Kylon", "Instinct", "Hark", "Muse", "Claude", "ChatGPT", "Slack", "Microsoft Copilot", "Liquid AI", "Sakana", "Nous Research", "Cartesia", "Mamba"];
async function audit(site: string) {
  const get = async (u: string) => { try { const r = await fetch(u, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (compatible; CausisOpsAudit/1.0)" } }); return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : "" }; } catch (e) { return { ok: false, status: 0, text: String(e) }; } };
  const [home, robots, sitemap, llms] = await Promise.all([get(site), get(site + "/robots.txt"), get(site + "/sitemap.xml"), get(site + "/llms.txt")]);
  const h = home.text;
  const m = (re: RegExp) => (h.match(re)?.[1] ?? "").trim();
  const title = m(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const desc = m(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || m(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const h1s = [...h.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((x) => x[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean);
  const og = /property=["']og:title["']/i.test(h) && /property=["']og:image["']/i.test(h);
  const canonical = /rel=["']canonical["']/i.test(h);
  const jsonld = [...h.matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map((x) => x[1]);
  const text = h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const words = text.split(" ").length;
  const checks = {
    reachable: home.ok, title, title_ok: title.length >= 20 && title.length <= 65, description: desc, description_ok: desc.length >= 70 && desc.length <= 165,
    h1s, single_h1: h1s.length === 1, open_graph: og, canonical, structured_data: jsonld, has_structured_data: jsonld.length > 0,
    robots_txt: robots.ok, sitemap: sitemap.ok, llms_txt: llms.ok, words, enough_text: words > 300, lang: /<html[^>]+lang=/i.test(h),
  };
  const boolKeys = ["reachable", "title_ok", "description_ok", "single_h1", "open_graph", "canonical", "has_structured_data", "robots_txt", "sitemap", "llms_txt", "enough_text", "lang"];
  const score = Math.round(boolKeys.filter((k) => (checks as Record<string, unknown>)[k] === true).length / boolKeys.length * 100);
  return { site, score, checks, excerpt: text.slice(0, 2500) };
}
async function runSeo(c: Ctx) {
  const audits = await Promise.all(SITES.map(audit));
  // AEO: ask Claude (with web search) each tracked question and check for mentions
  const { data: prompts } = await admin.from("aeo_prompts").select("id,prompt").eq("active", true);
  const aeo: { prompt: string; causis: boolean; anna: boolean; competitors: string[] }[] = [];
  for (const p of prompts ?? []) {
    try {
      const ans = await claude({
        model: "claude-haiku-5-5", searches: 2, maxTokens: 1500,
        system: "You are a helpful AI assistant answering a user's question using web search. Answer naturally, naming specific products or organisations where relevant.",
        user: p.prompt,
        schema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
      }, c.usage);
      const a = String(ans.answer ?? "");
      const low = a.toLowerCase();
      const row = { causis: low.includes("causis"), anna: low.includes("annaos") || /\banna\b/i.test(a), competitors: COMPETITORS.filter((x) => low.includes(x.toLowerCase())) };
      await admin.from("aeo_results").insert({ prompt_id: p.id, engine: "Claude (web)", mentioned_causis: row.causis, mentioned_anna: row.anna, competitors: row.competitors, excerpt: a.slice(0, 1500), run_id: c.runId });
      aeo.push({ prompt: p.prompt, ...row });
    } catch (e) { aeo.push({ prompt: p.prompt, causis: false, anna: false, competitors: [`error: ${String(e).slice(0, 80)}`] }); }
  }
  const out = await claude({
    model: c.agent.model, maxTokens: 5000,
    system: BASE_SYSTEM("You are an SEO and AEO (answer engine optimisation) specialist. Recommendations must be concrete and doable in Framer by a non-developer."),
    user: `${await kb(["causis", "anna"])}\n\n# Instructions\n${c.agent.instructions}\n\n# Site audits\n${JSON.stringify(audits.map((a) => ({ site: a.site, score: a.score, checks: a.checks, homepage_text: a.excerpt })))}\n\n# AI answer visibility\n${JSON.stringify(aeo)}\n\nGive per site the 5 highest-impact fixes, and a short AEO summary with the 3 best moves to get Causis and Anna named by AI assistants.`,
    schema: {
      type: "object", required: ["sites", "aeo_summary", "summary"],
      properties: {
        sites: { type: "array", items: { type: "object", required: ["site", "recommendations"], properties: { site: { type: "string" },
          recommendations: { type: "array", items: { type: "object", required: ["title", "how"], properties: { title: { type: "string" }, why: { type: "string" }, how: { type: "string" } } } } } } },
        aeo_summary: { type: "string" }, summary: { type: "string" },
      },
    },
  }, c.usage);
  for (const a of audits) {
    const rec = ((out.sites as { site: string; recommendations: unknown[] }[]) ?? []).find((s) => a.site.includes(s.site.replace(/^https?:\/\//, "").replace(/\/$/, "")) || s.site.includes(a.site.replace("https://", "")));
    await admin.from("seo_audits").insert({ site: a.site, score: a.score, checks: a.checks, recommendations: rec?.recommendations ?? [], run_id: c.runId });
  }
  const mentioned = aeo.filter((x) => x.causis || x.anna).length;
  return { summary: noDash(out.summary as string) || `SEO ${audits.map((a) => a.score).join("/")}; AI mentions ${mentioned}/${aeo.length}`, output: { aeo_summary: noDash(out.aeo_summary as string), mentioned, asked: aeo.length } };
}

const RUNNERS: Record<string, (c: Ctx) => Promise<{ summary: string; output: unknown }>> = { chief: runChief, scout: runScout, marketing: runMarketing, seo: runSeo };

async function runAgent(slug: string, trigger: string) {
  const { data: agent } = await admin.from("agents").select("*").eq("slug", slug).single();
  if (!agent) throw new Error(`No agent ${slug}`);
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const { data: spent } = await admin.from("agent_runs").select("cost_usd").eq("agent_id", agent.id).gte("started_at", monthStart.toISOString());
  const used = (spent ?? []).reduce((a, r) => a + Number(r.cost_usd ?? 0), 0);
  const { data: run } = await admin.from("agent_runs").insert({ agent_id: agent.id, trigger }).select().single();
  if (used >= Number(agent.monthly_budget_usd)) {
    await admin.from("agents").update({ last_run_at: new Date().toISOString() }).eq("id", agent.id);
    await admin.from("agent_runs").update({ status: "skipped", summary: `Monthly budget of $${agent.monthly_budget_usd} reached`, finished_at: new Date().toISOString() }).eq("id", run!.id);
    return { skipped: true };
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

function amsterdamNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short", hour12: false })
    .formatToParts(new Date()).map((p) => [p.type, p.value]));
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, weekday: wd };
}
const amsDate = (d: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date(d));

async function tick() {
  // mark stuck runs as failed
  await admin.from("agent_runs").update({ status: "failed", error: "Timed out", finished_at: new Date().toISOString() }).eq("status", "running").lt("started_at", new Date(Date.now() - 15 * 60e3).toISOString());
  const { data: agents } = await admin.from("agents").select("*").eq("enabled", true);
  const now = amsterdamNow();
  const started: string[] = [];
  for (const a of agents ?? []) {
    let due: boolean;
    if (a.every_hours >= 24) {
      const hourOk = a.at_hour == null || now.hour >= a.at_hour;
      const dayOk = a.weekday == null || now.weekday === a.weekday;
      const notToday = !a.last_run_at || amsDate(a.last_run_at) !== now.date;
      const gapOk = !a.last_run_at || (Date.now() - new Date(a.last_run_at).getTime()) >= (a.every_hours - 12) * 3600e3;
      due = hourOk && dayOk && notToday && gapOk;
    } else {
      due = !a.last_run_at || (Date.now() - new Date(a.last_run_at).getTime()) >= a.every_hours * 3600e3 - 5 * 60e3;
    }
    if (due) { await admin.rpc("start_agent", { p_slug: a.slug, p_trigger: "schedule" }); started.push(a.slug); }
  }
  return { started };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "tick";
  try {
    if (action === "tick") return json(await tick());
    if (action === "run") return json(await runAgent(url.searchParams.get("slug") ?? "", url.searchParams.get("trigger") ?? "manual"));
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
