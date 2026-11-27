// Clue writing for the Pōhutukawa Coast Times crossword.
// Shared by write-clues.mjs (a batch of answers) and regenerate-clue.mjs
// (one answer Leanne wants rewritten).
//
// Two passes, both on Claude Opus 5.5:
//   1. Compiler - drafts three clues per answer, each from a different
//      angle (everyday hook, other meaning, general knowledge, playful).
//   2. Editor - an independent pass that picks the best draft for each
//      answer (or writes a better one), and only lets through clues that
//      are accurate, fair, gettable without specialist knowledge, and not
//      flat. Picking from several drafts beats patching a single one.
//
// "Hard" here means clever, never obscure: Leanne wants clues that make
// readers think and then grin, not ones that need Latin or statistics.
//
// The API key lives only in Netlify's environment variables and is read
// here, server-side. It never reaches the browser.

// ES module with a static import: Netlify's bundler only ships the SDK
// with a function when it can see the import statically.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";
let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set. Add it in Netlify env vars.");
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 });
  return client;
}
// Local tests swap in a fake client so they never call the real API.
export function setClientForTests(fake) { client = fake; }

const SYSTEM = `You write the clues for the weekly crossword in the Pōhutukawa Coast Times, a free community newspaper for Beachlands, Maraetai, Whitford, Clevedon and the rest of the Pōhutukawa Coast, east of Auckland, New Zealand. Its readers are locals of every age and walk of life: retirees, parents, tradies, farmers, teachers, office workers. Many have done this crossword for years. They want to be made to think, and they want to enjoy it.

The editor, Leanne, has said two things: the clues used to be too easy, and they must never feel like an exam. Hard means clever, not obscure.

THE AIM
A great clue makes the solver stop, think, and then grin when the answer lands: "Oh, of course!" Everything needed to solve it is something a sharp, ordinary New Zealander already knows. The difficulty comes from approaching a familiar thing from an unexpected side, never from knowledge most readers don't have.

The quiz-night test: a sharp regular at a local pub quiz should have a fair shot at every clue, given a moment's thought and perhaps a crossing letter. If it needs a degree, a trade, a language or a niche hobby, it fails. If it reads like the first line of a dictionary entry, it's too easy.

TECHNIQUES THAT WORK (the editor's favourites: learn the style, don't reuse these clues)
- An everyday-life hook. RESULTS: "January news for NCEA students". TERRITORY: "Patch a tūī will fiercely defend".
- Well-known general knowledge, approached sideways. TRACTOR: "Hillary drove one to the South Pole". SUPREME: "Like New Zealand's highest court".
- A familiar word's other everyday meaning. SMART: "Sting". DRAW: "One-all, say".
- Misdirection by part of speech. TOTAL: "Utter" (it reads as a verb; it's the adjective).
- An example of the thing, with "for one" or "perhaps". OPERA: "Carmen, for one".
- A playful definition, flagged with a question mark. BIRTHDAY: "Present day?". SOCKS: "Wash-day escape artists?".
- A crisp, exact definition, when it's a good one. Not every clue needs a trick.

WHAT GETS THROWN OUT (real clues the editor rejected)
- Specialist knowledge. OPERA: "Works, to a Latin scholar" needs Latin. MOMENTS: "Mean and variance, to a statistician" needs statistics. No Latin or foreign-language senses, no technical, legal, medical, scientific or academic jargon, no "to a [specialist]" clues, no rare or archaic senses of words.
- Thesaurus swaps. GREATER: "More eminent". Swapping in a rarely used synonym isn't clever, it's a vocabulary test.
- Clumsy descriptions. SOCKS: "Knitted garments with heels". Technically true, but dull, and it describes the thing the way no one would.
- Giveaways (at Challenging and Fiendish). DAY: "Twenty-four hour period". PHYSICIAN: "Medical doctor". TOTAL: "Sum".

RULES FOR EVERY CLUE
- Accurate. Every fact, definition, part of speech, tense and number must be right. If you're not certain something is true, don't use it.
- Fair. A solver who gets the answer must agree it fits exactly, and no other common word of the same length should fit equally well. Misdirection on the way is good; ambiguity at the finish is not.
- One definition only. Never join two definitions with "or".
- Free of the answer: no part of the answer, no word from the same root.
- New Zealand English: NZ spelling (colour, organise, centre, programme, metre), metric units, NZ dollars. References may be New Zealand or international, never US-only (US sports, TV, towns, politics) or obscure British trivia. NZ flavour is welcome in some clues, not forced into all.
- Respectful. No dated or loaded terms, nothing about death, violence, illness, sex or politics that would jar in a community paper, nothing that pokes fun at age, weight or background.
- Concise: usually two to six words, newspaper tone, no exclamation marks. Don't state the answer's length; the paper prints it.
- The puzzle is a non-cryptic ("quick") crossword in a British-style blocked grid. Only about half of each answer's letters are crossed, so every clue has to stand on its own.`;

const DIFFICULTY = {
  standard:
    "STANDARD - friendly and satisfying. Most clues are crisp, exact definitions or everyday hooks that a regular solver gets on a first or second look; about one in four has a light twist. Skip the very first dictionary sense where a livelier one is just as clear.",
  challenging:
    "CHALLENGING - makes the solver think. Most clues need a moment of lateral thought: an everyday hook, a familiar word's other meaning, misdirection, an example, or well-known general knowledge approached sideways. Every clue must still land with an 'of course!' for an ordinary sharp reader, never a 'how was I meant to know that?'. A few can be crisp straight definitions, but none flat and none a giveaway. At most one '?' clue in this batch.",
  fiendish:
    "FIENDISH - a real workout that stays fair and fun. Nearly every clue twists: heavier misdirection, playful '?' definitions, less obvious (but everyday) meanings, and general knowledge can be more specific, the kind that comes up at a quiz night. Solvers should often need a crossing letter or two. Still no specialist knowledge, and never trade accuracy or fairness for difficulty. Up to two '?' clues in this batch.",
};
const DEFAULT_DIFFICULTY = "challenging";

const DRAFTS_SCHEMA = {
  type: "object",
  properties: {
    clues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          answer: { type: "string" },
          candidates: { type: "array", items: { type: "string" } },
        },
        required: ["answer", "candidates"],
        additionalProperties: false,
      },
    },
  },
  required: ["clues"],
  additionalProperties: false,
};

const PICKS_SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          answer: { type: "string" },
          clue: { type: "string" },
          note: { type: "string" },
        },
        required: ["answer", "clue", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["picks"],
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
  let p = `Draft clues for each answer below.\n\nDifficulty: ${DIFFICULTY[level]}\n\nAnswers:\n` +
    answers.map((a) => `- ${a.answer} (${a.answer.length})`).join("\n");
  if (rejected) {
    p += `\n\nLeanne rejected this clue for ${answers[0].answer}: "${rejected}". Every draft must take a clearly different angle, not reword it.`;
  }
  if (swaps.length) {
    p += "\n\nLeanne's recent rewrites (what she rejected, and the clue she kept). Learn her taste from them; don't reuse them:\n" +
      swaps.map((s) => `- ${s.answer}: rejected "${s.rejected}" -> kept "${s.kept}"`).join("\n");
  }
  p += "\n\nFor each answer, draft three finished, print-ready clues that take genuinely different angles (for example an everyday hook, a different meaning, general knowledge approached sideways, an example, a playful '?'). Put your best first. Every draft must pass the quiz-night test and follow every rule; the editor will choose between them. Vary the techniques across the batch. Return every answer exactly as given.";
  return p;
}

function editorPrompt(items, level, rejected) {
  let p = `You're the puzzle editor. The compiler has drafted clues for each answer below. For each answer, choose the clue that gives an ordinary sharp reader of the paper the most enjoyable fair challenge at this level. You may tighten its wording, or write a better clue yourself if none of the drafts is good enough.

Level for this puzzle: ${DIFFICULTY[level]}

A clue may go to print only if it is:
1. Accurate - every fact, meaning, part of speech, tense and number is correct. If you aren't confident a fact is true, it fails.
2. Fair - a solver who has the answer agrees it fits exactly, and no other common word of the same length fits as well.
3. Gettable - no specialist knowledge: no Latin or foreign-language senses, no technical, legal, medical, scientific or academic jargon, no "to a [specialist]" clues, no rare or archaic senses. It passes the quiz-night test.
4. Alive - not a thesaurus swap, not a clumsy description, and (at Challenging or Fiendish) not a dictionary-first giveaway.
5. House rules - one definition only (no "X or Y"), no part of the answer or a word from its root, NZ English with no US-only references, respectful, concise.

Prefer the clue with the best "of course!" moment. Don't let two clues in the batch lean on the same trick.`;
  if (rejected) p += `\n\nLeanne rejected "${rejected}" for ${items[0].answer}. Don't print that clue or anything close to it.`;
  p += "\n\nDrafts:\n" + items.map((c) =>
    `- ${c.answer} (${c.answer.length}):\n` + c.drafts.map((d, i) => `  ${i + 1}. ${d}`).join("\n")).join("\n");
  p += "\n\nFor each answer, return the final clue and a note of a few words on why it won or what you changed.";
  return p;
}

// Write and check clues for a batch of answers. Returns
// { clues: [{answer, clue}], checked, ms, usage }. Designed to finish
// well inside Netlify's 60 s limit: if the editor pass can't fit in the
// time left, the compiler's first clean draft is used instead of failing
// the whole batch.
async function writeBatch({ answers, difficulty, swapLog, rejectedClue }) {
  const started = Date.now();
  const deadline = started + 55_000;
  const level = DIFFICULTY[difficulty] ? difficulty : DEFAULT_DIFFICULTY;
  const swaps = cleanSwapLog(swapLog);
  const usage = [];
  const want = new Set(answers.map((a) => a.answer));
  const rejected = String(rejectedClue || "").trim().toLowerCase();
  const usable = (clue, answer) => clue && !clueProblem(clue, answer) && clue.toLowerCase() !== rejected;

  // Pass 1: compiler drafts.
  const w = await ask({
    prompt: writerPrompt(answers, level, swaps, rejectedClue),
    schema: DRAFTS_SCHEMA, effort: "high", timeoutMs: 40_000,
  });
  usage.push({ pass: "write", ...w.usage });
  const drafts = {};
  for (const c of w.data.clues || []) {
    const a = String(c.answer || "").toUpperCase().replace(/[^A-Z]/g, "");
    if (!want.has(a)) continue;
    drafts[a] = (Array.isArray(c.candidates) ? c.candidates : [])
      .map((d) => String(d || "").trim()).filter(Boolean).slice(0, 3);
  }
  const clueBy = {};
  for (const a of answers) clueBy[a.answer] = (drafts[a.answer] || []).find((d) => usable(d, a.answer)) || "";

  // Pass 2: independent editor picks (or improves) one per answer.
  let checked = false;
  const notes = {};
  const timeLeft = deadline - Date.now();
  const toPick = answers.filter((a) => (drafts[a.answer] || []).length)
    .map((a) => ({ answer: a.answer, drafts: drafts[a.answer] }));
  if (toPick.length && timeLeft > 12_000) {
    try {
      const e = await ask({
        prompt: editorPrompt(toPick, level, rejectedClue),
        schema: PICKS_SCHEMA, effort: "medium", timeoutMs: timeLeft - 2_000,
      });
      usage.push({ pass: "edit", ...e.usage });
      for (const v of e.data.picks || []) {
        const a = String(v.answer || "").toUpperCase().replace(/[^A-Z]/g, "");
        if (!want.has(a)) continue;
        const pick = String(v.clue || "").trim();
        if (usable(pick, a)) clueBy[a] = pick;
        notes[a] = String(v.note || "").slice(0, 200);
      }
      checked = true;
    } catch (err) {
      console.warn("editor pass skipped:", err && err.message);
    }
  }

  // Anything still breaking a hard rule is blanked so the page shows it
  // for a one-click rewrite rather than printing it.
  const clues = answers.map((a) => ({ answer: a.answer, clue: usable(clueBy[a.answer], a.answer) ? clueBy[a.answer] : "" }));
  return { clues, checked, level, ms: Date.now() - started, usage, drafts, notes };
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

export { writeBatch, streamJson, jsonResponse, DIFFICULTY, DEFAULT_DIFFICULTY, clueProblem };
