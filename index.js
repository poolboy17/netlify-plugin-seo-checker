/**
 * netlify-plugin-seo-checker
 *
 * Scans built HTML files after Astro (or any SSG) builds and reports SEO issues.
 *
 * Checks:
 *   1. Missing or empty <title> tags
 *   2. Missing or empty meta descriptions
 *   3. Missing or empty image alt attributes
 *   4. Broken internal links (links to pages that don't exist in the build)
 *   5. Orphan pages (pages with no inbound internal links)
 *   6. Thin content (pages with very little text)
 *   7. Missing canonical tags
 *   8. Missing Open Graph tags
 *   9. Duplicate titles or descriptions across pages
 */

const fs = require("fs");
const path = require("path");

// ── Config defaults ──────────────────────────────────────
const DEFAULTS = {
  minWordCount: 300,
  failOnError: false, // set true to break the build on SEO errors
  ignorePaths: [], // glob patterns to skip
};

// ── HTML parsing helpers (no external deps) ──────────────
function extractTag(html, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = html.match(re);
  return m ? m[1].trim() : null;
}

function extractMeta(html, name) {
  // Matches both name="" and property=""
  const re = new RegExp(
    `<meta\\s+(?:[^>]*?(?:name|property)=["']${name}["'][^>]*?content=["']([^"']*)["']|[^>]*?content=["']([^"']*)["'][^>]*?(?:name|property)=["']${name}["'])`,
    "i"
  );
  const m = html.match(re);
  return m ? (m[1] || m[2] || "").trim() : null;
}

function extractImages(html) {
  const imgs = [];
  const re = /<img\s+([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const srcMatch = attrs.match(/src=["']([^"']*?)["']/i);
    const altMatch = attrs.match(/alt=["']([^"']*?)["']/i);
    imgs.push({
      src: srcMatch ? srcMatch[1] : "",
      alt: altMatch ? altMatch[1].trim() : null,
      hasAlt: altMatch !== null,
    });
  }
  return imgs;
}

function extractInternalLinks(html) {
  const links = [];
  const re = /<a\s+[^>]*href=["']([^"']*?)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    // Internal links: start with / but not // (protocol-relative)
    if (href.startsWith("/") && !href.startsWith("//")) {
      links.push(href.split("#")[0].split("?")[0]); // strip hash and query
    }
  }
  return links;
}

function extractCanonical(html) {
  const re = /<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']*?)["']/i;
  const m = html.match(re);
  return m ? m[1].trim() : null;
}

function stripHtml(html) {
  // Remove script and style blocks, then all tags
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function countWords(text) {
  return text
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

// ── Main plugin ──────────────────────────────────────────
module.exports = {
  onPostBuild: async ({ constants, utils, inputs }) => {
    const publishDir = constants.PUBLISH_DIR;
    const config = { ...DEFAULTS, ...inputs };

    console.log("\n🔍 SEO Checker — scanning built HTML...\n");

    // 1. Find all HTML files
    const htmlFiles = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".html")) htmlFiles.push(full);
      }
    }
    walk(publishDir);

    if (htmlFiles.length === 0) {
      console.log("⚠️  No HTML files found in publish directory.");
      return;
    }

    console.log(`   Found ${htmlFiles.length} HTML files\n`);

    // 2. Parse each file
    const pages = [];
    for (const file of htmlFiles) {
      const relPath = "/" + path.relative(publishDir, file).replace(/\\/g, "/");
      // Normalize: /blog/foo/index.html → /blog/foo/
      const urlPath = relPath.replace(/\/index\.html$/, "/").replace(/\.html$/, "");

      const html = fs.readFileSync(file, "utf-8");
      const title = extractTag(html, "title");
      const description = extractMeta(html, "description");
      const ogTitle = extractMeta(html, "og:title");
      const ogDescription = extractMeta(html, "og:description");
      const ogImage = extractMeta(html, "og:image");
      const canonical = extractCanonical(html);
      const images = extractImages(html);
      const internalLinks = extractInternalLinks(html);
      const bodyText = stripHtml(html);
      const wordCount = countWords(bodyText);

      pages.push({
        file: relPath,
        urlPath,
        title,
        description,
        ogTitle,
        ogDescription,
        ogImage,
        canonical,
        images,
        internalLinks,
        wordCount,
      });
    }

    // Build set of known URL paths for link checking
    const knownPaths = new Set(pages.map((p) => p.urlPath));
    // Also add with/without trailing slash variants
    for (const p of [...knownPaths]) {
      if (p.endsWith("/")) knownPaths.add(p.slice(0, -1));
      else knownPaths.add(p + "/");
    }

    // Track inbound links for orphan detection
    const inboundCount = {};
    for (const p of pages) {
      inboundCount[p.urlPath] = 0;
    }

    // 3. Run checks
    const errors = [];
    const warnings = [];

    const titles = {};
    const descriptions = {};

    for (const page of pages) {
      const loc = page.urlPath;

      // Title
      if (!page.title) {
        errors.push(`${loc} — Missing <title> tag`);
      } else if (page.title.length > 70) {
        warnings.push(`${loc} — Title is ${page.title.length} chars (recommended ≤60)`);
      }

      // Duplicate titles
      if (page.title) {
        if (titles[page.title]) {
          warnings.push(`${loc} — Duplicate title with ${titles[page.title]}`);
        } else {
          titles[page.title] = loc;
        }
      }

      // Meta description
      if (!page.description) {
        errors.push(`${loc} — Missing meta description`);
      } else if (page.description.length > 160) {
        warnings.push(`${loc} — Meta description is ${page.description.length} chars (recommended ≤155)`);
      }

      // Duplicate descriptions
      if (page.description) {
        if (descriptions[page.description]) {
          warnings.push(`${loc} — Duplicate description with ${descriptions[page.description]}`);
        } else {
          descriptions[page.description] = loc;
        }
      }

      // Canonical
      if (!page.canonical) {
        warnings.push(`${loc} — Missing canonical tag`);
      }

      // Open Graph
      if (!page.ogTitle) warnings.push(`${loc} — Missing og:title`);
      if (!page.ogDescription) warnings.push(`${loc} — Missing og:description`);
      if (!page.ogImage) warnings.push(`${loc} — Missing og:image`);

      // Image alt tags
      for (const img of page.images) {
        if (!img.hasAlt) {
          errors.push(`${loc} — Image missing alt attribute: ${img.src.substring(0, 80)}`);
        } else if (img.alt === "") {
          // Empty alt is valid for decorative images, but flag as warning
          warnings.push(`${loc} — Image has empty alt (OK if decorative): ${img.src.substring(0, 80)}`);
        }
      }

      // Broken internal links
      for (const link of page.internalLinks) {
        const normalized = link.endsWith("/") ? link : link + "/";
        const withoutSlash = link.endsWith("/") ? link.slice(0, -1) : link;
        if (!knownPaths.has(normalized) && !knownPaths.has(withoutSlash) && !knownPaths.has(link)) {
          errors.push(`${loc} — Broken internal link: ${link}`);
        }
        // Track inbound
        for (const variant of [link, normalized, withoutSlash]) {
          if (variant in inboundCount) {
            inboundCount[variant]++;
          }
        }
      }

      // Thin content (skip non-content pages like index, 404)
      const isContentPage = loc.includes("/blog/") || loc.includes("/articles/") || loc.includes("/post/");
      if (isContentPage && page.wordCount < config.minWordCount) {
        warnings.push(`${loc} — Thin content: ${page.wordCount} words (minimum: ${config.minWordCount})`);
      }
    }

    // Orphan pages (content pages with zero inbound internal links)
    for (const page of pages) {
      const isContentPage = page.urlPath.includes("/blog/") || page.urlPath.includes("/articles/");
      if (!isContentPage) continue;

      const count =
        (inboundCount[page.urlPath] || 0) +
        (inboundCount[page.urlPath + "/"] || 0) +
        (inboundCount[page.urlPath.replace(/\/$/, "")] || 0);

      if (count === 0) {
        warnings.push(`${page.urlPath} — Orphan page: no inbound internal links detected`);
      }
    }

    // 4. Report
    console.log("═══════════════════════════════════════════");
    console.log("   SEO CHECKER REPORT");
    console.log("═══════════════════════════════════════════\n");

    console.log(`   Pages scanned: ${pages.length}`);
    console.log(`   Errors:        ${errors.length}`);
    console.log(`   Warnings:      ${warnings.length}\n`);

    if (errors.length > 0) {
      console.log("❌ ERRORS:\n");
      for (const e of errors) console.log(`   ${e}`);
      console.log("");
    }

    if (warnings.length > 0) {
      console.log("⚠️  WARNINGS:\n");
      for (const w of warnings) console.log(`   ${w}`);
      console.log("");
    }

    if (errors.length === 0 && warnings.length === 0) {
      console.log("✅ All pages passed SEO checks!\n");
    }

    // Summary table
    console.log("───────────────────────────────────────────");
    console.log("   PAGE SUMMARY");
    console.log("───────────────────────────────────────────\n");
    for (const page of pages) {
      const issues = [];
      if (!page.title) issues.push("no-title");
      if (!page.description) issues.push("no-desc");
      if (!page.ogImage) issues.push("no-og");
      if (page.images.some((i) => !i.hasAlt)) issues.push("missing-alts");
      const status = issues.length === 0 ? "✅" : "⚠️ " + issues.join(", ");
      console.log(`   ${page.urlPath.padEnd(50)} ${page.wordCount}w  ${status}`);
    }
    console.log("");

    // 5. Optionally fail the build
    if (config.failOnError && errors.length > 0) {
      utils.build.failBuild(
        `SEO Checker found ${errors.length} error(s). Fix them or set failOnError: false.`
      );
    }
  },
};
