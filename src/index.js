/**
 * draw.io Diagram Service
 *
 * The bridge between ServeAI's AI Agents and the draw.io rendering service.
 *
 * An AI Agent can already write draw.io XML unaided. What it cannot do from inside a Flowise tool
 * call is look up which of 4,000 shapes exists and how to address it, know whether the XML it just
 * wrote will actually open, keep a working copy across turns of a conversation, or reach a headless
 * Chrome. This service does those four things, and nothing else.
 *
 * The renderer it proxies (draw-image-export2) has no authentication of its own and must never be
 * network-exposed. This service is the only thing that should be able to reach it.
 */

const express = require("express");
const path = require("path");
const YAML = require("yamljs");
const swaggerUi = require("swagger-ui-express");
const OpenApiValidator = require("express-openapi-validator");

const { config, errorResponseMessage, storageService, renderService, shapeLibraryService } = require("./container");
const diagramRoutes = require("./routes/diagramRoutes");
const { assertCredentialsConfigured } = require("./middleware/auth");

const app = express();
const swaggerPath = path.join(__dirname, "swagger", "openapi.yaml");

// Diagram XML travels as a JSON string field, and a detailed diagram is a large document.
app.use(express.json({ limit: config.maxBodySize }));

// Swagger
const swaggerDocument = YAML.load(swaggerPath);
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.use(
  "/api",
  OpenApiValidator.middleware({
    apiSpec: swaggerPath,
    validateRequests: true,
    // Responses are not validated: a render's `data` and a validate's `data` differ in shape, and
    // shape-search results carry per-library fields (params, note) that only some libraries have. A
    // strict response schema would reject legitimate output and hide the field the agent needs.
    validateResponses: false,
    // Security is enforced solely by middleware/auth.js. Left on, the validator answers a missing
    // Authorization header itself, with a different body than a wrong-credentials rejection -- which
    // tells an attacker whether a header was recognised. One authority keeps both cases identical.
    validateSecurity: false,
    ignorePaths: (p) => /^\/api\/docs/.test(p),
  })
);

app.use("/api", diagramRoutes);

/**
 * Single error handler. Turns OpenApiValidator rejections, malformed JSON, oversized bodies, and any
 * unexpected failure into the same {success, error:{error, code, suggestion}} envelope the rest of
 * the API uses, so a caller -- and ultimately the AI Agent reading these responses -- never has to
 * parse a second error format.
 */
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).send(
      errorResponseMessage.badRequest("Request body is not valid JSON.", "invalid_json", "Check the payload syntax.")
    );
  }

  // Body-parser's own rejection. Without this branch an oversized diagram falls through to the
  // generic 500 below and the agent is told "internal_error" for a mistake it could have corrected.
  if (err.type === "entity.too.large") {
    return res.status(413).send(
      errorResponseMessage.payloadTooLarge(
        `Request body exceeds the ${config.maxBodySize} limit.`,
        "payload_too_large",
        "Split the diagram across pages and validate one page at a time."
      )
    );
  }

  if (err.status && err.errors) {
    return res.status(err.status).send(
      errorResponseMessage.badRequest(
        err.message,
        "schema_validation_failed",
        err.errors.map((e) => `${e.path} ${e.message}`).join("; ")
      )
    );
  }

  console.error("Unhandled error:", err);
  return res.status(500).send(errorResponseMessage.serverError(err.message || "Internal server error."));
});

// Refuse to start rather than run unprotected -- see middleware/auth.js.
assertCredentialsConfigured();

app.listen(config.port, () => {
  console.log(`draw.io Diagram Service listening at http://localhost:${config.port}`);
  console.log(`API docs:      http://localhost:${config.port}/api/docs`);
  console.log(`Storage root:  ${config.storageRoot} (TTL ${config.tempTtlHours}h, max ${config.maxDiagramsPerChat}/chat)`);
  console.log(`Shape index:   ${shapeLibraryService.index.shapeCount} shapes in ${shapeLibraryService.index.libraryCount} libraries`);
  console.log(`Renderer:      ${config.renderBaseUrl} (timeout ${config.renderTimeoutMs}ms)`);

  renderService.probe().then(({ reachable, detail }) => {
    // A warning, never a refusal to start. Validation and shape lookup work perfectly well with the
    // renderer down, and taking the whole service offline over it would be a worse outage.
    if (reachable) console.log(`Renderer:      reachable (${detail})`);
    else console.warn(`WARNING: renderer unreachable (${detail}) -- render endpoints will fail until it is up.`);
  });

  storageService.startSweeper();
});
