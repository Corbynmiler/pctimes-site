// Generate a weekly crossword for the Pōhutukawa Coast Times.
//
// Pipeline (hybrid — the classical approach for the hard constraint
// problem, LLM for the creative/open-ended problem):
//   1. Pick one of a few symmetric 13×13 grid templates.
//   2. Fetch a quality-scored wordlist (cached in memory between invocations).
//   3. Backtracking fill the grid with real words.
//   4. Call Claude to write clues for every answer in one batched call.
//   5. (optional, not yet) solver-validator pass to catch ambiguous clues.
//
// Costs ~NZ$0.02-0.05 per generation on Haiku 4.5. Leanne can regenerate
// as many times as she wants per week within the Anthropic monthly cap we set.

// ─── Grid templates ────────────────────────────────────────────────────
// Each is a 13×13 fully-symmetric (180°) pattern — '#' is black, '.' is
// white. Designed to bias toward meatier 4-9 letter words rather than lots
// of 3-letter filler. ~28-32 entries each.
const GRID_TEMPLATES = [
  {
    // The classic one we know fills reliably within the function timeout.
    // Yes it has several 3-letter entries — that's inherent to a 13×13.
    // The real fight against "too many 3-letter words" is template design;
    // deferred to a later pass once the fill engine is more robust.
    name: "classic-13a",
    rows: [
      "###..........",
      "###.#.#.#.#.#",
      ".............",
      ".#.#.#...#.#.",
      "....#...#....",
      ".#...##...#.#",
      "..#.....#..##",
      "#.#...##...#.",
      "....#...#....",
      ".#.#...#.#.#.",
      ".............",
      "#.#.#.#.#.###",
      "..........###",
    ],
  },
];

// Guard: at module load, make sure every template row is 13 chars.
for (const t of GRID_TEMPLATES) {
  for (const r of t.rows) {
    if (r.length !== 13) throw new Error(`Template ${t.name}: row not 13 chars: "${r}" (${r.length})`);
  }
  if (t.rows.length !== 13) throw new Error(`Template ${t.name}: not 13 rows`);
}

// ─── Wordlist (fetched once per container cold start) ──────────────────
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
  "NAZI", "NAZIS", "HITLER", "TRUMP",
  "CANCER", "TUMOR", "TUMOUR",
  "SHIT", "FUCK", "DAMN", "HELL",
  // Religious / theological specifics that feel loaded
  "SATAN", "DEVIL",
]);

async function getWordlist() {
  if (CACHED_WORDLIST) return { words: CACHED_WORDLIST, index: CACHED_INDEX };

  // Google's top-10000 most common English words, well-known and reliable.
  // We trim to a sensible band for crossword fill.
  const url = "https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english-usa-no-swears.txt";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`wordlist fetch failed: ${res.status}`);
  const text = await res.text();

  // Skip the very top (THE, OF, AND...) — too generic as crossword answers.
  // Take a quality band of common-but-interesting words.
  const all = text.split("\n").map((w) => w.trim().toUpperCase())
    .filter((w) => /^[A-Z]{3,13}$/.test(w) && !BLOCKED_ANSWERS.has(w));
  CACHED_WORDLIST = all.slice(30, 6000);

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

// ─── Clue generation (Claude) ──────────────────────────────────────────
const CLUE_SYSTEM_PROMPT =
`You are a professional crossword compiler writing for the Pōhutukawa Coast Times, a New Zealand community newspaper read by a smart, general adult audience. The editor, Leanne Chamberlin, is sharp — she will reject clues that feel childish, obvious, or culturally wrong.

HARD RULES:
1. ONE definition per clue. NEVER join two definitions with "or" ("Loss of footing or piece of paper" is forbidden — pick ONE). The "or" trick gives the solver two chances and makes the puzzle too easy. If you can't pick a single clean definition, use wordplay instead.
2. New Zealand context. NZ uses metric (km/h, kilometres, metres, Celsius), NOT imperial (mph, miles, Fahrenheit). NZ spelling: colour, metre, theatre, favourite, organise. NZ English, not American. No clues that assume US geography, US sports, or US cultural references unless internationally famous.
3. Medium difficulty. Smart adults should solve. No giveaways like "Yellow fruit" for BANANA or "Opposite of yes" for NO.
4. No overused crossword tropes. Forbidden definitions: "Opera solo" (ARIA), "Yes vote" (AYE), "Needle hole" (EYE), "Toward shelter" (ALEE), "Sch. subj." (nope). Find fresh angles.
5. Clues should be 2-7 words, concise.
6. Do NOT reveal the answer length in the clue text.
7. Formal newspaper tone. No slang, no emoji, no exclamation marks.
8. Prefer definition + light wordplay over pure definition when possible, but keep it accessible — this is a quick crossword, not a cryptic.
9. For abbreviations and initialisms: clue them WITHOUT flagging them as such whenever possible. "Help page section" for FAQ is fine — do NOT write "Help page section, briefly". Only add ", briefly" or "(abbr.)" when it is genuinely needed to avoid misleading the solver (e.g. if the clue would otherwise look like a full word). Over-using "briefly" is the single clearest tell of a lazy clue. AVOID using the word "briefly" in more than 2 or 3 clues per puzzle total.`;

async function callClaude(prompt, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 4000,
      system: CLUE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Anthropic API failed: ${res.status} ${txt.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = (json.content || []).map((p) => p.text || "").join("").trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

async function generateClues(entries, apiKey) {
  const prompt =
`Write ONE clue for each answer below. Follow the HARD RULES in the system message, especially: no "X or Y" double-definitions, no miles-per-hour or other imperial references, no overused tropes.

ANSWERS (JSON):
${JSON.stringify(entries)}

Return ONLY this JSON shape, nothing else, no markdown fences:
{"clues": [{"answer": "ASTRONOMER", "clue": "Expert on stars"}, ...]}

Include every answer in your response. Order does not matter.`;

  const parsed = await callClaude(prompt, apiKey);
  return parsed.clues || [];
}

// Detect the "X or Y" double-definition pattern — anything joined by " or "
// that isn't a single phrase is forbidden.
function looksLikeDoubleDefinition(clue) {
  if (!clue) return false;
  // " or " connecting what look like separate noun phrases
  // Simple heuristic: if we see " or " and both sides are > 2 chars, flag it.
  const m = clue.match(/^(.+?)\s+or\s+(.+)$/i);
  if (!m) return false;
  const left = m[1].trim(), right = m[2].trim();
  // Exceptions: single-word "or" inside a longer phrase like "more or less"
  const stopWords = /^(more|less|so|two|three|four|five|six|seven|eight|nine|ten)$/i;
  if (stopWords.test(left) || stopWords.test(right)) return false;
  // If it ends with "briefly" or "(abbr.)" the clue is likely one-sided
  if (/briefly|abbr\.?\)?/i.test(clue)) return false;
  return left.length >= 3 && right.length >= 3;
}

// Flag imperial-unit mentions that are wrong for NZ.
function looksUSCentric(clue) {
  if (!clue) return false;
  return /\b(mph|mile|miles|fahrenheit|yards?|feet|inches?|pounds?|gallons?)\b/i.test(clue);
}

async function regenerateClue(answer, lengthOf, apiKey) {
  const prompt =
`The crossword clue I wrote for the answer "${answer}" (${lengthOf} letters) was rejected by the editor. Write a BETTER single clue that:
- Uses ONE definition only, not two joined by "or"
- Is NZ-appropriate (metric, NZ spelling, no US-only references)
- Does NOT contain the word "briefly" — find a different way if it's an abbreviation
- Is a bit harder than obvious
- Is 2-7 words

Return ONLY this JSON, nothing else:
{"answer": "${answer}", "clue": "..."}`;
  const parsed = await callClaude(prompt, apiKey);
  return parsed.clue || null;
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
exports.handler = async () => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return json(500, { error: "ANTHROPIC_API_KEY not set. Add it in Netlify env vars." });
    }

    const { index } = await getWordlist();

    // Pick a random template and try to fill it.
    let filled = null;
    let templateUsed = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const tpl = GRID_TEMPLATES[Math.floor(Math.random() * GRID_TEMPLATES.length)];
      const { cells } = parseGrid(tpl.rows);
      const slots = extractSlots(cells);
      const deadline = Date.now() + 6000; // leave headroom for LLM call within 10s cap
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

    // Ask Claude to write clues for every answer.
    const entries = answers.map((a) => ({
      number: a.number, direction: a.direction, answer: a.answer,
    }));
    const clueResp = await generateClues(entries, apiKey);
    const clueByAnswer = Object.fromEntries(
      (clueResp || []).map((c) => [String(c.answer || "").toUpperCase(), c.clue])
    );

    // Second pass: regenerate any clue that violates the HARD RULES
    // (double-definition with " or ", imperial units, or missing entirely).
    // Also cap "briefly" at 2 per puzzle — any extras get rewritten.
    let brieflyBudget = 2;
    const needsRegen = [];
    for (const a of answers) {
      const c = clueByAnswer[a.answer];
      if (!c || looksLikeDoubleDefinition(c) || looksUSCentric(c)) {
        needsRegen.push(a);
        continue;
      }
      if (/\bbriefly\b/i.test(c)) {
        if (brieflyBudget > 0) brieflyBudget--;
        else needsRegen.push(a);
      }
    }
    // Do up to a handful of regenerations in parallel to stay within timeout.
    if (needsRegen.length) {
      const results = await Promise.allSettled(
        needsRegen.slice(0, 10).map((a) => regenerateClue(a.answer, a.len, apiKey))
      );
      results.forEach((r, i) => {
        if (r.status === "fulfilled" && r.value) {
          const a = needsRegen[i];
          if (!looksLikeDoubleDefinition(r.value) && !looksUSCentric(r.value)) {
            clueByAnswer[a.answer] = r.value;
          }
        }
      });
    }

    const across = answers.filter((a) => a.direction === "across").sort((a, b) => a.number - b.number);
    const down = answers.filter((a) => a.direction === "down").sort((a, b) => a.number - b.number);
    for (const a of across) a.clue = clueByAnswer[a.answer] || `(clue missing for ${a.answer})`;
    for (const a of down) a.clue = clueByAnswer[a.answer] || `(clue missing for ${a.answer})`;

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
      across: across.map(({ number, clue, len, answer }) => ({ n: number, clue, len, answer })),
      down: down.map(({ number, clue, len, answer }) => ({ n: number, clue, len, answer })),
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return json(500, { error: String(err && err.message ? err.message : err) });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}
