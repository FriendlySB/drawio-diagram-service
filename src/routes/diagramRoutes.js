const express = require("express");
const router = express.Router();

const { diagramController } = require("../container");
const { requireBasicAuth } = require("../middleware/auth");

/**
 * Adapts a controller method into an Express handler.
 *
 * Two things happen here. The method is invoked on the controller so `this` resolves -- passing
 * `diagramController.listDiagrams` unbound would call it with `this` undefined. And because the
 * handlers are async, a rejection is forwarded to the error middleware; Express 4 does not catch
 * async rejections itself, so without this an unexpected failure would hang the request instead of
 * answering with a 500.
 */
const handle = (method) => (req, res, next) =>
  Promise.resolve(diagramController[method](req, res)).catch(next);

// Health is unauthenticated so a tunnel or uptime monitor can probe the service without credentials.
router.get("/health", handle("health"));

// Everything below is the shared-credential surface ServeAI calls.
router.use(requireBasicAuth);

// Shape libraries. Reference data only -- no chatId, touches no diagram.
router.get("/shapes", handle("listShapes"));
router.get("/shapes/:library", handle("searchShapes"));

// Diagram lifecycle. /diagram/create and the other verbs are literal path segments rather than
// parameters, so no fileId can ever be mistaken for one.
router.get("/diagram", handle("listDiagrams"));
router.post("/diagram/create", handle("createDiagram"));
router.post("/diagram/validate", handle("validateDiagram"));
router.post("/diagram/render", handle("renderDiagram"));

// No DELETE. The AI Agent is not intended to remove diagrams, so the capability is not exposed at
// all; storage is reclaimed solely by the TTL sweeper in storageService.
module.exports = router;
