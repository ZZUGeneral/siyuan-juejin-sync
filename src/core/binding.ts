/**
 * Document ↔ article binding, stored in the root block attributes (FR-09 / §8.2).
 *
 * Block attributes are the **single source of truth**, deliberately not a plugin database:
 * they travel with the document through SiYuan sync/export, so the mapping survives a device
 * change. The plugin keeps no second copy, which also makes the "deleted attribute ⇒ treat as
 * unsynced" rule (PRD R7) a natural consequence instead of special-casing.
 */
import type { KernelApi, DocBinding, SyncStatus } from "../types";
import { BLOCK_ATTR } from "../types";
import type { Logger } from "./logger";

const MAX_ERROR_LENGTH = 200;
const STATUSES: SyncStatus[] = ["draft", "published", "failed", "imported", "unknown"];

/** Parse a raw attribute map into a {@link DocBinding}. */
export function bindingFromAttrs(attrs: Record<string, string>): DocBinding {
    const status = attrs[BLOCK_ATTR.STATUS];
    return {
        articleId: attrs[BLOCK_ATTR.ARTICLE_ID] || undefined,
        draftId: attrs[BLOCK_ATTR.DRAFT_ID] || undefined,
        syncTime: attrs[BLOCK_ATTR.SYNC_TIME] || undefined,
        status: STATUSES.includes(status as SyncStatus) ? (status as SyncStatus) : undefined,
        contentHash: attrs[BLOCK_ATTR.CONTENT_HASH] || undefined,
        categoryId: attrs[BLOCK_ATTR.CATEGORY_ID] || undefined,
        tagIds: attrs[BLOCK_ATTR.TAG_IDS]
            ? attrs[BLOCK_ATTR.TAG_IDS]
                .split(",")
                .map((value) => value.trim())
                .filter((value) => value.length > 0)
            : undefined,
        sourceArticleId: attrs[BLOCK_ATTR.SOURCE_ARTICLE_ID] || undefined,
        lastError: attrs[BLOCK_ATTR.LAST_ERROR] || undefined,
        brief: attrs[BLOCK_ATTR.BRIEF] || undefined,
    };
}

/** Serialize a binding into attribute values (empty fields are omitted by the caller). */
export function bindingToAttrs(binding: DocBinding): Record<string, string> {
    const attrs: Record<string, string> = {};
    if (binding.articleId) {
        attrs[BLOCK_ATTR.ARTICLE_ID] = binding.articleId;
    }
    if (binding.draftId) {
        attrs[BLOCK_ATTR.DRAFT_ID] = binding.draftId;
    }
    if (binding.syncTime) {
        attrs[BLOCK_ATTR.SYNC_TIME] = binding.syncTime;
    }
    if (binding.status) {
        attrs[BLOCK_ATTR.STATUS] = binding.status;
    }
    if (binding.contentHash) {
        attrs[BLOCK_ATTR.CONTENT_HASH] = binding.contentHash;
    }
    if (binding.categoryId) {
        attrs[BLOCK_ATTR.CATEGORY_ID] = binding.categoryId;
    }
    if (binding.tagIds && binding.tagIds.length > 0) {
        attrs[BLOCK_ATTR.TAG_IDS] = binding.tagIds.join(",");
    }
    if (binding.sourceArticleId) {
        attrs[BLOCK_ATTR.SOURCE_ARTICLE_ID] = binding.sourceArticleId;
    }
    if (binding.lastError) {
        attrs[BLOCK_ATTR.LAST_ERROR] = binding.lastError.slice(0, MAX_ERROR_LENGTH);
    }
    if (binding.brief) {
        attrs[BLOCK_ATTR.BRIEF] = binding.brief;
    }
    return attrs;
}

/** `DocBinding` field → block attribute key, used to clear attributes explicitly. */
const FIELD_TO_ATTR: Record<keyof DocBinding, string> = {
    articleId: BLOCK_ATTR.ARTICLE_ID,
    draftId: BLOCK_ATTR.DRAFT_ID,
    syncTime: BLOCK_ATTR.SYNC_TIME,
    status: BLOCK_ATTR.STATUS,
    contentHash: BLOCK_ATTR.CONTENT_HASH,
    categoryId: BLOCK_ATTR.CATEGORY_ID,
    tagIds: BLOCK_ATTR.TAG_IDS,
    sourceArticleId: BLOCK_ATTR.SOURCE_ARTICLE_ID,
    lastError: BLOCK_ATTR.LAST_ERROR,
    brief: BLOCK_ATTR.BRIEF,
};

/** A patch value that semantically means "remove this attribute". */
function isClearing(value: unknown): boolean {
    if (value === "" || value === null || value === undefined) {
        return true;
    }
    return Array.isArray(value) && value.length === 0;
}

/** Escape a value for a single-quoted SQL literal (`article_id`s are numeric, but be safe). */
function sqlLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/** Read/write the binding of one document. */
export class BindingService {
    private readonly kernel: KernelApi;
    private readonly logger: Logger;

    constructor(options: { kernel: KernelApi; logger: Logger }) {
        this.kernel = options.kernel;
        this.logger = options.logger;
    }

    /** Read the current binding; a kernel failure degrades to "unsynced" rather than throwing. */
    async read(docId: string): Promise<DocBinding> {
        try {
            const attrs = await this.kernel.getBlockAttrs(docId);
            return bindingFromAttrs(attrs);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`getBlockAttrs(${docId}) failed: ${message}`);
            return {};
        }
    }

    /** Merge a patch into the binding and persist it. */
    async write(docId: string, patch: Partial<DocBinding>): Promise<DocBinding> {
        const current = await this.read(docId);
        const merged: DocBinding = { ...current, ...patch };
        const attrs = bindingToAttrs(merged);

        // `bindingToAttrs` omits empty values, which leaves a stale attribute on the block
        // forever (a failed sync would keep `custom-juejin-last-error` even after a success).
        // Any field the caller *explicitly* emptied is therefore sent as "" — the kernel treats
        // an empty value as "remove this attribute".
        (Object.keys(patch) as Array<keyof DocBinding>).forEach((field) => {
            if (!isClearing(patch[field])) {
                return;
            }
            const attr = FIELD_TO_ATTR[field];
            if (attr) {
                attrs[attr] = "";
            }
        });

        await this.kernel.setBlockAttrs(docId, attrs);
        this.logger.info(`binding written for ${docId}: status=${merged.status ?? ""} draft=${merged.draftId ?? ""}`);
        return merged;
    }

    /** Remove every plugin-owned attribute from a document. */
    async clear(docId: string): Promise<void> {
        const empty: Record<string, string> = {};
        Object.values(BLOCK_ATTR).forEach((key) => {
            empty[key] = "";
        });
        await this.kernel.setBlockAttrs(docId, empty);
    }

    /**
     * Find a document previously imported from a given Juejin article (FR-27).
     *
     * @returns The document id, or `null` when the article was never imported.
     */
    async findBySourceArticleId(articleId: string): Promise<string | null> {
        try {
            const rows = await this.kernel.querySql<{ block_id?: string }>(
                `SELECT block_id FROM attributes WHERE name = ${sqlLiteral(BLOCK_ATTR.SOURCE_ARTICLE_ID)} AND value = ${sqlLiteral(articleId)} LIMIT 1`,
            );
            const found = rows[0]?.block_id;
            return found && found.length > 0 ? found : null;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`source article lookup failed: ${message}`);
            return null;
        }
    }
}
