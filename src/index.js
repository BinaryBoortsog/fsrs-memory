#!/usr/bin/env node
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { createEmptyCard, Rating } = require("ts-fsrs");

const { load, save, DATA_DIR } = require("./storage.js");
const { f, retrievability, searchMemories, fuzzySearch } = require("./engine.js");

// export handler for tests (defined later in file)
module.exports = { handleTool };

// ── 3. CLI Dashboard & Main ──
const chalk = require('chalk');
const fs = require("fs");
const path = require("path");

const MAX_FACT_LENGTH = 500;

/**
 * Sanitize and validate project names.
 * Allows only lowercase letters, numbers and hyphens. Returns sanitized string or null.
 * @param {string} name
 * @returns {string|null}
 */
function sanitizeProject(name) {
  if (!name || typeof name !== 'string') return null;
  const s = name.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(s)) return null;
  return s;
}

/**
 * Validate tags: array of strings, max 20 chars each, max 10 tags.
 * @param {any} tags
 * @returns {{ok:boolean,message?:string}}
 */
function validateTags(tags) {
  if (tags === undefined) return { ok: true };
  if (!Array.isArray(tags)) return { ok: false, message: 'tags must be an array of strings' };
  if (tags.length > 10) return { ok: false, message: 'tags array cannot contain more than 10 items' };
  for (const t of tags) {
    if (typeof t !== 'string') return { ok: false, message: 'each tag must be a string' };
    if (t.length === 0) return { ok: false, message: 'tags cannot be empty' };
    if (t.length > 20) return { ok: false, message: 'each tag must be at most 20 characters' };
    if (!/^[\w- ]+$/.test(t)) return { ok: false, message: 'tags may contain only letters, numbers, underscore, hyphen and spaces' };
  }
  return { ok: true };
}

/**
 * Paginate an array
 * @param {Array} arr
 * @param {number} page
 * @param {number} limit
 * @returns {{results:Array,total:number,page:number,limit:number,totalPages:number}}
 */
function paginate(arr, page = 1, limit = 20) {
  const total = arr.length;
  const p = Math.max(1, parseInt(page) || 1);
  const l = Math.max(1, Math.min(100, parseInt(limit) || 20));
  const start = (p - 1) * l;
  const results = arr.slice(start, start + l);
  return { results, total, page: p, limit: l, totalPages: Math.ceil(total / l) };
}

/**
 * Get latest updatedAt or createdAt for a set of memories
 * @param {Array} mems
 * @returns {string|null}
 */
function getLatestUpdatedAt(mems) {
  let latest = 0;
  for (const m of mems) {
    const candidates = [m.updatedAt, m.card?.last_review, m.createdAt];
    for (const c of candidates) {
      if (!c) continue;
      const ts = new Date(c).getTime();
      if (!isNaN(ts)) latest = Math.max(latest, ts);
    }
  }
  return latest === 0 ? null : new Date(latest).toISOString();
}

const server = new Server({ name: "fsrs-memory", version: "2.1.0" }, { capabilities: { tools: {} } });

// ── 1. Define Tools ──
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "remember",
      description: "Save a decision to long-term memory. ALWAYS include the project name.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          fact: { type: "string" },
          difficulty: { type: "number", enum: [1, 2, 3] },
        },
        required: ["project", "fact"],
      },
    },
    {
      name: "recall",
      description: "Get fading memories for a project (below 85% health).",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" }, tag: { type: "string" } },
        required: ["project"]
      },
    },
    {
      name: "search",
      description: "Search memories by keyword in a project.",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" }, query: { type: "string" } },
        required: ["project", "query"],
      },
    },
    {
      name: "recall_all",
      description: "Recall fading memories across all projects (optional tag).",
      inputSchema: { type: "object", properties: { tag: { type: "string" } }, required: [] },
    },
    {
      name: "bulk_forget",
      description: "Bulk forget memories by ids (array).",
      inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, force: { type: "boolean" } }, required: ["ids"] },
    },
    {
      name: "bulk_reviewed",
      description: "Bulk apply review rating to multiple memories.",
      inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, rating: { type: "number", enum: [1,2,3,4] } }, required: ["ids","rating"] },
    },
    {
      name: "reviewed",
      description: "Update memory health after recall.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, rating: { type: "number", enum: [1, 2, 3, 4] } },
        required: ["id", "rating"],
      },
    },
    {
      name: "forget",
      description: "Delete an outdated memory.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, force: { type: "boolean" } },
        required: ["id"],
      },
    }
    ,
    {
      name: "list",
      description: "List all memories for a project with health scores.",
      inputSchema: { type: "object", properties: { project: { type: "string" }, page: { type: "number" }, limit: { type: "number" } }, required: ["project"] },
    },
    {
      name: "restore",
      description: "Restore a soft-deleted memory by id.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    {
      name: "purge",
      description: "Permanently purge trashed memories older than 30 days.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "stats",
      description: "Return project/global stats (health, counts, reviews).",
      inputSchema: { type: "object", properties: { project: { type: "string" } }, required: [] },
    },
    {
      name: "summarize",
      description: "Summarize all memories for a project into a 3-sentence brief using Anthropic (requires ANTHROPIC_API_KEY).",
      inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
    },
    {
      name: "export",
      description: "Export all memories for a project as a markdown file in the data directory.",
      inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
    },
    {
      name: "rename",
      description: "Rename a project (change project field on all memories).",
      inputSchema: { type: "object", properties: { project: { type: "string" }, newName: { type: "string" } }, required: ["project","newName"] },
    }
    ,
    {
      name: "backup_history",
      description: "List recent git-backed snapshots of memories.",
      inputSchema: { type: "object", properties: { limit: { type: "number" } }, required: [] },
    },
    {
      name: "backup_restore",
      description: "Preview or restore memories.json from a backup commit hash.",
      inputSchema: { type: "object", properties: { commit: { type: "string" }, confirm: { type: "boolean" } }, required: ["commit"] },
    }
    ,
    {
      name: "backup_diff",
      description: "Show semantic diff between current memories.json and a commit hash.",
      inputSchema: { type: "object", properties: { commit: { type: "string" } }, required: ["commit"] },
    }
  ],
}));

// Wire CallTool requests to handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return await handleTool(name, args || {});
});

// ── 2. Handle Tool Calls ──
/**
 * Handle a tool invocation (used by server and exported for tests).
 * @param {string} name Tool name
 * @param {object} args Tool arguments
 * @returns {Promise<object>} RPC response content
 */
async function handleTool(name, args) {
  let memories = await load();

  if (name === "remember") {
    if (!args || !args.project || !args.fact) return { content: [{ type: "text", text: "Error: both `project` and `fact` are required." }] };
    const fact = String(args.fact).trim();
    if (fact.length === 0) return { content: [{ type: "text", text: "Error: `fact` cannot be empty." }] };
    if (fact.length > MAX_FACT_LENGTH) return { content: [{ type: "text", text: `Error: fact too long (max ${MAX_FACT_LENGTH} chars).` }] };
    const project = sanitizeProject(args.project);
    if (!project) return { content: [{ type: "text", text: "Error: `project` must be lowercase alphanumeric or hyphens only." }] };

    // validate tags
    const tagCheck = validateTags(args.tags);
    if (!tagCheck.ok) return { content: [{ type: "text", text: `Error: ${tagCheck.message}` }] };

    // Conflict detection (fuzzy): check for similar facts in same project (exclude deleted/meta)
    const projectMems = memories.filter(m => m.project === project && !m.deletedAt && !m.__meta);
    const fuzzy = fuzzySearch(projectMems, fact, 1)[0];
    if (fuzzy && fuzzy.similarity > 0.85 && !args.overwrite && !args.confirm) {
      return { content: [{ type: "text", text: `Possible conflict: similar to (id: ${fuzzy.item.id}) "${fuzzy.item.fact}" (similarity ${Math.round(fuzzy.similarity*100)}%). Call remember with {project, fact, overwrite:true} to replace, or {project, fact, confirm:true} to keep both.` }] };
    }

    const scheduling = f.repeat(createEmptyCard(), new Date());
    const ratingMap = { 1: Rating.Easy, 2: Rating.Good, 3: Rating.Hard };
    const now = new Date().toISOString();
    const memory = {
      id: Date.now().toString(36),
      project,
      fact,
      tags: Array.isArray(args.tags) ? args.tags.slice(0,10) : [],
      depends_on: Array.isArray(args.depends_on) ? args.depends_on : [],
      createdAt: now,
      updatedAt: now,
      card: scheduling[ratingMap[args.difficulty || 2]].card,
      reviews: [],
    };
    // Overwrite behavior: replace the existing memory if requested
    if (args.overwrite && fuzzy && fuzzy.item && fuzzy.item.id) {
      const idx = memories.findIndex(m => m.id === fuzzy.item.id);
      if (idx !== -1) {
        memories[idx].fact = fact;
        memories[idx].card = memory.card;
        memories[idx].tags = memory.tags;
        memories[idx].depends_on = memory.depends_on;
        memories[idx].createdAt = memories[idx].createdAt || memory.createdAt;
        memories[idx].updatedAt = now;
        await save(memories);
        return { content: [{ type: "text", text: `✓ Overwrote memory ${memories[idx].id}` }] };
      }
    }
    memories.push(memory);
    await save(memories);
    return { content: [{ type: "text", text: `✓ Saved (id: ${memory.id})` }] };
  }
  if (name === "recall") {
    if (!args || !args.project) return { content: [{ type: "text", text: "Error: `project` required." }] };
    const project = sanitizeProject(args.project);
    if (!project) return { content: [{ type: "text", text: "Error: `project` must be lowercase alphanumeric or hyphens only." }] };
    const tag = args.tag;
    const projectMems = memories.filter(m => m.project === project && !m.deletedAt && !m.__meta && (!tag || (m.tags||[]).includes(tag)));

    // Auto-decay by inactivity: if project untouched for 30 days, surface all as stale
    const TOUCH_WINDOW = 30 * 86400000;
    const latestTouch = projectMems.reduce((t, m) => {
      const last = m.updatedAt || m.card?.last_review || m.createdAt || 0;
      const ts = new Date(last).getTime();
      return Math.max(t, ts);
    }, 0);
    if (projectMems.length > 0 && Date.now() - latestTouch > TOUCH_WINDOW) {
      const lines = projectMems.map(m => `[STALE] "${m.fact}" (id: ${m.id})`);
      return { content: [{ type: "text", text: `Project "${args.project}" inactive >30 days. Surface all memories as stale:\n${lines.join("\n")}` }] };
    }

    const fading = projectMems
      .map(m => ({ ...m, r: retrievability(m.card) }))
      .filter(m => m.r < 0.85).sort((a, b) => a.r - b.r).slice(0, 5);

    // orphan detection: flag dependencies that are missing or soft-deleted
    for (const m of fading) {
      m.orphaned = false;
      for (const dep of (m.depends_on || [])) {
        const depMem = memories.find(x => x.id === dep && !x.__meta);
        if (!depMem || depMem.deletedAt) {
          m.orphaned = true;
          break;
        }
      }
    }

    // session log
    try {
      const logLine = JSON.stringify({ project, timestamp: new Date().toISOString(), fading_count: fading.length, tag: tag || null });
      await fs.promises.appendFile(path.join(DATA_DIR, "session-log.jsonl"), logLine + "\n");
    } catch (e) { /* ignore logging errors */ }

    if (fading.length === 0) return { content: [{ type: "text", text: "Memory is healthy." }] };
    const lines = fading.map(m => `${m.orphaned ? '[ORPHANED] ' : ''}[${Math.round(m.r * 100)}%] "${m.fact}" (id: ${m.id})${m.orphaned ? ` — Consider updating or forgetting this memory (id: ${m.id})` : ''}`);
    return { content: [{ type: "text", text: `Fading context:\n${lines.join("\n")}` }] };
  }
  if (name === "recall_all") {
    const tag = args?.tag;
    const all = memories.filter(m => !m.deletedAt && !m.__meta && (!tag || (m.tags||[]).includes(tag))).map(m => ({ ...m, r: retrievability(m.card) }));
    const fading = all.filter(m => m.r < 0.85).sort((a,b)=>a.r-b.r).slice(0, 20);
    if (fading.length === 0) return { content: [{ type: "text", text: "All memories healthy across projects." }] };
    // orphan detection
    for (const m of fading) {
      m.orphaned = false;
      for (const dep of (m.depends_on||[])) {
        const depMem = memories.find(x => x.id === dep && !x.__meta);
        if (!depMem || depMem.deletedAt) { m.orphaned = true; break; }
      }
    }
    const lines = fading.map(m => `${m.orphaned ? '[ORPHANED] ' : ''}[${Math.round(m.r * 100)}%] [${m.project}] "${m.fact}" (id: ${m.id})${m.orphaned ? ` — Consider updating or forgetting this memory (id: ${m.id})` : ''}`);
    return { content: [{ type: "text", text: `Global fading summary:\n${lines.join("\n")}` }] };
  }

  // Bulk forget
  if (name === "bulk_forget") {
    if (!args || !Array.isArray(args.ids) || args.ids.length === 0) return { content: [{ type: "text", text: "Error: `ids` array required." }] };
    const force = !!args.force;
    // Check for dependents across the ids; abort if any dependents and not force
    const problematic = [];
    for (const id of args.ids) {
      const dependents = memories.filter(m => (m.depends_on || []).includes(id) && !m.__meta && !m.deletedAt);
      if (dependents.length > 0) problematic.push({ id, dependents: dependents.map(d => d.id) });
    }
    if (problematic.length > 0 && !force) {
      const lines = problematic.map(p => `id: ${p.id} -> dependents: [${p.dependents.join(', ')}]`);
      return { content: [{ type: "text", text: `Aborted. Some ids have dependents:\n${lines.join('\n')}` }] };
    }
    const now = new Date().toISOString();
    let deleted = 0;
    const notFound = [];
    for (const id of args.ids) {
      const idx = memories.findIndex(m => m.id === id);
      if (idx === -1) { notFound.push(id); continue; }
      // If already soft-deleted and force => permanently remove
      if (memories[idx].deletedAt && force) {
        memories.splice(idx, 1);
        deleted++;
        continue;
      }
      // Soft-delete
      if (!memories[idx].deletedAt) {
        memories[idx].deletedAt = now;
        memories[idx].updatedAt = now;
        deleted++;
      }
    }
    await save(memories);
    return { content: [{ type: "text", text: `Deleted ${deleted}/${args.ids.length} memories.${notFound.length?` Not found: [${notFound.join(', ')}]`:''}` }] };
  }

  // Bulk reviewed
  if (name === "bulk_reviewed") {
    if (!args || !Array.isArray(args.ids) || args.ids.length === 0) return { content: [{ type: "text", text: "Error: `ids` array required." }] };
    const rating = Number(args.rating);
    if (![1,2,3,4].includes(rating)) return { content: [{ type: "text", text: "Error: `rating` must be 1..4." }] };
    const ratingMap = { 1: Rating.Again, 2: Rating.Hard, 3: Rating.Good, 4: Rating.Easy };
    const now = new Date().toISOString();
    let updated = 0;
    const notFound = [];
    for (const id of args.ids) {
      const idx = memories.findIndex(m => m.id === id);
      if (idx === -1) { notFound.push(id); continue; }
      if (memories[idx].deletedAt) { notFound.push(id); continue; }
      const scheduling = f.repeat(memories[idx].card, new Date());
      memories[idx].card = scheduling[ratingMap[rating]].card;
      memories[idx].card.last_review = now;
      memories[idx].reviews = memories[idx].reviews || [];
      const health = retrievability(memories[idx].card);
      memories[idx].reviews.push({ ts: now, rating, health });
      memories[idx].updatedAt = now;
      updated++;
    }
    await save(memories);
    return { content: [{ type: "text", text: `Updated ${updated}/${args.ids.length} memories.${notFound.length?` Not found: [${notFound.join(', ')}]`:''}` }] };
  }

  if (name === "search") {
    if (!args || !args.project || !args.query) return { content: [{ type: "text", text: "Error: `project` and `query` required." }] };
    const project = sanitizeProject(args.project);
    if (!project) return { content: [{ type: "text", text: "Error: `project` must be lowercase alphanumeric or hyphens only." }] };
    const projectMems = memories.filter(m => m.project === project && !m.deletedAt && !m.__meta);
    const results = searchMemories(projectMems, args.query).slice(0, 5);
    const lines = results.map(m => `"${m.fact}" (id: ${m.id})`);
    return { content: [{ type: "text", text: `Results for "${args.query}":\n${lines.join("\n")}` }] };
  }

  if (name === "reviewed") {
    if (!args || !args.id) return { content: [{ type: "text", text: "Error: `id` required." }] };
    if (![1,2,3,4].includes(Number(args.rating))) return { content: [{ type: "text", text: "Error: `rating` must be an integer 1..4." }] };
    const idx = memories.findIndex(m => m.id === args.id);
    if (idx === -1) return { content: [{ type: "text", text: "Not found." }] };
    if (memories[idx].deletedAt) return { content: [{ type: "text", text: "Cannot review a deleted memory. Restore it first." }] };
    const ratingMap = { 1: Rating.Again, 2: Rating.Hard, 3: Rating.Good, 4: Rating.Easy };
    const scheduling = f.repeat(memories[idx].card, new Date());
    memories[idx].card = scheduling[ratingMap[args.rating || 3]].card;
    // Ensure last_review is present for retrievability calculations
    memories[idx].card.last_review = new Date().toISOString();
    // review history + health trend
    memories[idx].reviews = memories[idx].reviews || [];
    const health = retrievability(memories[idx].card);
    memories[idx].reviews.push({ ts: new Date().toISOString(), rating: Number(args.rating), health });
    // flag repeat forgetting
    const last3 = memories[idx].reviews.slice(-3).map(r=>r.rating);
    if (last3.length === 3 && last3.every(r=>r<=2)) memories[idx].needs_rewrite = true;
    memories[idx].updatedAt = new Date().toISOString();
    await save(memories);
    return { content: [{ type: "text", text: "✓ Updated." }] };
  }

  if (name === "forget") {
    if (!args || !args.id) return { content: [{ type: "text", text: "Error: `id` required." }] };
    const idx = memories.findIndex(m => m.id === args.id);
    if (idx === -1) return { content: [{ type: "text", text: "Not found." }] };
    const dependents = memories.filter(m => (m.depends_on||[]).includes(args.id) && !m.__meta && !m.deletedAt);
    if (dependents.length > 0 && !args.force) {
      const ids = dependents.map(d => d.id).slice(0,5).join(", ");
      return { content: [{ type: "text", text: `Memory ${args.id} has ${dependents.length} dependent(s): ${ids}. Call forget with {id: "${args.id}", force:true} to delete and orphan dependents.` }] };
    }
    const now = new Date().toISOString();
    // If already soft-deleted and force => permanently remove
    if (memories[idx].deletedAt && args.force) {
      memories.splice(idx, 1);
      await save(memories);
      return { content: [{ type: "text", text: "✓ Permanently deleted." }] };
    }
    // Soft-delete
    memories[idx].deletedAt = now;
    memories[idx].updatedAt = now;
    await save(memories);
    return { content: [{ type: "text", text: "✓ Soft-deleted (in trash)." }] };
  }

  if (name === "list") {
    if (!args || !args.project) return { content: [{ type: "text", text: "Error: `project` required." }] };
    const project = sanitizeProject(args.project);
    if (!project) return { content: [{ type: "text", text: "Error: `project` must be lowercase alphanumeric or hyphens only." }] };
    const page = args.page || 1;
    const limit = args.limit || 20;
    const projectMems = memories.filter(m => m.project === project && !m.deletedAt && !m.__meta);
    if (projectMems.length === 0) return { content: [{ type: "text", text: `No memories found for project "${args.project}".` }] };
    const listing = paginate(projectMems, page, limit);
    const lines = listing.results.map(m => `[${Math.round(retrievability(m.card) * 100)}%] ${m.fact} (id: ${m.id})`);
    const header = `Memories for ${args.project} (page ${listing.page}/${listing.totalPages}, total: ${listing.total}):\n`;
    return { content: [{ type: "text", text: header + lines.join("\n") }] };
  }

  if (name === "restore") {
    if (!args || !args.id) return { content: [{ type: "text", text: "Error: `id` required." }] };
    const idx = memories.findIndex(m => m.id === args.id);
    if (idx === -1) return { content: [{ type: "text", text: "Not found." }] };
    if (!memories[idx].deletedAt) return { content: [{ type: "text", text: "Memory is not deleted." }] };
    delete memories[idx].deletedAt;
    memories[idx].updatedAt = new Date().toISOString();
    await save(memories);
    return { content: [{ type: "text", text: `✓ Restored ${args.id}` }] };
  }

  if (name === "purge") {
    // Permanently remove memories trashed older than 30 days
    const cutoff = Date.now() - (30 * 86400000);
    const before = memories.length;
    memories = memories.filter(m => !(m.deletedAt && new Date(m.deletedAt).getTime() < cutoff));
    const after = memories.length;
    await save(memories);
    return { content: [{ type: "text", text: `Purged ${before - after} memories from trash.` }] };
  }

  if (name === "stats") {
    const project = args?.project ? sanitizeProject(args.project) : null;
    if (args?.project && !project) return { content: [{ type: "text", text: "Error: `project` must be lowercase alphanumeric or hyphens only." }] };
    const pool = memories.filter(m => !m.deletedAt && !m.__meta && (!project || m.project === project));
    const total = pool.length;
    const healths = pool.map(m => retrievability(m.card));
    const avgHealth = healths.length ? Math.round((healths.reduce((a,b)=>a+b,0)/healths.length)*100) : 100;
    const below = pool.filter(m => retrievability(m.card) < 0.85).length;
    let mostRecent = null;
    let reviewsCount = 0;
    for (const m of pool) {
      if (Array.isArray(m.reviews) && m.reviews.length) {
        reviewsCount += m.reviews.length;
        const last = m.reviews[m.reviews.length-1].ts;
        if (!mostRecent || new Date(last) > new Date(mostRecent)) mostRecent = last;
      }
      if (m.card?.last_review) {
        if (!mostRecent || new Date(m.card.last_review) > new Date(mostRecent)) mostRecent = m.card.last_review;
      }
    }
    const payload = `total: ${total}\navg_health: ${avgHealth}%\nbelow_85: ${below}\nmost_recent_review: ${mostRecent || 'n/a'}\ntotal_reviews: ${reviewsCount}`;
    return { content: [{ type: "text", text: payload }] };
  }

  if (name === "summarize") {
    if (!args || !args.project) return { content: [{ type: "text", text: "Error: `project` required." }] };
    const project = sanitizeProject(args.project);
    if (!project) return { content: [{ type: "text", text: "Error: `project` must be lowercase alphanumeric or hyphens only." }] };
    const force = !!args.force;
    let projectMems = memories.filter(m => m.project === project && !m.deletedAt && !m.__meta);
    if (projectMems.length === 0) return { content: [{ type: "text", text: `No memories for ${args.project}` }] };

    // Check cache meta
    const summaryMeta = memories.find(m => m.__meta && m.metaType === 'summary' && m.project === project);
    const latestUpdate = getLatestUpdatedAt(projectMems);
    if (summaryMeta && !force && summaryMeta.summarizedAt && latestUpdate && new Date(summaryMeta.summarizedAt) >= new Date(latestUpdate)) {
      return { content: [{ type: "text", text: `${summaryMeta.summary} [cached]` }] };
    }

    try {
      const llm = require("./llm.js");
      const text = await llm.summarizeProject(projectMems);
      // remove old summary meta for project
      memories = memories.filter(m => !(m.__meta && m.metaType === 'summary' && m.project === project));
      const meta = {
        id: `__summary:${project}`,
        __meta: true,
        metaType: 'summary',
        project,
        summary: text,
        summarizedAt: new Date().toISOString(),
        lastUpdatedAt: latestUpdate,
      };
      memories.push(meta);
      await save(memories);
      return { content: [{ type: "text", text: text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Summarize failed: ${e.message}` }] };
    }
  }

  if (name === "export") {
    if (!args || !args.project) return { content: [{ type: "text", text: "Error: `project` required." }] };
    const project = sanitizeProject(args.project);
    if (!project) return { content: [{ type: "text", text: "Error: `project` must be lowercase alphanumeric or hyphens only." }] };
    const projectMems = memories.filter(m => m.project === project && !m.deletedAt && !m.__meta);
    if (projectMems.length === 0) return { content: [{ type: "text", text: `No memories for ${args.project}` }] };
    const md = [`# Memories for ${args.project}`, ""]; 
    projectMems.forEach(m => md.push(`- [${Math.round(retrievability(m.card)*100)}%] ${m.fact} (id: ${m.id})`));
    const filename = `export-${project}-${Date.now()}.md`;
    const outPath = path.join(DATA_DIR, filename);
    await fs.promises.writeFile(outPath, md.join("\n"), "utf-8");
    return { content: [{ type: "text", text: `Exported to ${outPath}` }] };
  }

  if (name === 'backup_history') {
    const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10));
    try {
      const storage = require('./storage.js');
      const items = await storage.getBackupHistory(limit);
      if (!items || items.length === 0) return { content: [{ type: 'text', text: 'No backups found or git not available.' }] };
      const lines = items.map((it, i) => `${i+1}. ${it.message} (${it.hash})`);
      return { content: [{ type: 'text', text: `Recent backups:\n${lines.join('\n')}` }] };
    } catch (e) { return { content: [{ type: 'text', text: `Backup history failed: ${e.message}` }] }; }
  }

  if (name === 'backup_restore') {
    if (!args || !args.commit) return { content: [{ type: 'text', text: 'Error: `commit` required.' }] };
    const commit = String(args.commit).trim();
    if (!/^[0-9a-fA-F]+$/.test(commit)) return { content: [{ type: 'text', text: 'Error: invalid commit hash.' }] };
    const storage = require('./storage.js');
    const preview = await storage.previewCommit(commit);
    if (!preview) return { content: [{ type: 'text', text: 'Could not find commit or git not available.' }] };
    if (!args.confirm) {
      return { content: [{ type: 'text', text: `This will restore ${preview.count} memories from commit ${commit} (${preview.timestamp || 'unknown'}). Call backup_restore with {commit: '${commit}', confirm: true} to proceed.` }] };
    }
    const res = await storage.restoreFromCommit(commit);
    if (!res) return { content: [{ type: 'text', text: 'Restore failed.' }] };
    return { content: [{ type: 'text', text: `Restored ${res.restoredCount} memories from ${commit}` }] };
  }

  if (name === 'backup_diff') {
    if (!args || !args.commit) return { content: [{ type: 'text', text: 'Error: `commit` required.' }] };
    const commit = String(args.commit).trim();
    if (!/^[0-9a-fA-F]+$/.test(commit)) return { content: [{ type: 'text', text: 'Error: invalid commit hash.' }] };
    const storage = require('./storage.js');
    const old = await storage.getFileAtCommit(commit);
    if (!old) return { content: [{ type: 'text', text: 'Could not load memories at that commit (git missing or commit not found).' }] };
    const current = memories.filter(m => !m.__meta);
    const engine = require('./engine.js');
    const diff = engine.calculateDiff(old, current);
    const parts = [];
    parts.push(`Added: ${diff.added.length}`);
    diff.added.slice(0,20).forEach(a => parts.push(`+ ${a.id}: ${a.fact}`));
    parts.push(`Removed: ${diff.removed.length}`);
    diff.removed.slice(0,20).forEach(r => parts.push(`- ${r.id}: ${r.fact}`));
    parts.push(`Changed: ${diff.changed.length}`);
    diff.changed.slice(0,20).forEach(c => parts.push(`~ ${c.id}: "${c.oldFact}" -> "${c.newFact}"`));
    if (diff.added.length + diff.removed.length + diff.changed.length === 0) parts.push('No semantic differences found.');
    return { content: [{ type: 'text', text: parts.join('\n') }] };
  }

  if (name === "rename") {
    if (!args || !args.project || !args.newName) return { content: [{ type: "text", text: "Error: `project` and `newName` required." }] };
    const oldName = sanitizeProject(args.project);
    const newName = sanitizeProject(args.newName);
    if (!oldName || !newName) return { content: [{ type: "text", text: "Error: project names must be lowercase alphanumeric or hyphens only." }] };
    let count = 0;
    memories.forEach(m => { if (m.project === oldName) { m.project = newName; m.updatedAt = new Date().toISOString(); count++; } });
    await save(memories);
    return { content: [{ type: "text", text: `Renamed ${count} memories from ${oldName} → ${newName}` }] };
  }

  return { content: [{ type: "text", text: "Unknown tool" }] };

}

// ── 3. CLI Dashboard & Main ──
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "status") {
    const memories = await load();
    const pool = memories.filter(m => !m.deletedAt && !m.__meta);
    const total = pool.length;
    const projects = Array.from(new Set(pool.map(m => m.project)));
    const healths = pool.map(m => retrievability(m.card));
    const avgHealth = healths.length ? Math.round((healths.reduce((a,b)=>a+b,0)/healths.length)*100) : 100;
    console.log(`\n🧠 Memory Health Dashboard — total: ${total}, projects: ${projects.length}, avg: ${avgHealth}%`);
    // Group by project
    for (const p of projects.sort()) {
      console.log(`\nProject: ${p}`);
      const pm = pool.filter(m => m.project === p);
      for (const m of pm) {
        const h = Math.round(retrievability(m.card) * 100);
        let sym = '✅'; let color = chalk.green;
        if (h < 50) { sym = '❌'; color = chalk.red; }
        else if (h < 85) { sym = '⚠️'; color = chalk.yellow; }
        const txt = `${sym} [${h}%] ${m.fact.substring(0,60)} (${m.id})`;
        console.log(color(txt));
      }
    }
    process.exit(0);
  }

  if (args[0] === 'forget' && args[1]) {
    const id = args[1];
    const force = args.includes('--force');
    const resp = await handleTool('forget', { id, force });
    console.log(resp.content[0].text);
    process.exit(0);
  }

  if (args[0] === 'stats') {
    const project = args[1];
    const resp = await handleTool('stats', project ? { project } : {});
    console.log(resp.content[0].text);
    process.exit(0);
  }

  if (args[0] === 'backup') {
    const storage = require('./storage.js');
    const items = await storage.getBackupHistory(10);
    const count = await storage.getCommitCount();
    const size = fs.existsSync(path.join(DATA_DIR, 'memories.json')) ? (await fs.promises.stat(path.join(DATA_DIR, 'memories.json'))).size : 0;
    if (!items || items.length === 0) {
      console.log('No backups found or git not available.');
      process.exit(0);
    }
    console.log('Recent backups:');
    items.forEach((it, i) => console.log(`${i+1}. ${it.message} (${it.hash})`));
    console.log(`\nTotal commits: ${count || 'unknown'}`);
    console.log(`memories.json size: ${size} bytes`);
    process.exit(0);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module && process.argv[1] && process.argv[1].endsWith('index.js')) {
  main().catch(console.error);
}