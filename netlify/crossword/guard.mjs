// Who may use the crossword, and how much.
//
// Every AI-backed crossword call costs real money, and these functions sit
// at public URLs, so the limits live here on the server (the page only
// displays them):
//
//   - Sign-in: the caller must send the GitHub token they signed into the
//     CMS with, and that account must be able to push to the site's repo.
//     Strangers can't spend the credit or burn Leanne's allowance.
//   - Weekly allowance (resets Monday, NZ time): a few new puzzles and a
//     batch of single-clue rewrites. A puzzle that never got any clues
//     (every batch failed, or the page was closed) is refunded.
//   - Each clue batch must belong to a puzzle issued in the last 30
//     minutes, so clue writing can't be called outside that allowance.
//
// Change the allowance without a code change by setting these Netlify
// environment variables: CROSSWORD_WEEKLY_PUZZLES, CROSSWORD_WEEKLY_REWRITES,
// CROSSWORD_EXEMPT_LOGINS (comma-separated GitHub logins that aren't
// counted — the site owner, for testing).

import { getStore } from "@netlify/blobs";

const REPO = "Corbynmiler/pctimes-site";
const TZ = "Pacific/Auckland";
const PUZZLE_TTL_MS = 30 * 60 * 1000;

const envInt = (name, fallback) => {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
export const LIMITS = {
  puzzles: envInt("CROSSWORD_WEEKLY_PUZZLES", 2),
  rewrites: envInt("CROSSWORD_WEEKLY_REWRITES", 20),
};
const EXEMPT = new Set((process.env.CROSSWORD_EXEMPT_LOGINS ?? "Corbynmiler")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

// ─── Test hooks (never used in production) ────────────────────────────
let storeOverride = null;
let githubOverride = null;
export function setGuardForTests({ store, github } = {}) {
  storeOverride = store || null;
  githubOverride = github || null;
  authCache.clear();
}
function store() {
  return storeOverride || getStore({ name: "crossword", consistency: "strong" });
}

export function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// ─── Sign-in ───────────────────────────────────────────────────────────
const authCache = new Map(); // sha256(token) → { login, until }

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(buf).toString("hex");
}

async function askGitHub(token) {
  if (githubOverride) return githubOverride(token);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pctimes-crossword",
  };
  const [user, repo] = await Promise.all([
    fetch("https://api.github.com/user", { headers }),
    fetch(`https://api.github.com/repos/${REPO}`, { headers }),
  ]);
  if (user.status === 401 || repo.status === 401) return { status: 401 };
  if (!user.ok || !repo.ok) return { status: 403 };
  const u = await user.json();
  const r = await repo.json();
  return { status: r.permissions && r.permissions.push ? 200 : 403, login: u.login };
}

// Returns { editor: { login, exempt } } or { response } to send back.
export async function requireEditor(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "");
  if (!m) {
    return { response: jsonResponse(401, { error: "Please sign in to the CMS first, then come back to this page.", code: "signin" }) };
  }
  const token = m[1].trim();
  const key = await sha256(token);
  const hit = authCache.get(key);
  let login = hit && hit.until > Date.now() ? hit.login : null;
  if (!login) {
    let result;
    try {
      result = await askGitHub(token);
    } catch {
      return { response: jsonResponse(503, { error: "Couldn't check your sign-in just now. Try again in a minute." }) };
    }
    if (result.status === 401) {
      return { response: jsonResponse(401, { error: "Your CMS sign-in has expired. Open the CMS, sign in again, then come back.", code: "signin" }) };
    }
    if (result.status !== 200) {
      return { response: jsonResponse(403, { error: "This account isn't allowed to make crosswords.", code: "forbidden" }) };
    }
    login = result.login;
    authCache.set(key, { login, until: Date.now() + 10 * 60 * 1000 });
  }
  return { editor: { login, exempt: EXEMPT.has(String(login).toLowerCase()) } };
}

// ─── Weekly allowance ──────────────────────────────────────────────────
// The Monday (NZ time) that starts the current week, as YYYY-MM-DD.
export function weekStart(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(now).map((x) => [x.type, x.value]));
  const back = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[p.weekday];
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day - back));
  return d.toISOString().slice(0, 10);
}

// Read-modify-write that can't lose an update to a parallel request:
// the write only lands if nobody else changed the entry since we read it.
// Parallel requests (several ↻ clicks, or a puzzle's clue batches) retry
// with a short random back-off so they stagger instead of colliding again.
async function update(key, change) {
  const st = store();
  for (let attempt = 0; attempt < 15; attempt++) {
    const cur = await st.getWithMetadata(key, { type: "json" });
    const next = change(cur ? cur.data : null);
    const opts = cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true };
    const res = await st.setJSON(key, next, opts);
    if (res && res.modified) return next;
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 60 * (attempt + 1)));
  }
  throw new Error("The crossword is busy. Try again in a moment.");
}

const usageKey = () => `usage/${weekStart()}`;
const emptyUsage = () => ({ puzzles: 0, rewrites: 0, last_puzzle: null });

// A puzzle that never got a single clue written shouldn't use up an
// allowance. It's refunded straight away when the page reports every
// batch failed (releasePuzzle), when a new puzzle replaces it, or — for a
// page closed mid-way — once its 30-minute clue window has passed.
async function lastPuzzleWasWasted(usage, { replacing = false } = {}) {
  if (!usage || !usage.last_puzzle) return false;
  const st = store();
  if (await st.get(`puzzle/${usage.last_puzzle}/ok`)) return false;
  if (replacing) return true;
  const puzzle = await st.get(`puzzle/${usage.last_puzzle}`, { type: "json" });
  return !puzzle || Date.now() - puzzle.created > PUZZLE_TTL_MS;
}

function describe(usage, editor) {
  const u = usage || emptyUsage();
  return {
    puzzles_used: u.puzzles, puzzles_limit: LIMITS.puzzles,
    rewrites_used: u.rewrites, rewrites_limit: LIMITS.rewrites,
    resets: "Monday",
    exempt: !!(editor && editor.exempt),
  };
}

export async function getQuota(editor) {
  const u = (await store().get(usageKey(), { type: "json" })) || emptyUsage();
  const shown = { ...u };
  if (await lastPuzzleWasWasted(u)) shown.puzzles = Math.max(0, u.puzzles - 1);
  return describe(shown, editor);
}

// Claim one new puzzle for this week, under id `puzzleId`.
export async function claimPuzzle(editor, puzzleId, answers) {
  const st = store();
  const key = usageKey();
  if (!editor.exempt) {
    const before = await st.get(key, { type: "json" });
    const wasted = (await lastPuzzleWasWasted(before, { replacing: true })) ? before.last_puzzle : null;
    let allowed = false;
    const after = await update(key, (u) => {
      const next = { ...emptyUsage(), ...(u || {}) };
      if (wasted && next.last_puzzle === wasted) { next.puzzles = Math.max(0, next.puzzles - 1); next.last_puzzle = null; }
      allowed = next.puzzles < LIMITS.puzzles;
      if (allowed) { next.puzzles += 1; next.last_puzzle = puzzleId; }
      return next;
    });
    if (!allowed) return { allowed: false, quota: describe(after, editor) };
  }
  await st.setJSON(`puzzle/${puzzleId}`, { answers, created: Date.now() });
  return { allowed: true, quota: await getQuota(editor) };
}

// Check a clue batch belongs to a live puzzle, and cap batches per puzzle
// (the page sends ~4 answers per batch and retries a failed one once).
export async function checkBatch(puzzleId, answers) {
  if (!/^[a-f0-9-]{36}$/.test(String(puzzleId || ""))) {
    return { error: "This puzzle has expired. Generate a new one.", status: 400 };
  }
  const st = store();
  const puzzle = await st.get(`puzzle/${puzzleId}`, { type: "json" });
  if (!puzzle || Date.now() - puzzle.created > PUZZLE_TTL_MS) {
    return { error: "This puzzle has expired. Generate a new one.", status: 400 };
  }
  const known = new Set(puzzle.answers);
  if (!answers.every((a) => known.has(a))) return { error: "Those answers aren't in this puzzle.", status: 400 };
  const maxCalls = Math.ceil(puzzle.answers.length / 4) * 2 + 2;
  const calls = await update(`puzzle/${puzzleId}/calls`, (n) => (n || 0) + 1);
  if (calls > maxCalls) return { error: "This puzzle has already had its clues written.", status: 429 };
  return { ok: true };
}

export async function markPuzzleOk(puzzleId) {
  await store().setJSON(`puzzle/${puzzleId}/ok`, true);
}

// The page calls this when every clue batch for a puzzle failed, so the
// failed attempt doesn't use up one of the week's puzzles.
export async function releasePuzzle(editor, puzzleId) {
  if (!editor.exempt && puzzleId) {
    const st = store();
    if (!(await st.get(`puzzle/${puzzleId}/ok`))) {
      await update(usageKey(), (u) => {
        const next = { ...emptyUsage(), ...(u || {}) };
        if (next.last_puzzle === puzzleId) { next.puzzles = Math.max(0, next.puzzles - 1); next.last_puzzle = null; }
        return next;
      });
    }
  }
  return getQuota(editor);
}

// Claim one single-clue rewrite; returns a refund function for failures.
export async function claimRewrite(editor) {
  if (editor.exempt) return { allowed: true, quota: await getQuota(editor), refund: async () => {} };
  const key = usageKey();
  let allowed = false;
  const after = await update(key, (u) => {
    const next = { ...emptyUsage(), ...(u || {}) };
    allowed = next.rewrites < LIMITS.rewrites;
    if (allowed) next.rewrites += 1;
    return next;
  });
  return {
    allowed,
    quota: describe(after, editor),
    refund: async () => {
      await update(key, (u) => ({ ...emptyUsage(), ...(u || {}), rewrites: Math.max(0, ((u && u.rewrites) || 1) - 1) }));
    },
  };
}
