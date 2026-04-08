const { forgetting_curve, FSRS5_DEFAULT_DECAY, fsrs, generatorParameters, State } = require("ts-fsrs");
const Fuse = require("fuse.js");

const f = fsrs(generatorParameters({ enable_fuzz: false }));

function retrievability(card) {
  // New cards are considered fully retrievable until their first review
  if (!card) return 1.0;
  if (card.state === State.New) return 1.0;
  if (!card.last_review) return 1.0;
  const elapsed = (Date.now() - new Date(card.last_review).getTime()) / 86400000;
  const stability = card.stability || 1;
  return forgetting_curve(FSRS5_DEFAULT_DECAY, elapsed, stability);
}

function searchMemories(memories, query) {
  const fuse = new Fuse(memories, {
    keys: ["fact"],
    threshold: 0.4,
  });
  return fuse.search(query).map(r => r.item);
}

// Returns array of {item, score (0..1), similarity (1-score)} sorted best-first
function fuzzySearch(memories, query, limit = 5) {
  const fuse = new Fuse(memories, { keys: ["fact"], includeScore: true, threshold: 1 });
  const results = fuse.search(query, { limit });
  return results.map(r => ({ item: r.item, score: r.score ?? 1, similarity: 1 - (r.score ?? 1) }));
}

/**
 * Calculate semantic diff between two arrays of memories.
 * Returns { added: [], removed: [], changed: [{id, oldFact, newFact}] }
 * @param {Array} oldMems
 * @param {Array} newMems
 * @returns {{added:Array,removed:Array,changed:Array}}
 */
function calculateDiff(oldMems = [], newMems = []) {
  const oldMap = new Map((oldMems || []).map(m => [m.id, m]));
  const newMap = new Map((newMems || []).map(m => [m.id, m]));
  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, nm] of newMap.entries()) {
    if (!oldMap.has(id)) {
      added.push(nm);
    } else {
      const om = oldMap.get(id);
      if ((om.fact || '').trim() !== (nm.fact || '').trim()) {
        changed.push({ id, oldFact: om.fact || '', newFact: nm.fact || '' });
      }
    }
  }

  for (const [id, om] of oldMap.entries()) {
    if (!newMap.has(id)) removed.push(om);
  }

  return { added, removed, changed };
}

module.exports = { f, retrievability, searchMemories, fuzzySearch, calculateDiff };