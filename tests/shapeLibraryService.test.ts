/**
 * Pins the search behaviour an AI Agent depends on.
 *
 * The load-bearing property is that a caller receives FINISHED style strings and never has to
 * assemble one. Everything else here protects the ergonomics of getting to the right one.
 */

import { describe, expect, it } from "vitest"

const ErrorResponseMessage = require("../src/utils/errorResponseMessage")
const ShapeLibraryService = require("../src/services/shapeLibraryService")

const service = new ShapeLibraryService({ errorResponseMessage: new ErrorResponseMessage() })
const names = (result: any) => result.data.matches.map((m: any) => m.name)

describe("catalogue", () => {
    it("stays small enough to be worth an agent's context", () => {
        // It is the first thing an agent reads and it pays for it in tokens.
        expect(JSON.stringify(service.catalogue()).length).toBeLessThan(4000)
    })

    it("reports coverage per library so an agent knows what it is trusting", () => {
        const libs = service.catalogue().data.libraries
        expect(libs).toHaveLength(30)
        expect(libs.every((l: any) => typeof l.coverage === "string")).toBe(true)
    })
})

describe("single-library search", () => {
    it("puts an exact match first", () => {
        expect(names(service.search("aws4", "lambda"))[0]).toBe("lambda")
    })

    it("prefers the shorter name when scores tie", () => {
        const result = names(service.search("aws4", "lambda"))
        expect(result.indexOf("lambda")).toBeLessThan(result.indexOf("lambda_function"))
    })

    it("is separator-insensitive", () => {
        // "virtual machine", "virtual-machine" and "virtualmachine" must all find Virtual_Machine.
        for (const q of ["virtual machine", "virtual-machine", "virtualmachine"]) {
            expect(names(service.search("azure2", q))[0], q).toBe("compute/Virtual_Machine")
        }
    })

    it("answers every requested term before any term gets a second hit", () => {
        // The point of multi-term search is "give me these N shapes in one call". A flat global
        // ranking would let s3's many variants push lambda off the page entirely.
        expect(names(service.search("aws4", "lambda,s3,dynamodb")).slice(0, 3))
            .toEqual(["lambda", "s3", "dynamodb"])
    })

    it("accepts terms as an array, which is how the OpenAPI layer delivers them", () => {
        expect(names(service.search("aws4", ["lambda", "s3"])).slice(0, 2)).toEqual(["lambda", "s3"])
    })

    it("never returns a style containing an unsubstituted placeholder", () => {
        for (const m of service.search("aws4", "lambda").data.matches) {
            expect(m.style).not.toMatch(/[{}]/)
        }
    })

    it("does not dump a large library when no query is given", () => {
        const result = service.search("aws4")
        expect(result.data.matches).toHaveLength(0)
        expect(result.data.counts.library).toBe(1031)
        expect(result.data.note).toContain("?q=")
        // ...but still hands over something usable to start from.
        expect(result.data.example).toContain("<mxCell")
    })

    it("returns a small library in full", () => {
        const result = service.search("infographic")
        expect(result.data.matches).toHaveLength(9)
    })

    it("404s on an unknown library and lists the valid ids", () => {
        const result = service.search("nope")
        expect(result.success).toBe(false)
        expect(result.status).toBe(404)
        expect(result.error.suggestion).toContain("aws4")
    })

    it("returns success with an empty match list rather than an error", () => {
        const result = service.search("aws4", "zzzznotathing")
        expect(result.success).toBe(true)
        expect(result.data.matches).toEqual([])
        expect(result.data.note).toBeTruthy()
    })

    it("caps limit at 50 and floors it at 1", () => {
        expect(service.search("aws4", "s3", 500).data.matches.length).toBeLessThanOrEqual(50)
        expect(service.search("aws4", "s3", 0).data.matches.length).toBeGreaterThan(0)
    })

    it("carries library params where extra style keys are required", () => {
        expect(service.search("bpmn", "gateway").data.params.outline).toContain("throwing")
    })
})

describe("cross-library search", () => {
    it("finds the right library for each term", () => {
        const result = service.searchAll("lambda,pod,firewall", 6)
        const top3 = result.data.matches.slice(0, 3)
        expect(top3.map((m: any) => `${m.library}/${m.name}`))
            .toEqual(["aws4/lambda", "kubernetes/pod", "cisco19/firewall"])
    })

    it("falls back to the catalogue when there is no query", () => {
        expect(service.searchAll("").data.libraryCount).toBe(30)
    })

    it("does not return the same shape twice", () => {
        const keys = service.searchAll("lambda,lambda", 10).data.matches.map((m: any) => `${m.library}/${m.name}`)
        expect(new Set(keys).size).toBe(keys.length)
    })
})
