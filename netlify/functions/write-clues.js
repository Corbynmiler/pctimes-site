// Step 2 of 2: write and fact-check clues for a batch of crossword answers.
// The page splits each puzzle's answers into small batches and calls this
// once per batch, in parallel, so every call stays well inside Netlify's
// 60-second limit. See netlify/crossword/clues.js for the prompts.
//
// POST body: { answers: ["PRIVILEGE", ...], difficulty?, swap_log? }
// Returns:   { clues: [{answer, clue}], checked, level, ms, usage }

const { writeBatch } = require("../crossword/clues.js");

const MAX_BATCH = 10;

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
    const body = JSON.parse(event.body || "{}");
    const raw = Array.isArray(body.answers) ? body.answers : [];
    const answers = [...new Set(raw.map((a) => String(a || "").toUpperCase().trim()))]
      .filter((a) => /^[A-Z]{3,15}$/.test(a))
      .map((answer) => ({ answer }));
    if (!answers.length) return json(400, { error: "No valid answers sent." });
    if (answers.length > MAX_BATCH) return json(400, { error: `At most ${MAX_BATCH} answers per batch.` });

    const result = await writeBatch({
      answers,
      difficulty: String(body.difficulty || ""),
      swapLog: body.swap_log,
    });
    return json(200, result);
  } catch (err) {
    console.error("write-clues failed:", err);
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
