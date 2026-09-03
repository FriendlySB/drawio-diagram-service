/**
 * Error Response Message
 *
 * Builds the error bodies controllers send. The method names mirror the helper used across ServeAI so
 * controllers here read the same way, and the envelope is identical to the OfficeCLI Server's:
 *
 *   { "success": false, "error": { "error", "code", "suggestion" } }
 *
 * The `code` and `suggestion` fields are the point. They are what lets the AI Agent correct a bad
 * diagram and retry without human intervention -- "you referenced mxgraph.aws4.lamda, did you mean
 * lambda?" is actionable in a way that "400 Bad Request" is not. Because this wrapper's own refusals
 * use the same shape as a failed render or a rejected XML document, the agent has exactly one error
 * contract to learn regardless of which layer failed.
 */

const build = (message, code, suggestion) => ({
  success: false,
  error: { error: message, code, suggestion },
});

class ErrorResponseMessage {
  /** 400 -- the request was malformed or refused before any work was done. */
  badRequest(message, code = "bad_request", suggestion) {
    return build(message, code, suggestion);
  }

  /** 401 -- credentials missing or incorrect. */
  unauthorized(message = "Unauthorized.", code = "unauthorized", suggestion) {
    return build(message, code, suggestion);
  }

  /** 404 -- no such diagram in this session, or no such shape library. */
  notFoundError(message, code = "not_found", suggestion) {
    return build(message, code, suggestion);
  }

  /** 413 -- the payload exceeded the body limit. Correctable, so it is not a 500. */
  payloadTooLarge(message, code = "payload_too_large", suggestion) {
    return build(message, code, suggestion);
  }

  /**
   * A failure in something we call rather than something we are. Returned with HTTP 200 on purpose:
   * an unreachable renderer is an external-tool failure the agent should read and react to, not a
   * transport error. This mirrors OfficeCLI's cli_timeout / cli_failure discipline.
   */
  externalFailure(message, code, suggestion) {
    return build(message, code, suggestion);
  }

  /** 500 -- an unexpected failure in this server, not a correctable diagram error. */
  serverError(message, code = "internal_error", suggestion = "Check the server logs.") {
    return build(message, code, suggestion);
  }
}

module.exports = ErrorResponseMessage;
