/**
 * Pins the render client against a stubbed fetch, covering every branch that can answer a caller.
 *
 * The distinction being pinned throughout: refusals WE make carry an HTTP status (4xx), while
 * failures of the renderer come back as HTTP 200 with success:false. A dead external dependency is
 * something the AI Agent should read and react to, not a transport error -- the same discipline the
 * sibling OfficeCLI Server uses for cli_timeout / cli_failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const ErrorResponseMessage = require("../src/utils/errorResponseMessage")
const RenderService = require("../src/services/renderService")

const XML = '<mxfile><diagram id="p1" name="P"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>'
const PNG_BASE64 = Buffer.from("fake png bytes").toString("base64")

let renderer: any
const originalFetch = globalThis.fetch

const stub = (impl: (url: string, init: any) => any) => {
    globalThis.fetch = vi.fn(impl) as any
}

/** A response shaped like draw-image-export2's: base64 body, text/plain, dimension headers. */
const ok = (body = PNG_BASE64, headers: Record<string, string> = {}) => ({
    ok: true,
    status: 200,
    headers: new Headers({
        "content-type": "text/plain",
        "content-ex-width": "577",
        "content-ex-height": "194",
        "content-scale": "2",
        ...headers,
    }),
    text: async () => body,
})

beforeEach(() => {
    renderer = new RenderService({
        baseUrl: "http://renderer.test",
        timeoutMs: 35000,
        defaultBackground: "#ffffff",
        defaultScale: 2,
        defaultBorder: 10,
        errorResponseMessage: new ErrorResponseMessage(),
    })
})

afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
})

describe("the request it builds", () => {
    it("sends base64 and embedXml as the STRING \"1\"", async () => {
        // The renderer compares with ==, against "1". Numbers or booleans silently do nothing, and
        // losing embedXml would silently cost every delivered PNG its re-editability.
        let body: URLSearchParams | undefined
        stub((_url, init) => { body = init.body; return ok() })

        await renderer.render({ xml: XML, format: "png" })
        expect(body!.get("base64")).toBe("1")
        expect(body!.get("embedXml")).toBe("1")
        expect(body!.get("format")).toBe("png")
    })

    it("defaults the background to white", async () => {
        // The renderer omits the background for a PNG when bg is absent, and a transparent PNG with
        // dark text is invisible in a dark-mode chat.
        let body: URLSearchParams | undefined
        stub((_url, init) => { body = init.body; return ok() })

        await renderer.render({ xml: XML, format: "png" })
        expect(body!.get("bg")).toBe("#ffffff")
    })

    it("honours an explicit transparent background by omitting bg", async () => {
        let body: URLSearchParams | undefined
        stub((_url, init) => { body = init.body; return ok() })

        await renderer.render({ xml: XML, format: "png", background: "none" })
        expect(body!.has("bg")).toBe(false)
    })

    it("forwards page selection and scale", async () => {
        let body: URLSearchParams | undefined
        stub((_url, init) => { body = init.body; return ok() })

        await renderer.render({ xml: XML, format: "pdf", scale: 3, pageId: "pg2", allPages: true })
        expect(body!.get("pageId")).toBe("pg2")
        expect(body!.get("allPages")).toBe("1")
        expect(body!.get("scale")).toBe("3")
    })

    it("posts form-urlencoded, which is the only body the renderer parses", async () => {
        let init: any
        stub((_url, i) => { init = i; return ok() })

        await renderer.render({ xml: XML, format: "png" })
        expect(init.method).toBe("POST")
        expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded")
    })
})

describe("success", () => {
    it("synthesises the mime type rather than forwarding text/plain", async () => {
        stub(() => ok())
        const result = await renderer.render({ xml: XML, format: "png" })

        expect(result.success).toBe(true)
        // Forwarding the renderer's own text/plain would tell ServeAI to treat a PNG as a text file.
        expect(result.data.mimeType).toBe("image/png")
        expect(result.data.contentBase64).toBe(PNG_BASE64)
        expect(result.data.sizeBytes).toBe(Buffer.from(PNG_BASE64, "base64").length)
    })

    it("passes through the rendered pixel dimensions", async () => {
        stub(() => ok())
        const result = await renderer.render({ xml: XML, format: "png" })
        expect(result.data.width).toBe(577)
        expect(result.data.height).toBe(194)
    })

    it("maps jpg to image/jpeg", async () => {
        stub(() => ok())
        expect((await renderer.render({ xml: XML, format: "jpg" })).data.mimeType).toBe("image/jpeg")
    })
})

describe("refusals we make ourselves (4xx)", () => {
    it("rejects svg with a message naming what IS supported", async () => {
        // The renderer's own answer is a bare 400 "Unsupported Format!", which tells an agent nothing.
        stub(() => { throw new Error("must not be called") })

        const result = await renderer.render({ xml: XML, format: "svg" })
        expect(result.success).toBe(false)
        expect(result.error.code).toBe("unsupported_format")
        expect(result.status).toBe(400)
        expect(result.error.suggestion).toContain("png, jpg, jpeg, pdf")
    })

    it("rejects an oversized diagram before dispatching it", async () => {
        const called = vi.fn(() => ok())
        stub(called)

        const result = await renderer.render({ xml: "x".repeat(2_000_001), format: "png" })
        expect(result.error.code).toBe("diagram_too_large")
        expect(result.status).toBe(400)
        expect(called).not.toHaveBeenCalled()
    })
})

describe("renderer failures (200 + success:false)", () => {
    const expectExternal = (result: any, code: string) => {
        expect(result.success).toBe(false)
        expect(result.error.code).toBe(code)
        // No status field means the controller answers 200 -- an external-tool failure, not a
        // transport error.
        expect(result.status).toBeUndefined()
    }

    it("reports a timeout distinctly from unreachability", async () => {
        stub(() => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e })
        expectExternal(await renderer.render({ xml: XML, format: "png" }), "render_timeout")
    })

    it("reports a connection failure as unreachable", async () => {
        stub(() => { throw new TypeError("fetch failed") })
        const result = await renderer.render({ xml: XML, format: "png" })
        expectExternal(result, "render_service_unreachable")
        expect(result.error.error).toContain("http://renderer.test")
    })

    it("relays the renderer's bare-text error body", async () => {
        stub(() => ({ ok: false, status: 500, headers: new Headers(), text: async () => "Error!" }))
        const result = await renderer.render({ xml: XML, format: "png" })
        expectExternal(result, "render_failed")
        expect(result.error.error).toContain("Error!")
    })

    it("truncates a runaway error body", async () => {
        stub(() => ({ ok: false, status: 500, headers: new Headers(), text: async () => "x".repeat(5000) }))
        const result = await renderer.render({ xml: XML, format: "png" })
        expect(result.error.error.length).toBeLessThan(300)
    })

    it("catches an HTML page from a proxy standing in front of the renderer", async () => {
        stub(() => ok("<!doctype html><html><body>Sign in</body></html>", { "content-type": "text/html" }))
        const result = await renderer.render({ xml: XML, format: "png" })
        expectExternal(result, "render_failed")
        expect(result.error.suggestion).toContain("draw-image-export2")
    })

    it("catches a 200 whose body is not base64 at all", async () => {
        stub(() => ok("Internal Server Error: something went wrong!"))
        expectExternal(await renderer.render({ xml: XML, format: "png" }), "render_failed")
    })
})

describe("probe", () => {
    it("treats any HTTP response as proof of life, including a 400", async () => {
        // A parameterless GET falls through to the renderer's `400 BAD REQUEST` WITHOUT launching
        // Chrome, so reachability costs nothing to establish.
        stub(() => ({ ok: false, status: 400, headers: new Headers(), text: async () => "BAD REQUEST" }))
        expect(await renderer.probe()).toEqual({ reachable: true, detail: "HTTP 400" })
    })

    it("never throws when the renderer is down", async () => {
        stub(() => { throw new TypeError("fetch failed") })
        expect(await renderer.probe()).toEqual({ reachable: false, detail: "fetch failed" })
    })
})
