// Re-download covers, falling back to 320x320 if 600x600 doesn't exist.
const fs = require("fs");
const path = require("path");
const https = require("https");
const yaml = require("js-yaml");

const ROOT = path.join(__dirname, "..");
const ISSUES_DIR = path.join(ROOT, "src/_data/issues");
const IMG_DIR = path.join(ROOT, "src/assets/images/archive");

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "pctimes-importer/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

(async () => {
  // Need the original 320x320 URLs — recover them from the cached archive HTML
  const all = fs.readdirSync("/tmp/pctimes_pages").filter(f => /^p\d+\.html$/.test(f));
  const map = {}; // blogId -> 320 url
  for (const f of all) {
    const html = fs.readFileSync(`/tmp/pctimes_pages/${f}`, "utf8");
    const re = /<div class="cmsItem\s+BlogItem"\s+blogid="(\d+)">([\s\S]*?)<\/li>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const img = m[2].match(/src="(https:\/\/webimages\.cms-tool\.net\/[^"]+)"/);
      if (img) map[m[1]] = img[1];
    }
  }

  const ymlFiles = fs.readdirSync(ISSUES_DIR).filter(f => f.endsWith(".yml"));
  let ok = 0, fail = 0;
  for (const f of ymlFiles) {
    const fp = path.join(ISSUES_DIR, f);
    const data = yaml.load(fs.readFileSync(fp, "utf8"));
    // Find the blog id from the cover_image URL if it's already local
    let blogId = null;
    if (data.cover_image && data.cover_image.startsWith("/assets/images/archive/")) {
      blogId = path.basename(data.cover_image, ".jpg");
    }
    if (!blogId) {
      // Try matching by issue number via the cached HTML — find blogId whose 320 url matches an image
      // for entries that ended up with a remote URL still in cover_image
      const match = Object.entries(map).find(([id, url]) => url === data.cover_image || data.cover_image.endsWith(path.basename(url)));
      if (match) blogId = match[0];
    }
    if (!blogId) { fail++; continue; }

    const url320 = map[blogId];
    if (!url320) { fail++; continue; }

    const dest = path.join(IMG_DIR, `${blogId}.jpg`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
      // Already have it — make sure yml points at local
      if (data.cover_image !== `/assets/images/archive/${blogId}.jpg`) {
        data.cover_image = `/assets/images/archive/${blogId}.jpg`;
        fs.writeFileSync(fp, yaml.dump(data, { lineWidth: 120 }));
      }
      ok++;
      continue;
    }
    try {
      // Try 600 first (might succeed for newer), fall back to 320
      let buf;
      try { buf = await get(url320.replace("/images-320x320/", "/images-600x600/")); }
      catch { buf = await get(url320); }
      fs.writeFileSync(dest, buf);
      data.cover_image = `/assets/images/archive/${blogId}.jpg`;
      fs.writeFileSync(fp, yaml.dump(data, { lineWidth: 120 }));
      ok++;
      process.stdout.write(`\r  ${ok} ok / ${fail} fail   `);
    } catch (e) {
      console.warn(`\n  ${f}: ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDone: ${ok} ok, ${fail} fail`);
})();
