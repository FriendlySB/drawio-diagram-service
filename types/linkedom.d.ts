/**
 * Local ambient declaration for linkedom, used ONLY by the vendored-module build.
 *
 * Why this file exists: linkedom's package.json says `"type": "module"` and its
 * exports map offers types only under the "import" condition
 * (types -> ./types/esm/index.d.ts). Under moduleResolution Node16 our CommonJS
 * build therefore resolves linkedom's types as ESM and tsc raises TS1479
 * ("cannot be imported with require") -- even though the emitted
 * require("linkedom") is correct and resolves at runtime to ./cjs/index.js via
 * the exports map's "default" condition (verified: cjs/package.json declares
 * {"type":"commonjs"}).
 *
 * An ambient declaration takes precedence over node resolution for a bare
 * specifier, so this both silences the false positive and pins the exact surface
 * the vendored files use. Do not widen it casually -- if a vendored module starts
 * importing something else from linkedom, add it here deliberately.
 */
declare module "linkedom" {
    export class DOMParser {
        parseFromString(source: string, mimeType: string): Document
    }
}
