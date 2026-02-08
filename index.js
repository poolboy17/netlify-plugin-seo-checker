/**
 * netlify-plugin-seo-checker
 *
 * Scans built HTML files after build and:
 *   1. Auto-fixes what it can (titles, descriptions, OG tags, alts, canonicals)
 *   2. Reports remaining issues it can't fix (broken links, orphans, thin content)
 *
 * Auto-fixes (modifies HTML in dist/):
 *   - Titles too long → trims at word boundary to ≤60 chars
 *   - Missing meta description → generates from page content
 *   - Missing canonical → adds self-referencing canonical
 *   - Missing og:title → copies from <title>
 *   - Missing og:description → copies from meta description
 *   - Missing og:image → inserts default OG image
 *   - Missing image alt → generates from filename
 *
 * Report-only (cannot auto-fix):
 *   - Broken internal links
 *   - Orphan pages (no inbound links)
 *   - Thin content (below word count threshold)
 *   - Duplicate titles/descriptions
 */

const fs = require("fs");
const path = require("path");

// ── Config defaults ──────────────────────────────────────
const DEFAULTS = {
  minWordCount: 300,
  failOnError: false,
  autoFix: true,
  defaultOgImage: "/og-image.png",
  siteUrl: "",
  ignorePaths: [],
};

// ── HTML parsing helpers ─────────────────────────────────
function extractTag(html, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = html.match(re);
  return m ? m[1].trim() : null;
}

function extractMeta(html, name) {
  const re = new RegExp(
    `<meta\\s+(?:[^>]*?(?:name|property)=["']${name}["'][^>]*?content=["']([^"']*)["']|[^>]*?content=["']([^"']*)["'][^>]*?(?:name|property)=["']${name}["'])`,
    "i"
  );
  const m = html.match(re);
  return m ? (m[1] || m[2] || "").trim() : null;
}

function extractImages(html) {
  const imgs = [];
  const re = /<img\s+([^>]*?)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const srcMatch = attrs.match(/src=["']([^"']*?)["']/i);
    const altMatch = attrs.match(/alt=["']([^"']*?)["']/i);
    imgs.push({
      fullMatch: m[0],
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
    if (href.startsWith("/") && !href.startsWith("//")) {
      links.push(href.split("#")[0].split("?")[0]);
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
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countWords(text) {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

// ── Auto-fix helpers ─────────────────────────────────────

function trimTitle(title, maxLen = 60) {
  if (title.length <= maxLen) return title;
  const trimmed = title.substring(0, maxLen);
  const lastSpace = trimmed.lastIndexOf(" ");
  return lastSpace > 20 ? trimmed.substring(0, lastSpace) : trimmed;
}

function generateDescription(bodyText, maxLen = 155) {
  const clean = bodyText.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  const trimmed = clean.substring(0, maxLen);
  const lastPeriod = trimmed.lastIndexOf(".");
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastPeriod > 80) return trimmed.substring(0, lastPeriod + 1);
  if (lastSpace > 80) return trimmed.substring(0, lastSpace) + "…";
  return trimmed + "…";
}

function altFromFilename(src) {
  const basename = path.basename(src).replace(/\.[^.]+$/, "");
  return basename
    .replace(/[-_]/g, " ")
    .replace(/\b(ncsf|cpt|csc|sns|ace|nasm|issa)\b/gi, (m) => m.toUpperCase())
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Main plugin ──────────────────────────────────────────
module.exports = {
  onPostBuild: async ({ constants, utils, inputs }) => {
    const publishDir = constants.PUBLISH_DIR;
    const config = { ...DEFAULTS, ...inputs };
    const siteUrl = (config.siteUrl || process.env.URL || "").replace(/\/$/, "");

    console.log("\n🔍 SEO Checker — scanning built HTML...\n");
    if (config.autoFix) {
      console.log("   🔧 Auto-fix: ENABLED\n");
    }

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
      console.log("⚠️  No HTML files found.");
      return;
    }

    console.log(`   Found ${htmlFiles.length} HTML files\n`);

    // 2. Parse + fix each file
    const pages = [];
    const fixes = [];
    const errors = [];
    const warnings = [];

    for (const file of htmlFiles) {
      const relPath = "/" + path.relative(publishDir, file).replace(/\\/g, "/");
      const urlPath = relPath.replace(/\/index\.html$/, "/").replace(/\.html$/, "");

      let html = fs.readFileSync(file, "utf-8");
      let modified = false;
      const pageFixes = [];

      const bodyText = stripHtml(html);
      const wordCount = countWords(bodyText);

      // ── Title ──────────────────────────────
      let title = extractTag(html, "title");
      if (!title) {
        errors.push(`${urlPath} — Missing <title> tag (cannot auto-fix)`);
      } else if (title.length > 60 && config.autoFix) {
        const newTitle = trimTitle(title);
        html = html.replace(
          new RegExp(`<title>${escapeRegex(title)}</title>`, "i"),
          `<title>${newTitle}</title>`
        );
        pageFixes.push(`title trimmed: "${title}" → "${newTitle}"`);
        title = newTitle;
        modified = true;
      } else if (title.length > 60) {
        warnings.push(`${urlPath} — Title is ${title.length} chars (recommended ≤60)`);
      }

      // ── Meta description ───────────────────
      let description = extractMeta(html, "description");
      if (!description && config.autoFix) {
        const generated = generateDescription(bodyText);
        if (generated.length > 20) {
          html = html.replace(
            /<\/title>/i,
            `</title>\n    <meta name="description" content="${escapeHtml(generated)}" />`
          );
          pageFixes.push(`meta description generated (${generated.length} chars)`);
          description = generated;
          modified = true;
        } else {
          errors.push(`${urlPath} — Missing meta description (content too short to generate)`);
        }
      } else if (!description) {
        errors.push(`${urlPath} — Missing meta description`);
      } else if (description.length > 160) {
        warnings.push(`${urlPath} — Meta description is ${description.length} chars (recommended ≤155)`);
      }

      // ── Canonical ──────────────────────────
      const canonical = extractCanonical(html);
      if (!canonical && config.autoFix && siteUrl) {
        const canonicalUrl = `${siteUrl}${urlPath}`;
        html = html.replace(
          /<\/title>/i,
          `</title>\n    <link rel="canonical" href="${canonicalUrl}" />`
        );
        pageFixes.push(`canonical added: ${canonicalUrl}`);
        modified = true;
      } else if (!canonical) {
        warnings.push(`${urlPath} — Missing canonical tag`);
      }

      // ── OG tags ────────────────────────────
      const ogTitle = extractMeta(html, "og:title");
      if (!ogTitle && title && config.autoFix) {
        html = html.replace(
          /<\/head>/i,
          `    <meta property="og:title" content="${escapeHtml(title)}" />\n  </head>`
        );
        pageFixes.push("og:title added from <title>");
        modified = true;
      } else if (!ogTitle) {
        warnings.push(`${urlPath} — Missing og:title`);
      }

      const ogDesc = extractMeta(html, "og:description");
      if (!ogDesc && description && config.autoFix) {
        html = html.replace(
          /<\/head>/i,
          `    <meta property="og:description" content="${escapeHtml(description)}" />\n  </head>`
        );
        pageFixes.push("og:description added from meta description");
        modified = true;
      } else if (!ogDesc) {
        warnings.push(`${urlPath} — Missing og:description`);
      }

      const ogImage = extractMeta(html, "og:image");
      if (!ogImage && config.autoFix && config.defaultOgImage) {
        const ogImgUrl = siteUrl ? `${siteUrl}${config.defaultOgImage}` : config.defaultOgImage;
        html = html.replace(
          /<\/head>/i,
          `    <meta property="og:image" content="${ogImgUrl}" />\n  </head>`
        );
        pageFixes.push("og:image added (default)");
        modified = true;
      } else if (!ogImage) {
        warnings.push(`${urlPath} — Missing og:image`);
      }

      // ── Image alts ─────────────────────────
      const images = extractImages(html);
      for (const img of images) {
        if (!img.hasAlt && img.src && config.autoFix) {
          const generatedAlt = altFromFilename(img.src);
          const newTag = img.fullMatch.replace(/>$/, ` alt="${escapeHtml(generatedAlt)}">`);
          html = html.replace(img.fullMatch, newTag);
          pageFixes.push(`alt added to image: "${generatedAlt}"`);
          modified = true;
        } else if (!img.hasAlt) {
          errors.push(`${urlPath} — Image missing alt: ${img.src.substring(0, 80)}`);
        }
      }

      // ── Write fixed HTML ───────────────────
      if (modified) {
        fs.writeFileSync(file, html, "utf-8");
        for (const fix of pageFixes) {
          fixes.push(`${urlPath} — ${fix}`);
        }
      }

      // ── Collect for cross-page checks ──────
      const internalLinks = extractInternalLinks(html);
      pages.push({
        file: relPath,
        urlPath,
        title,
        description,
        internalLinks,
        wordCount,
      });
    }

    // ── Cross-page checks ────────────────────
    const knownPaths = new Set(pages.map((p) => p.urlPath));
    for (const p of [...knownPaths]) {
      if (p.endsWith("/")) knownPaths.add(p.slice(0, -1));
      else knownPaths.add(p + "/");
    }

    const inboundCount = {};
    for (const p of pages) inboundCount[p.urlPath] = 0;

    const titles = {};
    const descriptions = {};

    for (const page of pages) {
      // Duplicate titles
      if (page.title) {
        if (titles[page.title]) {
          warnings.push(`${page.urlPath} — Duplicate title with ${titles[page.title]}`);
        } else {
          titles[page.title] = page.urlPath;
        }
      }

      // Duplicate descriptions
      if (page.description) {
        if (descriptions[page.description]) {
          warnings.push(`${page.urlPath} — Duplicate description with ${descriptions[page.description]}`);
        } else {
          descriptions[page.description] = page.urlPath;
        }
      }

      // Broken internal links
      for (const link of page.internalLinks) {
        const normalized = link.endsWith("/") ? link : link + "/";
        const withoutSlash = link.endsWith("/") ? link.slice(0, -1) : link;
        if (!knownPaths.has(normalized) && !knownPaths.has(withoutSlash) && !knownPaths.has(link)) {
          errors.push(`${page.urlPath} — Broken internal link: ${link}`);
        }
        for (const variant of [link, normalized, withoutSlash]) {
          if (variant in inboundCount) inboundCount[variant]++;
        }
      }

      // Thin content
      const isContentPage = page.urlPath.includes("/blog/") || page.urlPath.includes("/articles/");
      if (isContentPage && page.wordCount < config.minWordCount) {
        warnings.push(`${page.urlPath} — Thin content: ${page.wordCount} words (min: ${config.minWordCount})`);
      }
    }

    // Orphan pages
    for (const page of pages) {
      const isContentPage = page.urlPath.includes("/blog/") || page.urlPath.includes("/articles/");
      if (!isContentPage) continue;
      const count =
        (inboundCount[page.urlPath] || 0) +
        (inboundCount[page.urlPath + "/"] || 0) +
        (inboundCount[page.urlPath.replace(/\/$/, "")] || 0);
      if (count === 0) {
        warnings.push(`${page.urlPath} — Orphan page: no inbound internal links`);
      }
    }

    // ── Report ───────────────────────────────
    console.log("═══════════════════════════════════════════");
    console.log("   SEO CHECKER REPORT");
    console.log("═══════════════════════════════════════════\n");
    console.log(`   Pages scanned:  ${pages.length}`);
    console.log(`   Auto-fixes:     ${fixes.length}`);
    console.log(`   Errors:         ${errors.length}`);
    console.log(`   Warnings:       ${warnings.length}\n`);

    if (fixes.length > 0) {
      console.log("🔧 AUTO-FIXED:\n");
      for (const f of fixes) console.log(`   ✅ ${f}`);
      console.log("");
    }

    if (errors.length > 0) {
      console.log("❌ ERRORS (cannot auto-fix):\n");
      for (const e of errors) console.log(`   ${e}`);
      console.log("");
    }

    if (warnings.length > 0) {
      console.log("⚠️  WARNINGS:\n");
      for (const w of warnings) console.log(`   ${w}`);
      console.log("");
    }

    if (fixes.length === 0 && errors.length === 0 && warnings.length === 0) {
      console.log("✅ All pages passed SEO checks!\n");
    }

    // Page summary
    console.log("───────────────────────────────────────────");
    console.log("   PAGE SUMMARY");
    console.log("───────────────────────────────────────────\n");
    for (const page of pages) {
      console.log(`   ${page.urlPath.padEnd(50)} ${page.wordCount}w`);
    }
    console.log("");

    if (config.failOnError && errors.length > 0) {
      utils.build.failBuild(
        `SEO Checker found ${errors.length} error(s). Fix them or set failOnError: false.`
      );
    }
  },
};
