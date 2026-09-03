/**
 * Pins the boundary between this service and the vendored next-ai-draw-io modules.
 *
 * Two vendored semantics are pinned deliberately, because both invite the wrong assumption and
 * either mistake would be silent:
 *
 *   1. validateAndFixXml's `fixed` is not a success flag. It is null on some successes and non-null
 *      on some failures. Only `valid` may be branched on.
 *   2. The modules read DOMParser and XMLSerializer off globalThis and DEGRADE SILENTLY without
 *      them -- a validator missing its parser still answers valid:true. domPolyfill must therefore
 *      be loaded before them, which diagramService does by requiring it at the top.
 */

import { describe, expect, it } from "vitest"

const ErrorResponseMessage = require("../src/utils/errorResponseMessage")
const DiagramService = require("../src/services/diagramService")
const ShapeLibraryService = require("../src/services/shapeLibraryService")

const errorResponseMessage = new ErrorResponseMessage()
const shapeLibraryService = new ShapeLibraryService({ errorResponseMessage })
const service = new DiagramService({ shapeLibraryService, shapeCheckEnabled: true, errorResponseMessage })

describe("the DOM polyfill is actually installed", () => {
    it("exposes both globals", () => {
        // If this fails, every other test here still passes while the validator quietly degrades to
        // regex checking. That is the failure this test exists to make loud.
        expect(typeof (globalThis as any).DOMParser).toBe("function")
        expect(typeof (globalThis as any).XMLSerializer).toBe("function")
    })

    it("serialises through the shim rather than returning an empty string", () => {
        const doc = new (globalThis as any).DOMParser().parseFromString("<a><b/></a>", "text/xml")
        expect(new (globalThis as any).XMLSerializer().serializeToString(doc)).toContain("<b")
    })
})

describe("emptyDocument", () => {
    it("produces a valid single-page mxfile with draw.io's two root sentinels", () => {
        const xml = service.emptyDocument("My diagram")
        expect(xml).toContain("<mxfile")
        expect(xml).toContain('name="My diagram"')
        expect(xml).toContain('<mxCell id="0"/>')
        expect(xml).toContain('<mxCell id="1" parent="0"/>')
        expect(service.validate(xml).success).toBe(true)
    })

    it("reports an empty page as having no user cells", () => {
        // The two sentinels are structural, not content. "cellCount: 0" must mean "nothing drawn".
        expect(service.summarize(service.emptyDocument()).cellCount).toBe(0)
    })
})

describe("validate", () => {
    const wrap = (cells: string) =>
        `<mxfile><diagram id="p1" name="P"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram></mxfile>`

    it("accepts a well-formed document unchanged", () => {
        const xml = wrap('<mxCell id="a" value="Node" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>')
        const result = service.validate(xml)
        expect(result.success).toBe(true)
        expect(result.data.fixes).toEqual([])
        expect(result.data.pages.count).toBe(1)
        expect(result.data.pages.cellCount).toBe(1)
    })

    it("repairs an unescaped ampersand and says so", () => {
        const result = service.validate(wrap('<mxCell id="a" value="R&D" vertex="1" parent="1"><mxGeometry as="geometry"/></mxCell>'))
        expect(result.success).toBe(true)
        expect(result.data.xml).toContain("R&amp;D")
        expect(result.data.fixes.join(" ")).toMatch(/&/)
    })

    it("promotes a bare mxGraphModel to a full mxfile", () => {
        // Canonical storage form is always mxfile, so downstream readers never branch on shape.
        const result = service.validate('<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>')
        expect(result.success).toBe(true)
        expect(result.data.xml.startsWith("<mxfile")).toBe(true)
    })

    it("rejects unsalvageable XML with a correctable message", () => {
        const result = service.validate('<mxfile><diagram><mxGraphModel><root><mxCell id="0"</root>')
        expect(result.success).toBe(false)
        expect(result.error.code).toBe("invalid_xml")
        expect(result.status).toBe(400)
        // The agent must be told its failure changed nothing, or it may re-send the whole document
        // believing the stored copy is now corrupt.
        expect(result.error.suggestion).toContain("NOT been changed")
    })

    it("rejects empty input", () => {
        expect(service.validate("").error.code).toBe("empty_xml")
        expect(service.validate("   ").error.code).toBe("empty_xml")
        expect(service.validate(undefined).error.code).toBe("empty_xml")
    })

    it("rejects a document that is not draw.io at all", () => {
        const result = service.validate("<html><body>hello</body></html>")
        expect(result.success).toBe(false)
        expect(result.error.code).toBe("invalid_xml")
    })

    it("counts pages across a multi-page document", () => {
        const page = (id: string, name: string) =>
            `<diagram id="${id}" name="${name}"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" vertex="1" parent="1"><mxGeometry as="geometry"/></mxCell></root></mxGraphModel></diagram>`
        const result = service.validate(`<mxfile>${page("p1", "One")}${page("p2", "Two")}</mxfile>`)

        expect(result.data.pages.count).toBe(2)
        expect(result.data.pages.cellCount).toBe(2)
        expect(result.data.pages.pages.map((p: any) => p.name)).toEqual(["One", "Two"])
    })
})

describe("shape cross-check (warnings only)", () => {
    const withStyle = (style: string) =>
        `<mxfile><diagram id="p1" name="P"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>` +
        `<mxCell id="a" style="${style}" vertex="1" parent="1"><mxGeometry as="geometry"/></mxCell>` +
        `</root></mxGraphModel></diagram></mxfile>`

    it("warns on a typo in a fully-indexed library and suggests the real name", () => {
        const result = service.validate(withStyle("shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lamda;"))
        expect(result.success).toBe(true) // A warning must never block storage.
        expect(result.data.warnings).toHaveLength(1)
        expect(result.data.warnings[0]).toContain("lambda")
    })

    it("stays silent on a correct reference", () => {
        const result = service.validate(withStyle("shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda;"))
        expect(result.data.warnings).toEqual([])
    })

    it("stays silent on a real-but-unindexed shape from a PARTIAL library", () => {
        // electrical is documented as a sample of ~50 categories. Warning here would train the agent
        // to distrust correct output, which is worse than saying nothing.
        const result = service.validate(withStyle("shape=mxgraph.electrical.resistors.resistor_7;"))
        expect(result.data.warnings).toEqual([])
    })

    it("stays silent on styles that address no library at all", () => {
        expect(service.validate(withStyle("rounded=1;fillColor=#dae8fc;")).data.warnings).toEqual([])
    })

    it("can be switched off entirely", () => {
        const off = new DiagramService({ shapeLibraryService, shapeCheckEnabled: false, errorResponseMessage })
        expect(off.validate(withStyle("resIcon=mxgraph.aws4.lamda;")).data.warnings).toEqual([])
    })
})
