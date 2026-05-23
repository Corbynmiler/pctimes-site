const yaml = require("js-yaml");
const MarkdownIt = require("markdown-it");
const md = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: false });

module.exports = function (eleventyConfig) {
  // YAML support for _data/*.yml — Eleventy 3 doesn't include this by default
  eleventyConfig.addDataExtension("yml,yaml", (contents) => yaml.load(contents));

  // Don't render anything inside /admin as a template — Sveltia's HTML/YAML
  // ship through untouched.
  eleventyConfig.ignores.add("src/admin/**/*");

  // Static asset passthrough
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });
  eleventyConfig.addPassthroughCopy({ "src/files": "files" });
  eleventyConfig.addPassthroughCopy({ "src/admin": "admin" });
  eleventyConfig.addPassthroughCopy({ "src/robots.txt": "robots.txt" });

  // Watch CSS for live reload
  eleventyConfig.addWatchTarget("src/assets/css/");

  // Format a date like "22 May 2026"
  eleventyConfig.addFilter("formatDate", (value) => {
    if (!value) return "";
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return value;
    const months = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  });

  // Year shortcode for footer copyright
  eleventyConfig.addShortcode("year", () => `${new Date().getFullYear()}`);

  // Format number with thousand separators (6800 -> "6,800")
  eleventyConfig.addFilter("thousands", (value) => {
    if (value === undefined || value === null) return "";
    const n = Number(value);
    if (Number.isNaN(n)) return String(value);
    return n.toLocaleString("en-NZ");
  });

  // Render a Markdown string to HTML (block-level)
  eleventyConfig.addFilter("markdown", (value) => {
    if (!value) return "";
    return md.render(String(value));
  });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data",
    },
    templateFormats: ["njk", "md", "html"],
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
  };
};
