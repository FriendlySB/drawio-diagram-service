#!/usr/bin/env node
/**
 * Shape Index Generator
 *
 * Reads docs/shape-libraries/*.md and writes src/shapes/shapeIndex.json, the artefact the service
 * serves from. Run with `npm run build:shapes`; the OUTPUT IS CHECKED IN.
 *
 * Why a build step rather than parsing at boot: this parse is the riskiest code in the service. The
 * 30 markdown files use five different addressing idioms and three different section layouts, and a
 * regression here does not crash -- it quietly emits style strings that draw.io silently ignores,
 * producing blank rectangles in a user's diagram. A checked-in artefact is reviewed once in a diff
 * and pinned by tests, instead of being re-derived on every production boot where nobody is looking.
 *
 * The single design rule everything else follows from:
 *
 *     NEVER MAKE THE AGENT CONSTRUCT A STYLE STRING. SHIP IT ONE, FULLY SUBSTITUTED.
 *
 * Five idioms (direct shape=, aws4's resIcon, cisco19's prIcon, image paths, a CDN URL template)
 * collapse into one mechanism: each library is a single style template with a {shape} hole, and each
 * shape is a token that already carries whatever category qualification its library needs. The
 * endpoint substitutes and returns finished styles, so there is no addressing decision left for a
 * caller to get wrong.
 *
 * Hard rules, each learned from a specific file that breaks the naive version:
 *   - Harvest only within a library's shape sections. This is what excludes bpmn's `## Parameters`
 *     bullets (`outline`, `symbol` are style keys) without needing to name them.
 *   - Drop bullets whose slug starts with "mxgraph." -- 18 files list their own library prefix as a
 *     shape, and it is not one.
 *   - Take only the FIRST backticked span per bullet (infographic: "`shadedCube` (needs `isoAngle=15;`)").
 *   - Never split a slug on "." or "," -- last.fm, gateway_xor_(data).
 *   - Never coerce a slug to a number -- sap's shapes include "1" through "13".
 *   - Never derive a prefix from a filename -- network -> mxgraph.networks, fluidpower -> mxgraph.fluid_power.
 *   - Heading counts are optional: "### resistors" and "### compute (38)" both occur.
 *   - docs/shape-libraries/README.md is WRONG (bad prefixes, four libraries that do not exist, omits
 *     material_design) and is never read.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DOCS_DIR = path.join(__dirname, "..", "docs", "shape-libraries");
const OUT_FILE = path.join(__dirname, "..", "src", "shapes", "shapeIndex.json");
const OVERRIDES_FILE = path.join(__dirname, "..", "src", "shapes", "overrides.json");

/** Counts are optional in headings, so the trailing "(N)" group must be. */
const HEADING = /^(#{2,3})\s+(.+?)(?:\s+\((\d+)\))?\s*$/;
/** A bullet's slug is its FIRST backticked span, whatever follows. */
const BULLET = /^-\s+`([^`]+)`(.*)$/;
/** rack's fourth level: `**switches:**` beneath a `### Vendor` heading. */
const BOLD_SECTION = /^\*\*([^*]+):\*\*\s*$/;
/** azure2's Additional Categories: `- **devops** (10): API_Connections, Application_Insights, ...` */
const COMMA_LIST = /^-\s+\*\*([^*]+)\*\*\s*\(\d+\)\s*:\s*(.+)$/;
/** infographic's per-shape extras: "(needs `isoAngle=15;`)" */
const EXTRA_PARAMS = /needs\s+`([^`]+)`/;

const fail = (msg) => {
  console.error(`[buildShapeIndex] FATAL: ${msg}`);
  process.exit(1);
};

/** A vendor heading becomes a path segment: "HPE Aruba" -> "hpe_aruba". */
const slugifySection = (s) => s.trim().toLowerCase().replace(/\s+/g, "_");

/**
 * Pull the style string out of a library's ```xml Usage block and punch the {shape} hole in it.
 *
 * The hole is either already there ({shape}, 17 files) or is occupied by a worked example that
 * overrides.json names exactly (find/into, 13 files). A `find` that no longer appears is a build
 * failure on purpose: it means the markdown changed under a rule that no longer describes it, and
 * the alternative -- emitting a template with a hard-coded example shape baked in -- would ship
 * 1,000 shapes that all render as the same icon.
 */
function extractTemplate(libName, markdown, rules) {
  const match = markdown.match(/style="([^"]+)"/);
  if (!match) fail(`${libName}: no style="..." found in its Usage block.`);
  let style = match[1];

  if (rules.find) {
    if (!style.includes(rules.find)) {
      fail(
        `${libName}: overrides.json says find="${rules.find}" but that string is not in the Usage ` +
        `block any more. The markdown changed; update the rule.\n  Usage style: ${style}`
      );
    }
    style = style.split(rules.find).join(rules.into);
  }

  if (!style.includes("{shape}")) {
    fail(`${libName}: style template has no {shape} placeholder after substitution.\n  Got: ${style}`);
  }
  return style;
}

/** Default geometry, taken from the same Usage block, so callers get a sane starting size. */
function extractSize(markdown) {
  const m = markdown.match(/mxGeometry[^>]*width="(\d+)"[^>]*height="(\d+)"/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 60, height: 60 };
}

/**
 * Split a file into sections keyed by heading, preserving level and order.
 * @returns {Array<{level:Number, title:String, lines:Array<String>}>}
 */
function sections(markdown) {
  const out = [];
  let current = { level: 0, title: "", lines: [] };
  for (const line of markdown.split(/\r?\n/)) {
    const h = line.match(HEADING);
    if (h) {
      out.push(current);
      current = { level: h[1].length, title: h[2].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  out.push(current);
  return out;
}

/**
 * Harvest the shape slugs from a block of lines.
 * @returns {Array<{name:String, extras:String|null}>}
 */
function bullets(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.match(BULLET);
    if (!m) continue;
    const slug = m[1].trim();
    // The poison bullet: 18 files list their own library prefix among the shapes.
    if (slug.startsWith("mxgraph.")) continue;
    const extra = m[2].match(EXTRA_PARAMS);
    out.push({ name: slug, extras: extra ? extra[1] : null });
  }
  return out;
}

/** flat: every bullet under a section whose title matches the shape-section pattern. */
function harvestFlat(secs, rules, defaults) {
  const pattern = new RegExp(rules.shapeSectionPattern || defaults.shapeSectionPattern);
  const out = [];
  for (const sec of secs) {
    if (sec.level !== 2 || !pattern.test(sec.title)) continue;
    out.push(...bullets(sec.lines));
  }
  return out;
}

/**
 * sectioned: bullets live under category headings and the category is (usually) part of the token.
 * Covers electrical (h3, joined with "."), azure2 (h3, joined with "/", plus a comma-list pass) and
 * material_design (h2, join "" because the CDN URL takes a bare name).
 */
function harvestSectioned(secs, rules) {
  const level = rules.sectionLevel || 3;
  const join = rules.tokenJoin === undefined ? "." : rules.tokenJoin;
  const out = [];

  for (const sec of secs) {
    if (sec.level !== level) continue;

    // azure2's comma-list block is a different shape of data under a heading of the same level.
    if (rules.commaListSection && sec.title === rules.commaListSection) {
      for (const line of sec.lines) {
        const m = line.match(COMMA_LIST);
        if (!m) continue;
        const category = slugifySection(m[1]);
        for (const raw of m[2].split(",")) {
          const name = raw.trim();
          if (name) out.push({ name: join ? `${category}${join}${name}` : name, extras: null });
        }
      }
      continue;
    }

    const category = slugifySection(sec.title);
    for (const b of bullets(sec.lines)) {
      out.push({ ...b, name: join ? `${category}${join}${b.name}` : b.name });
    }
  }
  return out;
}

/**
 * sectionedVendor: rack only. `### Vendor` sections, an optional `**subcategory:**` level inside
 * them, and one heading that is not a vendor at all -- `### General (rackGeneral)` switches the
 * mxgraph library, so its shapes carry their own template.
 */
function harvestSectionedVendor(secs, rules) {
  const overridesByTitle = rules.sectionTemplateOverride || {};
  const out = [];

  for (const sec of secs) {
    if (sec.level !== 3) continue;

    // Heading titles lose their "(N)" suffix in `sections`, but "General (rackGeneral)" is a name,
    // not a count -- it survives, so it can be matched literally.
    const templateOverride = overridesByTitle[sec.title] || null;
    const vendor = templateOverride ? null : slugifySection(sec.title);

    let subcategory = null;
    for (const line of sec.lines) {
      const bold = line.match(BOLD_SECTION);
      if (bold) {
        subcategory = slugifySection(bold[1]);
        continue;
      }
      const m = line.match(BULLET);
      if (!m) continue;
      const slug = m[1].trim();
      if (slug.startsWith("mxgraph.")) continue;

      const segments = [vendor, subcategory, slug].filter(Boolean);
      out.push({ name: segments.join("."), extras: null, templateOverride });
    }
  }
  return out;
}

function build() {
  const overrides = JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf8"));
  const defaults = overrides.defaults;

  const files = fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();

  const libraries = {};
  const hash = crypto.createHash("sha256");
  let totalShapes = 0;

  for (const file of files) {
    const libName = file.replace(/\.md$/, "");
    const rules = overrides.libraries[libName];
    if (!rules) fail(`${libName}: no entry in overrides.json. Add one deliberately, do not default.`);

    const markdown = fs.readFileSync(path.join(DOCS_DIR, file), "utf8");
    hash.update(file).update("\0").update(markdown).update("\0");

    const template = extractTemplate(libName, markdown, rules);
    const mode = rules.mode || defaults.mode;
    const secs = sections(markdown);

    let harvested;
    if (mode === "manual") harvested = (rules.shapes || []).map((s) => ({ extras: null, ...s }));
    else if (mode === "sectioned") harvested = harvestSectioned(secs, rules);
    else if (mode === "sectionedVendor") harvested = harvestSectionedVendor(secs, rules);
    else harvested = harvestFlat(secs, rules, defaults);

    if (harvested.length === 0) fail(`${libName}: harvested zero shapes in mode "${mode}".`);

    // A duplicate token means two categories collided and the join is wrong -- worth knowing loudly,
    // but the first wins rather than failing the build, since a repeated name is still addressable.
    const seen = new Set();
    const shapes = [];
    for (const h of harvested) {
      if (seen.has(h.name)) continue;
      seen.add(h.name);

      const base = h.templateOverride || template;
      // The whole point: substitute here, once, so the response never asks a caller to.
      let style = base.split("{shape}").join(h.name);
      // infographic: fold the shape's own required params into its finished style.
      if (h.extras) style = style.replace(/;{2,}/g, ";").replace(/;?$/, ";") + h.extras;

      const entry = { name: h.name, style };
      if (h.note) entry.note = h.note;
      shapes.push(entry);
    }

    if (shapes.length !== harvested.length) {
      console.warn(
        `[buildShapeIndex] ${libName}: ${harvested.length - shapes.length} duplicate token(s) dropped.`
      );
    }

    libraries[libName] = {
      id: libName,
      title: rules.title || libName,
      form: rules.form,
      coverage: rules.coverage || defaults.coverage,
      styleTemplate: template,
      size: extractSize(markdown),
      count: shapes.length,
      ...(rules.params ? { params: rules.params } : {}),
      ...(rules.note ? { note: rules.note } : {}),
      shapes,
    };
    totalShapes += shapes.length;
  }

  const index = {
    generatedBy: "scripts/buildShapeIndex.js",
    // Pins the index to the markdown it was generated from. A test recomputes this and fails when
    // the two drift, so the docs stay the source of truth rather than becoming a stale copy.
    sourceHash: hash.digest("hex"),
    libraryCount: Object.keys(libraries).length,
    shapeCount: totalShapes,
    libraries,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(index, null, 2) + "\n", "utf8");

  console.log(`[buildShapeIndex] ${index.libraryCount} libraries, ${totalShapes} shapes`);
  for (const lib of Object.values(libraries)) {
    const flag = lib.coverage === "complete" ? "" : `  (${lib.coverage})`;
    console.log(`  ${lib.id.padEnd(18)} ${String(lib.count).padStart(5)}${flag}`);
  }
  console.log(`[buildShapeIndex] wrote ${path.relative(process.cwd(), OUT_FILE)}`);
}

build();
