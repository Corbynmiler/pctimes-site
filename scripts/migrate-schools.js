#!/usr/bin/env node
// Migrate the Schools roster CSV into the roster YAML schema.
// Handles the schools sheet's columns: School, Contact, Date due, Date published,
// Student's name, Barfoots agent, contacted, awarded.
//
// Usage:
//   node scripts/migrate-schools.js <csv-path>

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const [, , csvPath] = process.argv;
if (!csvPath) { console.error("Usage: node scripts/migrate-schools.js <csv-path>"); process.exit(1); }

// --- CSV parse (handles quoted fields with commas) ---------------------
const csv = fs.readFileSync(csvPath, "utf8");
function parseCSV(text) {
  const rows = []; let row = []; let cell = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q) {
      if (c === '"' && n === '"') { cell += '"'; i++; }
      else if (c === '"') { q = false; }
      else { cell += c; }
    } else {
      if (c === '"') { q = true; }
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (c === "\r") { /* skip */ }
      else { cell += c; }
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const rows = parseCSV(csv).map((r) => r.map((c) => c.trim()));

const headerIdx = rows.findIndex((r) => r.some((c) => /school/i.test(c)) && r.some((c) => /contact/i.test(c)));
if (headerIdx === -1) { console.error("Could not find header"); process.exit(1); }
const dataRows = rows.slice(headerIdx + 1);

// --- Date parsing (same patterns as the GE sheet, plus "27-Feb" style) --
const EMAIL_RE = /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i;
const DEFAULT_YEAR = 2026;
function parseDate(s) {
  s = (s || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // US MM/DD/YYYY
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return iso(m[3], m[1], m[2]);
  // DD.MM.YY
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return iso(y, m[2], m[1]);
  }
  // "27-Feb" or "4 Sept" (short) with optional year
  const cleaned = s.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+/i, "").trim();
  // "27-Feb" → day-month
  m = cleaned.match(/^(\d{1,2})[-\s]+([A-Za-z]{3,})(?:[-\s]+(\d{4}))?$/);
  if (m) {
    const mm = monthNumber(m[2]);
    if (!mm) return "";
    const y = m[3] || String(DEFAULT_YEAR);
    return iso(y, mm, m[1]);
  }
  // "27 Feb 2026"
  m = cleaned.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (m) {
    const mm = monthNumber(m[2]);
    if (!mm) return "";
    return iso(m[3], mm, m[1]);
  }
  return "";
}
function iso(y, m, d) {
  const mm = String(parseInt(m, 10)).padStart(2, "0");
  const dd = String(parseInt(d, 10)).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}
function monthNumber(s) {
  const map = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  return map[s.slice(0, 4).toLowerCase()] || map[s.slice(0, 3).toLowerCase()] || 0;
}
function slugify(s) {
  return String(s || "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
}

// --- Build ------------------------------------------------------------
const contributors = new Map();
const slots = [];
const warnings = [];

for (let i = 0; i < dataRows.length; i++) {
  const [schoolRaw, contactRaw, dueRaw, pubRaw, studentRaw, barfootsRaw, contactedRaw, awardedRaw] = dataRows[i];
  if (!schoolRaw && !contactRaw && !dueRaw && !pubRaw) continue;
  // Skip "Term 1/2/3/4" section headers and "Holidays:" rows
  if (/^Term\s+\d/i.test(schoolRaw)) continue;
  if (/^holidays?:?$/i.test((contactRaw || "").trim())) continue;
  if (!schoolRaw.trim()) continue;

  const school = schoolRaw.trim();
  const key = slugify(school);

  // Contact — pick first before "/", strip email if present
  const contactRawTrim = (contactRaw || "").trim();
  const firstContact = contactRawTrim.split("/")[0].trim();
  const emailMatch = contactRawTrim.match(EMAIL_RE);
  const email = emailMatch ? emailMatch[1] : "";
  const contactName = firstContact.replace(EMAIL_RE, "").replace(/[,\-]+\s*$/, "").trim();

  if (!contributors.has(key)) {
    contributors.set(key, {
      key, organisation: school, display_name: contactName, email, self_authored: false, notes: "",
    });
  } else {
    const existing = contributors.get(key);
    if (!existing.email && email) existing.email = email;
    if (!existing.display_name && contactName) existing.display_name = contactName;
  }

  const due = parseDate(dueRaw);
  const pub = parseDate(pubRaw);
  if (!due) warnings.push(`row ${headerIdx + 2 + i}: couldn't parse due "${dueRaw}" (school: ${school})`);
  if (!pub) warnings.push(`row ${headerIdx + 2 + i}: couldn't parse pub "${pubRaw}" (school: ${school})`);

  const contacted = /^y/i.test(contactedRaw || "");
  const slotNotes = [];
  if (studentRaw && studentRaw.trim()) slotNotes.push(`Student: ${studentRaw.trim()}`);
  if (barfootsRaw && barfootsRaw.trim()) slotNotes.push(`Barfoots agent: ${barfootsRaw.trim()}`);
  if (awardedRaw && /^y/i.test(awardedRaw)) slotNotes.push("Award given");

  slots.push({
    issue_date: pub,
    due_date: due,
    contributor_key: key,
    status: contacted ? "received" : "pending",
    notes: slotNotes.join(" · "),
    chase_log: [],
  });
}

const output = {
  roster: {
    key: "schools",
    label: "Schools",
    default_lead_days: 30,
    default_followup_days: 23,
    template_key: "schools",
  },
  contributors: Array.from(contributors.values()).sort((a, b) => a.key.localeCompare(b.key)),
  slots: slots.sort((a, b) => (a.issue_date || "").localeCompare(b.issue_date || "")),
};

const outPath = path.join(__dirname, "..", "src", "_data", "rosters", "schools.yml");
fs.writeFileSync(
  outPath,
  "# Generated by scripts/migrate-schools.js. Hand-edit from here.\n\n" +
  yaml.dump(output, { lineWidth: 100, noRefs: true }),
);
console.log(`✔ ${outPath}`);
console.log(`   ${output.contributors.length} schools, ${output.slots.length} slots, ${warnings.length} warnings`);
if (warnings.length) for (const w of warnings.slice(0, 5)) console.log(`   ⚠ ${w}`);

// Report missing emails
const missing = output.contributors.filter((c) => !c.email);
if (missing.length) {
  const report = [
    `# Schools roster migration report`,
    ``,
    `${missing.length} schools without an email — Leanne to fill via chaser inline edit.`,
    ``,
    ...missing.map((c) => `- **${c.organisation}** — contact: \`${c.display_name || "(none)"}\``),
    ``,
  ].join("\n");
  const reportPath = path.join(__dirname, "..", "MIGRATION_REPORT_schools.md");
  fs.writeFileSync(reportPath, report);
  console.log(`✔ ${reportPath}`);
}
