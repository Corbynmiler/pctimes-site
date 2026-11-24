// Generate a weekly crossword grid for the Pōhutukawa Coast Times.
//
// Step 1 of 2. This function fills the grid and returns the answers — no
// AI involved, and it answers in well under a second. The page then sends
// the answers in small batches to write-clues.mjs, which has Claude write
// and fact-check the clues. Splitting it keeps every call far inside
// Netlify's 60-second function limit and lets the page show progress.
//
// Pipeline:
//   1. Pick one of a few symmetric 13×13 grid templates.
//   2. Load the bundled, dictionary-checked wordlist (netlify/crossword/).
//   3. Backtracking fill the grid with real words.

import WORDLIST from "../crossword/wordlist.mjs";
import { requireEditor, claimPuzzle, jsonResponse } from "../crossword/guard.mjs";

// ─── Grid templates ────────────────────────────────────────────────────
// 13×13, 180° symmetric, British "blocked" style (every other letter is
// checked) — the same look as a Times/Listener quick crossword.
//
// Leanne asked for ~30 clues max so the clue list fits her page space
// (the old dense grid produced 41). These give 26–30 entries, mostly 5, 7
// and 9-letter words, and only 4–6 three-letter words each.
//
// Picked by a search script that stress-tested each layout against the
// real wordlist: 300/300 successful fills each, typically in under 20 ms,
// so the fill never comes close to the function timeout.
const GRID_TEMPLATES = [
  {
    name: "blocked-26a", // 26 entries: 4×3, 8×5, 8×7, 6×9
    rows: [
      ".......#.....",
      ".#.#.###.#.#.",
      "...#.........",
      ".###.#.#.#.#.",
      ".......#.....",
      ".#.#.#.###.##",
      ".#.........#.",
      "##.###.#.#.#.",
      ".....#.......",
      ".#.#.#.#.###.",
      ".........#...",
      ".#.#.###.#.#.",
      ".....#.......",
    ],
  },
  {
    name: "blocked-26b", // 26 entries: 4×3, 8×5, 8×7, 6×9
    rows: [
      ".......#.....",
      ".#.#.###.#.#.",
      ".....#.......",
      ".###.#.###.#.",
      ".......#.....",
      "##.#.#.#.#.#.",
      ".#.........#.",
      ".#.#.#.#.#.##",
      ".....#.......",
      ".#.###.#.###.",
      ".......#.....",
      ".#.#.###.#.#.",
      ".....#.......",
    ],
  },
  {
    name: "blocked-28a", // 28 entries: 6×3, 10×5, 8×7, 4×9
    rows: [
      ".......#.....",
      ".#.#.###.#.#.",
      ".....#.......",
      "##.#.#.#.###.",
      ".......#.....",
      ".#.#.#.###.##",
      ".#.........#.",
      "##.###.#.#.#.",
      ".....#.......",
      ".###.#.#.#.##",
      ".......#.....",
      ".#.#.###.#.#.",
      ".....#.......",
    ],
  },
  {
    name: "blocked-30a", // 30 entries: 6×3, 13×5, 10×7, 1×9
    rows: [
      ".....#.......",
      ".#.#.#.#.#.#.",
      ".......#.....",
      ".###.###.###.",
      ".....#.......",
      "##.#.#.###.#.",
      ".#.........#.",
      ".#.###.#.#.##",
      ".......#.....",
      ".###.###.###.",
      ".....#.......",
      ".#.#.#.#.#.#.",
      ".......#.....",
    ],
  },
];
const MAX_ENTRIES = 30;

// Guard: at module load, make sure every template is 13×13 and 180°
// symmetric. (The entry-count cap is checked after slot extraction below.)
for (const t of GRID_TEMPLATES) {
  for (const r of t.rows) {
    if (r.length !== 13) throw new Error(`Template ${t.name}: row not 13 chars: "${r}" (${r.length})`);
  }
  if (t.rows.length !== 13) throw new Error(`Template ${t.name}: not 13 rows`);
  for (let r = 0; r < 13; r++) {
    for (let c = 0; c < 13; c++) {
      if ((t.rows[r][c] === "#") !== (t.rows[12 - r][12 - c] === "#")) {
        throw new Error(`Template ${t.name}: not symmetric at ${r},${c}`);
      }
    }
  }
}

// ─── Wordlist (bundled; built by scripts/build-crossword-wordlist.js) ──
let CACHED_WORDLIST = null;
let CACHED_INDEX = null;

// Words we never want appearing as answers in a NZ community paper.
// Includes US-specific units (NZ uses metric), sensitive topics, and a few
// grim ones. Over-filter here if in doubt — plenty of words to pick from.
const BLOCKED_ANSWERS = new Set([
  // US imperial units (NZ uses metric)
  "LBS", "MPH", "YDS", "OZS", "GAL", "GALS",
  // Sensitive / inappropriate for a community weekly
  "AIDS", "HIV", "ISIS", "KKK", "LGBT",
  "DIED", "DEAD", "KILL", "KILLED", "KILLING", "KILLS",
  "MURDER", "RAPE", "RAPED", "SUICIDE",
  "TORTURE", "TORTURED", "ABUSE", "ABUSED", "TERRORISM", "TERRORIST", "TERRORISTS",
  "NAZI", "NAZIS", "HITLER", "TRUMP",
  "CANCER", "TUMOR", "TUMOUR",
  "SHIT", "FUCK", "DAMN", "HELL",
  "DEATH", "DEATHS", "DIE", "DIES", "DYING", "DEADLY", "KILLER", "MURDERS",
  "GUN", "GUNS", "WEAPON", "WEAPONS", "SHOOT", "SHOOTING", "BOMB", "BOMBS", "ASSAULT", "TERROR",
  "VICTIM", "VICTIMS", "SLAVE", "SLAVES", "HATE", "DRUNK", "DRUG", "DRUGS", "MARIJUANA",
  "DISEASE", "DISEASES", "DISABLED", "DISABILITY", "DISABILITIES", "ABORTION",
  "GAY", "GAYS", "ADULT", "ADULTS", "SEXUAL", "SEXUALLY", "SEXUALITY", "NAKED", "BREAST",
  "BREASTS", "LINGERIE", "THONG", "THONGS", "BRA", "BRAS", "FETISH", "EROTICA", "ESCORTS",
  "BUTTS", "SCREW", "CASINO", "CASINOS", "POKER", "GAMBLING", "BETTING", "CRAPS",
  "CIGARETTE", "CIGARETTES", "COLORED", "ORIENTAL", "WARCRAFT",
  "RANDY", "HORNY", "SEXY", "SEX", "NUDE", "NUDITY", "STRIPPER",
  "NIGER", // a real country, but one letter from a slur; not worth printing
  // Religious / theological specifics that feel loaded
  "SATAN", "DEVIL",
]);

// The wordlist is American. A clue can be NZ-flavoured but the grid locks
// in the spelling, so an answer like REALIZE would make an NZ solver write
// REALISE and get it "wrong". Drop US-only spellings from the answer pool.
const NOT_US_IZE = new Set(["SIZE", "SIZED", "SIZES", "PRIZE", "PRIZES", "SEIZE", "SEIZED",
  "MAIZE", "CAPSIZE", "DOWNSIZE", "OVERSIZED", "CITIZEN", "CITIZENS"]);
const US_IZE = /(IZE|IZED|IZES|IZING|IZATION|IZATIONS|IZER|IZERS|YZE|YZED|YZES|YZING)$/;
const US_OR = /^(COLOR|FAVOR|HONOR|LABOR|NEIGHBOR|HUMOR|FLAVOR|ARMOR|RUMOR|VAPOR|HARBOR|BEHAVIOR|ENDEAVOR|SAVOR|VIGOR|PARLOR|ODOR)(S|ED|ING|FUL|ITE|ITES|ABLE|HOOD|HOODS)?$/;
const US_ER = /^(CENTER|THEATER|FIBER|LITER|CALIBER|SOMBER|SPECTER|LUSTER|MANEUVER)S?$/;
const US_OTHER = new Set(["DEFENSE", "OFFENSE", "LICENSE", "LICENSED", "LICENSES", "LICENSING",
  "GRAY", "PAJAMAS", "JEWELRY", "ALUMINUM", "MOM", "MOMS", "CATALOG", "CATALOGS", "ANALOG",
  "DIALOG", "TRAVELED", "TRAVELING", "TRAVELER", "TRAVELERS", "CANCELED", "CANCELING",
  "MODELING", "LABELED", "LABELING", "FULFILL", "ENROLLMENT", "PROGRAM", "PROGRAMS",
  "APARTMENT", "APARTMENTS", "GASOLINE", "ENCYCLOPEDIA", "JUDGMENT", "AGING", "COUNSELOR",
  "PLOW", "SKEPTICAL"]);
function isUSSpelling(w) {
  return (US_IZE.test(w) && !NOT_US_IZE.has(w)) || US_OR.test(w) || US_ER.test(w) || US_OTHER.has(w);
}

// The wordlist comes from web text, so short entries are full of junk:
// tech acronyms (USB, PHP, MSN), first names (ROY, JIM), month/day
// abbreviations (OCT, TUE). Three-letter answers must come from this
// hand-checked list of real words. Longer entries just need a vowel
// (drops HTML, BLVD, HDTV) and can't be apostrophe-less contractions.
const THREE_LETTER_OK = new Set((
  "MAY OUT USE ANY SEE HIS WHO WEB NOW GET HOW ITS TOP HAD DAY TWO BUY HER ADD SHE SET MAP " +
  "WAY OFF DID CAR OWN END HIM PER BIG LAW ART OLD WHY LOW MAN JOB TOO MEN BOX AIR YES HOT " +
  "SAY TAX GOT LET ACT RED KEY FEW AGE PAY WAR FAX YET SUN RUN NET PUT TRY LOG FUN LOT ASK " +
  "DUE PRO AGO VIA BAD FAR OIL BIT BAY BAR DOG GAS SIX ZIP BID WIN BED SEA CUT KIT BOY SON " +
  "BIN VAN ADS POP HIT EYE FEE AID FAT SAW SUB LED FAN TEN CAT PET GUY CUP FIT MET ICE BUS " +
  "BAG NOR BUG MID LAB TAG MIX FIX RAY DRY SPA CON WON DOC ROW EAT AIM TIP SKI FLY HEY TEA " +
  "SKY TOY HIP DOT DNA CAP INK PIN RAW HAT CAM WET RAM FOX ARM PUB HOP REF KID PAN SUM OAK " +
  "VAT SIR SPY SIT WOW FIG TAB BIO SIN LEG GAP ROB ERA JET PAR MAD PEN JOY RAN ILL LAY BET " +
  "DAD PAT EAR TIE MOD TOE DEN LIE AMP EVE PAD ROD SAD POT EGG JAM ARC APP ION FED BAN ODD " +
  "CRY ZOO TEE CAD HUB ACE SUE FLU RAP TIN RAT COD GEL THY PAL MAT GYM TAN PIE BOW"
).split(" "));
const CONTRACTIONS = new Set(["THATS", "DONT", "CANT", "WONT", "ISNT", "DIDNT", "DOESNT",
  "WASNT", "ARENT", "COULDNT", "WOULDNT", "SHOULDNT", "HAVENT", "HASNT", "HADNT", "WERENT",
  "YOURE", "THEYRE", "YOUVE", "THEYVE", "YOULL", "THEYLL", "WHATS", "THERES", "HERES", "WHERES"]);
function isJunk(w) {
  if (w.length === 3) return !THREE_LETTER_OK.has(w);
  return !/[AEIOUY]/.test(w) || CONTRACTIONS.has(w);
}

async function getWordlist() {
  if (CACHED_WORDLIST) return { words: CACHED_WORDLIST, index: CACHED_INDEX };

  // Dictionary-checked everyday English (the build script drops names,
  // places, brands and web jargon). Filter again here for anything unsuitable.
  CACHED_WORDLIST = WORDLIST.split(" ")
    .filter((w) => /^[A-Z]{3,13}$/.test(w) && !BLOCKED_ANSWERS.has(w) && !isUSSpelling(w) && !isJunk(w));

  // Index for fast slot lookup: key "len:pos:letter" → [words]
  // Also a bare by-length index for unconstrained slots.
  const index = { byLen: {}, byPos: {} };
  for (const w of CACHED_WORDLIST) {
    const len = w.length;
    (index.byLen[len] = index.byLen[len] || []).push(w);
    for (let i = 0; i < len; i++) {
      const key = `${len}:${i}:${w[i]}`;
      (index.byPos[key] = index.byPos[key] || []).push(w);
    }
  }
  CACHED_INDEX = index;
  return { words: CACHED_WORDLIST, index };
}

// ─── Slot extraction ───────────────────────────────────────────────────
function parseGrid(rows) {
  const size = rows.length;
  const cells = rows.map((r) => r.split("").map((c) => (c === "#" ? null : "")));
  return { size, cells };
}

function extractSlots(cells) {
  const size = cells.length;
  const slots = [];
  // Across
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (cells[r][c] === null) { c++; continue; }
      let start = c;
      while (c < size && cells[r][c] !== null) c++;
      const len = c - start;
      if (len >= 3) slots.push({ dir: "A", row: r, col: start, len });
    }
  }
  // Down
  for (let c = 0; c < size; c++) {
    let r = 0;
    while (r < size) {
      if (cells[r][c] === null) { r++; continue; }
      let start = r;
      while (r < size && cells[r][c] !== null) r++;
      const len = r - start;
      if (len >= 3) slots.push({ dir: "D", row: start, col: c, len });
    }
  }
  return slots;
}

function slotPattern(cells, slot) {
  let p = "";
  for (let i = 0; i < slot.len; i++) {
    const r = slot.dir === "A" ? slot.row : slot.row + i;
    const c = slot.dir === "A" ? slot.col + i : slot.col;
    p += cells[r][c] || ".";
  }
  return p;
}

// Standard crossword grids sometimes have "orphan" white cells — whites
// surrounded by blacks in both directions such that neither the across nor
// the down run reaches length 3. My fill engine only handles entries of
// length >= 3, so orphans stay empty and the grid has visible gaps.
// Simple pragmatic fix: pre-fill orphan cells with a random vowel so they
// at least render as letters. They are never clued (no entry covers them).
function fillOrphans(cells, slots) {
  const size = cells.length;
  const covered = new Set();
  for (const s of slots) {
    for (let i = 0; i < s.len; i++) {
      const r = s.dir === "A" ? s.row : s.row + i;
      const c = s.dir === "A" ? s.col + i : s.col;
      covered.add(`${r},${c}`);
    }
  }
  const vowels = "AEIOU";
  let n = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (cells[r][c] === null) continue;
      if (!covered.has(`${r},${c}`)) {
        cells[r][c] = vowels[Math.floor(Math.random() * vowels.length)];
        n++;
      }
    }
  }
  return n;
}

function placeWord(cells, slot, word) {
  for (let i = 0; i < slot.len; i++) {
    const r = slot.dir === "A" ? slot.row : slot.row + i;
    const c = slot.dir === "A" ? slot.col + i : slot.col;
    cells[r][c] = word[i];
  }
}

function unplaceWord(cells, slot, originalPattern) {
  for (let i = 0; i < slot.len; i++) {
    const r = slot.dir === "A" ? slot.row : slot.row + i;
    const c = slot.dir === "A" ? slot.col + i : slot.col;
    cells[r][c] = originalPattern[i] === "." ? "" : originalPattern[i];
  }
}

// ─── Candidate finder ──────────────────────────────────────────────────
function candidates(pattern, index) {
  const len = pattern.length;
  const fixed = [];
  for (let i = 0; i < len; i++) if (pattern[i] !== ".") fixed.push([i, pattern[i]]);

  if (fixed.length === 0) return (index.byLen[len] || []).slice();

  // Start from the position-key with fewest entries.
  let seed = null;
  for (const [i, ch] of fixed) {
    const arr = index.byPos[`${len}:${i}:${ch}`] || [];
    if (!seed || arr.length < seed.length) seed = arr;
  }
  return seed.filter((w) => fixed.every(([i, ch]) => w[i] === ch));
}

// ─── Backtracking fill ─────────────────────────────────────────────────
function shuffle(arr) {
  // Fisher-Yates. Mutates in place.
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function fillGrid(cells, slots, index, deadlineMs, usedGlobal) {
  // Used-word set is shared across all recursion levels so a word placed
  // in one slot can't be reused in another (crossword convention: every
  // answer must be unique within the puzzle).
  if (!usedGlobal) usedGlobal = new Set();

  // Pick slot with fewest candidates (MRV).
  const unfilled = slots.filter((s) => slotPattern(cells, s).includes("."));
  if (unfilled.length === 0) return true;
  if (Date.now() > deadlineMs) return false;

  let best = null, bestCands = null;
  for (const s of unfilled) {
    const pat = slotPattern(cells, s);
    const cands = candidates(pat, index).filter((w) => !usedGlobal.has(w));
    if (!best || cands.length < bestCands.length) {
      best = s; bestCands = cands;
      if (cands.length <= 1) break;
    }
  }
  if (!bestCands || bestCands.length === 0) return false;
  shuffle(bestCands);

  const originalPattern = slotPattern(cells, best);
  const usedThisSlot = new Set();

  for (const w of bestCands) {
    if (usedThisSlot.has(w)) continue;
    usedThisSlot.add(w);
    placeWord(cells, best, w);
    usedGlobal.add(w);
    if (fillGrid(cells, slots, index, deadlineMs, usedGlobal)) return true;
    unplaceWord(cells, best, originalPattern);
    usedGlobal.delete(w);
    if (Date.now() > deadlineMs) return false;
  }
  return false;
}

// ─── Puzzle assembly ───────────────────────────────────────────────────
function computeNumbers(cells) {
  const size = cells.length;
  const numbers = {};
  let n = 1;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (cells[r][c] === null) continue;
      const startsA = (c === 0 || cells[r][c - 1] === null) &&
        (c + 1 < size && cells[r][c + 1] !== null);
      const startsD = (r === 0 || cells[r - 1][c] === null) &&
        (r + 1 < size && cells[r + 1][c] !== null);
      if (startsA || startsD) numbers[`${r},${c}`] = n++;
    }
  }
  return numbers;
}

function buildAnswers(cells, slots, numbers) {
  const answers = [];
  for (const s of slots) {
    let word = "";
    for (let i = 0; i < s.len; i++) {
      const r = s.dir === "A" ? s.row : s.row + i;
      const c = s.dir === "A" ? s.col + i : s.col;
      word += cells[r][c];
    }
    answers.push({
      direction: s.dir === "A" ? "across" : "down",
      number: numbers[`${s.row},${s.col}`],
      len: s.len,
      answer: word,
    });
  }
  return answers;
}

// ─── Handler ───────────────────────────────────────────────────────────
export async function buildPuzzle() {
  try {
    const { index } = await getWordlist();

    // Pick a random template and try to fill it.
    let filled = null;
    let templateUsed = null;
    // Fill time is heavy-tailed: ~99% finish in under 100 ms, but a rare
    // unlucky shuffle can wander for seconds. Restarting with a fresh
    // shuffle beats waiting, so each attempt gets a short budget.
    for (let attempt = 0; attempt < 5; attempt++) {
      const tpl = GRID_TEMPLATES[Math.floor(Math.random() * GRID_TEMPLATES.length)];
      const { cells } = parseGrid(tpl.rows);
      const slots = extractSlots(cells);
      if (slots.length > MAX_ENTRIES) {
        return json(500, { error: `Template ${tpl.name} has ${slots.length} entries (max ${MAX_ENTRIES}).` });
      }
      const deadline = Date.now() + 800;
      // Pre-fill any orphan cells (white but not in any >= 3-letter entry).
      fillOrphans(cells, slots);
      if (fillGrid(cells, slots, index, deadline)) {
        filled = cells;
        templateUsed = tpl;
        var finalSlots = slots;
        break;
      }
    }
    if (!filled) return json(500, { error: "Could not fill a grid in time. Try again." });

    const numbers = computeNumbers(filled);
    const answers = buildAnswers(filled, finalSlots, numbers);
    const across = answers.filter((a) => a.direction === "across").sort((a, b) => a.number - b.number);
    const down = answers.filter((a) => a.direction === "down").sort((a, b) => a.number - b.number);

    // Shape for the client: rows with letters, numbers map, clues lists.
    // Guard: if any white cell didn't get filled (shouldn't happen with a
    // valid grid + successful fill, but belt-and-braces), surface a "?"
    // instead of dropping the character via join("") and producing a
    // short row.
    let unfilledCount = 0;
    const rows = filled.map((row) => row.map((c) => {
      if (c === null) return "#";
      if (!c) { unfilledCount++; return "?"; }
      return c;
    }).join(""));
    // Safety: every row must be exactly the template width.
    for (const r of rows) {
      if (r.length !== filled.length) {
        return json(500, { error: `Grid row length mismatch (${r.length} vs ${filled.length}). Try again.` });
      }
    }
    if (unfilledCount > 0) {
      return json(500, { error: `${unfilledCount} cell(s) could not be filled. Try again.` });
    }
    return json(200, {
      template: templateUsed.name,
      size: filled.length,
      rows,
      numbers,
      // Clues are filled in by the page via write-clues.mjs.
      across: across.map(({ number, len, answer }) => ({ n: number, clue: "", len, answer })),
      down: down.map(({ number, len, answer }) => ({ n: number, clue: "", len, answer })),
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return json(500, { error: String(err && err.message ? err.message : err) });
  }
}

function json(status, body) {
  return { status, body };
}

// The endpoint: signed-in editors only, and each new puzzle comes out of
// the weekly allowance (see netlify/crossword/guard.mjs).
export default async (req) => {
  const auth = await requireEditor(req);
  if (auth.response) return auth.response;
  try {
    const built = await buildPuzzle();
    if (built.status !== 200) return jsonResponse(built.status, built.body);
    const puzzleId = crypto.randomUUID();
    const answers = [...new Set([...built.body.across, ...built.body.down].map((e) => e.answer))];
    const claim = await claimPuzzle(auth.editor, puzzleId, answers);
    if (!claim.allowed) {
      return jsonResponse(429, {
        error: `You've made this week's ${claim.quota.puzzles_limit} new puzzles. Your allowance resets on Monday. You can still rewrite single clues with the ↻ buttons.`,
        code: "limit",
        quota: claim.quota,
      });
    }
    return jsonResponse(200, { ...built.body, puzzle_id: puzzleId, quota: claim.quota });
  } catch (err) {
    console.error("generate-crossword failed:", err);
    return jsonResponse(500, { error: String(err && err.message ? err.message : err) });
  }
};
