#!/usr/bin/env node
// One-off migration from the exported Google Sheets CSV into the new
// src/_data/rosters/*.yml schema. Produces:
//   - src/_data/rosters/<key>.yml  (contributors + slots)
//   - MIGRATION_REPORT.md          (ambiguities Leanne needs to resolve)
//
// Safe to re-run — overwrites outputs. Never emails anyone. Never touches
// anything outside the repo.
//
// Usage:
//   node scripts/migrate-roster.js <csv-path> <roster-key> <roster-label>
//
// Example:
//   node scripts/migrate-roster.js /tmp/claude-501/roster_sheet1.csv \
//        guest_editorial "Guest Editorial"

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const [, , csvPath, rosterKey, rosterLabel] = process.argv;
if (!csvPath || !rosterKey || !rosterLabel) {
  console.error("Usage: node scripts/migrate-roster.js <csv-path> <roster-key> <roster-label>");
  process.exit(1);
}

const csv = fs.readFileSync(csvPath, "utf8");
const lines = csv.split(/\r?\n/);

// ---- CSV parsing (fields have no embedded commas / quotes in this sheet) --
const rows = lines.map((l) => l.split(",").map((c) => c.trim()));

// Find the header row (contains "Organisation" or "Contact")
const headerIdx = rows.findIndex((r) => r.some((c) => /organisation/i.test(c)));
if (headerIdx === -1) {
  console.error("Could not find header row in CSV");
  process.exit(1);
}
const dataRows = rows.slice(headerIdx + 1).filter((r) => r.some((c) => c && c.length));

// ---- Helpers --------------------------------------------------------------

const EMAIL_RE = /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i;

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function parseContact(raw) {
  const text = (raw || "").trim();
  if (!text) return { display_name: "", email: "", notes: "" };
  const emailMatch = text.match(EMAIL_RE);
  const email = emailMatch ? emailMatch[1] : "";
  // Remove the email from the string to get the name
  let name = email ? text.replace(email, "").trim() : text;
  // Strip trailing hyphens/dashes
  name = name.replace(/[-,–]\s*$/, "").trim();
  // Pull out "received" / status markers that got jammed into the contact cell
  const notesParts = [];
  const statusWords = /\b(received|supplying|not supplying|pending)\b/i;
  if (statusWords.test(name)) {
    const m = name.match(statusWords);
    if (m) notesParts.push(`contact-cell note: "${m[0]}"`);
    name = name.replace(statusWords, "").replace(/[-,–]\s*$/, "").trim();
  }
  return { display_name: name, email, notes: notesParts.join("; ") };
}

// Date parsers — in order of specificity. All resolve to YYYY-MM-DD.
function parseDate(raw, defaultYear) {
  const s = (raw || "").trim();
  if (!s) return { iso: "", raw: s, note: "empty" };

  // ISO form: 2026-01-30
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { iso: s, raw: s };

  // US MM/DD/YYYY form: 7/23/2026
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return { iso: iso(yyyy, mm, dd), raw: s, note: "US MM/DD/YYYY" };
  }

  // Dot form: 30.1.26 or 30.1.2026
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
  if (m) {
    const [, dd, mm, yy] = m;
    const yyyy = yy.length === 2 ? `20${yy}` : yy;
    return { iso: iso(yyyy, mm, dd), raw: s, note: "DD.MM.YY" };
  }

  // Textual: "22 Jan", "Thursday 29 Jan", "3 Sept 2026", "4 Sept", "17 Jul"
  // Strip leading weekday word if present
  const cleaned = s.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+/i, "").trim();
  m = cleaned.match(/^(\d{1,2})\s+([A-Za-z]{3,})(?:\s+(\d{4}))?$/);
  if (m) {
    const [, dd, monStr, yearStr] = m;
    const mm = monthNumber(monStr);
    if (!mm) return { iso: "", raw: s, note: `unknown month "${monStr}"` };
    const yyyy = yearStr || String(defaultYear);
    return { iso: iso(yyyy, mm, dd), raw: s, note: yearStr ? "" : "year inferred" };
  }

  return { iso: "", raw: s, note: "unrecognised format" };
}

function iso(y, m, d) {
  const mm = String(parseInt(m, 10)).padStart(2, "0");
  const dd = String(parseInt(d, 10)).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

function monthNumber(s) {
  const map = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  };
  return map[s.slice(0, 4).toLowerCase()] || map[s.slice(0, 3).toLowerCase()] || 0;
}

// ---- Build model ---------------------------------------------------------

const DEFAULT_YEAR = 2026; // sheet is 2026 dates despite the 2025 title
const contributors = new Map(); // key -> record
const slots = [];
const warnings = [];

for (let i = 0; i < dataRows.length; i++) {
  const [orgRaw, contactRaw, dueRaw, pubRaw, contactedRaw] = dataRows[i];
  const rowNum = headerIdx + 2 + i; // 1-indexed CSV line number

  // Skip the trailing TODO note ("add Chris Luxon…")
  if (orgRaw && /^add .* to .* schedule/i.test(orgRaw)) {
    warnings.push(`Row ${rowNum}: trailing TODO ("${orgRaw}") kept as reminder only, not imported.`);
    continue;
  }

  if (!orgRaw && !contactRaw && !dueRaw && !pubRaw) continue;

  // Detect "org has status jammed into name" patterns
  let organisation = orgRaw;
  let perSlotStatus = null;
  let perSlotNotes = [];

  if (/not supplying/i.test(organisation)) {
    perSlotStatus = "not_supplying";
    organisation = organisation.replace(/\s*(not supplying)\s*/i, "").trim();
    perSlotNotes.push("imported as 'not_supplying' — organisation name had 'not supplying' in it");
  }

  if (/\?/.test(organisation)) {
    perSlotNotes.push(`organisation unclear in source: "${orgRaw}" — Leanne to confirm`);
  }

  const contact = parseContact(contactRaw);
  const key = slugify(organisation);
  if (!key) {
    warnings.push(`Row ${rowNum}: no organisation name, skipped.`);
    continue;
  }

  // Register / merge contributor
  const existing = contributors.get(key);
  if (!existing) {
    const selfAuthored = /^leanne$/i.test(contact.display_name);
    contributors.set(key, {
      key,
      organisation,
      display_name: contact.display_name || organisation,
      email: contact.email,
      self_authored: selfAuthored,
      notes: contact.notes,
    });
  } else {
    // Fill in email if we didn't have it before
    if (!existing.email && contact.email) existing.email = contact.email;
    if (!existing.display_name && contact.display_name) existing.display_name = contact.display_name;
    if (contact.notes && !existing.notes.includes(contact.notes)) {
      existing.notes = [existing.notes, contact.notes].filter(Boolean).join("; ");
    }
  }

  const due = parseDate(dueRaw, DEFAULT_YEAR);
  const pub = parseDate(pubRaw, DEFAULT_YEAR);

  if (due.note && due.note !== "DD.MM.YY" && due.note !== "year inferred") {
    warnings.push(`Row ${rowNum} (${organisation}): due_date "${dueRaw}" → ${due.iso || "FAILED"} (${due.note})`);
  }
  if (pub.note && pub.note !== "DD.MM.YY" && pub.note !== "year inferred") {
    warnings.push(`Row ${rowNum} (${organisation}): issue_date "${pubRaw}" → ${pub.iso || "FAILED"} (${pub.note})`);
  }

  // Derive initial status
  let status = perSlotStatus || "pending";
  if (!perSlotStatus) {
    const contacted = /^y/i.test(contactedRaw || "");
    if (contacted) status = "received"; // historic rows marked "yes" are past & delivered
  }

  slots.push({
    issue_date: pub.iso,
    due_date: due.iso,
    contributor_key: key,
    status,
    notes: perSlotNotes.join("; "),
    source_row: rowNum,
    source_contacted: contactedRaw || "",
    chase_log: [],
  });
}

// ---- Emit YAML -----------------------------------------------------------

const contributorsArr = Array.from(contributors.values()).sort((a, b) => a.key.localeCompare(b.key));

// Sort slots by issue date
slots.sort((a, b) => (a.issue_date || "").localeCompare(b.issue_date || ""));

const output = {
  roster: {
    key: rosterKey,
    label: rosterLabel,
    default_lead_days: 10,
    default_followup_days: 3,
    template_key: rosterKey, // matches chase-templates.yml key
  },
  contributors: contributorsArr.map((c) => ({
    key: c.key,
    organisation: c.organisation,
    display_name: c.display_name || c.organisation,
    email: c.email || "",
    self_authored: !!c.self_authored,
    notes: c.notes || "",
  })),
  slots: slots.map((s) => ({
    issue_date: s.issue_date,
    due_date: s.due_date,
    contributor_key: s.contributor_key,
    status: s.status,
    notes: s.notes,
    chase_log: s.chase_log,
  })),
};

const outDir = path.join(__dirname, "..", "src", "_data", "rosters");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${rosterKey}.yml`);
fs.writeFileSync(
  outPath,
  "# Generated by scripts/migrate-roster.js. Hand-editable from here on.\n" +
    "# The admin at /admin/cms/#/collections/rosters is the primary editor.\n\n" +
    yaml.dump(output, { lineWidth: 100, noRefs: true }),
);
console.log(`✔ Wrote ${outPath} (${contributorsArr.length} contributors, ${slots.length} slots)`);

// ---- Migration report ----------------------------------------------------

const missingEmail = contributorsArr.filter((c) => !c.email && !c.self_authored);
const notSupplying = slots.filter((s) => s.status === "not_supplying");
const unclear = slots.filter((s) => s.notes);

const report = [];
report.push(`# Migration report — ${rosterLabel}`);
report.push("");
report.push(`Generated from \`${path.basename(csvPath)}\` on ${new Date().toISOString()}.`);
report.push("");
report.push(`- Imported **${slots.length} slots** across **${contributorsArr.length} contributors**.`);
report.push(`- **${missingEmail.length} contributors** have no email on file (chase emails cannot be drafted for them yet).`);
report.push(`- **${notSupplying.length} slots** inferred as \`not_supplying\` from the source data.`);
report.push("");
report.push("## Contributors missing an email");
report.push("");
if (missingEmail.length === 0) report.push("_None._");
else {
  for (const c of missingEmail) {
    report.push(`- **${c.organisation}** — contact: \`${c.display_name || "(unknown)"}\``);
  }
}
report.push("");
report.push("## Slots flagged with ambiguities");
report.push("");
if (unclear.length === 0) report.push("_None._");
else {
  for (const s of unclear) {
    report.push(`- Issue date ${s.issue_date || "???"} — ${s.contributor_key} — ${s.notes}`);
  }
}
report.push("");
report.push("## Parser warnings");
report.push("");
if (warnings.length === 0) report.push("_None._");
else {
  for (const w of warnings) report.push(`- ${w}`);
}
report.push("");
report.push("## Next steps for Leanne");
report.push("");
report.push("1. Open **/admin/** → **Roster** → **Contributors** and fill in missing emails.");
report.push("2. Confirm any slot flagged above — change the contributor or clarify the organisation.");
report.push("3. Any row already published (status `received`) is historical — safe to leave as-is.");
report.push("");

const reportPath = path.join(__dirname, "..", `MIGRATION_REPORT_${rosterKey}.md`);
fs.writeFileSync(reportPath, report.join("\n"));
console.log(`✔ Wrote ${reportPath}`);
