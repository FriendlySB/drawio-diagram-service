/**
 * Render Service
 *
 * The client for draw-image-export2, the headless-Chrome renderer that turns draw.io XML into an
 * image. It is the only part of this codebase that talks to another server.
 *
 * The renderer is a bare Express app with no authentication, CORS `*`, and a fresh Chrome per
 * request. It must never be network-exposed -- private network or loopback only. It also answers
 * everything in plain text: a successful base64 render and a failure both come back as text/plain,
 * so status code is the primary signal and content-type only a secondary guard against an HTML page
 * from a misconfigured proxy in between.
 *
 * Every failure below is returned as HTTP 200 with { success:false }. A renderer that is down is an
 * external-tool failure the AI Agent should read and react to, not a transport error -- the same
 * discipline the OfficeCLI Server uses for cli_timeout / cli_failure.
 */

/** SVG is deliberately absent: draw-image-export2 does not implement it and answers a bare 400. */
const SUPPORTED_FORMATS = ["png", "jpg", "jpeg", "pdf"];

const MIME_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
};

/**
 * The renderer parses bodies with express.urlencoded({ limit: '10mb' }). XML form-encodes to roughly
 * three times its size once every '<', '>' and '"' becomes a percent escape, so a document much past
 * ~2.5 MB is rejected by the renderer's body parser with an opaque error. We refuse earlier, with a
 * message that says what to do about it.
 */
const MAX_XML_BYTES = 2_000_000;

class RenderService {
  constructor({ baseUrl, timeoutMs, defaultBackground, defaultScale, defaultBorder, errorResponseMessage }) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.defaultBackground = defaultBackground;
    this.defaultScale = defaultScale;
    this.defaultBorder = defaultBorder;
    this.errorResponseMessage = errorResponseMessage;
    this.supportedFormats = SUPPORTED_FORMATS;
  }

  /**
   * Wraps an error body with the HTTP status the controller should use.
   * @private
   */
  fail(body, status) {
    return { ...body, status };
  }

  /**
   * Refusals we make ourselves, before spending a Chrome launch on a request that cannot succeed.
   * @param {Object} options - { format, xml }
   * @returns {Object|null} An error result, or null when the request is worth dispatching
   * @private
   */
  precheck({ format, xml }) {
    if (!SUPPORTED_FORMATS.includes(format)) {
      // The renderer's own answer to an unknown format is `400 "Unsupported Format!"` with no list
      // of what IS supported -- useless to an agent trying to correct itself. Hence our own message.
      return this.fail(
        this.errorResponseMessage.badRequest(
          `Unsupported render format: "${format}".`,
          "unsupported_format",
          `Use one of: ${SUPPORTED_FORMATS.join(", ")}. SVG is not available from this renderer.`
        ),
        400
      );
    }

    const bytes = Buffer.byteLength(xml, "utf8");
    if (bytes > MAX_XML_BYTES) {
      return this.fail(
        this.errorResponseMessage.badRequest(
          `Diagram is ${bytes} bytes, above the ${MAX_XML_BYTES}-byte render limit.`,
          "diagram_too_large",
          "Split the diagram across pages and render one page at a time with pageId."
        ),
        400
      );
    }

    return null;
  }

  /**
   * Render a diagram.
   *
   * @param {Object} options
   * @param {String} options.xml - The full <mxfile> document
   * @param {String} options.format - png | jpg | jpeg | pdf
   * @param {Number} [options.scale] - Render scale; higher is more legible and larger
   * @param {String} [options.pageId] - Render one page of a multi-page document
   * @param {Boolean} [options.allPages] - PDF only: every page in one file
   * @param {String} [options.background] - CSS colour, or "none" for transparent
   * @returns {Object} { success, data: { format, mimeType, contentBase64, ... } } or an error result
   */
  async render({ xml, format, scale, pageId, allPages, background }) {
    const refused = this.precheck({ format, xml });
    if (refused) return refused;

    const params = new URLSearchParams();
    params.set("xml", xml);
    params.set("format", format);
    // The renderer compares these with `==` against the STRING "1", so numbers would silently fail.
    params.set("base64", "1");
    // The whole delivery story, and it is PNG-only in practice. ServeAI cannot carry a .drawio file,
    // so for a PNG the renderer writes the source XML into a zTXt chunk keyed "mxGraphModel" (raw
    // deflate, URI-encoded) and the delivered image reopens in draw.io as a fully editable diagram
    // rather than a flat picture. Verified end to end: the chunk decodes back to the stored document
    // byte for byte.
    //
    // REQUIRES the two writePngWithText fixes in drawio-diagram-renderer-service. Upstream
    // draw-image-export2 computes the zTXt CRC over only the compressed payload (omitting the key,
    // its null terminator and the compression-method byte) and under-allocates the output buffer by
    // 8 bytes, truncating IEND. The result is a PNG that draw.io reads happily and stricter decoders
    // reject -- so with an unpatched renderer, embedXml silently corrupts every delivered image.
    //
    // The renderer has a PDF equivalent (pdf-lib setSubject) but it does not take effect in this
    // build -- a rendered PDF's Info dictionary carries only Chrome's own Title and Creator, with no
    // /Subject, with or without allPages. Measured, not assumed. The flag is still sent because it
    // is harmless and would start working if the renderer were fixed, but nothing may promise a PDF
    // is re-editable: see the message the controller attaches, which claims it only for PNG.
    params.set("embedXml", "1");
    params.set("scale", String(scale ?? this.defaultScale));
    params.set("border", String(this.defaultBorder));

    // Defaulted to white on purpose. The renderer sets omitBackground when format is png and bg is
    // null or "none", and a transparent PNG with dark text is invisible in a dark-mode chat.
    const bg = background ?? this.defaultBackground;
    if (bg && bg !== "none") params.set("bg", bg);

    if (pageId) params.set("pageId", pageId);
    if (allPages) params.set("allPages", "1");

    let res;
    try {
      res = await fetch(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
        // Deliberately ABOVE the renderer's own 30s Chrome kill. Aborting sooner would abandon
        // renders that were about to succeed while Chrome burns the CPU anyway.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        return this.errorResponseMessage.externalFailure(
          `Render timed out after ${this.timeoutMs} ms.`,
          "render_timeout",
          "The diagram may be very large. Try rendering a single page, or lowering scale."
        );
      }
      return this.errorResponseMessage.externalFailure(
        `Could not reach the render service at ${this.baseUrl}: ${err.message}`,
        "render_service_unreachable",
        "The rendering service is down or unreachable. Retry shortly; if it persists, it needs an operator."
      );
    }

    if (!res.ok) {
      // Error bodies are bare strings: "Unsupported Format!", "BAD REQUEST", "Error!".
      const body = (await res.text().catch(() => "")).slice(0, 200);
      return this.errorResponseMessage.externalFailure(
        `Render service returned ${res.status}: ${body || "(empty body)"}`,
        "render_failed",
        res.status >= 500
          ? "The renderer failed while drawing. The XML may reference an unavailable shape library."
          : "The renderer rejected the request. Check format and page selection."
      );
    }

    const contentBase64 = await res.text();

    // A 200 whose body is HTML did not come from the renderer -- it came from something in front of
    // it (a proxy login page, a tunnel error). Catch it before handing an agent 40 KB of markup.
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/html") || !/^[A-Za-z0-9+/=\s]+$/.test(contentBase64.slice(0, 512))) {
      return this.errorResponseMessage.externalFailure(
        "Render service returned a non-image response.",
        "render_failed",
        `Expected base64 image data. Check that ${this.baseUrl} points at draw-image-export2 and not at a proxy.`
      );
    }

    return {
      success: true,
      data: {
        format,
        // Synthesised here. The renderer's own Content-Type is text/plain because the body is
        // base64, and forwarding that would tell ServeAI to treat a PNG as a text file.
        mimeType: MIME_TYPES[format],
        contentBase64,
        sizeBytes: Buffer.from(contentBase64, "base64").length,
        // Free from the response headers, and worth passing on: rendered pixel dimensions are what
        // let an agent reason about whether a diagram will be legible as a chat thumbnail.
        width: Number(res.headers.get("content-ex-width")) || null,
        height: Number(res.headers.get("content-ex-height")) || null,
        pageId: res.headers.get("content-page-id") || pageId || null,
        scale: Number(res.headers.get("content-scale")) || scale || this.defaultScale,
      },
    };
  }

  /**
   * Cheap reachability check for boot and /api/health.
   *
   * A parameterless GET falls through the renderer's dispatch to `res.status(400).end("BAD REQUEST")`
   * WITHOUT launching Chrome, so any HTTP response at all proves the service is up while costing
   * nothing. Never throws -- a probe failure is information, not an outage of this server.
   * @returns {Object} { reachable, detail }
   */
  async probe() {
    try {
      const res = await fetch(this.baseUrl, { signal: AbortSignal.timeout(5000) });
      return { reachable: true, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { reachable: false, detail: err.message };
    }
  }
}

module.exports = RenderService;
