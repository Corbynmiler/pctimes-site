// Clue writing for the Pōhutukawa Coast Times crossword.
// Shared by write-clues.js (a batch of answers) and regenerate-clue.js
// (one answer Leanne wants rewritten).
//
// Two passes, both on Claude Opus 5.5:
//   1. Compiler — writes a clue per answer at the chosen difficulty,
//      thinking through several angles before picking one.
//   2. Editor — an independent check of every clue for accuracy,
//      fairness, house rules and pitch; rewrites any that fail. This is
//      what stops a confidently wrong clue (the "MPH is NZ's speed unit"
//      kind) from reaching the page now that clues lean on trivia and
//      misdirection.
//
// The API key lives only in Netlify's environment variables and is read
// here, server-side. It never reaches the browser.

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-opus-5-5";
const AnthropicClient = Anthropic.default || Anthropic;
let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set. Add it in Netlify env vars.");
  if (!client) client = new AnthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 });
  return client;
}

const SYSTEM = `You compile the crossword for the Pōhutukawa Coast Times, a weekly community newspaper on the Pōhutukawa Coast, east of Auckland, New Zealand. Its readers are sharp, well-read adults; many have done the paper's crossword for years and want to be stretched. The editor, Leanne Chamberlin, throws out clues that are flat, obvious, inaccurate or culturally off.

The puzzle is a non-cryptic ("quick") crossword in a British-style blocked grid. Only about half of each answer's letters are crossed by other answers, so every clue has to stand up on its own.

Every clue, at every difficulty, must be:
- Accurate. Every fact, definition, part of speech, tense and number must be right. If you are not certain something is true, don't use it.
- Fair. A solver who gets the answer must agree it fits exactly, and no other common word of the same length should fit equally well. Misdirection on the way is good; ambiguity at the finish is not.
- One definition only. Never join two definitions with "or" ("Slip of paper or stumble") - that hands the solver two routes in.
- Free of the answer: no part of the answer or a word from the same root.
- New Zealand English: NZ spelling (colour, organise, centre, programme, metre), metric units, NZ dollars. References may be New Zealand or international, never US-only (US sports teams, TV, towns, politics) or obscure UK trivia.
- Respectful. No dated or loaded terms ("Oriental"), nothing about death, violence, illness or politics that would jar in a community paper.
- Concise: usually one to six words, newspaper tone, no exclamation marks. Don't state the answer's length; the paper prints it.
- Abbreviations: avoid flagging with "briefly" or "(abbr.)" unless the clue would otherwise mislead.

How a quick-crossword clue becomes hard without becoming unfair:
- Lead with a less obvious meaning. SHELL: not "Beach find" but "Bombard". SMART: not "Clever" but "Sting".
- Misdirect on part of speech. "Utter" for TOTAL reads like a verb; it's the adjective.
- Use a precise, less common synonym an educated reader knows. "Obdurate" for STUBBORN.
- Use specific, accurate general knowledge. "Lodge member" for MASON. "Katherine Mansfield's birthplace" for WELLINGTON.
- Occasionally, a playful definition flagged with a question mark. "Present day?" for BIRTHDAY.
- Too easy (never at Challenging or Fiendish): "Twenty-four hour period" for DAY, "Medical doctor" for PHYSICIAN, "Sum" for TOTAL.`;

const DIFFICULTY = {
  standard:
    "STANDARD - a good everyday quick crossword. Most clues are clean, precise definitions a regular solver gets on a first or second look, but skip the very first dictionary sense and textbook giveaways. Roughly one clue in four should use a less obvious meaning or a light touch of misdirection.",
  challenging:
    "CHALLENGING - a demanding broadsheet quick crossword for experienced solvers. Most clues should make the solver stop and think: lead with a secondary meaning, misdirect on part of speech, or use a precise less-common synonym. Up to a quarter can be accurate general knowledge (New Zealand or international). No more than one in five may be a plain first-meaning definition, and none may be a giveaway. At most one playful '?' clue in this batch.",
  fiendish:
    "FIENDISH - as hard as a non-cryptic crossword gets while staying fair. Almost every clue should misdirect or rely on an uncommon but genuine sense of the answer; general-knowledge clues can be specific (still accurate, NZ or international). A strong solver should often need a crossing letter or two to be sure. Never trade accuracy or fairness for difficulty. At most one playful '?' clue in this batch.",
};
const DEFAULT_DIFFICULTY = "challenging";

const CLUES_SCHEMA = {
  type: "object",
  properties: {
    clues: {
      type: "array",
      items: {
        type: "object",
        properties: { answer: { type: "string" }, clue: { type: "string" } },
        required: ["answer", "clue"],
        additionalProperties: false,
      },
    },
  },
  required: ["clues"],
  additionalProperties: false,
};

const VERDICTS_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          answer: { type: "string" },
          ok: { type: "boolean" },
          problem: { type: "string" },
          replacement: { type: "string" },
        },
        required: ["answer", "ok", "problem", "replacement"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
};

// One structured-output call. Opus 5.5 always thinks before answering;
// `effort` sets how hard. The fallback beta reroutes the rare request a
// safety classifier declines instead of failing it.
async function ask({ prompt, schema, effort, timeoutMs }) {
  const msg = await getClient().beta.messages.create(
    {
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
      output_config: { effort, format: { type: "json_schema", schema } },
    },
    { timeout: timeoutMs },
  );
  if (msg.stop_reason === "refusal") throw new Error("The clue writer declined this batch.");
  if (msg.stop_reason === "max_tokens") throw new Error("The clue writer ran out of room.");
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { data: JSON.parse(text), usage: msg.usage };
}

// ─── Cheap code-side checks (belt and braces after the editor) ─────────
function looksLikeDoubleDefinition(clue) {
  const m = String(clue || "").match(/^(.+?)\s+or\s+(.+)$/i);
  if (!m) return false;
  const left = m[1].trim(), right = m[2].trim();
  if (/^(more|less|so|two|three|four|five|six|seven|eight|nine|ten|either|whether)$/i.test(left) ||
      /^(more|less|so|two|three|four|five|six|seven|eight|nine|ten|so|other|not)$/i.test(right)) return false;
  return left.length >= 3 && right.length >= 3;
}
function looksUSCentric(clue) {
  return /\b(mph|mile|miles|fahrenheit|yards?|feet|inches?|pounds?|gallons?|organization|color|center|theater)\b/i.test(clue || "");
}
// Catches the answer itself and obvious same-root words (PRIVILEGED for
// PRIVILEGE, ACCUSATION for ACCUSED) without false alarms like SEASON for
// SEA or ACCURATE for ACCUSED. Subtler same-root cases are the editor's job.
function containsAnswer(clue, answer) {
  const words = String(clue || "").toUpperCase().match(/[A-Z]+/g) || [];
  const stem = answer.slice(0, Math.max(5, answer.length - 2));
  return words.some((w) => w === answer || (answer.length >= 5 && w.startsWith(stem)));
}
function clueProblem(clue, answer) {
  if (!clue || !clue.trim()) return "empty";
  if (looksLikeDoubleDefinition(clue)) return "two definitions joined by 'or'";
  if (looksUSCentric(clue)) return "US spelling or imperial units";
  if (containsAnswer(clue, answer)) return "contains the answer";
  return null;
}

function cleanSwapLog(swapLog) {
  if (!Array.isArray(swapLog)) return [];
  return swapLog.slice(-10)
    .filter((s) => s && /^[A-Z]{2,15}$/.test(String(s.answer || "")))
    .map((s) => ({
      answer: String(s.answer),
      rejected: String(s.rejected || "").slice(0, 160),
      kept: String(s.kept || "").slice(0, 160),
    }));
}

function writerPrompt(answers, level, swaps, rejected) {
  let p = `Write one clue for each answer below.\n\nDifficulty: ${DIFFICULTY[level]}\n\nAnswers:\n` +
    answers.map((a) => `- ${a.answer} (${a.answer.length})`).join("\n");
  if (rejected) {
    p += `\n\nLeanne rejected this clue for ${answers[0].answer}: "${rejected}". Write a clearly different one - a different angle, not a reworded version.`;
  }
  if (swaps.length) {
    p += "\n\nLeanne's recent rewrites (what she rejected, and the clue she kept). Learn her taste from them; don't reuse them:\n" +
      swaps.map((s) => `- ${s.answer}: rejected "${s.rejected}" -> kept "${s.kept}"`).join("\n");
  }
  p += "\n\nFor each answer, weigh a few different angles - other meanings, parts of speech, general-knowledge hooks - and choose the one that best fits the difficulty while staying accurate and fair. Vary the kinds of clue across the batch. Return every answer exactly as given.";
  return p;
}

function editorPrompt(items, level) {
  return `You are the second pair of eyes on this puzzle: check each clue before it goes to print. The level for this puzzle is: ${DIFFICULTY[level]}

For each clue, check:
1. Accurate - every fact, meaning, part of speech, tense and number is correct. If you aren't confident a fact is true, it fails.
2. Fair - a solver who has the answer would agree it fits, and no other common word of the same length fits the clue equally well.
3. House rules - one definition only (no "X or Y"), doesn't contain the answer or a word from the same root, NZ English with no US-only references, respectful, concise.
4. Pitch - right for the level above. At Challenging or Fiendish, a clue that most solvers would get instantly with no crossing letters fails.

If a clue passes all four: ok true, problem "", replacement "".
If it fails any: ok false, problem in a few words, and a replacement clue that passes all four.

Clues:
${items.map((c) => `- ${c.answer} (${c.answer.length}): ${c.clue}`).join("\n")}`;
}

// Write and check clues for a batch of answers. Returns
// { clues: [{answer, clue}], checked, ms, usage }. Designed to finish
// well inside Netlify's 60 s limit: if the editor pass can't fit in the
// time left, the compiler's clues are returned unchecked rather than
// failing the whole batch.
async function writeBatch({ answers, difficulty, swapLog, rejectedClue }) {
  const started = Date.now();
  const deadline = started + 55_000;
  const level = DIFFICULTY[difficulty] ? difficulty : DEFAULT_DIFFICULTY;
  const swaps = cleanSwapLog(swapLog);
  const usage = [];
  const want = new Set(answers.map((a) => a.answer));

  // Pass 1: compiler.
  const w = await ask({
    prompt: writerPrompt(answers, level, swaps, rejectedClue),
    schema: CLUES_SCHEMA, effort: "high", timeoutMs: 40_000,
  });
  usage.push({ pass: "write", ...w.usage });
  const clueBy = {};
  for (const c of w.data.clues || []) {
    const a = String(c.answer || "").toUpperCase().replace(/[^A-Z]/g, "");
    if (want.has(a)) clueBy[a] = String(c.clue || "").trim();
  }

  // Pass 2: independent editor.
  let checked = false;
  const timeLeft = deadline - Date.now();
  const toCheck = answers.filter((a) => clueBy[a.answer]).map((a) => ({ answer: a.answer, clue: clueBy[a.answer] }));
  if (toCheck.length && timeLeft > 12_000) {
    try {
      const e = await ask({
        prompt: editorPrompt(toCheck, level),
        schema: VERDICTS_SCHEMA, effort: "medium", timeoutMs: timeLeft - 2_000,
      });
      usage.push({ pass: "edit", ...e.usage });
      for (const v of e.data.verdicts || []) {
        const a = String(v.answer || "").toUpperCase().replace(/[^A-Z]/g, "");
        if (!want.has(a) || v.ok) continue;
        const replacement = String(v.replacement || "").trim();
        if (replacement && !clueProblem(replacement, a)) clueBy[a] = replacement;
      }
      checked = true;
    } catch (err) {
      console.warn("editor pass skipped:", err && err.message);
    }
  }

  // Last line of defence: anything still breaking a hard rule is blanked
  // so the page shows it for a one-click rewrite rather than printing it.
  const clues = answers.map((a) => {
    const clue = clueBy[a.answer] || "";
    return { answer: a.answer, clue: clueProblem(clue, a.answer) ? "" : clue };
  });
  return { clues, checked, level, ms: Date.now() - started, usage };
}

// Netlify's edge drops a request that sends nothing for ~30 s, and a
// careful clue batch can take longer than that. So the clue functions
// stream: a space every few seconds while Claude works, then the JSON.
// Leading whitespace is valid JSON, so the page just calls res.json().
// Failures arrive as {"error": "..."} in the body (the 200 status is
// already sent by then).
function streamJson(work) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(" "));
      const beat = setInterval(() => controller.enqueue(encoder.encode(" ")), 5_000);
      try {
        controller.enqueue(encoder.encode(JSON.stringify(await work())));
      } catch (err) {
        console.error("clue request failed:", err);
        controller.enqueue(encoder.encode(JSON.stringify({ error: String(err && err.message ? err.message : err) })));
      } finally {
        clearInterval(beat);
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

module.exports = { writeBatch, streamJson, jsonResponse, DIFFICULTY, DEFAULT_DIFFICULTY, clueProblem };
