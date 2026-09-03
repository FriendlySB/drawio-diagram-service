/**
 * Pins the generated shape index (src/shapes/shapeIndex.json).
 *
 * The generator is the riskiest code in the service, and its failure mode is silent: a regression
 * does not crash, it emits style strings that draw.io ignores, producing blank rectangles in a
 * user's diagram. These tests exist to make that failure loud.
 *
 * The counts below are pinned EXACTLY rather than as lower bounds. A parser change that quietly
 * gains or loses shapes is precisely what needs to show up in a diff.
 */

import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import index from "../src/shapes/shapeIndex.json"

const DOCS_DIR = join(__dirname, "..", "docs", "shape-libraries")

type Shape = { name: string; style: string; note?: string }
type Library = {
    id: string
    title: string
    form: string
    coverage: string
    styleTemplate: string
    size: { width: number; height: number }
    count: number
    params?: Record<string, string[]>
    note?: string
    shapes: Shape[]
}

const libraries = index.libraries as unknown as Record<string, Library>
const everyShape = (): Array<{ lib: Library; shape: Shape }> =>
    Object.values(libraries).flatMap((lib) => lib.shapes.map((shape) => ({ lib, shape })))

describe("shape index integrity", () => {
    it("covers all 30 libraries and 4,065 shapes", () => {
        expect(index.libraryCount).toBe(30)
        expect(index.shapeCount).toBe(4065)
        expect(Object.keys(libraries)).toHaveLength(30)
    })

    it("is in sync with the markdown it was generated from", () => {
        // The docs stay the source of truth. If someone edits a library file and forgets to run
        // `npm run build:shapes`, this fails rather than the service serving a stale index.
        const hash = createHash("sha256")
        for (const file of readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md") && f !== "README.md").sort()) {
            hash.update(file).update("\0").update(readFileSync(join(DOCS_DIR, file), "utf8")).update("\0")
        }
        expect(index.sourceHash).toBe(hash.digest("hex"))
    })

    it("never ships an unsubstituted placeholder", () => {
        // The single most important invariant. A style still containing {shape} means the agent
        // would paste a literal placeholder into a diagram.
        const broken = everyShape().filter(({ shape }) => /[{}]/.test(shape.style))
        expect(broken.map((b) => `${b.lib.id}/${b.shape.name}`)).toEqual([])
    })

    it("never doubles a library prefix", () => {
        // What "mxgraph.aws4." + "mxgraph.aws4.lambda" would look like.
        const broken = everyShape().filter(({ shape }) => shape.style.includes(".mxgraph."))
        expect(broken.map((b) => `${b.lib.id}/${b.shape.name}`)).toEqual([])
    })

    it("drops the poison bullet -- no token is a bare library prefix", () => {
        // 18 of the 30 files list their own mxgraph prefix among the shapes. It is not a shape.
        const broken = everyShape().filter(({ shape }) => shape.name.startsWith("mxgraph."))
        expect(broken.map((b) => `${b.lib.id}/${b.shape.name}`)).toEqual([])
    })

    it("gives every shape a non-empty name and a style that sets something", () => {
        for (const { lib, shape } of everyShape()) {
            expect(shape.name.trim(), `${lib.id} has an empty shape name`).not.toBe("")
            expect(shape.style, `${lib.id}/${shape.name}`).toMatch(/(shape|resIcon|prIcon|image)=/)
        }
    })

    it("keeps each library's count consistent with its shapes array", () => {
        for (const lib of Object.values(libraries)) {
            expect(lib.count, lib.id).toBe(lib.shapes.length)
        }
    })
})

describe("per-library counts", () => {
    // Pinned exactly. A silent gain or loss here is the regression these tests exist to catch.
    const expected: Record<string, number> = {
        alibaba_cloud: 310, android: 47, arrows2: 18, atlassian: 17, aws4: 1031,
        azure2: 513, basic: 30, bpmn: 39, cabinets: 53, cisco19: 232,
        citrix: 97, electrical: 16, floorplan: 44, flowchart: 34, fluidpower: 246,
        gcp2: 297, infographic: 9, kubernetes: 40, lean_mapping: 13, material_design: 300,
        mscae: 1, network: 57, openstack: 18, pid: 4, rack: 19,
        salesforce: 96, sap: 164, sitemap: 50, vvd: 94, webicons: 176,
    }

    for (const [id, count] of Object.entries(expected)) {
        it(`${id} has ${count} shapes`, () => {
            expect(libraries[id]?.count).toBe(count)
        })
    }
})

describe("the five addressing idioms", () => {
    const styleOf = (libId: string, name: string) =>
        libraries[libId].shapes.find((s) => s.name === name)?.style

    it("aws4 puts the qualified name in resIcon, not shape", () => {
        expect(styleOf("aws4", "lambda")).toBe(
            "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda;fillColor=#ED7100;" +
            "strokeColor=#ffffff;verticalLabelPosition=bottom;verticalAlign=top;align=center;"
        )
    })

    it("cisco19 puts a BARE slug in prIcon", () => {
        // The trap: prIcon takes "router", not "mxgraph.cisco19.router".
        expect(styleOf("cisco19", "router")).toContain("prIcon=router;")
        expect(styleOf("cisco19", "router")).toContain("shape=mxgraph.cisco19.rect;")
    })

    it("azure2 keeps the category in the image path", () => {
        // A flat list would emit img/lib/azure2/Virtual_Machine.svg, which does not exist.
        expect(styleOf("azure2", "compute/Virtual_Machine")).toContain(
            "image=img/lib/azure2/compute/Virtual_Machine.svg;"
        )
    })

    it("electrical qualifies the shape name with its category", () => {
        expect(styleOf("electrical", "resistors.resistor_1")).toBe("shape=mxgraph.electrical.resistors.resistor_1;")
    })

    it("material_design substitutes into the CDN url and does NOT qualify by category", () => {
        // Its sections are organisational; the URL takes a bare icon name.
        expect(styleOf("material_design", "account_balance")).toContain(
            "image=https://fonts.gstatic.com/s/i/materialicons/account_balance/v6/24px.svg;"
        )
    })
})

describe("the awkward libraries", () => {
    it("rack switches library for its General section", () => {
        // `### General (rackGeneral)` is not a vendor -- it changes mxgraph.rack to mxgraph.rackGeneral.
        expect(libraries.rack.shapes.find((s) => s.name === "rackCabinet3")?.style).toBe(
            "shape=mxgraph.rackGeneral.rackCabinet3;strokeColor=#666666;"
        )
        // ...while a real vendor keeps three levels of qualification.
        expect(libraries.rack.shapes.find((s) => s.name.startsWith("hpe_aruba.security."))?.style).toContain(
            "shape=mxgraph.rack.hpe_aruba.security."
        )
    })

    it("bpmn excludes its Parameters bullets and surfaces them as params", () => {
        const names = libraries.bpmn.shapes.map((s) => s.name)
        expect(names).not.toContain("outline")
        expect(names).not.toContain("symbol")
        expect(libraries.bpmn.params?.outline).toContain("throwing")
        expect(libraries.bpmn.params?.symbol).toContain("message")
    })

    it("infographic folds each shape's required extra params into its style", () => {
        const cube = libraries.infographic.shapes.find((s) => s.name === "shadedCube")
        expect(cube?.style).toContain("isoAngle=15;")
        const ribbon = libraries.infographic.shapes.find((s) => s.name === "ribbonSimple")
        expect(ribbon?.style).toContain("notch1=20;notch2=20;")
        // A shape with no extras must not inherit another's.
        expect(libraries.infographic.shapes.find((s) => s.name === "ribbonRolled")?.style).not.toContain("isoAngle")
    })

    it("pid ships a working valveType default", () => {
        expect(libraries.pid.shapes.find((s) => s.name === "pid2valves.valve")?.style)
            .toBe("shape=mxgraph.pid2valves.valve;valveType=gate;")
        expect(libraries.pid.params?.valveType).toContain("butterfly")
    })

    it("never derives an mxgraph prefix from a filename", () => {
        // network -> mxgraph.networks, fluidpower -> mxgraph.fluid_power.
        expect(libraries.network.styleTemplate).toContain("mxgraph.networks.")
        expect(libraries.fluidpower.styleTemplate).toContain("mxgraph.fluid_power.")
    })
})

describe("slug landmines", () => {
    it("keeps dots inside a slug rather than splitting on them", () => {
        expect(libraries.webicons.shapes.map((s) => s.name)).toContain("last.fm")
    })

    it("keeps parentheses", () => {
        expect(libraries.bpmn.shapes.map((s) => s.name)).toContain("gateway_xor_(data)")
    })

    it("treats bare numbers as names, not indices", () => {
        const one = libraries.sap.shapes.find((s) => s.name === "1")
        expect(typeof one?.name).toBe("string")
        expect(one?.style).toContain("img/lib/sap/1.svg")
    })
})

describe("coverage honesty", () => {
    it("labels the five incomplete libraries", () => {
        const byCoverage: Record<string, string[]> = {}
        for (const lib of Object.values(libraries)) {
            ;(byCoverage[lib.coverage] ||= []).push(lib.id)
        }
        expect(byCoverage.complete).toHaveLength(24)
        expect(byCoverage.partial.sort()).toEqual(["azure2", "electrical", "material_design", "rack"])
        expect(byCoverage.parametric).toEqual(["pid"])
        expect(byCoverage.unindexed).toEqual(["mscae"])
    })

    it("gives every non-complete library a note explaining the gap", () => {
        for (const lib of Object.values(libraries)) {
            if (lib.coverage === "complete") continue
            expect(lib.note, `${lib.id} is ${lib.coverage} but says nothing about it`).toBeTruthy()
        }
    })
})
