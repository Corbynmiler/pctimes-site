// Regenerate ONE clue — called when Leanne clicks the ↻ next to a clue she
// doesn't like (or one that came back blank). Same compiler + editor passes
// as the full puzzle (see netlify/crossword/clues.js), told what she
// rejected and shown her recent rewrites so it moves towards her taste.
// Streams, like write-clues, so a slow rewrite isn't cut off as idle.
//
// POST body: { answer, rejected_clue?, difficulty?, swap_log? }
// Returns:   { answer, clue, checked } or { error }.

import clues from "../crossword/clues.js";

const { writeBatch, streamJson, jsonResponse } = clues;

export default async (req) => {
  if (req.method !== "POST") return jsonResponse(405, { error: "POST only" });
  const body = await req.json().catch(() => ({}));
  const answer = String(body.answer || "").toUpperCase().trim();
  if (!/^[A-Z]{2,15}$/.test(answer)) return jsonResponse(400, { error: "Invalid answer" });
  const rejected = String(body.rejected_clue || "").trim().slice(0, 200);

  return streamJson(async () => {
    const result = await writeBatch({
      answers: [{ answer }],
      difficulty: String(body.difficulty || ""),
      swapLog: body.swap_log,
      rejectedClue: rejected,
    });
    const clue = result.clues[0] && result.clues[0].clue;
    if (!clue || clue.toLowerCase() === rejected.toLowerCase()) {
      throw new Error("Could not produce a clean clue. Try again.");
    }
    return { answer, clue, checked: result.checked, ms: result.ms };
  });
};
