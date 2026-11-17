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
// Each is a 13×13 symmetric pattern — '#' is black, '.' is white.
// Hand-designed to give ~30 entries, print well at 80×80 mm.
const GRID_TEMPLATES = [
  {
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
  {
    name: "classic-13b",
    rows: [
      "....#....#...",
      ".#..#.#..#...",
      "....#...#....",
      "###.#...#.###",
      "....#...#....",
      ".#..####....#",
      "...#.....#...",
      "#....####..#.",
      "....#...#....",
      "###.#...#.###",
      "....#...#....",
      "...#..#.#..#.",
      "...#....#....",
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
    .filter((w) => /^[A-Z]{3,13}$/.test(w));
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

function fillGrid(cells, slots, index, deadlineMs) {
  // Pick slot with fewest candidates (MRV).
  const unfilled = slots.filter((s) => slotPattern(cells, s).includes("."));
  if (unfilled.length === 0) return true;
  if (Date.now() > deadlineMs) return false;

  let best = null, bestCands = null;
  for (const s of unfilled) {
    const pat = slotPattern(cells, s);
    const cands = candidates(pat, index);
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
    if (fillGrid(cells, slots, index, deadlineMs)) return true;
    unplaceWord(cells, best, originalPattern);
    if (Date.now() > deadlineMs) return false;
  }
  return false;
}

// ─── Clue generation (Claude) ──────────────────────────────────────────
async function generateClues(entries, apiKey) {
  const prompt =
`You are writing clues for a weekly quick crossword in the Pōhutukawa Coast Times, a New Zealand community newspaper read by a smart, general audience (not seniors-only, not specialist). Aunty Leanne is the editor.

Write ONE clue for each ANSWER below.

Rules:
- Each clue must have the answer as its unique solution. A reasonable solver should not confuse it for another word.
- Difficulty: medium. Smart adults should solve them. No giveaways like "Yellow fruit" for BANANA.
- Use NZ/UK English spelling where it matters.
- Keep clues concise: 2-8 words. End with a question mark only for genuinely ambiguous wordplay.
- Mix definition, light wordplay, and allusion. Avoid overused crossword tropes ("Opera solo" for ARIA, "Yes vote" for AYE, "Needle hole" for EYE).
- Do NOT reveal the answer length in the clue text.
- Keep tone neutral/newspaper-formal. No slang, no emojis.

ANSWERS (JSON):
${JSON.stringify(entries)}

Respond with ONLY a single JSON object in this exact shape:
{"clues": [{"answer": "...", "clue": "..."}]}

Nothing before or after the JSON. No markdown fences.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Anthropic API failed: ${res.status} ${txt.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = (json.content || []).map((p) => p.text || "").join("").trim();
  // Strip optional ```json fences just in case
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned);
  return parsed.clues || [];
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

    const across = answers.filter((a) => a.direction === "across").sort((a, b) => a.number - b.number);
    const down = answers.filter((a) => a.direction === "down").sort((a, b) => a.number - b.number);
    for (const a of across) a.clue = clueByAnswer[a.answer] || `(clue missing for ${a.answer})`;
    for (const a of down) a.clue = clueByAnswer[a.answer] || `(clue missing for ${a.answer})`;

    // Shape for the client: rows with letters, numbers map, clues lists.
    const rows = filled.map((row) => row.map((c) => (c === null ? "#" : c)).join(""));
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
