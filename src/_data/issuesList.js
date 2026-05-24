// Computed data: read every yml in src/_data/issues/, sort by date desc,
// expose `issuesList.latest` (current edition) and `issuesList.previous` (archive).
//
// This makes the newest issue *automatically* the "this week's paper" on the
// home page and the Latest Issue page — no separate "current vs archive"
// editing. Adding a new issue in the CMS demotes the previous one without any
// manual archiving step.
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

module.exports = function () {
  const dir = path.join(__dirname, "issues");
  if (!fs.existsSync(dir)) return { latest: null, previous: [], all: [] };

  const items = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => {
      try { return yaml.load(fs.readFileSync(path.join(dir, f), "utf8")) || {}; }
      catch { return null; }
    })
    .filter((it) => it && it.issue_number);

  // Sort newest first by date; fall back to issue_number if dates tie/missing
  items.sort((a, b) => {
    const ad = a.date ? Date.parse(a.date) : 0;
    const bd = b.date ? Date.parse(b.date) : 0;
    if (bd !== ad) return bd - ad;
    return (b.issue_number || 0) - (a.issue_number || 0);
  });

  return {
    latest: items[0] || null,
    previous: items.slice(1),
    all: items,
  };
};
