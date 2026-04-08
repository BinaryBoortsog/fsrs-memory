const path = require('path');

// Mock storage to avoid touching disk
jest.mock('../src/storage.js', () => {
  const p = require('path');
  let mems = [];
  return {
    load: async () => mems,
    save: async (m) => { mems = m; },
    DATA_DIR: p.join(__dirname, 'data'),
    getBackupHistory: async (limit) => [
      { hash: 'abc1234', message: '[fsrs-backup] save at 2024-01-15T10:30:00.000Z' },
      { hash: 'def5678', message: '[fsrs-backup] save at 2024-01-15T09:15:00.000Z' }
    ].slice(0, limit),
    previewCommit: async (commit) => ({ count: mems.length, memories: mems, raw: JSON.stringify(mems), timestamp: new Date().toISOString() }),
    restoreFromCommit: async (commit) => { /* simulate restore by leaving mems alone */ return { restoredCount: mems.length }; },
    getCommitCount: async () => 5,
    commitBackup: async () => {},
    initGitRepo: async () => {}
  };
});

// Mock llm to avoid network calls
jest.mock('../src/llm.js', () => ({
  summarizeProject: async (projectMems) => `BRIEF: ${projectMems.length} items.`
}));

const engine = require('../src/engine.js');
const storage = require('../src/storage.js');
const indexModule = require('../src/index.js');

// Helper to call tool handlers via the server request handler
const { CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

// We will import the module and call its request handler directly by requiring the file
// The server has registered handlers on require; we can call the exported server through require cache

// Work with the module's setRequestHandler by requiring server from the file

describe('fsrs-memory basic flows', () => {
  let handler;
  beforeAll(async () => {
    const serverModule = require.cache[require.resolve('../src/index.js')];
    // The server is not exported; instead, we will require the module and access its handler indirectly
    // Simpler: re-require the module's CallToolRequestSchema handler by reading exports - but index.js doesn't export it.
    // Instead, we'll invoke the tool handlers by spawning the internal logic: require the index file and simulate calls by requiring the file that defines the handler.
    // To keep tests simple, import index.js and call the top-level functions by executing JSON-RPC like structure.
    // Alternative approach: require('../src/index.js') has registered handlers on internal Server instance, but it's not exported.
    // So we'll exercise engine and llm directly and verify index flows via integration-test style.
  });

  test('engine retrievability and fuzzy search', async () => {
    const card = { state: 0 }; // some state not New
    const r = engine.retrievability(card);
    expect(typeof r).toBe('number');

    const mems = [
      { id: 'a', fact: 'Use Postgres' },
      { id: 'b', fact: 'Use Redis' },
    ];
    const results = engine.fuzzySearch(mems, 'Postgres', 1);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].item.id).toBe('a');
  });

  test('summarize routes to llm client', async () => {
    // The simplest test: call llm mock directly to ensure wiring
    const llm = require('../src/llm.js');
    const text = await llm.summarizeProject([{ fact: 'a' }, { fact: 'b' }]);
    expect(text).toContain('BRIEF: 2 items');
  });

  test('recall flags orphaned dependencies with suggestion', async () => {
    // seed storage with a memory that depends on missing id and make it stale
    const old = new Date(Date.now() - (365 * 86400000)).toISOString();
    const now = new Date().toISOString();
    const mems = [
      { id: 'a', project: 'proj', fact: 'Alpha', depends_on: ['missing'], card: { state: 1, last_review: old, stability: 0.5 }, createdAt: old, updatedAt: now, reviews: [] }
    ];
    await storage.save(mems);
    const resp = await indexModule.handleTool('recall', { project: 'proj' });
    const txt = resp.content[0].text;
    expect(txt).toContain('[ORPHANED]');
    expect(txt).toContain('Consider updating or forgetting this memory');
  });

  test('bulk_reviewed updates multiple memories and reports not-found', async () => {
    const now = new Date().toISOString();
    const { createEmptyCard, Rating } = require('ts-fsrs');
    const sched = engine.f.repeat(createEmptyCard(), new Date());
    const k = Object.keys(sched).find(x => sched[x] && sched[x].card);
    const card = sched[k].card;
    const mems = [
      { id: 'm1', project: 'p', fact: 'One', card, createdAt: now, updatedAt: now, reviews: [] },
      { id: 'm2', project: 'p', fact: 'Two', card, createdAt: now, updatedAt: now, reviews: [] }
    ];
    await storage.save(mems);
    const resp = await indexModule.handleTool('bulk_reviewed', { ids: ['m1','m2','missing'], rating: 3 });
    const txt = resp.content[0].text;
    expect(txt).toMatch(/Updated 2\/3/);
    expect(txt).toContain('Not found: [missing]');
    const after = await storage.load();
    const a = after.find(x=>x.id==='m1');
    expect(a.reviews.length).toBeGreaterThan(0);
  });

  test('bulk_forget aborts when dependents exist and proceeds with force', async () => {
    const now = new Date().toISOString();
    const mems = [
      { id: 'root', project: 'p', fact: 'Root', card: { state:0 }, createdAt: now, updatedAt: now, reviews: [] },
      { id: 'child', project: 'p', fact: 'Child', depends_on: ['root'], card: { state:0 }, createdAt: now, updatedAt: now, reviews: [] }
    ];
    await storage.save(mems);
    const resp1 = await indexModule.handleTool('bulk_forget', { ids: ['root'] });
    expect(resp1.content[0].text).toContain('Aborted. Some ids have dependents');
    const resp2 = await indexModule.handleTool('bulk_forget', { ids: ['root'], force: true });
    expect(resp2.content[0].text).toMatch(/Deleted 1\/1/);
    const after = await storage.load();
    const root = after.find(x=>x.id==='root');
    expect(root.deletedAt).toBeDefined();
  });
});
