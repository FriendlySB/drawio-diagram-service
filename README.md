# draw.io Diagram Service

An HTTP bridge between ServeAI's AI Agents and the draw.io rendering service.

An AI Agent can already write draw.io XML unaided. What it cannot do from inside a Flowise tool call
is look up which of ~4,000 shapes exists and how to address it, know whether the XML it just wrote
will actually open, keep a working copy across turns of a conversation, or reach a headless Chrome.
This service does those four things, and nothing else.

```
ServeAI (Flowise agent)
        │  HTTPS + Basic auth
        ▼
drawio-diagram-service ──── shape index (4,065 shapes, 30 libraries)
        │                   validator (vendored from next-ai-draw-io)
        │                   per-conversation working copies, 24h TTL
        │  form-urlencoded, private network only
        ▼
draw-image-export2 (headless Chrome)
```

## Quick start

```bash
npm install
npm run build:vendor      # compile the vendored TypeScript modules to dist/vendor/
cp .env.example .env      # then set DRAWIO_CLIENT_ID and DRAWIO_CLIENT_SECRET
npm start
```

The server **refuses to start** while the credentials are still the placeholder values, so a copied
template cannot go live unprotected.

`src/http/diagram.http` is a numbered, runnable request sequence covering the whole workflow.
Interactive docs are at `/api/docs`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness. **Unauthenticated.** Reports renderer reachability. |
| `GET` | `/api/shapes` | Library catalogue; `?q=` searches across every library. |
| `GET` | `/api/shapes/{library}` | Search one library. `?q=term1,term2` |
| `POST` | `/api/diagram/create` | Start a diagram. Returns a `fileId`. |
| `GET` | `/api/diagram` | List this session's diagrams (metadata only). |
| `POST` | `/api/diagram/validate` | Validate XML; store it **only if it passes**. |
| `POST` | `/api/diagram/render` | Render the stored copy to PNG, JPG or PDF. |

**There is no delete endpoint.** The AI Agent is not intended to remove diagrams, so the capability
is not exposed. Storage is reclaimed by the TTL sweeper alone — which makes that sweeper the only
thing standing between an abandoned session and the disk, and is why `MAX_DIAGRAMS_PER_CHAT` exists.

## The three ideas worth knowing

**1. Shape styles arrive finished.** draw.io addresses shapes five different ways depending on the
library — a direct `shape=`, aws4's `resIcon=`, cisco19's bare `prIcon=`, an image path, a CDN URL —
and some libraries need category qualification that a flat name list gets silently wrong. Every one
of those decisions is made at build time. `matches[].style` is a complete style string; copy it
verbatim. The agent never assembles one, so there is no addressing decision left to get wrong.

```jsonc
// GET /api/shapes/aws4?q=lambda
"matches": [{
  "name": "lambda",
  "style": "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda;fillColor=#ED7100;..."
}]
```

**2. Validate first, write second.** The stored copy is what the user last approved. An attempt to
improve it must not be able to destroy it, so the validator runs against the submitted XML in memory
and the disk is touched only after it returns ok. A rejected document leaves the stored bytes
byte-identical and the agent gets back what was wrong with its attempt. Writes are atomic (temp file
plus rename), so a crash mid-write cannot truncate a good diagram either.

Minor faults are repaired rather than rejected — an unescaped `&`, a bare `<mxGraphModel>` promoted
to a full `<mxfile>` — and every repair is reported in `fixes` so a recurring mistake gets noticed
instead of being invisibly patched forever.

**3. The delivered PNG is the editable artefact.** ServeAI cannot carry a `.drawio` file, so
`embedXml` writes the source XML into the PNG's `zTXt` chunk. The image a user receives reopens in
draw.io as a fully editable diagram rather than a flat picture. *(PNG only: the renderer's PDF
equivalent does not take effect in the current build — measured, not assumed.)*

> **This requires a patched renderer.** Upstream `draw-image-export2` has two bugs in
> `writePngWithText`: it computes the `zTXt` CRC over only the compressed payload — omitting the
> key, its null terminator and the compression-method byte — and it under-allocates the output
> buffer by 8 bytes, truncating the `IEND` chunk. The resulting PNG is malformed. draw.io's own
> reader is lenient enough to open it, which is why the bug is easy to miss, but strict decoders
> reject it outright. Both are fixed in `drawio-diagram-renderer-service`; against an unpatched
> renderer, `embedXml=1` silently corrupts every image this service delivers.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `5100` | |
| `DRAWIO_CLIENT_ID` | — | Required. Server refuses to boot on the placeholder. |
| `DRAWIO_CLIENT_SECRET` | — | Required. Compared in constant time. |
| `STORAGE_ROOT` | `/tmp/serveAI-drawio` | `{root}/{chatId}/{fileId}.xml` + `.json` sidecar |
| `TEMP_TTL_HOURS` | `24` | Idle time before a conversation's diagrams are swept. |
| `MAX_DIAGRAMS_PER_CHAT` | `20` | The only ceiling, since nothing can delete. |
| `MAX_BODY_SIZE` | `10mb` | Oversized bodies get a 413 with a proper envelope. |
| `RENDER_SERVICE_URL` | `http://localhost:8000` | **Must not be network-exposed.** |
| `RENDER_TIMEOUT_MS` | `35000` | Deliberately above the renderer's own 30 s Chrome kill. |
| `RENDER_BACKGROUND` | `#ffffff` | Not transparent — see below. |
| `RENDER_SCALE` | `2` | |
| `RENDER_BORDER` | `10` | |
| `SHAPE_CHECK_ENABLED` | `1` | Cross-check style references. Warnings only, never rejects. |

Two defaults are deliberate rather than arbitrary. `RENDER_TIMEOUT_MS` exceeds the renderer's
internal kill because aborting earlier only abandons renders that were about to succeed while Chrome
burns the CPU anyway. `RENDER_BACKGROUND` is white because the renderer omits the background for a
PNG when it is unset, and a transparent PNG with dark text is invisible in a dark-mode chat.

## Error contract

One envelope for everything, whether the failure came from this server, the validator or the
renderer:

```json
{ "success": false, "error": { "error": "...", "code": "...", "suggestion": "..." } }
```

`code` and `suggestion` are the point — they are what lets the AI Agent correct itself and retry
without a human. The status code carries one further distinction:

- **4xx** — a refusal *we* make. The request was wrong and the agent can fix it.
- **200 with `success: false`** — an *external* failure (`render_timeout`,
  `render_service_unreachable`, `render_failed`). A dead dependency is something to read and react
  to, not a transport error. This matches the sibling OfficeCLI Server's `cli_timeout` discipline.

## Security

- One shared credential, Basic auth, compared with `crypto.timingSafeEqual`. A missing header and a
  wrong secret produce byte-identical responses, so an attacker cannot learn when they have guessed
  a valid client id.
- `chatId` and `fileId` become filesystem path segments and are restricted to
  `^[A-Za-z0-9_-]{1,64}$` — enforced by the OpenAPI schema *and* independently in the storage layer,
  since a direct call bypasses the former.
- **The renderer has no authentication of its own**, allows CORS `*`, and launches a fresh Chrome per
  request. It must be reachable only from this service — private network or loopback.
- The renderer also fetches `viewer.diagrams.net/export3.html` per request, so it needs outbound
  internet unless you self-host draw.io and point `DRAWIO_BASE_URL` at it.

## Project structure

```
src/
  index.js                     express -> swagger -> OpenApiValidator -> routes -> error handler
  container.js                 the only place process.env is read
  domPolyfill.js               installs globalThis.DOMParser + XMLSerializer  (see below)
  middleware/auth.js           Basic auth
  routes/diagramRoutes.js
  controllers/diagramController.js
  services/
    shapeLibraryService.js     serves shapeIndex.json; search + reference cross-check
    diagramService.js          the ONLY consumer of the vendored modules
    storageService.js          working copies, sidecars, TTL sweeper
    renderService.js           the renderer client
  shapes/
    shapeIndex.json            GENERATED, checked in — `npm run build:shapes`
    overrides.json             hand-curated parser RULES (not shapes)
  swagger/openapi.yaml         served at /api/docs AND enforced on every request
  http/diagram.http            numbered runnable requests
  *.ts                         VENDORED from next-ai-draw-io — do not edit
scripts/buildShapeIndex.js     parses docs/shape-libraries/*.md -> shapeIndex.json
docs/shape-libraries/          source of truth for what shapes exist
tests/                         181 tests; `npm test`
```

### Two things that will bite you

**`domPolyfill.js` must load before anything vendored.** The vendored modules read `DOMParser` and
`XMLSerializer` off the global object and **degrade silently** without them: the validator skips a
repair pattern, falls back to regex checking, and still answers `valid: true`. Since this service
writes to disk only when the validator says ok, a quietly-degraded validator is the worst failure
mode available. `container.js` requires the polyfill on its first line for exactly this reason.

**The shape index is generated, not parsed at boot.** `scripts/buildShapeIndex.js` is the riskiest
code here, and its failure mode is silent — a regression emits style strings draw.io ignores,
producing blank rectangles in a user's diagram. A checked-in artefact is reviewed once in a diff and
pinned by tests, rather than re-derived on every production boot where nobody is looking. After
editing anything in `docs/shape-libraries/`, run `npm run build:shapes`; a test compares a hash of
the markdown against the index and fails if you forget.

## Coverage, stated honestly

24 of the 30 libraries are indexed completely. Five are not, and each says so in its `coverage`
field and carries a `note` explaining the gap:

| Library | Coverage | Why |
|---|---|---|
| `azure2` | partial | 513 of 648 shapes documented upstream. |
| `electrical` | partial | A sample of ~50 categories. |
| `material_design` | partial | 300 common icons; any Material name works in the same URL. |
| `rack` | partial | A representative sample of vendors. |
| `pid` | parametric | One valve shape specialised by `valveType=`, not a list. |
| `mscae` | unindexed | Needs a category segment the source never attributes. Prefer `azure2`. |

The validator's shape cross-check **skips every library that is not `complete`**. In a partial
library an unrecognised name is at least as likely to be a gap in our data as a mistake in the
agent's, and warning about correct output would train the agent to distrust the check entirely.

## Licence

Apache-2.0. `src/*.ts` are vendored from
[DayuanJiang/next-ai-draw-io](https://github.com/DayuanJiang/next-ai-draw-io) (Apache-2.0); see
`LICENSE`.
