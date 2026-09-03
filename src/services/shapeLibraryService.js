/**
 * Shape Library Service
 *
 * Serves the generated shape index (src/shapes/shapeIndex.json, built by scripts/buildShapeIndex.js)
 * and cross-checks style references on the way back in.
 *
 * The contract this file exists to uphold: a caller receives finished style strings, never a
 * template plus instructions. draw.io addresses shapes five different ways depending on the library
 * -- shape=, aws4's resIcon=, cisco19's prIcon=, an image path, a CDN URL -- and every one of those
 * decisions is made at build time and baked into `matches[].style`. An AI Agent copies; it does not
 * assemble. `styleTemplate` is returned alongside for the one case where assembling is genuinely
 * better: varying fillColor across six shapes means editing one string, not six.
 *
 * Search deliberately does NOT dump a library. aws4 alone is 1,031 names; pasting that into an
 * agent's context to answer "what's the Lambda icon" would cost more than the diagram it is drawing.
 */

const index = require("../shapes/shapeIndex.json");

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** Below this a library is small enough that listing it whole is cheaper than making the agent ask twice. */
const SMALL_LIBRARY = 30;

/** Fold "Virtual Machine", "virtual-machine" and "virtual_machine" onto one key. */
const normalize = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/**
 * Accept the query in either shape it can arrive in.
 *
 * `q` is declared in openapi.yaml as a comma-delimited array (style: form, explode: false), so the
 * validator normally hands it over already split. But these methods are also called directly in
 * tests and could be reached by a future route without that layer in front, so a plain
 * "a,b" string is accepted too rather than silently becoming one nonsense term.
 */
const parseTerms = (q) => {
  const raw = Array.isArray(q) ? q : String(q ?? "").split(",");
  return raw.map(normalize).filter(Boolean);
};

class ShapeLibraryService {
  constructor({ errorResponseMessage }) {
    this.errorResponseMessage = errorResponseMessage;
    this.index = index;

    /**
     * Reverse map for the validator's cross-check: every addressable value an mxCell style could
     * legitimately carry, mapped to the library that owns it. Built once at construction because it
     * is consulted per-cell during validation.
     *
     * Only `complete` libraries are entered. A partial library's absence from this map would
     * otherwise make every real-but-unindexed shape look like a typo -- see checkReference.
     */
    this.knownValues = new Map();
    this.libraryPrefixes = [];
    for (const lib of Object.values(index.libraries)) {
      if (lib.coverage !== "complete") continue;
      const prefix = this.addressPrefix(lib);
      if (prefix) this.libraryPrefixes.push({ prefix, lib });
      for (const shape of lib.shapes) {
        for (const value of this.addressableValues(lib, shape)) {
          this.knownValues.set(value, { lib: lib.id, name: shape.name });
        }
      }
    }
  }

  fail(body, status) {
    return { ...body, status };
  }

  /**
   * The prefix that identifies a style value as belonging to this library, e.g. "mxgraph.aws4.".
   * Derived from the template rather than the library id, because they differ: the `network` library
   * addresses as mxgraph.networks and `fluidpower` as mxgraph.fluid_power.
   * @private
   */
  addressPrefix(lib) {
    const m = lib.styleTemplate.match(/(?:shape|resIcon)=([A-Za-z0-9_.]*?)\{shape\}/);
    return m ? m[1] : null;
  }

  /**
   * Every value that, appearing on the right of shape= / resIcon= / prIcon= / image=, means this
   * shape. A library contributes more than one form where its template uses more than one key --
   * aws4 puts a qualified name in resIcon= while shape= holds the constant "resourceIcon".
   * @private
   */
  addressableValues(lib, shape) {
    const out = [];
    for (const part of shape.style.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (["shape", "resIcon", "prIcon", "image"].includes(key) && value) out.push(value);
    }
    return out;
  }

  /**
   * Rank a shape name against one search term.
   *
   * Scored against the full token AND its leaf, because tokens in category-qualified libraries
   * carry a prefix the caller will not type. An azure2 token is "compute/Virtual_Machine" and a
   * rack token is "hpe_aruba.security.aruba_clearpass_c1000_front"; nobody searches for the
   * category, so matching only the full token would make those libraries feel broken.
   *
   * @returns {Number} 0 when it does not match at all
   * @private
   */
  score(name, term) {
    const full = normalize(name);
    // "/" separates azure2 categories, "." separates electrical/rack/pid qualification.
    const leaf = normalize(String(name).split(/[/.]/).pop());
    return Math.max(this.scoreOne(full, term), this.scoreOne(leaf, term));
  }

  /** @private */
  scoreOne(n, term) {
    // The trailing word, so searching "lambda" still finds "s3_object_lambda".
    const tail = n.includes("_") ? n.slice(n.lastIndexOf("_") + 1) : n;
    // Word separators are unreliable in both directions: the caller types "rack cabinet" while the
    // shape is "rackCabinet3", or types "virtualmachine" while the shape is "Virtual_Machine".
    // Comparing the squashed forms as well makes both find each other.
    const squashedName = n.replace(/_/g, "");
    const squashedTerm = term.replace(/_/g, "");

    if (n === term) return 100;
    if (tail === term) return 95;
    if (squashedName === squashedTerm) return 90;
    if (n.startsWith(term)) return 70;
    if (squashedName.startsWith(squashedTerm)) return 65;
    if (n.split("_").includes(term)) return 60;
    if (n.includes(term)) return 40;
    if (squashedName.includes(squashedTerm)) return 35;
    return 0;
  }

  /**
   * Rank one term's matches within a library, best first.
   * @private
   */
  rankTerm(lib, term) {
    const scored = [];
    for (const shape of lib.shapes) {
      const score = this.score(shape.name, term);
      if (score > 0) scored.push({ shape, score });
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Shorter wins the tie: searching "lambda" should surface `lambda`, not `lambda_function_url`.
      if (a.shape.name.length !== b.shape.name.length) return a.shape.name.length - b.shape.name.length;
      return a.shape.name.localeCompare(b.shape.name);
    });

    return scored;
  }

  /**
   * Search one library's shapes across every term.
   *
   * Results are interleaved by term rather than sorted into one global list, and that is the whole
   * design of multi-term search. `?q=lambda,s3` means "give me both of these", so a flat ranking is
   * actively wrong: `s3` and `lambda` are both exact matches, `s3` wins the shorter-name tie-break,
   * and the seven `s3_*` variants that follow push `lambda` off a limit-10 page entirely. Taking
   * each term's best match in turn guarantees every term the caller asked about is represented
   * before any term gets a second entry.
   *
   * @param {Object} lib - A library entry from the index
   * @param {Array<String>} terms - Normalised search terms
   * @param {Number} limit - Maximum matches to return
   * @private
   */
  rank(lib, terms, limit) {
    const perTerm = terms.map((term) => this.rankTerm(lib, term));

    const seen = new Set();
    const matches = [];
    // Round-robin: every term's #1, then every term's #2, and so on.
    for (let round = 0; matches.length < limit; round++) {
      let exhausted = true;
      for (const ranked of perTerm) {
        if (round >= ranked.length) continue;
        exhausted = false;
        const { shape } = ranked[round];
        if (seen.has(shape.name)) continue;
        seen.add(shape.name);
        matches.push(shape);
        if (matches.length >= limit) break;
      }
      if (exhausted) break;
    }

    // `matched` counts distinct shapes matching ANY term, so it does not double-count a shape that
    // two terms both found.
    const matched = new Set(perTerm.flatMap((r) => r.map((s) => s.shape.name))).size;
    return { matched, matches };
  }

  /** Shrink a library entry to its header -- everything except the shapes array. */
  header(lib) {
    const { shapes, ...rest } = lib;
    return rest;
  }

  /**
   * The catalogue: what libraries exist, what each is for, how complete it is. Deliberately small
   * (~1-2 KB) because it is the first thing an agent reads and it pays for it in context.
   * @returns {Object} { success, data }
   */
  catalogue() {
    return {
      success: true,
      data: {
        libraryCount: this.index.libraryCount,
        shapeCount: this.index.shapeCount,
        libraries: Object.values(this.index.libraries).map((lib) => ({
          id: lib.id,
          title: lib.title,
          count: lib.count,
          coverage: lib.coverage,
        })),
        usage:
          "GET /api/shapes/{library}?q=term1,term2 returns ready-to-paste style strings. " +
          "Copy `matches[].style` verbatim into an mxCell's style attribute -- do not build it yourself.",
      },
    };
  }

  /**
   * Search across every library at once, for when the agent knows what it wants but not where it
   * lives ("kubernetes pod", "firewall").
   * @param {String} q - Comma-separated search terms
   * @param {Number} [limit] - Maximum matches
   * @returns {Object} { success, data }
   */
  searchAll(q, limit = DEFAULT_LIMIT) {
    const terms = parseTerms(q);
    if (terms.length === 0) return this.catalogue();

    const capped = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);

    // Term-major, for the same reason single-library search is: a flat global sort would let one
    // popular term fill the whole page and answer nothing about the others.
    const perTerm = terms.map((term) => {
      const hits = [];
      for (const lib of Object.values(this.index.libraries)) {
        for (const { shape, score } of this.rankTerm(lib, term)) {
          hits.push({ library: lib.id, name: shape.name, style: shape.style, score });
        }
      }
      hits.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
      return hits;
    });

    const seen = new Set();
    const top = [];
    for (let round = 0; top.length < capped; round++) {
      let exhausted = true;
      for (const hits of perTerm) {
        if (round >= hits.length) continue;
        exhausted = false;
        const { score, ...hit } = hits[round];
        const key = `${hit.library}/${hit.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        top.push(hit);
        if (top.length >= capped) break;
      }
      if (exhausted) break;
    }

    const matched = new Set(perTerm.flatMap((hits) => hits.map((h) => `${h.library}/${h.name}`))).size;

    return {
      success: true,
      data: {
        query: terms.join(","),
        matches: top,
        counts: { returned: top.length, matched },
        note:
          top.length === 0
            ? "No shape matched. Try a broader term, or GET /api/shapes to see which libraries exist."
            : "Copy `style` verbatim into an mxCell style attribute.",
      },
    };
  }

  /**
   * Search within one library.
   * @param {String} libraryId - Library id from the catalogue
   * @param {String} [q] - Comma-separated search terms
   * @param {Number} [limit] - Maximum matches
   * @returns {Object} { success, data } or a library_not_found error result
   */
  search(libraryId, q, limit = DEFAULT_LIMIT) {
    const lib = this.index.libraries[libraryId];
    if (!lib) {
      return this.fail(
        this.errorResponseMessage.notFoundError(
          `No shape library "${libraryId}".`,
          "library_not_found",
          `Valid libraries: ${Object.keys(this.index.libraries).join(", ")}.`
        ),
        404
      );
    }

    const capped = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);
    const terms = parseTerms(q);

    const base = {
      ...this.header(lib),
      // One finished cell the agent can paste and then edit, so the geometry and the style arrive
      // together rather than the agent having to guess a sensible size.
      example: this.exampleCell(lib),
    };

    // No query on a big library returns the header, not 1,031 names.
    if (terms.length === 0) {
      if (lib.count <= SMALL_LIBRARY) {
        return {
          success: true,
          data: { ...base, matches: lib.shapes, counts: { returned: lib.count, matched: lib.count, library: lib.count } },
        };
      }
      return {
        success: true,
        data: {
          ...base,
          matches: [],
          counts: { returned: 0, matched: 0, library: lib.count },
          note: `This library has ${lib.count} shapes. Add ?q=term1,term2 to search it.`,
        },
      };
    }

    const { matched, matches } = this.rank(lib, terms, capped);
    return {
      success: true,
      data: {
        ...base,
        query: terms.join(","),
        matches,
        counts: { returned: matches.length, matched, library: lib.count },
        ...(matches.length === 0
          ? { note: `Nothing in ${lib.id} matched. ${lib.note || "Try a different term or a different library."}` }
          : {}),
      },
    };
  }

  /**
   * A complete, valid mxCell using this library's first shape -- the fastest way for an agent to see
   * how style and geometry fit together.
   * @private
   */
  exampleCell(lib) {
    const first = lib.shapes[0];
    const { width, height } = lib.size;
    return (
      `<mxCell id="n1" value="Label" style="${first.style}" vertex="1" parent="1">` +
      `<mxGeometry x="40" y="40" width="${width}" height="${height}" as="geometry"/>` +
      `</mxCell>`
    );
  }

  /**
   * Judge one style reference found in a submitted diagram.
   *
   * Returns a warning string, or null when there is nothing worth saying -- which includes every
   * case we are not confident about. Specifically, a value belonging to a library whose coverage is
   * not "complete" produces no warning at all: our index is a documented subset there, so
   * `mxgraph.electrical.resistors.resistor_7` is a real shape we simply do not list, and flagging it
   * would train the agent to distrust correct output.
   *
   * @param {String} key - shape | resIcon | prIcon | image
   * @param {String} value - The value found in the style
   * @returns {String|null} A warning, or null
   */
  checkReference(key, value) {
    if (this.knownValues.has(value)) return null;

    // Which complete library does this value claim to belong to? If none, we have no basis for an
    // opinion -- it may be a partial library, a built-in draw.io shape, or a custom stencil.
    const owner = this.libraryPrefixes.find(({ prefix }) => value.startsWith(prefix));
    if (!owner) return null;

    const bare = value.slice(owner.prefix.length);
    const suggestion = this.nearest(owner.lib, bare);
    return (
      `Unknown shape "${value}" in library ${owner.lib.id}` +
      (suggestion
        ? `. Did you mean "${owner.prefix}${suggestion}"?`
        : `. Search it with GET /api/shapes/${owner.lib.id}?q=...`)
    );
  }

  /**
   * Closest indexed name to a misspelling, by edit distance. Only offered when it is close enough to
   * be a plausible typo -- a bad guess is worse than no guess.
   * @private
   */
  nearest(lib, target) {
    const t = normalize(target);
    let best = null;
    let bestDistance = Infinity;
    for (const shape of lib.shapes) {
      const d = this.editDistance(t, normalize(shape.name));
      if (d < bestDistance) {
        bestDistance = d;
        best = shape.name;
      }
    }
    return bestDistance <= Math.max(1, Math.floor(t.length / 4)) ? best : null;
  }

  /** @private */
  editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 4) return Infinity; // Cheap bail-out; we only care about near misses.
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) {
        row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = row;
    }
    return prev[b.length];
  }
}

module.exports = ShapeLibraryService;
