/**
 * Storage Service
 *
 * Owns the per-conversation working copies of diagram XML. ServeAI keys every request by chatId, so
 * a conversation's diagrams live together and expire together.
 *
 * Layout:
 *   {STORAGE_ROOT}/{chatId}/{fileId}.xml     the diagram itself, always a full <mxfile>
 *   {STORAGE_ROOT}/{chatId}/{fileId}.json    sidecar metadata (name, revision, page summary)
 *
 * The sidecar exists because a fileId is opaque: GET /api/diagram has to report a human-readable
 * name and a page summary without reading and parsing every document. Keeping metadata on disk next
 * to the file (rather than in memory) means a restart doesn't orphan working copies -- the directory
 * listing is always the source of truth.
 *
 * Methods return { success, data } or { success:false, error, status } rather than throwing, so
 * callers branch on the result instead of wrapping every call in try/catch.
 */

const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * The traversal defence. chatId and fileId both land in filesystem paths, so they are restricted to
 * characters that cannot escape the storage root -- no dots, no separators, no null bytes. Every
 * public method validates before touching the disk.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

class StorageService {
  constructor({ storageRoot, tempTtlHours, maxDiagramsPerChat, errorResponseMessage }) {
    this.storageRoot = storageRoot;
    this.tempTtlHours = tempTtlHours;
    this.maxDiagramsPerChat = maxDiagramsPerChat;
    this.errorResponseMessage = errorResponseMessage;
  }

  /**
   * Wraps an error body with the HTTP status the controller should use.
   * @private
   */
  fail(body, status) {
    return { ...body, status };
  }

  /**
   * Validate a value that will become a path segment.
   * @param {String} value - The candidate id
   * @param {String} label - "chatId" or "fileId", used in the error message
   * @returns {Object|null} An error result, or null when the value is safe
   */
  validateId(value, label) {
    if (typeof value !== "string" || !ID_PATTERN.test(value)) {
      return this.fail(
        this.errorResponseMessage.badRequest(
          `Invalid ${label}: must be 1-64 characters of A-Z, a-z, 0-9, underscore or hyphen.`,
          `invalid_${label}`,
          `Pass a ${label} such as "chat-12345". Path separators and dots are rejected.`
        ),
        400
      );
    }
    return null;
  }

  /** @private */
  chatDir(chatId) {
    return path.join(this.storageRoot, chatId);
  }

  /** @private */
  sidecarPath(chatId, fileId) {
    return path.join(this.storageRoot, chatId, `${fileId}.json`);
  }

  /** @private */
  xmlPath(chatId, fileId) {
    return path.join(this.storageRoot, chatId, `${fileId}.xml`);
  }

  /**
   * Write a file so a crash cannot leave a half-written diagram behind. "Validate first, write
   * second" is worthless if the write itself can truncate the copy the user was happy with, so the
   * bytes land in a temp file and are moved into place by a single rename.
   * @private
   */
  async writeAtomic(target, contents) {
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, contents, "utf8");
    await fs.rename(tmp, target);
  }

  /**
   * Register a new diagram and write its initial XML.
   * @param {String} chatId - The chat session
   * @param {Object} options - { name, xml, pages }
   * @returns {Object} { success, data: { meta } }, or an error result
   */
  async createEntry(chatId, { name, xml, pages }) {
    const invalid = this.validateId(chatId, "chatId");
    if (invalid) return invalid;

    // With no delete endpoint, `create` is the only thing that grows a session and the TTL is the
    // only thing that shrinks one. An agent looping on create would otherwise fill the disk before
    // the sweeper ever ran, so the ceiling is enforced here.
    const existing = await this.listDiagrams(chatId);
    if (existing.success && existing.data.length >= this.maxDiagramsPerChat) {
      return this.fail(
        this.errorResponseMessage.badRequest(
          `Session "${chatId}" already holds ${existing.data.length} diagrams (limit ${this.maxDiagramsPerChat}).`,
          "diagram_limit_reached",
          `Reuse an existing diagram instead of creating another: ${existing.data
            .map((m) => `${m.fileId} ("${m.name}")`)
            .join(", ")}.`
        ),
        400
      );
    }

    await fs.mkdir(this.chatDir(chatId), { recursive: true });

    const fileId = crypto.randomUUID().replace(/-/g, "");
    const now = new Date().toISOString();
    const meta = {
      fileId,
      chatId,
      name: name || "Untitled diagram",
      createdAt: now,
      updatedAt: now,
      // Increments on every accepted validate. Lets the agent -- and a human reading the logs --
      // tell "never edited" from "edited and reverted to something that looks the same".
      revision: 1,
      pages,
      sizeBytes: Buffer.byteLength(xml, "utf8"),
    };

    await this.writeAtomic(this.xmlPath(chatId, fileId), xml);
    await this.writeAtomic(this.sidecarPath(chatId, fileId), JSON.stringify(meta, null, 2));
    return { success: true, data: { meta } };
  }

  /**
   * Read a diagram's metadata and XML.
   * @param {String} chatId - The chat session
   * @param {String} fileId - The diagram identifier
   * @returns {Object} { success, data: { meta, xml } }, or a diagram_not_found error result
   */
  async readEntry(chatId, fileId) {
    const invalidChat = this.validateId(chatId, "chatId");
    if (invalidChat) return invalidChat;
    const invalidFile = this.validateId(fileId, "fileId");
    if (invalidFile) return invalidFile;

    let meta;
    try {
      meta = JSON.parse(await fs.readFile(this.sidecarPath(chatId, fileId), "utf8"));
    } catch {
      return this.fail(
        this.errorResponseMessage.notFoundError(
          `No diagram "${fileId}" in session "${chatId}".`,
          "diagram_not_found",
          "Call GET /api/diagram to list this session's diagrams, or POST /api/diagram/create to start one."
        ),
        404
      );
    }

    let xml;
    try {
      xml = await fs.readFile(this.xmlPath(chatId, fileId), "utf8");
    } catch {
      return this.fail(
        this.errorResponseMessage.notFoundError(
          `Working copy for "${fileId}" is missing from session "${chatId}".`,
          "diagram_not_found",
          "The session may have expired. Create the diagram again."
        ),
        404
      );
    }

    return { success: true, data: { meta, xml } };
  }

  /**
   * Replace a diagram's stored XML. Only ever called after the validator has accepted the document
   * -- see diagramService. The write is atomic, and the sidecar is updated second so a crash between
   * the two leaves stale metadata over good bytes rather than the reverse.
   * @param {String} chatId - The chat session
   * @param {String} fileId - The diagram identifier
   * @param {String} xml - The validated document
   * @param {Object} pages - Page summary to record
   * @returns {Object} { success, data: { meta } }, or an error result
   */
  async replaceEntry(chatId, fileId, xml, pages) {
    const found = await this.readEntry(chatId, fileId);
    if (!found.success) return found;

    const meta = {
      ...found.data.meta,
      updatedAt: new Date().toISOString(),
      revision: (found.data.meta.revision || 0) + 1,
      pages,
      sizeBytes: Buffer.byteLength(xml, "utf8"),
    };

    await this.writeAtomic(this.xmlPath(chatId, fileId), xml);
    await this.writeAtomic(this.sidecarPath(chatId, fileId), JSON.stringify(meta, null, 2));
    await this.touchDir(chatId);
    return { success: true, data: { meta } };
  }

  /**
   * Record activity that did not change the document -- a render, for instance. A conversation
   * actively producing images from a diagram is not idle, and should not be swept.
   * @param {String} chatId - The chat session
   * @param {String} fileId - The diagram identifier
   */
  async touchEntry(chatId, fileId) {
    try {
      const target = this.sidecarPath(chatId, fileId);
      const meta = JSON.parse(await fs.readFile(target, "utf8"));
      meta.updatedAt = new Date().toISOString();
      await this.writeAtomic(target, JSON.stringify(meta, null, 2));
      await this.touchDir(chatId);
    } catch {
      // A missing sidecar is not worth failing an otherwise successful render over.
    }
  }

  /**
   * Push the session directory's mtime forward.
   *
   * Rewriting a file does NOT update its parent directory's mtime -- only creating, renaming or
   * removing an entry does. The sweeper no longer relies on directory mtime as its primary signal
   * (see sweepExpired), but ops scripts and a human running `ls -lt` reasonably expect a live
   * session to look recently touched, so we keep it honest explicitly.
   * @private
   */
  async touchDir(chatId) {
    try {
      const now = new Date();
      await fs.utimes(this.chatDir(chatId), now, now);
    } catch {
      // Best-effort only; never fail a request because a timestamp could not be set.
    }
  }

  /**
   * List a session's diagrams from their sidecars. Metadata only -- never the XML. A tool result
   * enters the agent's context window, and an mxfile is a long document.
   * @param {String} chatId - The chat session
   * @param {String} [fileId] - Restrict to a single diagram
   * @returns {Object} { success, data } with an array of metadata, or an error result
   */
  async listDiagrams(chatId, fileId) {
    const invalid = this.validateId(chatId, "chatId");
    if (invalid) return invalid;

    if (fileId) {
      const found = await this.readEntry(chatId, fileId);
      return found.success ? { success: true, data: [found.data.meta] } : found;
    }

    let entries;
    try {
      entries = await fs.readdir(this.chatDir(chatId));
    } catch {
      return { success: true, data: [] }; // A session that has stored nothing is empty, not an error.
    }

    const metas = [];
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      try {
        metas.push(JSON.parse(await fs.readFile(path.join(this.chatDir(chatId), entry), "utf8")));
      } catch {
        // Skip corrupt sidecars rather than failing the whole listing.
      }
    }

    return { success: true, data: metas.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) };
  }

  /**
   * The most recent `updatedAt` among a session's sidecars, in epoch milliseconds.
   *
   * This is the sweeper's primary signal, and it exists because the obvious alternative is wrong.
   * Statting the session *directory* measures time since the last file was created, not since the
   * last edit -- so a conversation that spends two days refining one diagram (rewriting the same
   * two files, never creating a third) looks untouched to the filesystem and gets swept
   * mid-conversation.
   *
   * @param {String} dir - Absolute path of the session directory
   * @returns {Number|null} Epoch ms of the newest sidecar, or null if none could be read
   * @private
   */
  async newestSidecarTime(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      return null;
    }

    let newest = null;
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      try {
        const meta = JSON.parse(await fs.readFile(path.join(dir, entry), "utf8"));
        const t = Date.parse(meta.updatedAt || meta.createdAt);
        // Never let an unparseable date become a deletion decision: NaN loses every comparison,
        // and `NaN < cutoff` is false, but being explicit keeps that from depending on it.
        if (!Number.isNaN(t) && (newest === null || t > newest)) newest = t;
      } catch {
        // Corrupt sidecar -- ignore it here; the mtime fallback still covers the directory.
      }
    }
    return newest;
  }

  /**
   * Reclaim sessions that have gone idle. With no delete endpoint exposed, this is the ONLY path by
   * which storage is ever released, so it errs towards keeping data: a session is removed only when
   * we can positively establish that it is stale.
   * @returns {Number} How many session directories were removed
   */
  async sweepExpired() {
    const cutoff = Date.now() - this.tempTtlHours * 60 * 60 * 1000;
    let chatIds;
    try {
      chatIds = await fs.readdir(this.storageRoot);
    } catch {
      return 0; // Storage root not created yet -- nothing to sweep.
    }

    let removed = 0;
    for (const chatId of chatIds) {
      const dir = path.join(this.storageRoot, chatId);
      try {
        const stats = await fs.stat(dir);
        if (!stats.isDirectory()) continue;

        // Sidecar time first; directory mtime only when no sidecar is readable at all (an empty or
        // corrupted session directory still needs reclaiming).
        const sidecarTime = await this.newestSidecarTime(dir);
        const lastActivity = sidecarTime === null ? stats.mtimeMs : sidecarTime;

        if (lastActivity < cutoff) {
          await fs.rm(dir, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // Directory vanished mid-sweep (or is not readable) -- nothing to do.
      }
    }

    if (removed > 0) console.log(`Storage sweeper removed ${removed} expired session(s)`);
    return removed;
  }

  /** Run the sweeper hourly. unref() keeps the timer from holding the process open on Ctrl-C. */
  startSweeper() {
    const sweep = () => this.sweepExpired().catch((err) => console.error("Storage sweep failed:", err.message));
    sweep();
    setInterval(sweep, 60 * 60 * 1000).unref();
  }
}

module.exports = StorageService;
