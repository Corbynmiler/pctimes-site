// Regenerate ONE clue for one answer. Called when Leanne clicks the ↻
// next to a clue she doesn't like.
//
// Much cheaper than a full-puzzle regen — one Claude call with a tight
// system prompt reusing the HARD RULES from the main generator.
//
// POST body: { answer, length, rejected_clue, swap_log? }
// Returns:   { clue }

const CLUE_SYSTEM_PROMPT =
`You are a professional crossword compiler writing for the Pōhutukawa Coast Times, a New Zealand community newspaper read by a smart, general adult audience. The editor, Leanne Chamberlin, is sharp — she will reject clues that feel childish, obvious, or culturally wrong.

HARD RULES:
1. ONE definition per clue. NEVER join two definitions with "or" ("Loss of footing or piece of paper" is forbidden — pick ONE). The "or" trick gives the solver two chances and makes the puzzle too easy. If you can't pick a single clean definition, use wordplay instead.
2. New Zealand context. NZ uses metric (km/h, kilometres, metres, Celsius), NOT imperial (mph, miles, Fahrenheit). NZ spelling: colour, metre, theatre, favourite, organise. NZ English, not American. No clues that assume US geography, US sports, or US cultural references unless internationally famous.
3. Medium difficulty. Smart adults should solve. No giveaways like "Yellow fruit" for BANANA or "Opposite of yes" for NO.
4. No overused crossword tropes. Forbidden definitions: "Opera solo" (ARIA), "Yes vote" (AYE), "Needle hole" (EYE), "Toward shelter" (ALEE), "Sch. subj." (nope). Find fresh angles.
5. Clues should be 2-7 words, concise.
6. Do NOT reveal the answer length in the clue text.
7. Formal newspaper tone. No slang, no emoji, no exclamation marks.
8. Prefer definition + light wordplay over pure definition when possible, but keep it accessible — this is a quick crossword, not a cryptic.

9. For abbreviations and initialisms: clue them WITHOUT flagging them as such whenever possible. "Help page section" for FAQ is fine — do NOT write "Help page section, briefly". Only add ", briefly" or "(abbr.)" when it is genuinely needed to avoid misleading the solver. Over-using "briefly" is the single clearest tell of a lazy clue.`;

function looksLikeDoubleDefinition(clue) {
  if (!clue) return false;
  const m = clue.match(/^(.+?)\s+or\s+(.+)$/i);
  if (!m) return false;
  const left = m[1].trim(), right = m[2].trim();
  const stopWords = /^(more|less|so|two|three|four|five|six|seven|eight|nine|ten)$/i;
  if (stopWords.test(left) || stopWords.test(right)) return false;
  if (/briefly|abbr\.?\)?/i.test(clue)) return false;
  return left.length >= 3 && right.length >= 3;
}
function looksUSCentric(clue) {
  return /\b(mph|mile|miles|fahrenheit|yards?|feet|inches?|pounds?|gallons?)\b/i.test(clue || "");
}

async function callClaude(prompt, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      system: CLUE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Anthropic API failed: ${res.status} ${txt.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = (json.content || []).map((p) => p.text || "").join("").trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "POST only" });
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return json(500, { error: "ANTHROPIC_API_KEY not set." });

    const body = JSON.parse(event.body || "{}");
    const answer = String(body.answer || "").toUpperCase().trim();
    const length = Number(body.length || answer.length);
    const rejected = String(body.rejected_clue || "").trim();
    const swapLog = Array.isArray(body.swap_log) ? body.swap_log.slice(-10) : [];

    if (!/^[A-Z]{2,15}$/.test(answer)) return json(400, { error: "Invalid answer" });

    // Build "learned preferences" hint from Leanne's previous swap history
    // (passed by the client — stored in her browser). Last 10 swaps show the
    // style she rejects vs the style she keeps.
    const historyBlock = swapLog.length
      ? `\n\nLeanne's recent clue preferences (for context — do NOT reuse these verbatim):\n` +
        swapLog.map((s) => `- For ${s.answer}: REJECTED "${s.rejected}" → KEPT "${s.kept}"`).join("\n")
      : "";

    const prompt =
`Rewrite ONE crossword clue.

Answer: "${answer}" (${length} letters)
${rejected ? `Rejected clue: "${rejected}" — do not produce this or anything close to it.` : ""}${historyBlock}

Write a single fresh clue following the HARD RULES in the system message. Aim for a style that matches what Leanne has kept in past puzzles.

Return ONLY this JSON, nothing else, no markdown fences:
{"answer": "${answer}", "clue": "..."}`;

    // Up to 3 attempts to get past the automatic quality filter.
    let clue = null;
    for (let i = 0; i < 3; i++) {
      const parsed = await callClaude(prompt, apiKey);
      const candidate = parsed && parsed.clue;
      if (!candidate) continue;
      if (candidate.toLowerCase() === rejected.toLowerCase()) continue;
      if (looksLikeDoubleDefinition(candidate)) continue;
      if (looksUSCentric(candidate)) continue;
      clue = candidate;
      break;
    }
    if (!clue) return json(500, { error: "Could not produce a clean clue. Try again." });

    return json(200, { answer, clue });
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
