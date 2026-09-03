/**
 * Basic Authentication Middleware
 *
 * This service sits behind a shared credential so it does not operate as an open diagram-rendering
 * service. It needs to trust exactly one caller -- ServeAI. The AI Agent's Flowise tools never reach
 * this server directly; ServeAI proxies for them, which is why a single shared credential suffices
 * and why it never leaves ServeAI's side.
 *
 * Credentials come from DRAWIO_CLIENT_ID / DRAWIO_CLIENT_SECRET. They are prefixed because ServeAI
 * deployments already carry a CLIENT_ID/CLIENT_SECRET pair for the OfficeCLI Server, and two
 * services sharing one env var name in one compose file is a mix-up waiting to happen.
 */

const crypto = require("crypto");
require("dotenv").config();

/** Values shipped in .env.example. Treated as "not configured" so a copied template can't go live. */
const PLACEHOLDERS = new Set(["your_client_id", "your_client_secret", ""]);

const CLIENT_ID = process.env.DRAWIO_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DRAWIO_CLIENT_SECRET || "";

/**
 * Fails fast at startup rather than at first request. Booting with blank credentials would build the
 * expected header for ":" and accept `Basic Og==` from anyone, silently exposing every endpoint -- a
 * refusal to start is far safer than a server that looks protected and isn't.
 */
const assertCredentialsConfigured = () => {
  if (PLACEHOLDERS.has(CLIENT_ID) || PLACEHOLDERS.has(CLIENT_SECRET)) {
    throw new Error(
      "DRAWIO_CLIENT_ID and DRAWIO_CLIENT_SECRET must be set to real values in .env before the server can start.\n" +
      "They are the shared credential ServeAI uses to authenticate against this server."
    );
  }
};

const EXPECTED_HEADER =
  "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

/**
 * Constant-time header comparison. The service may be reachable over a public tunnel, so a
 * byte-by-byte early-exit compare would leak the secret to a patient remote caller.
 * timingSafeEqual throws on length mismatch, hence the length check first.
 */
const headerMatches = (provided) => {
  const a = Buffer.from(provided);
  const b = Buffer.from(EXPECTED_HEADER);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const requireBasicAuth = (req, res, next) => {
  const header = req.headers.authorization;

  if (!header || !headerMatches(header)) {
    // A missing header and a wrong secret get an identical response on purpose: distinguishing them
    // would tell an attacker when they had guessed a valid client id.
    res.set("WWW-Authenticate", 'Basic realm="drawio-diagram-service"');
    return res.status(401).json({
      success: false,
      error: {
        error: "Unauthorized.",
        code: "unauthorized",
        suggestion:
          "Send an Authorization: Basic header built from DRAWIO_CLIENT_ID and DRAWIO_CLIENT_SECRET.",
      },
    });
  }

  return next();
};

module.exports = { requireBasicAuth, assertCredentialsConfigured };
