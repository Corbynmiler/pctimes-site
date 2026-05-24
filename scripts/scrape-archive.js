// One-off importer: scrape the old pctimes.co.nz archive into our new issues/ folder.
// Run with:  node scripts/scrape-archive.js
//
// What it does:
//   1. Parses cached /tmp/pctimes_pages/p{0,30,60,...}.html for issue listings
//   2. For each issue, fetches the blog page to find the PDF URL
//   3. Downloads PDFs to src/files/issues/archive/<blogId>.pdf
//   4. Downloads preview images to src/assets/images/archive/<blogId>.jpg
//   5. Writes one yml per issue into src/_data/issues/
//
// Skips "Coast & Country Property Guide" entries (we don't render them right now).

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const PAGES_DIR = "/tmp/pctimes_pages";
const ISSUES_DIR = path.join(ROOT, "src/_data/issues");
const PDF_DIR = path.join(ROOT, "src/files/issues/archive");
const IMG_DIR = path.join(ROOT, "src/assets/images/archive");

fs.mkdirSync(ISSUES_DIR, { recursive: true });
fs.mkdirSync(PDF_DIR, { recursive: true });
fs.mkdirSync(IMG_DIR, { recursive: true });

// ---- Tiny helpers ----------------------------------------------------------
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "pctimes-importer/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) return Promise.resolve(false); // already present
  return get(url).then((buf) => {
    fs.writeFileSync(dest, buf);
    return true;
  });
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

function yamlEscape(v) {
  if (v === null || v === undefined) return "''";
  const s = String(v);
  if (s === "") return "''";
  // Always quote if contains special chars
  if (/[:#\[\]{}&*!|>'"%@`,\n]/.test(s)) {
    return "'" + s.replace(/'/g, "''") + "'";
  }
  return s;
}

function dateToISO(dateStr) {
  // "22 May 2026" -> "2026-05-22"
  const months = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
                   january:1, february:2, march:3, april:4, june:6, july:7, august:8, september:9, october:10, november:11, december:12 };
  const m = dateStr.trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const day = String(parseInt(m[1], 10)).padStart(2, "0");
  const mo = months[m[2].toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, "0")}-${day}`;
}

// ---- Parse one cached archive page ----------------------------------------
function parsePage(html) {
  const items = [];
  // Split on cmsItem wrappers
  const re = /<div class="cmsItem\s+BlogItem"\s+blogid="(\d+)">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const blogId = m[1];
    const block = m[2];

    const imgMatch = block.match(/<img src="(https:\/\/webimages\.cms-tool\.net\/[^"]+)"/);
    const titleMatch = block.match(/<div class="cmsTitle"><b><a href="\/blog\/\d+"[^>]*>([^<]+)<\/a>/);
    const descMatch = block.match(/<div class="summary cmsText">\s*([\s\S]*?)\s*<\/div>/);

    if (!titleMatch) continue;
    const title = decodeEntities(titleMatch[1].trim());

    let bullets = [];
    let blurb = "";
    if (descMatch) {
      const raw = descMatch[1]
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .trim();
      const lines = raw.split("\n").map((l) => decodeEntities(l).trim()).filter(Boolean);
      // Drop leading "In this issue:" header
      const startIdx = lines.findIndex((l) => /^in this issue/i.test(l));
      const body = startIdx >= 0 ? lines.slice(startIdx + 1) : lines;
      // Bulleted lines start with "-" or "•"
      bullets = body
        .filter((l) => /^[-•]\s*/.test(l))
        .map((l) => l.replace(/^[-•]\s*/, "").trim())
        .filter(Boolean);
      if (bullets.length === 0 && body.length > 0) blurb = body.join(" ").slice(0, 280);
    }

    // Issue number + date
    const issueMatch = title.match(/Issue\s+(\d+)\s*[-–—]+\s*(.+)$/i);
    const isPropertyGuide = /Property\s+Guide/i.test(title);

    items.push({
      blogId,
      blogUrl: `https://www.pctimes.co.nz/blog/${blogId}`,
      imageUrlThumb: imgMatch ? imgMatch[1] : "",
      // Higher-res variant (the cms-tool resizer accepts other dimensions)
      imageUrlLarge: imgMatch ? imgMatch[1].replace("/images-320x320/", "/images-600x600/") : "",
      title,
      isPropertyGuide,
      issueNumber: !isPropertyGuide && issueMatch ? parseInt(issueMatch[1], 10) : null,
      dateRaw: !isPropertyGuide && issueMatch ? issueMatch[2].trim() : (isPropertyGuide ? title.replace(/.*Property Guide\s*[-–—]?\s*/i, "").trim() : null),
      isoDate: null, // filled later
      bullets,
      blurb,
      pdfUrl: null, // filled later
    });
  }
  return items;
}

// ---- Main ------------------------------------------------------------------
(async () => {
  // 1. Parse cached pages
  const pageFiles = fs.readdirSync(PAGES_DIR).filter((f) => f.startsWith("p") && f.endsWith(".html"));
  let all = [];
  for (const f of pageFiles) {
    const html = fs.readFileSync(path.join(PAGES_DIR, f), "utf8");
    all = all.concat(parsePage(html));
  }
  // De-dupe by blogId
  const seen = new Set();
  all = all.filter((it) => {
    if (seen.has(it.blogId)) return false;
    seen.add(it.blogId);
    return true;
  });
  console.log(`Parsed ${all.length} entries total`);

  // 2. Resolve ISO dates
  for (const it of all) {
    if (it.dateRaw) it.isoDate = dateToISO(it.dateRaw);
  }

  // 3. Skip Property Guides for now (user said hide for phase 1/2)
  const issues = all.filter((it) => !it.isPropertyGuide && it.issueNumber && it.isoDate);
  console.log(`${issues.length} weekly issues to import (Property Guides skipped)`);

  // 4. For each issue, fetch blog page → find PDF URL
  console.log("Fetching blog pages for PDF URLs...");
  for (let i = 0; i < issues.length; i++) {
    const it = issues[i];
    try {
      const html = (await get(it.blogUrl)).toString("utf8");
      const pdfMatch = html.match(/href="(\/files\/[^"]+\.pdf)"/i);
      if (pdfMatch) it.pdfUrl = `https://www.pctimes.co.nz${pdfMatch[1]}`;
      process.stdout.write(`\r  ${i + 1}/${issues.length}  Issue ${it.issueNumber}  ${it.pdfUrl ? "ok" : "no-pdf"}   `);
    } catch (e) {
      process.stdout.write(`\r  ${i + 1}/${issues.length}  Issue ${it.issueNumber}  err: ${e.message}   `);
    }
  }
  console.log("");

  // 5. Download PDFs + images (with progress)
  console.log("Downloading PDFs + images...");
  for (let i = 0; i < issues.length; i++) {
    const it = issues[i];
    const pdfDest = path.join(PDF_DIR, `${it.blogId}.pdf`);
    const imgDest = path.join(IMG_DIR, `${it.blogId}.jpg`);
    try {
      if (it.pdfUrl) {
        await download(it.pdfUrl, pdfDest);
        it.localPdf = `/files/issues/archive/${it.blogId}.pdf`;
      }
    } catch (e) { console.warn(`\n  PDF fail Issue ${it.issueNumber}: ${e.message}`); }
    try {
      if (it.imageUrlLarge) {
        await download(it.imageUrlLarge, imgDest);
        it.localImg = `/assets/images/archive/${it.blogId}.jpg`;
      }
    } catch (e) { console.warn(`\n  IMG fail Issue ${it.issueNumber}: ${e.message}`); }
    process.stdout.write(`\r  ${i + 1}/${issues.length}   `);
  }
  console.log("");

  // 6. Write one yml per issue
  console.log("Writing yml files...");
  for (const it of issues) {
    const fname = `${String(it.issueNumber).padStart(4, "0")}.yml`;
    const fpath = path.join(ISSUES_DIR, fname);
    if (fs.existsSync(fpath)) continue; // don't overwrite manual edits
    const lines = [];
    lines.push(`issue_number: ${it.issueNumber}`);
    lines.push(`date: ${it.isoDate}`);
    lines.push(`title: ''`);
    lines.push(`blurb: ${yamlEscape(it.blurb)}`);
    if (it.bullets.length) {
      lines.push("in_this_issue:");
      for (const b of it.bullets) lines.push(`  - ${yamlEscape(b)}`);
    } else {
      lines.push("in_this_issue: []");
    }
    lines.push(`pdf: ${yamlEscape(it.localPdf || it.pdfUrl || "")}`);
    lines.push(`cover_image: ${yamlEscape(it.localImg || it.imageUrlLarge || "")}`);
    lines.push(`flipbook_url: ''`);
    lines.push(`editor_notes: ''`);
    fs.writeFileSync(fpath, lines.join("\n") + "\n");
  }
  console.log(`Wrote ${issues.length} issue files to src/_data/issues/`);
})();
