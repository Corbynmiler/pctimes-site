// Regenerate ONE clue — called when Leanne clicks the ↻ next to a clue she
// doesn't like (or one that came back blank). Same compiler + editor passes
// as the full puzzle (see netlify/crossword/clues.mjs), told what she
// rejected and shown her recent rewrites so it moves towards her taste.
// Signed-in editors only; each rewrite comes out of the weekly allowance,
// and a failed one is refunded (see netlify/crossword/guard.mjs).
// Streams, like write-clues, so a slow rewrite isn't cut off as idle.
//
// POST body: { answer, rejected_clue?, swap_log? }
// Returns:   { answer, clue, checked, quota } or { error, quota? }.

import { writeBatch, streamJson } from "../crossword/clues.mjs";
import { requireEditor, claimRewrite, jsonResponse } from "../crossword/guard.mjs";

export default async (req) => {
  if (req.method !== "POST") return jsonResponse(405, { error: "POST only" });
  const auth = await requireEditor(req);
  if (auth.response) return auth.response;

  const body = await req.json().catch(() => ({}));
  const answer = String(body.answer || "").toUpperCase().trim();
  if (!/^[A-Z]{2,15}$/.test(answer)) return jsonResponse(400, { error: "Invalid answer" });
  const rejected = String(body.rejected_clue || "").trim().slice(0, 200);

  let claim;
  try {
    claim = await claimRewrite(auth.editor);
  } catch (err) {
    console.error("regenerate-clue guard failed:", err);
    return jsonResponse(503, { error: "Couldn't check this week's allowance just now. Try again in a moment." });
  }
  if (!claim.allowed) {
    return jsonResponse(429, {
      error: `You've used this week's ${claim.quota.rewrites_limit} clue rewrites. They reset on Monday.`,
      code: "limit",
      quota: claim.quota,
    });
  }

  return streamJson(async () => {
    try {
      const result = await writeBatch({
        answers: [{ answer }],
        swapLog: body.swap_log,
        rejectedClue: rejected,
      });
      const clue = result.clues[0] && result.clues[0].clue;
      if (!clue || clue.toLowerCase() === rejected.toLowerCase()) {
        throw new Error("Could not produce a clean clue. Try again.");
      }
      return { answer, clue, checked: result.checked, quota: claim.quota };
    } catch (err) {
      await claim.refund().catch(() => {});
      throw err;
    }
  });
};
