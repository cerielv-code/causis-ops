// Orchestrator: the chat on the Overview. Claude with tools over the panel's data and actions.
// POST /functions/v1/orchestrator  body: { message }   (operator JWT)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const PRICES: Record<string, [number, number]> = { "claude-sonnet-5-5": [3, 15], "claude-haiku-5-5": [1, 5], "claude-opus-5-5": [5, 25] };
const noDash = (s: string) => (s ?? "").replace(/\s*[—–]\s*/g, ", ");
const today = () => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date());

async function isOperator(auth: string | null) {
  if (!auth) return false;
  const u = createClient(SB_URL, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data } = await u.from("operators").select("email").limit(1);
  return !!data && data.length > 0;
}
async function ventures() {
  const { data } = await admin.from("ventures").select("id,slug,name");
  return data ?? [];
}
const vId = async (slug?: string) => slug ? (await ventures()).find((v) => v.slug === slug)?.id ?? null : null;
const trim = (x: unknown, n = 6000) => { const s = JSON.stringify(x); return s.length > n ? s.slice(0, n) + "...(truncated)" : s; };

// ---------- tools ----------
const VENTURE = { type: "string", enum: ["causis", "anna"], description: "Which venture" };
const TOOLS = [
  { name: "search_email", description: "Search synced email by text (sender, subject, body). Returns newest first.", input_schema: { type: "object", properties: { query: { type: "string" }, status: { type: "string", enum: ["inbox", "todo", "waiting", "archived"] }, limit: { type: "integer" } } } },
  { name: "read_email", description: "Read one email in full by id.", input_schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  { name: "list_deals", description: "List CRM deals. Filter by pipeline (fundraise, partnership, pilot, grant, customer), stage, or text.", input_schema: { type: "object", properties: { pipeline: { type: "string" }, stage: { type: "string" }, query: { type: "string" } } } },
  { name: "search_contacts", description: "Search CRM contacts by name, org, email, tag or notes.", input_schema: { type: "object", required: ["query"], properties: { query: { type: "string" } } } },
  { name: "list_tasks", description: "List open tasks (or all with include_done).", input_schema: { type: "object", properties: { include_done: { type: "boolean" } } } },
  { name: "telegram_recent", description: "Recent Telegram messages from starred chats, optionally filtered by chat title.", input_schema: { type: "object", properties: { chat: { type: "string" }, hours: { type: "integer" } } } },
  { name: "x_stats", description: "X follower counts and recent post engagement for our accounts.", input_schema: { type: "object", properties: {} } },
  { name: "agents_status", description: "The AI agents, their schedules, last runs, results and spend this month.", input_schema: { type: "object", properties: {} } },
  { name: "list_approvals", description: "Items waiting for Ceriel's approval.", input_schema: { type: "object", properties: {} } },
  { name: "read_knowledge", description: "Read the company knowledge docs every agent uses (keys: causis, anna, fundraising, voice).", input_schema: { type: "object", properties: {} } },
  { name: "growth_status", description: "Latest SEO audit scores and AI-answer visibility.", input_schema: { type: "object", properties: {} } },
  { name: "create_task", description: "Create a task.", input_schema: { type: "object", required: ["title"], properties: { title: { type: "string" }, notes: { type: "string" }, due_date: { type: "string", description: "YYYY-MM-DD" }, priority: { type: "integer", enum: [1, 2, 3] }, venture: VENTURE } } },
  { name: "update_task", description: "Update or complete a task by id.", input_schema: { type: "object", required: ["id"], properties: { id: { type: "string" }, status: { type: "string", enum: ["todo", "doing", "done"] }, due_date: { type: "string" }, title: { type: "string" }, notes: { type: "string" } } } },
  { name: "upsert_contact", description: "Create a contact, or update one if id is given.", input_schema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, org: { type: "string" }, role: { type: "string" }, email: { type: "string" }, telegram: { type: "string" }, x_handle: { type: "string" }, linkedin: { type: "string" }, tags: { type: "array", items: { type: "string" } }, notes: { type: "string" }, venture: VENTURE } } },
  { name: "upsert_deal", description: "Create a deal, or update one if id is given (stage, next step, amount, notes).", input_schema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, pipeline: { type: "string", enum: ["fundraise", "partnership", "pilot", "grant", "customer"] }, stage: { type: "string", enum: ["lead", "contacted", "meeting", "diligence", "committed", "won", "lost", "parked"] }, amount_usd: { type: "number" }, next_step: { type: "string" }, next_step_date: { type: "string" }, notes: { type: "string" }, contact_id: { type: "string" }, venture: VENTURE } } },
  { name: "update_knowledge", description: "Replace the content of a knowledge doc (causis, anna, fundraising, voice). Read it first and keep what still holds.", input_schema: { type: "object", required: ["key", "content"], properties: { key: { type: "string" }, content: { type: "string" } } } },
  { name: "run_agent", description: "Start one of the agents now: chief, scout, marketing, seo. Results arrive in 1 to 3 minutes.", input_schema: { type: "object", required: ["slug"], properties: { slug: { type: "string", enum: ["chief", "scout", "marketing", "seo"] } } } },
  { name: "configure_agent", description: "Change an agent's instructions, schedule, model, budget or on/off.", input_schema: { type: "object", required: ["slug"], properties: { slug: { type: "string", enum: ["chief", "scout", "marketing", "seo"] }, instructions: { type: "string" }, enabled: { type: "boolean" }, at_hour: { type: "integer" }, every_hours: { type: "integer" }, monthly_budget_usd: { type: "number" }, model: { type: "string", enum: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"] } } } },
  { name: "draft_email", description: "Draft an email for Ceriel to approve and send. Goes to Approvals, never sent directly.", input_schema: { type: "object", required: ["to", "subject", "body"], properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, reply_to_email_id: { type: "string" }, venture: VENTURE } } },
  { name: "draft_x_post", description: "Draft an X post for approval. account: annaos_ai, causisresearch or notinvariant.", input_schema: { type: "object", required: ["account", "text"], properties: { account: { type: "string", enum: ["annaos_ai", "causisresearch", "notinvariant"] }, text: { type: "string" }, why: { type: "string" } } } },
  { name: "draft_telegram", description: "Draft a Telegram message to a chat (by title) for approval.", input_schema: { type: "object", required: ["chat", "text"], properties: { chat: { type: "string" }, text: { type: "string" } } } },
];

type Action = { tool: string; summary: string };
async function runTool(name: string, i: Record<string, unknown>, actions: Action[]): Promise<unknown> {
  const s = (x: unknown) => String(x ?? "");
  switch (name) {
    case "search_email": {
      let q = admin.from("email_messages").select("id,from_name,from_addr,subject,snippet,received_at,status,priority,category,ai_note").order("received_at", { ascending: false }).limit(Number(i.limit ?? 15));
      if (i.query) { const t = s(i.query).replace(/[,()]/g, " "); q = q.or(`subject.ilike.%${t}%,from_addr.ilike.%${t}%,from_name.ilike.%${t}%,body_text.ilike.%${t}%`); }
      if (i.status) q = q.eq("status", s(i.status));
      return (await q).data;
    }
    case "read_email": { const { data } = await admin.from("email_messages").select("id,from_name,from_addr,to_addrs,subject,received_at,body_text,message_id,account_id,venture_id").eq("id", s(i.id)).single(); return data ? { ...data, body_text: (data.body_text ?? "").slice(0, 8000) } : null; }
    case "list_deals": {
      let q = admin.from("deals").select("id,title,pipeline,stage,amount_usd,next_step,next_step_date,notes,contacts(name,org,email)").order("updated_at", { ascending: false }).limit(60);
      if (i.pipeline) q = q.eq("pipeline", s(i.pipeline)); if (i.stage) q = q.eq("stage", s(i.stage)); if (i.query) q = q.ilike("title", `%${s(i.query)}%`);
      return (await q).data;
    }
    case "search_contacts": { const t = s(i.query).replace(/[,()]/g, " "); return (await admin.from("contacts").select("id,name,org,role,email,telegram,x_handle,tags,notes").or(`name.ilike.%${t}%,org.ilike.%${t}%,email.ilike.%${t}%,notes.ilike.%${t}%`).limit(25)).data; }
    case "list_tasks": { let q = admin.from("tasks").select("id,title,status,priority,due_date,notes").order("due_date", { nullsFirst: false }).limit(80); if (!i.include_done) q = q.neq("status", "done"); return (await q).data; }
    case "telegram_recent": {
      let q = admin.from("tg_msgs").select("text,sender_name,is_outgoing,sent_at,tg_dialogs!inner(title,tracked)").eq("tg_dialogs.tracked", true).gte("sent_at", new Date(Date.now() - Number(i.hours ?? 48) * 3600e3).toISOString()).order("sent_at", { ascending: false }).limit(80);
      if (i.chat) q = q.ilike("tg_dialogs.title", `%${s(i.chat)}%`);
      return (await q).data;
    }
    case "x_stats": return { accounts: (await admin.from("x_accounts").select("handle,followers,last_synced_at")).data, recent_posts: (await admin.from("x_posts").select("text,likes,reposts,replies,impressions,created_at,x_accounts(handle)").order("created_at", { ascending: false }).limit(15)).data };
    case "agents_status": return (await admin.from("agents").select("slug,name,enabled,every_hours,at_hour,model,monthly_budget_usd,last_run_at,instructions")).data;
    case "list_approvals": return (await admin.from("approvals").select("id,kind,title,body,created_at").eq("status", "pending").order("created_at", { ascending: false }).limit(40)).data;
    case "read_knowledge": return (await admin.from("knowledge").select("key,title,content")).data;
    case "growth_status": return { seo: (await admin.from("seo_audits").select("site,score,recommendations,at").order("at", { ascending: false }).limit(2)).data, aeo: (await admin.from("aeo_results").select("mentioned_causis,mentioned_anna,competitors,at,aeo_prompts(prompt)").order("at", { ascending: false }).limit(10)).data };
    case "create_task": {
      const { data } = await admin.from("tasks").insert({ title: s(i.title), notes: i.notes ?? null, due_date: i.due_date ?? null, priority: i.priority ?? 2, venture_id: await vId(i.venture as string) }).select("id,title").single();
      actions.push({ tool: name, summary: `Task: ${i.title}` }); return data;
    }
    case "update_task": {
      const patch: Record<string, unknown> = {}; for (const k of ["status", "due_date", "title", "notes"]) if (i[k] !== undefined) patch[k] = i[k];
      const { data } = await admin.from("tasks").update(patch).eq("id", s(i.id)).select("id,title,status").single();
      actions.push({ tool: name, summary: `Task updated: ${data?.title ?? i.id}` }); return data;
    }
    case "upsert_contact": {
      const row: Record<string, unknown> = {}; for (const k of ["name", "org", "role", "email", "telegram", "x_handle", "linkedin", "tags", "notes"]) if (i[k] !== undefined) row[k] = i[k];
      if (i.venture) row.venture_id = await vId(i.venture as string);
      const r = i.id ? await admin.from("contacts").update(row).eq("id", s(i.id)).select("id,name").single() : await admin.from("contacts").insert({ name: "Unnamed", ...row }).select("id,name").single();
      actions.push({ tool: name, summary: `${i.id ? "Contact updated" : "Contact added"}: ${r.data?.name}` }); return r.data ?? r.error;
    }
    case "upsert_deal": {
      const row: Record<string, unknown> = {}; for (const k of ["title", "pipeline", "stage", "amount_usd", "next_step", "next_step_date", "notes", "contact_id"]) if (i[k] !== undefined) row[k] = i[k];
      if (i.venture) row.venture_id = await vId(i.venture as string);
      const r = i.id ? await admin.from("deals").update(row).eq("id", s(i.id)).select("id,title,stage").single() : await admin.from("deals").insert({ title: "Untitled", ...row }).select("id,title,stage").single();
      actions.push({ tool: name, summary: `${i.id ? "Deal updated" : "Deal added"}: ${r.data?.title} (${r.data?.stage})` }); return r.data ?? r.error;
    }
    case "update_knowledge": {
      const { data } = await admin.from("knowledge").update({ content: noDash(s(i.content)), updated_at: new Date().toISOString() }).eq("key", s(i.key)).select("key,title").single();
      actions.push({ tool: name, summary: `Knowledge updated: ${data?.title ?? i.key}` }); return data ?? "No such key";
    }
    case "run_agent": { await admin.rpc("start_agent", { p_slug: s(i.slug), p_trigger: "orchestrator" }); actions.push({ tool: name, summary: `Started ${i.slug}` }); return "Started. Results in 1 to 3 minutes."; }
    case "configure_agent": {
      const patch: Record<string, unknown> = {}; for (const k of ["instructions", "enabled", "at_hour", "every_hours", "monthly_budget_usd", "model"]) if (i[k] !== undefined) patch[k] = i[k];
      const { data } = await admin.from("agents").update(patch).eq("slug", s(i.slug)).select("name").single();
      actions.push({ tool: name, summary: `${data?.name} updated: ${Object.keys(patch).join(", ")}` }); return data;
    }
    case "draft_email": {
      let extra: Record<string, unknown> = {};
      if (i.reply_to_email_id) { const { data: m } = await admin.from("email_messages").select("message_id,account_id,venture_id").eq("id", s(i.reply_to_email_id)).single(); if (m) extra = { in_reply_to: m.message_id, account_id: m.account_id }; }
      await admin.from("approvals").insert({ kind: "email", title: `Email to ${i.to}: ${i.subject}`, body: noDash(s(i.body)), venture_id: await vId(i.venture as string), payload: { to: i.to, subject: i.subject, ...extra } });
      actions.push({ tool: name, summary: `Email draft to ${i.to} in Approvals` }); return "Drafted into Approvals";
    }
    case "draft_x_post": {
      await admin.from("approvals").insert({ kind: "x_post", title: `@${i.account}`, body: noDash(s(i.text)), venture_id: i.account === "annaos_ai" ? await vId("anna") : i.account === "causisresearch" ? await vId("causis") : null, payload: { account: i.account, why: i.why ?? "From the orchestrator" } });
      actions.push({ tool: name, summary: `X post for @${i.account} in Approvals` }); return "Drafted into Approvals";
    }
    case "draft_telegram": {
      const { data: d } = await admin.from("tg_dialogs").select("account_id,id,title").ilike("title", `%${s(i.chat)}%`).order("last_message_at", { ascending: false }).limit(1).maybeSingle();
      if (!d) return "No Telegram chat matches that title";
      await admin.from("approvals").insert({ kind: "other", title: `Telegram: ${d.title}`, body: noDash(s(i.text)), payload: { channel: "telegram", account_id: d.account_id, chat_id: String(d.id) } });
      actions.push({ tool: name, summary: `Telegram message to ${d.title} in Approvals` }); return "Drafted into Approvals";
    }
  }
  return "Unknown tool";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await isOperator(req.headers.get("authorization")))) return json({ error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));
  const message = String(body.message ?? "").trim();
  if (!message) return json({ error: "Empty message" }, 400);

  const { data: agent } = await admin.from("agents").select("*").eq("slug", "orchestrator").single();
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const { data: spent } = await admin.from("agent_runs").select("cost_usd").eq("agent_id", agent.id).gte("started_at", monthStart.toISOString());
  if ((spent ?? []).reduce((a, r) => a + Number(r.cost_usd ?? 0), 0) >= Number(agent.monthly_budget_usd)) return json({ error: `Monthly budget of $${agent.monthly_budget_usd} reached. Raise it in Agents.` }, 402);

  const { data: keyRow } = await admin.rpc("get_app_secret", { p_name: "anthropic" });
  const key = Deno.env.get("ANTHROPIC_API_KEY") || (keyRow as string | null);
  if (!key) return json({ error: "Anthropic API key not set. Add it in Settings." }, 400);

  await admin.from("chat_messages").insert({ role: "user", content: message });
  const { data: hist } = await admin.from("chat_messages").select("role,content").order("created_at", { ascending: false }).limit(21);
  const history = (hist ?? []).reverse().map((m) => ({ role: m.role, content: m.content }));
  while (history.length && history[0].role !== "user") history.shift();

  const { data: kn } = await admin.from("knowledge").select("title,content").in("key", ["causis", "anna"]);
  const { data: brief } = await admin.from("briefs").select("content,created_at").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const system = `You are the orchestrator of Causis Research and its product Anna: Ceriel van den Adel's chief operator, working inside his private control panel. Now: ${today()} (Amsterdam).
You can look anything up with your tools and act on internal things directly (tasks, contacts, deals, knowledge, agents). Anything that leaves the company (email, X, Telegram) you only draft into Approvals; say so when you do it. Use web search for outside facts.
Be brief and concrete. Lead with the answer or what you did. Use short lists when useful. Never invent facts, names, numbers or emails: look them up or say you don't know. Never use em dashes or en dashes.

# Company context
${(kn ?? []).map((k) => `## ${k.title}\n${k.content}`).join("\n\n")}

# Today's brief
${brief?.content ?? "No brief yet today."}`;

  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }, ...TOOLS];
  const messages: { role: string; content: unknown }[] = history;
  const actions: Action[] = [];
  let tin = 0, tout = 0, searches = 0, reply = "";
  try {
    for (let step = 0; step < 10; step++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: agent.model, max_tokens: 4000, system, tools, messages }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(`Claude API ${r.status}: ${JSON.stringify(j?.error ?? j).slice(0, 300)}`);
      tin += j.usage?.input_tokens ?? 0; tout += j.usage?.output_tokens ?? 0; searches += j.usage?.server_tool_use?.web_search_requests ?? 0;
      const content = j.content ?? [];
      const uses = content.filter((c: { type: string }) => c.type === "tool_use");
      reply = content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n").trim() || reply;
      if (j.stop_reason === "pause_turn") { messages.push({ role: "assistant", content }); continue; }
      if (!uses.length) break;
      messages.push({ role: "assistant", content });
      const results = [];
      for (const u of uses) {
        let out: unknown;
        try { out = await runTool(u.name, u.input ?? {}, actions); } catch (e) { out = `Error: ${e instanceof Error ? e.message : String(e)}`; }
        results.push({ type: "tool_result", tool_use_id: u.id, content: trim(out) });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    reply = `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
  }
  const [pi, po] = PRICES[agent.model] ?? [3, 15];
  const cost = +(tin / 1e6 * pi + tout / 1e6 * po + searches / 1000 * 10).toFixed(4);
  reply = noDash(reply || "Done.");
  await admin.from("chat_messages").insert({ role: "assistant", content: reply, actions, cost_usd: cost });
  await admin.from("agent_runs").insert({ agent_id: agent.id, trigger: "chat", status: "done", summary: message.slice(0, 140), tokens_in: tin, tokens_out: tout, searches, cost_usd: cost, finished_at: new Date().toISOString() });
  return json({ reply, actions, cost });
});
