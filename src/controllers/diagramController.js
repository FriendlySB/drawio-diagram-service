/**
 * Diagram Controller
 *
 * Seven endpoints: health, two for shape libraries, and four for the per-conversation diagram
 * lifecycle (create, list, validate, render).
 *
 * Three conventions hold across every handler:
 *   - chatId is always required on diagram routes. It selects the session directory that scopes all
 *     file access, and ServeAI supplies it from the chatroom the agent is answering in.
 *   - Responses always use the same envelope, {success, data} or {success, error:{...}}, whether the
 *     result came from this server, the validator, or the renderer. One contract for the agent.
 *   - The XML never travels back. Create, list and validate all answer with a page summary; the
 *     agent already holds the document it sent, and an mxfile is a very long string to spend an
 *     agent's context window on.
 */

class DiagramController {
  constructor({ shapeLibraryService, storageService, renderService, diagramService, errorResponseMessage }) {
    this.shapeLibraryService = shapeLibraryService;
    this.storageService = storageService;
    this.renderService = renderService;
    this.diagramService = diagramService;
    this.errorResponseMessage = errorResponseMessage;
  }

  /**
   * Send a service's error result using the status it carries. A result with no `status` is an
   * external-tool failure (a dead renderer, say) and goes out as 200 with success:false -- the agent
   * should read and react to it, not treat it as a transport error.
   * @private
   */
  sendFailure(res, result) {
    const { status = 200, ...body } = result;
    return res.status(status).send(body);
  }

  /**
   * Resolve chatId from body or query, depending on the verb.
   * @private
   */
  requireChatId(req, res) {
    const chatId = req.body?.chatId || req.query?.chatId;
    if (!chatId) {
      res.status(400).send(
        this.errorResponseMessage.badRequest(
          "chatId is required.",
          "missing_chatId",
          "Every call must name the chat session that owns the diagram."
        )
      );
      return null;
    }
    return chatId;
  }

  /** Unauthenticated liveness probe. Reports the renderer's reachability without launching Chrome. */
  async health(req, res) {
    const renderer = await this.renderService.probe();
    return res.status(200).send({
      success: true,
      data: {
        service: "drawio-diagram-service",
        status: "ok",
        shapeLibraries: this.shapeLibraryService.index.libraryCount,
        shapes: this.shapeLibraryService.index.shapeCount,
        // Reported, not enforced: this service is still useful for validation when the renderer is
        // down, so a failed probe is information rather than an unhealthy verdict.
        renderer: { url: this.renderService.baseUrl, ...renderer },
      },
    });
  }

  /** The library catalogue, or a cross-library search when ?q= is present. */
  async listShapes(req, res) {
    const { q, limit } = req.query;
    const result = q ? this.shapeLibraryService.searchAll(q, limit) : this.shapeLibraryService.catalogue();
    return res.status(200).send(result);
  }

  /** Search one library, returning ready-to-paste style strings. */
  async searchShapes(req, res) {
    const result = this.shapeLibraryService.search(req.params.library, req.query.q, req.query.limit);
    if (!result.success) return this.sendFailure(res, result);
    return res.status(200).send(result);
  }

  /**
   * Start a new diagram in this session: a valid, empty, single-page mxfile.
   *
   * Seeding a real document rather than an empty file means the agent's first validate is an edit of
   * something that already parses, and a render is possible before a single node exists.
   */
  async createDiagram(req, res) {
    const chatId = this.requireChatId(req, res);
    if (!chatId) return;

    const { name } = req.body;
    const xml = this.diagramService.emptyDocument(name);
    const pages = this.diagramService.summarize(xml);

    const created = await this.storageService.createEntry(chatId, { name, xml, pages });
    if (!created.success) return this.sendFailure(res, created);

    return res.status(200).send({
      success: true,
      data: {
        ...created.data.meta,
        message:
          "Diagram created. Send its full XML to POST /api/diagram/validate with this fileId; " +
          "it is stored only if it validates.",
      },
    });
  }

  /** List this session's diagrams, or one of them. Metadata only -- never the XML. */
  async listDiagrams(req, res) {
    const chatId = this.requireChatId(req, res);
    if (!chatId) return;

    const listed = await this.storageService.listDiagrams(chatId, req.query.fileId);
    if (!listed.success) return this.sendFailure(res, listed);

    return res.status(200).send({
      success: true,
      data: { chatId, count: listed.data.length, diagrams: listed.data },
    });
  }

  /**
   * Validate a candidate document and, only if it is sound, replace the stored copy.
   *
   * This ordering is the whole point of the endpoint. The stored copy is what the user last approved;
   * an attempt to improve it must not be able to destroy it. So the validator runs against the
   * submitted XML in memory, and the disk is touched only after it returns ok. A rejected document
   * leaves the stored bytes identical, and the agent gets back what was wrong with its attempt.
   */
  async validateDiagram(req, res) {
    const chatId = this.requireChatId(req, res);
    if (!chatId) return;

    const { fileId, xml } = req.body;

    // Confirm the target exists before spending a parse on the payload, so a wrong fileId is
    // reported as a wrong fileId rather than surfacing later as a confusing write failure.
    const existing = await this.storageService.readEntry(chatId, fileId);
    if (!existing.success) return this.sendFailure(res, existing);

    const validated = this.diagramService.validate(xml);
    if (!validated.success) return this.sendFailure(res, validated);

    const saved = await this.storageService.replaceEntry(
      chatId,
      fileId,
      validated.data.xml,
      validated.data.pages
    );
    if (!saved.success) return this.sendFailure(res, saved);

    return res.status(200).send({
      success: true,
      data: {
        ...saved.data.meta,
        valid: true,
        stored: true,
        // What we silently corrected on the way in. Reported so a recurring mistake gets noticed
        // rather than being invisibly patched forever.
        fixes: validated.data.fixes,
        // Shape references we did not recognise. Advisory only -- the diagram is already stored.
        warnings: validated.data.warnings,
        message: "Diagram validated and stored. Render it with POST /api/diagram/render.",
      },
    });
  }

  /**
   * Render the stored copy to an image.
   *
   * Renders from disk, not from a submitted payload: the agent has already had its XML accepted, and
   * re-sending it would let an unvalidated document reach the renderer through the back door.
   */
  async renderDiagram(req, res) {
    const chatId = this.requireChatId(req, res);
    if (!chatId) return;

    const { fileId, format = "png", scale, pageId, allPages, background } = req.body;

    const existing = await this.storageService.readEntry(chatId, fileId);
    if (!existing.success) return this.sendFailure(res, existing);

    const rendered = await this.renderService.render({
      xml: existing.data.xml,
      format,
      scale,
      pageId,
      allPages,
      background,
    });
    if (!rendered.success) return this.sendFailure(res, rendered);

    // A render is activity. Without this, a conversation that spends a day producing images from one
    // finished diagram would look idle to the sweeper and be reclaimed underneath itself.
    await this.storageService.touchEntry(chatId, fileId);

    return res.status(200).send({
      success: true,
      data: {
        chatId,
        fileId,
        name: existing.data.meta.name,
        ...rendered.data,
        message:
          rendered.data.format === "png"
            ? "PNG carries the diagram source in its metadata, so it reopens in draw.io as an editable diagram."
            : "Rendered.",
      },
    });
  }
}

module.exports = DiagramController;
