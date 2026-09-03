/**
 * Container
 *
 * Constructs the services and controller and passes their dependencies as a single object, matching
 * the `constructor({ dep })` signature used across ServeAI. Keeping the wiring here means the classes
 * themselves resolve nothing -- they receive what they need and can be constructed with stubs in a
 * test without a server, a filesystem, or a running renderer.
 *
 * Configuration is read once, HERE. No other module reaches into process.env.
 */

// FIRST. The vendored diagram modules read DOMParser and XMLSerializer off the global object, and
// they degrade SILENTLY without them -- a validator missing its parser still answers valid:true.
// Requiring the polyfill before anything that might pull in a vendored module is the whole defence.
require("./domPolyfill");

require("dotenv").config();

const ErrorResponseMessage = require("./utils/errorResponseMessage");
const ShapeLibraryService = require("./services/shapeLibraryService");
const StorageService = require("./services/storageService");
const RenderService = require("./services/renderService");
const DiagramService = require("./services/diagramService");
const DiagramController = require("./controllers/diagramController");

const config = {
  port: process.env.PORT || 5100,
  storageRoot: process.env.STORAGE_ROOT || "/tmp/serveAI-drawio",
  tempTtlHours: Number(process.env.TEMP_TTL_HOURS || 24),
  /**
   * With no delete endpoint exposed, `create` is the only thing that grows a session and the TTL
   * sweeper is the only thing that shrinks one. This is the ceiling that stops a looping agent from
   * filling the disk in the hours before the sweeper next runs.
   */
  maxDiagramsPerChat: Number(process.env.MAX_DIAGRAMS_PER_CHAT || 20),
  maxBodySize: process.env.MAX_BODY_SIZE || "10mb",

  renderBaseUrl: process.env.RENDER_SERVICE_URL || "http://localhost:8000",
  /**
   * Deliberately ABOVE draw-image-export2's own 30s Chrome kill. Aborting first would abandon
   * renders that were about to succeed while Chrome burns the CPU regardless.
   */
  renderTimeoutMs: Number(process.env.RENDER_TIMEOUT_MS || 35000),
  /**
   * White, not transparent. The renderer sets omitBackground when format is png and bg is unset, and
   * a transparent PNG with dark text is invisible in a dark-mode chat.
   */
  renderBackground: process.env.RENDER_BACKGROUND || "#ffffff",
  renderScale: Number(process.env.RENDER_SCALE || 2),
  renderBorder: Number(process.env.RENDER_BORDER || 10),

  shapeCheckEnabled: process.env.SHAPE_CHECK_ENABLED !== "0",
};

const errorResponseMessage = new ErrorResponseMessage();

const shapeLibraryService = new ShapeLibraryService({ errorResponseMessage });

const storageService = new StorageService({
  storageRoot: config.storageRoot,
  tempTtlHours: config.tempTtlHours,
  maxDiagramsPerChat: config.maxDiagramsPerChat,
  errorResponseMessage,
});

const renderService = new RenderService({
  baseUrl: config.renderBaseUrl,
  timeoutMs: config.renderTimeoutMs,
  defaultBackground: config.renderBackground,
  defaultScale: config.renderScale,
  defaultBorder: config.renderBorder,
  errorResponseMessage,
});

const diagramService = new DiagramService({
  shapeLibraryService,
  shapeCheckEnabled: config.shapeCheckEnabled,
  errorResponseMessage,
});

const diagramController = new DiagramController({
  shapeLibraryService,
  storageService,
  renderService,
  diagramService,
  errorResponseMessage,
});

module.exports = {
  config,
  errorResponseMessage,
  shapeLibraryService,
  storageService,
  renderService,
  diagramService,
  diagramController,
};
