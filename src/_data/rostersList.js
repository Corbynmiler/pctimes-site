// Reads every yml in src/_data/rosters/, returns the combined roster index.
// Used by src/admin-data.njk to build the JSON file the Roster dashboard
// consumes, and could be reused later by templated views on the public site.

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

module.exports = function () {
  const dir = path.join(__dirname, "rosters");
  if (!fs.existsSync(dir)) return { rosters: [] };

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();

  const rosters = files
    .map((f) => {
      try {
        return yaml.load(fs.readFileSync(path.join(dir, f), "utf8")) || {};
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);

  return { rosters };
};
