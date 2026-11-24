// Step 2 of 2: write and fact-check clues for a batch of crossword answers.
// The page splits each puzzle's answers into small batches and calls this
// once per batch, in parallel. The response streams (see streamJson in
// netlify/crossword/clues.mjs) so a slow batch isn't cut off as idle.
//
// POST body: { answers: ["PRIVILEGE", ...], difficulty?, swap_log? }
// Returns:   { clues: [{answer, clue}], checked, level, ms, usage }
//            or { error } on failure.

import { writeBatch, streamJson, jsonResponse } from "../crossword/clues.mjs";
const MAX_BATCH = 10;

export default async (req) => {
  if (req.method !== "POST") return jsonResponse(405, { error: "POST only" });
  const body = await req.json().catch(() => ({}));
  const raw = Array.isArray(body.answers) ? body.answers : [];
  const answers = [...new Set(raw.map((a) => String(a || "").toUpperCase().trim()))]
    .filter((a) => /^[A-Z]{3,15}$/.test(a))
    .map((answer) => ({ answer }));
  if (!answers.length) return jsonResponse(400, { error: "No valid answers sent." });
  if (answers.length > MAX_BATCH) return jsonResponse(400, { error: `At most ${MAX_BATCH} answers per batch.` });

  return streamJson(() => writeBatch({
    answers,
    difficulty: String(body.difficulty || ""),
    swapLog: body.swap_log,
  }));
};
