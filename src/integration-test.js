const { load, save, DATA_DIR } = require("./storage.js");
const { f, retrievability } = require("./engine.js");
const { createEmptyCard, Rating } = require("ts-fsrs");

async function run() {
  console.log("Integration test started");
  const memories = await load();

  // Create a memory (remember)
  const scheduling = f.repeat(createEmptyCard(), new Date());
  const memory = {
    id: Date.now().toString(36),
    project: "integ-test",
    fact: "We use integration-test flow",
    tags: ["test"],
    createdAt: new Date().toISOString(),
    card: scheduling[Rating.Good].card,
    reviews: [],
  };
  memories.push(memory);
  await save(memories);
  console.log(`Saved memory id=${memory.id}`);

  // Load and recall
  const after = await load();
  const proj = after.filter(m=>m.project==="integ-test");
  console.log(`Found ${proj.length} memories for integ-test`);
  proj.forEach(m=>{
    const r = retrievability(m.card);
    console.log(`- [${Math.round(r*100)}%] ${m.fact} (id:${m.id})`);
  });

  // Review the created memory
  const idx = after.findIndex(m=>m.id===memory.id);
  if (idx !== -1) {
    const sched = f.repeat(after[idx].card, new Date());
    after[idx].card = sched[Rating.Easy].card;
    after[idx].card.last_review = new Date().toISOString();
    after[idx].reviews = after[idx].reviews || [];
    after[idx].reviews.push({ ts: new Date().toISOString(), rating: 4, health: retrievability(after[idx].card) });
    await save(after);
    console.log(`Reviewed memory ${after[idx].id}, new health ${Math.round(retrievability(after[idx].card)*100)}%`);
  }

  console.log("Integration test completed");
}

run().catch(err=>{ console.error("Integration test failed:", err); process.exit(1); });
