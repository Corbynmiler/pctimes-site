// Regenerate ONE clue — called when Leanne clicks the ↻ next to a clue she
// doesn't like. Same compiler + editor passes as the full puzzle (see
// netlify/crossword/clues.js), told what she rejected and shown her recent
// rewrites so the replacement moves towards her taste.
//
// POST body: { answer, rejected_clue?, difficulty?, swap_log? }
// Returns:   { answer, clue }

const { writeBatch } = require("../crossword/clues.js");

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
    const body = JSON.parse(event.body || "{}");
    const answer = String(body.answer || "").toUpperCase().trim();
    if (!/^[A-Z]{2,15}$/.test(answer)) return json(400, { error: "Invalid answer" });
    const rejected = String(body.rejected_clue || "").trim().slice(0, 200);

    const result = await writeBatch({
      answers: [{ answer }],
      difficulty: String(body.difficulty || ""),
      swapLog: body.swap_log,
      rejectedClue: rejected,
    });
    const clue = result.clues[0] && result.clues[0].clue;
    if (!clue || clue.toLowerCase() === rejected.toLowerCase()) {
      return json(500, { error: "Could not produce a clean clue. Try again." });
    }
    return json(200, { answer, clue, checked: result.checked, ms: result.ms });
  } catch (err) {
    console.error("regenerate-clue failed:", err);
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
