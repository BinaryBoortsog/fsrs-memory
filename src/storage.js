const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require('child_process');

const DATA_DIR = path.join(os.homedir(), ".fsrs-memory");
const DATA_FILE = path.join(DATA_DIR, "memories.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Simple in-memory cache to avoid frequent disk reads. Invalidated on save().
let memoryCache = null;

async function load() {
  if (memoryCache) return memoryCache;
  try {
    if (!fs.existsSync(DATA_FILE)) {
      memoryCache = [];
      return memoryCache;
    }
    const body = await fs.promises.readFile(DATA_FILE, "utf-8");
    memoryCache = JSON.parse(body || "[]");
    return memoryCache;
  } catch (e) {
    memoryCache = [];
    return memoryCache;
  }
}

/*
 * Initialize git repo in DATA_DIR if not already initialized.
 * Non-blocking; logs warnings if git is not available.
 */
async function initGitRepo() {
  try {
    const gitDir = path.join(DATA_DIR, '.git');
    if (fs.existsSync(gitDir)) return; // already a repo
    // run git init
    execFile('git', ['init'], { cwd: DATA_DIR }, (err) => {
      if (err) { console.warn('git not available or init failed:', err.message); return; }
      // add and commit initial
      execFile('git', ['add', '-A'], { cwd: DATA_DIR }, () => {
        const msg = `[fsrs-backup] init at ${new Date().toISOString()}`;
        execFile('git', ['commit', '-m', msg], { cwd: DATA_DIR }, () => {});
      });
    });
  } catch (e) {
    console.warn('git init error:', e.message);
  }
}

/**
 * Create an asynchronous git commit for backups. Non-blocking; logs errors.
 * @param {string} action
 */
function commitBackup(action = 'save') {
  const ts = new Date().toISOString();
  const msg = `[fsrs-backup] ${action} at ${ts}`;
  try {
    execFile('git', ['add', '-A'], { cwd: DATA_DIR }, (err) => {
      if (err) { console.warn('git add failed:', err.message); return; }
      execFile('git', ['commit', '-m', msg], { cwd: DATA_DIR }, (e, stdout, stderr) => {
        if (e) {
          // likely nothing to commit or other issue
          // don't treat as fatal
          console.warn('git commit error:', e && e.message ? e.message : stderr);
        }
      });
    });
  } catch (e) {
    console.warn('git commit error:', e.message);
  }
}

/**
 * Get recent git backup history (array of {hash,message}).
 * @param {number} limit
 * @returns {Promise<Array<{hash:string,message:string}>>}
 */
function getBackupHistory(limit = 10) {
  return new Promise((resolve) => {
    try {
      execFile('git', ['log', '--pretty=format:%h%x09%s', '-n', String(limit)], { cwd: DATA_DIR }, (err, stdout) => {
        if (err) return resolve([]);
        const lines = String(stdout || '').trim().split('\n').filter(Boolean);
        const items = lines.map(l => {
          const [h, ...rest] = l.split('\t');
          return { hash: h, message: rest.join('\t') };
        });
        resolve(items);
      });
    } catch (e) { resolve([]); }
  });
}

/**
 * Preview the memories.json content at a specific commit.
 * @param {string} commit
 * @returns {Promise<{count:number, memories:Array, raw:string, timestamp?:string}|null>}
 */
function previewCommit(commit) {
  return new Promise((resolve) => {
    if (!/^[0-9a-fA-F]+$/.test(commit)) return resolve(null);
    try {
      execFile('git', ['show', `${commit}:memories.json`], { cwd: DATA_DIR }, (err, stdout) => {
        if (err) return resolve(null);
        const raw = String(stdout || '');
        try {
          const parsed = JSON.parse(raw || '[]');
          // get commit date
          execFile('git', ['show', '-s', '--format=%cI', commit], { cwd: DATA_DIR }, (e, out) => {
            const ts = e ? undefined : String(out || '').trim();
            resolve({ count: Array.isArray(parsed) ? parsed.length : 0, memories: parsed, raw, timestamp: ts });
          });
        } catch (e) { resolve({ count: 0, memories: [], raw }); }
      });
    } catch (e) { resolve(null); }
  });
}

/**
 * Get the parsed memories.json content at a specific commit hash.
 * Uses `git show {hash}:memories.json` and returns parsed JSON or null.
 * @param {string} hash
 * @returns {Promise<Array|null>}
 */
function getFileAtCommit(hash) {
  return new Promise((resolve) => {
    if (!hash || typeof hash !== 'string' || !/^[0-9a-fA-F]+$/.test(hash)) return resolve(null);
    try {
      execFile('git', ['show', `${hash}:memories.json`], { cwd: DATA_DIR }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const parsed = JSON.parse(String(stdout || ''));
          return resolve(Array.isArray(parsed) ? parsed : null);
        } catch (e) { return resolve(null); }
      });
    } catch (e) { return resolve(null); }
  });
}

/**
 * Restore memories.json from commit and reload cache. Commits the restore.
 * @param {string} commit
 * @returns {Promise<{restoredCount:number}|null>}
 */
async function restoreFromCommit(commit) {
  if (!/^[0-9a-fA-F]+$/.test(commit)) return null;
  try {
    const preview = await previewCommit(commit);
    if (!preview) return null;
    // overwrite file
    await fs.promises.writeFile(DATA_FILE, preview.raw || '[]', 'utf-8');
    memoryCache = preview.memories || [];
    // async commit restored state
    setImmediate(() => commitBackup(`restored from ${commit}`));
    return { restoredCount: (preview.memories || []).length };
  } catch (e) {
    return null;
  }
}

/**
 * Get total commit count
 * @returns {Promise<number|null>}
 */
function getCommitCount() {
  return new Promise((resolve) => {
    try {
      execFile('git', ['rev-list', '--count', 'HEAD'], { cwd: DATA_DIR }, (err, stdout) => {
        if (err) return resolve(null);
        const n = parseInt(String(stdout || '').trim(), 10);
        resolve(isNaN(n) ? null : n);
      });
    } catch (e) { resolve(null); }
  });
}

// Try to initialize git repo on load (non-blocking)
initGitRepo();

async function save(memories) {
  memoryCache = memories;
  const tempFile = `${DATA_FILE}.tmp`;
  await fs.promises.writeFile(tempFile, JSON.stringify(memories, null, 2));
  await fs.promises.rename(tempFile, DATA_FILE);
  // fire-and-forget backup commit
  try { setImmediate(() => commitBackup('save')); } catch (e) { /* ignore */ }
}

module.exports = { load, save, DATA_DIR, initGitRepo, commitBackup, getBackupHistory, previewCommit, restoreFromCommit, getCommitCount };
