// Decode HTML entities in scraped issue yml files; normalise the date to plain YYYY-MM-DD.
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const DIR = path.join(__dirname, "..", "src", "_data", "issues");

function decode(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/&#8217;/g, "’")
    .replace(/&#8216;/g, "‘")
    .replace(/&#8220;/g, "“")
    .replace(/&#8221;/g, "”")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&#8230;/g, "…")
    .replace(/&#363;/g, "ū")
    .replace(/&#257;/g, "ā")
    .replace(/&#299;/g, "ī")
    .replace(/&#333;/g, "ō")
    .replace(/&#363;/g, "ū")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    // generic decimal entities as a fallback
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

const files = fs.readdirSync(DIR).filter(f => f.endsWith(".yml"));
let cleaned = 0;
for (const f of files) {
  const fp = path.join(DIR, f);
  const data = yaml.load(fs.readFileSync(fp, "utf8")) || {};

  // Normalise date to YYYY-MM-DD string (was being written as ISO datetime)
  if (data.date instanceof Date) {
    const d = data.date;
    data.date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  } else if (typeof data.date === "string" && data.date.includes("T")) {
    data.date = data.date.slice(0, 10);
  }

  // Decode entities everywhere
  if (Array.isArray(data.in_this_issue)) data.in_this_issue = data.in_this_issue.map(decode);
  if (typeof data.blurb === "string") data.blurb = decode(data.blurb);
  if (typeof data.title === "string") data.title = decode(data.title);

  fs.writeFileSync(fp, yaml.dump(data, { lineWidth: 120, quotingType: "'", forceQuotes: false }));
  cleaned++;
}
console.log(`Cleaned ${cleaned} files`);
