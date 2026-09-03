/**
 * Diagram Service
 *
 * The ONLY consumer of the vendored next-ai-draw-io modules. Everything those modules know about
 * draw.io XML -- how to repair it, what a page is, what canonical form looks like -- reaches the
 * rest of this codebase through here, so if the vendored code is ever replaced there is exactly one
 * file to rewrite.
 *
 * The vendored modules are TypeScript compiled to dist/vendor/ (see tsconfig.json). They read
 * DOMParser and XMLSerializer off the global object, which is why domPolyfill is required first --
 * without it the validator degrades silently and still reports valid:true.
 *
 * Two pieces of vendored semantics matter enough to state plainly, because both invite the wrong
 * assumption:
 *
 *   1. validateAndFixXml returns { valid, error, fixed, fixes }. `fixed === null` does NOT mean
 *      failure and `fixed !== null` does NOT mean success. Branch on `valid`, only ever on `valid`.
 *   2. normalizeToMxfile returns null on failure rather than throwing.
 */

require("../domPolyfill");

/**
 * The vendored modules are TypeScript and live in dist/ only after a build. A bare require would
 * fail here with "Cannot find module '../../dist/vendor/xml-validation'", which reads like a broken
 * import rather than a missing build step -- so say what to actually do about it.
 */
const requireVendor = (name) => {
  try {
    return require(`../../dist/vendor/${name}`);
  } catch (err) {
    if (err.code !== "MODULE_NOT_FOUND") throw err;
    throw new Error(
      `The vendored diagram modules have not been compiled: dist/vendor/${name} is missing.\n` +
      "Run `npm run build:vendor` (it compiles src/*.ts) before starting the server."
    );
  }
};

const { validateAndFixXml } = requireVendor("xml-validation");
const { normalizeToMxfile, parseMxfile, listPagesFromDoc } = requireVendor("pages");

/**
 * A bare single-page document, the seed for POST /api/diagram/create. The inner model is the same
 * literal pages.ts uses for a new page: ids "0" and "1" are draw.io's reserved root sentinels and
 * every real cell descends from "1".
 */
const EMPTY_MODEL =
  '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';

class DiagramService {
  constructor({ shapeLibraryService, shapeCheckEnabled, errorResponseMessage }) {
    this.shapeLibraryService = shapeLibraryService;
    this.shapeCheckEnabled = shapeCheckEnabled;
    this.errorResponseMessage = errorResponseMessage;
  }

  /**
   * Wraps an error body with the HTTP status the controller should use.
   * @private
   */
  fail(body, status) {
    return { ...body, status };
  }

  /** A fresh, valid, empty mxfile. */
  emptyDocument(name) {
    return normalizeToMxfile(EMPTY_MODEL, name ? { pageName: name } : undefined);
  }

  /**
   * Summarise a document's pages without handing back the document.
   *
   * GET /api/diagram and POST /api/diagram/validate both answer with this rather than the XML: a
   * tool result is pasted into the agent's context window, and an mxfile of any substance is a very
   * long string to spend context on when the agent already has the copy it just sent.
   *
   * @param {String} xml - A full <mxfile>
   * @returns {Object} { count, cellCount, pages: [{ id, name, index, cellCount }] }
   */
  summarize(xml) {
    const doc = parseMxfile(xml);
    if (!doc) return { count: 0, cellCount: 0, pages: [] };

    const pages = listPagesFromDoc(doc);
    return {
      count: pages.length,
      // The two root sentinels are per page and are not user content, so they are excluded to keep
      // "cellCount: 0" meaning "this page is empty".
      cellCount: pages.reduce((sum, p) => sum + Math.max(0, p.cellCount - 2), 0),
      pages,
    };
  }

  /**
   * Validate, repair, and canonicalise a candidate document.
   *
   * This is the gate the whole service turns on. The caller writes to disk only when this returns
   * success, so a diagram the user was happy with cannot be destroyed by an attempt to improve it.
   *
   * @param {String} xml - The candidate XML, bare <mxGraphModel> or full <mxfile>
   * @returns {Object} { success, data: { xml, pages, fixes, warnings } } or an error result
   */
  validate(xml) {
    if (typeof xml !== "string" || !xml.trim()) {
      return this.fail(
        this.errorResponseMessage.badRequest(
          "No XML supplied.",
          "empty_xml",
          "Send the full diagram document in the `xml` field."
        ),
        400
      );
    }

    let result;
    try {
      result = validateAndFixXml(xml);
    } catch (err) {
      // The vendored validator is written not to throw, but it parses attacker-shaped input and a
      // crash here would otherwise become a 500 for what is really a bad document.
      return this.fail(
        this.errorResponseMessage.badRequest(
          `The diagram could not be parsed: ${err.message}`,
          "invalid_xml",
          "Check that every tag is closed and every attribute quoted."
        ),
        400
      );
    }

    // Branch on `valid` alone. `fixed` is populated on some failures and null on some successes.
    if (!result.valid) {
      return this.fail(
        this.errorResponseMessage.badRequest(
          result.error || "The diagram XML is not valid.",
          "invalid_xml",
          "Fix the reported problem and resend. The stored diagram has NOT been changed."
        ),
        400
      );
    }

    const repaired = result.fixed || xml;

    // Canonical storage form is always <mxfile>, so a bare <mxGraphModel> is wrapped here rather
    // than at every point that later reads the file.
    const canonical = normalizeToMxfile(repaired);
    if (!canonical) {
      return this.fail(
        this.errorResponseMessage.badRequest(
          "The diagram passed validation but is not a recognisable draw.io document.",
          "invalid_xml",
          "The root element must be <mxfile> or <mxGraphModel>."
        ),
        400
      );
    }

    const pages = this.summarize(canonical);

    return {
      success: true,
      data: {
        xml: canonical,
        pages,
        // What we silently corrected. Reported so the agent can learn -- an unescaped `&` repaired
        // ten times without ever being mentioned is a habit that never gets fixed.
        fixes: result.fixes || [],
        warnings: this.shapeCheckEnabled ? this.checkShapeReferences(canonical) : [],
      },
    };
  }

  /**
   * Cross-check every `shape=` / `resIcon=` / `prIcon=` / `image=` reference against the shape index.
   *
   * Warnings only, never a rejection. The index does not cover every library completely (see
   * `coverage` in shapeIndex.json), so an unrecognised name is at least as likely to be a gap in our
   * data as a mistake in the agent's -- refusing to store a working diagram over that would be
   * strictly worse than saying nothing. Libraries whose coverage is not "complete" are skipped
   * entirely for the same reason.
   *
   * @param {String} xml - The validated document
   * @returns {Array<String>} Human-readable warnings, empty when everything resolves
   */
  checkShapeReferences(xml) {
    if (!this.shapeLibraryService) return [];

    const doc = parseMxfile(xml);
    if (!doc) return [];

    const warnings = [];
    const seen = new Set();

    for (const cell of doc.querySelectorAll("mxCell")) {
      const style = cell.getAttribute("style");
      if (!style) continue;

      for (const part of style.split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        const key = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (!["shape", "resIcon", "prIcon", "image"].includes(key)) continue;
        if (seen.has(value)) continue;
        seen.add(value);

        const verdict = this.shapeLibraryService.checkReference(key, value);
        if (verdict) warnings.push(verdict);
      }
    }

    return warnings;
  }
}

module.exports = DiagramService;
module.exports.EMPTY_MODEL = EMPTY_MODEL;
