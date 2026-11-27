// Step 2 of 2: write and fact-check clues for a batch of crossword answers.
// The page splits each puzzle's answers into small batches and calls this
// once per batch, in parallel. Only signed-in editors, and only for a
// puzzle issued from this week's allowance in the last 30 minutes (see
// netlify/crossword/guard.mjs). The response streams (see streamJson in
// netlify/crossword/clues.mjs) so a slow batch isn't cut off as idle.
//
// POST body: { puzzle_id, answers: ["PRIVILEGE", ...], swap_log? }
// Returns:   { clues: [{answer, clue}], checked, ms, usage }
//            or { error } on failure.

import { writeBatch, streamJson } from "../crossword/clues.mjs";
import { requireEditor, checkBatch, markPuzzleOk, jsonResponse } from "../crossword/guard.mjs";

const MAX_BATCH = 10;

export default async (req) => {
  if (req.method !== "POST") return jsonResponse(405, { error: "POST only" });
  const auth = await requireEditor(req);
  if (auth.response) return auth.response;

  const body = await req.json().catch(() => ({}));
  const raw = Array.isArray(body.answers) ? body.answers : [];
  const answers = [...new Set(raw.map((a) => String(a || "").toUpperCase().trim()))]
    .filter((a) => /^[A-Z]{3,15}$/.test(a));
  if (!answers.length) return jsonResponse(400, { error: "No valid answers sent." });
  if (answers.length > MAX_BATCH) return jsonResponse(400, { error: `At most ${MAX_BATCH} answers per batch.` });

  let check;
  try {
    check = await checkBatch(body.puzzle_id, answers);
  } catch (err) {
    console.error("write-clues guard failed:", err);
    return jsonResponse(503, { error: "Couldn't check this puzzle just now. Try again in a moment." });
  }
  if (!check.ok) return jsonResponse(check.status, { error: check.error });

  return streamJson(async () => {
    const result = await writeBatch({
      answers: answers.map((answer) => ({ answer })),
      swapLog: body.swap_log,
    });
    if (result.clues.some((c) => c.clue)) await markPuzzleOk(body.puzzle_id);
    return result;
  });
};
