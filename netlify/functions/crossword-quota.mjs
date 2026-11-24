// This week's crossword allowance, for the admin page to display.
//
// GET  → { puzzles_used, puzzles_limit, rewrites_used, rewrites_limit, resets, exempt }
// POST { release: puzzle_id } → same, after refunding that puzzle if none
//      of its clue batches succeeded (the page sends this when every batch
//      failed, so a failed attempt doesn't use up a puzzle).
//
// Signed-in editors only. Limits live in netlify/crossword/guard.mjs.

import { requireEditor, getQuota, releasePuzzle, jsonResponse } from "../crossword/guard.mjs";

export default async (req) => {
  const auth = await requireEditor(req);
  if (auth.response) return auth.response;
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      return jsonResponse(200, await releasePuzzle(auth.editor, String(body.release || "")));
    }
    return jsonResponse(200, await getQuota(auth.editor));
  } catch (err) {
    console.error("crossword-quota failed:", err);
    return jsonResponse(503, { error: "Couldn't check this week's allowance just now. Try again in a minute." });
  }
};
