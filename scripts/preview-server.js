// Tiny static server for local previewing of the _site output.
// Not used in production. Netlify serves the real site.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8099;
const ROOT = path.join(__dirname, "..", "_site");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const full = path.join(ROOT, p);
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA-ish fallback: try adding .html
      fs.readFile(full + ".html", (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end(`not found: ${p}`); }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(d2);
      });
      return;
    }
    const type = MIME[path.extname(full)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`preview on http://localhost:${PORT}`));
