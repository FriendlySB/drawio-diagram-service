/**
 * DOM Polyfill
 *
 * A side-effect module. Requiring it installs `globalThis.DOMParser` and
 * `globalThis.XMLSerializer`, which the vendored next-ai-draw-io modules expect to
 * find on the global object. It must be required BEFORE any of them.
 *
 * Why this is not optional, and why it is a separate file rather than three lines
 * at the top of container.js: the vendored validator degrades *silently* without
 * these globals. `xml-validation.js` guards one repair pattern behind
 * `typeof DOMParser !== "undefined"` and wraps its structural parse in a try/catch
 * that falls back to regex validation. So a missing polyfill does not throw -- it
 * produces a weaker validator that still answers `valid: true`. Given this service
 * writes to disk only when the validator says ok, a quietly-degraded validator is
 * the worst failure mode available to us. The install point is therefore its own
 * file, named for what it does, impossible to drop in a refactor.
 *
 * linkedom supplies DOMParser but NOT XMLSerializer (verified: its export list has
 * no such name). Its nodes serialise through `outerHTML`, so the serialiser below
 * is a shim over that -- identical to the one upstream installs in index.ts and to
 * the one pinned by tests/vendor/multi-page.test.ts.
 */

const { DOMParser } = require("linkedom");

/** Mirrors upstream's shim exactly; `outerHTML` is linkedom's serialisation path. */
class XMLSerializerPolyfill {
  serializeToString(node) {
    if (node.outerHTML !== undefined) return node.outerHTML;
    if (node.documentElement) return node.documentElement.outerHTML;
    return "";
  }
}

// Assigned unconditionally. A real DOM global would mean we are not on Node, in
// which case something has gone wrong that a silent skip would only hide.
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializerPolyfill;

module.exports = { DOMParser, XMLSerializerPolyfill };
