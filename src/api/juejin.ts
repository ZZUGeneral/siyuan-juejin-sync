/**
 * The **only** Juejin adapter (§3.2).
 *
 * Every URL, every body field name and every `err_no` interpretation lives in this file.
 * Nothing above this layer is allowed to know what an `err_no` is, and nothing here decides
 * any user-facing copy — failures are raised as {@link SyncError} carrying an i18n key plus
 * the verbatim upstream facts (D4).
 *
 * Determinism labels come from `docs/ARCHITECTURE.md` §9:
 *  - 【已证实】 routes were hit live on 2026-11-25,
 *  - 【据推断】 bodies/shapes come from public reference implementations,
 *  - 【待验证】 have a mock + degradation path and a probe in {@link JuejinClient.probeEndpoints}.
 */
import { hasPublishedHintText, mapJuejinErrNo, mapProxyError, ProxyError, SyncError } from "../core/errors";
import type { Logger } from "../core/logger";
import { ErrorKind } from "../types";
import type {
    CredentialProbe,
    DraftInput,
    EndpointProbe,
    JuejinApi,
    JuejinArticleDetail,
    JuejinArticleRef,
    JuejinCategory,
    JuejinCredential,
    JuejinDraftDetail,
    JuejinDraftRef,
    JuejinTag,
    ProbeDeterminism,
} from "../types";
import {
    base64ToArrayBuffer,
    bytesToBase64,
    canonicalQueryString,
    buildSigV4,
    crc32Hex,
    crc32HexLittleEndian,
    decodeSessionKeyHost,
} from "./juejinSign";
import { DEFAULT_USER_AGENT, HttpProxy } from "./proxy";

/* ------------------------------------------------------------------ *
 * Endpoint table — the single place where Juejin URLs are written
 * ------------------------------------------------------------------ */

const AID = "2608";
const IMAGEX_HOST = "imagex.bytedanceapi.com";
const IMAGEX_SERVICE_ID = "73owjymdk6";
const IMAGEX_VERSION = "2018-08-01";
const IMAGEX_REGION = "cn-north-1";
const IMAGEX_SERVICE = "imagex";
/** Documented default taken from public reference implementations (§1.4). */
const DEFAULT_UPLOAD_HOST = "tos-d-x-hl.snssdk.com";

const JUEJIN_API = "https://api.juejin.cn";

export const ENDPOINTS = {
    /* verified routes */
    userGet: `${JUEJIN_API}/user_api/v1/user/get`,
    categoryBriefs: `${JUEJIN_API}/tag_api/v1/query_category_briefs`,
    tagList: `${JUEJIN_API}/tag_api/v1/query_tag_list`,
    draftCreate: `${JUEJIN_API}/content_api/v1/article_draft/create`,
    draftDelete: `${JUEJIN_API}/content_api/v1/article_draft/delete`,
    articlePublish: `${JUEJIN_API}/content_api/v1/article/publish`,
    articleQueryList: `${JUEJIN_API}/content_api/v1/article/query_list`,
    recommendFeed: `${JUEJIN_API}/recommend_api/v1/article/recommend_all_feed`,
    /* inferred bodies */
    draftUpdate: `${JUEJIN_API}/content_api/v1/article_draft/update`,
    draftDetail: `${JUEJIN_API}/content_api/v1/article_draft/detail`,
    articleDetail: `${JUEJIN_API}/content_api/v1/article/detail`,
    /* known-missing routes, kept only so the self-check can prove it */
    articleUpdate: `${JUEJIN_API}/content_api/v1/article/update`,
    articleUnpublish: `${JUEJIN_API}/content_api/v1/article/unpublish`,
    /* image host (Juejin side) */
    genToken: `${JUEJIN_API}/imagex/v2/gen_token`,
    getImgUrl: `${JUEJIN_API}/imagex/v2/get_img_url`,
    /* image host (ByteDance side) */
    imagex: `https://${IMAGEX_HOST}/`,
    /* rendered page, reverse-import fallback (A4) */
    postPage: (articleId: string): string => `https://juejin.cn/post/${articleId}`,
} as const;

/** Public article URL used for the "open draft in browser" action. */
export function draftUrl(draftId: string): string {
    return `https://juejin.cn/drafts/${draftId}`;
}

/* ------------------------------------------------------------------ *
 * Envelope
 * ------------------------------------------------------------------ */

interface JuejinEnvelope<T> {
    err_no?: number;
    err_msg?: string;
    data?: T;
    cursor?: string;
    has_more?: boolean;
}

interface ImagexToken {
    AccessKeyId: string;
    SecretAccessKey: string;
    SessionToken: string;
}

/** One row of `query_tag_list`; the display name is nested (verified 2026-11-26). */
interface TagRow {
    tag_id?: string | number;
    tag_name?: string;
    tag?: { tag_id?: string | number; tag_name?: string };
}

/**
 * Map `query_tag_list` rows to `{id, name}`, dropping rows without an id.
 *
 * Factored out because both paging (`fetchTags`) and keyword search (`searchTags`) hit the same
 * route: reading only the flat `tag_name` silently degrades every chip to a 19-digit id.
 */
function toTags(rows: TagRow[]): JuejinTag[] {
    const tags: JuejinTag[] = [];
    const seen = new Set<string>();
    rows.forEach((item) => {
        if (!item || item.tag_id === undefined) {
            return;
        }
        const id = String(item.tag_id);
        if (seen.has(id)) {
            return;
        }
        seen.add(id);
        const name = item.tag?.tag_name ?? item.tag_name ?? id;
        tags.push({ id, name: String(name) });
    });
    return tags;
}

/** One draft record, in whichever nesting the current route returns it. */
interface DraftPayload {
    id?: string | number;
    draft_id?: string | number;
    title?: string;
    mark_content?: string;
    category_id?: string | number;
    tag_ids?: Array<string | number>;
    article_id?: string | number;
}

interface ImagexUploadAddress {
    StoreInfos?: Array<{ StoreUri?: string; Auth?: string }>;
    SessionKey?: string;
}

interface ImagexApplyResult {
    Result?: { UploadAddress?: ImagexUploadAddress };
    ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
}

interface ImagexCommitResult {
    Result?: { Results?: Array<{ UriStatus?: number; Uri?: string }> };
    ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
}

export interface JuejinClientOptions {
    /** Read lazily so a credential change takes effect without rebuilding the client. */
    getCredential: () => Promise<JuejinCredential | null>;
    proxy: HttpProxy;
    logger: Logger;
    /** Deterministic UUID generator, injectable for tests. */
    uuid?: () => string;
}

/** Generate the 19-digit numeric `uuid` Juejin's web client sends. */
export function generateUuid(): string {
    let out = "";
    for (let i = 0; i < 19; i += 1) {
        out += Math.floor(Math.random() * 10).toString();
    }
    return out;
}

/**
 * Adapter for the Juejin web private API.
 *
 * @implements JuejinApi
 */
export class JuejinClient implements JuejinApi {
    private readonly getCredential: () => Promise<JuejinCredential | null>;
    private readonly proxy: HttpProxy;
    private readonly logger: Logger;
    private readonly uuid: () => string;
    /** Temporary credential used by the "test connection" button; never persisted. */
    private credentialOverride: string | null = null;

    constructor(options: JuejinClientOptions) {
        this.getCredential = options.getCredential;
        this.proxy = options.proxy;
        this.logger = options.logger;
        this.uuid = options.uuid ?? generateUuid;
    }

    /* ---------------- low level ---------------- */

    /**
     * Probe an unsaved value without writing it to disk (settings panel "test connection").
     *
     * @param sessionId Cookie value to use for the next calls; `null` restores the stored one.
     */
    setCredentialOverride(sessionId: string | null): void {
        this.credentialOverride = sessionId && sessionId.length > 0 ? sessionId : null;
    }

    /** Build the cookie header, or fail with an actionable error. */
    private async cookieHeader(): Promise<string | null> {
        if (this.credentialOverride) {
            return `sessionid_ss=${this.credentialOverride}`;
        }
        const credential = await this.getCredential();
        if (!credential || !credential.sessionId) {
            return null;
        }
        return `sessionid_ss=${credential.sessionId}`;
    }

    private baseHeaders(cookie: string | null): Record<string, string> {
        const headers: Record<string, string> = {
            "User-Agent": DEFAULT_USER_AGENT,
            Referer: "https://juejin.cn/",
        };
        if (cookie) {
            headers.Cookie = cookie;
        }
        return headers;
    }

    /**
     * One JSON call, returning the raw envelope so callers can read `cursor` / `has_more`.
     *
     * @param options.name Probe / log name, e.g. `draft.create`.
     * @param options.allowAnonymous Skip the credential requirement (used by probes).
     */
    private async callEnvelope<T>(options: {
        name: string;
        method: "GET" | "POST";
        url: string;
        body?: unknown;
        allowAnonymous?: boolean;
    }): Promise<JuejinEnvelope<T>> {
        const cookie = await this.cookieHeader();
        if (!cookie && !options.allowAnonymous) {
            throw new SyncError(ErrorKind.AUTH_EXPIRED, { i18nKey: "sync.blocked.noCredential" });
        }
        const headers = this.baseHeaders(cookie);
        const endpoint = shortEndpoint(options.url);

        let parsed: JuejinEnvelope<T>;
        let httpStatus = 0;
        let elapsedMs = 0;
        try {
            const response =
                options.method === "GET"
                    ? await this.proxy.getJson(options.url, headers)
                    : await this.proxy.postJson(options.url, options.body ?? {}, headers);
            httpStatus = response.status;
            elapsedMs = response.elapsedMs;
            parsed = parseEnvelope<T>(response.body);
        } catch (error) {
            throw attachContext(error, endpoint);
        }

        const errNo = typeof parsed.err_no === "number" ? parsed.err_no : -1;
        this.logger.info(`${options.name} -> err_no=${errNo} http=${httpStatus} elapsed=${elapsedMs}ms`);
        if (errNo !== 0) {
            throw mapJuejinErrNo(errNo, String(parsed.err_msg ?? ""), httpStatus).withContext({
                endpoint,
                elapsedMs,
                httpStatus,
            });
        }
        return parsed;
    }

    private async callData<T>(options: {
        name: string;
        method: "GET" | "POST";
        url: string;
        body?: unknown;
        allowAnonymous?: boolean;
    }): Promise<T> {
        const envelope = await this.callEnvelope<T>(options);
        return envelope.data as T;
    }

    /* ---------------- credential ---------------- */

    /**
     * FR-01's only exit. Three states collapsed here, and **this method never throws**.
     */
    async probeCredential(): Promise<CredentialProbe> {
        const startedAt = Date.now();
        // "Nothing configured" is its own state: telling a first-time user that the credential
        // "expired" is both wrong and confusing (they never had one).
        const cookie = await this.cookieHeader();
        if (!cookie) {
            return { state: "not-configured", elapsedMs: Date.now() - startedAt };
        }
        try {
            const user = await this.callData<{ user_name?: string; user_id?: string }>({
                name: "user.get",
                method: "GET",
                url: ENDPOINTS.userGet,
            });
            const userName = String(user?.user_name ?? "");
            return {
                state: userName ? "valid" : "expired",
                user: userName ? { userName, userId: String(user?.user_id ?? "") } : undefined,
                elapsedMs: Date.now() - startedAt,
            };
        } catch (error) {
            const elapsedMs = Date.now() - startedAt;
            const issue = toIssueParts(error);
            const state = issue.kind === ErrorKind.AUTH_EXPIRED || issue.kind === ErrorKind.NEED_PHONE ? "expired" : "unreachable";
            return {
                state,
                httpStatus: issue.raw.httpStatus,
                errNo: issue.raw.errNo,
                errMsg: issue.raw.errMsg,
                elapsedMs: issue.raw.elapsedMs ?? elapsedMs,
            };
        }
    }

    /* ---------------- taxonomy ---------------- */

    /** `GET /tag_api/v1/query_category_briefs` — POST answers "route does not exist". */
    async fetchCategories(): Promise<JuejinCategory[]> {
        const url = `${ENDPOINTS.categoryBriefs}?aid=${AID}`;
        const data = await this.callData<Array<{ category_id?: string | number; category_name?: string }>>({
            name: "category.briefs",
            method: "GET",
            url,
        });
        return (data ?? [])
            .filter((item) => item && item.category_id !== undefined)
            .map((item) => ({ id: String(item.category_id), name: String(item.category_name ?? item.category_id) }));
    }

    /**
     * `POST /tag_api/v1/query_tag_list` — the popular page, and nothing more.
     *
     * 【据实测 2026-11-26】This route ignores `cursor`, `limit` and `key_word` for a non-browser
     * client: every paging variant comes back with the same ten tags and the same `cursor: "10"`,
     * so a `for` loop over pages issues ten identical requests and still yields ten tags. It is
     * called exactly once; the rest of the picker is fed by {@link fetchFeedTags} and
     * {@link fetchArticleTags}.
     */
    async fetchTags(): Promise<JuejinTag[]> {
        const envelope = await this.callEnvelope<TagRow[]>({
            name: "tag.list",
            method: "POST",
            url: ENDPOINTS.tagList,
            body: { cursor: "0", limit: 10, key_word: "" },
        });
        return toTags(envelope.data ?? []);
    }

    /**
     * Collect the tags carried by the public recommend feed.
     *
     * 【据实测】The feed is the only anonymous route that still answers with real tag objects
     * (`item_info.tags[]`, each with `tag_id` + `tag_name`) when paging and search are ignored
     * upstream. One page returns ~20 articles and ~13 distinct tags, which is a meaningful
     * widening of the ten popular ones.
     */
    async fetchFeedTags(): Promise<JuejinTag[]> {
        const envelope = await this.callEnvelope<
            Array<{ item_info?: { tags?: Array<{ tag_id?: string | number; tag_name?: string }> } }>
        >({
            name: "feed.tags",
            method: "POST",
            url: ENDPOINTS.recommendFeed,
            body: { id_type: 2, client_type: 2608, cursor: "0", limit: 20, sort_type: 200 },
        });
        const rows: TagRow[] = [];
        (envelope.data ?? []).forEach((item) => {
            (item?.item_info?.tags ?? []).forEach((tag) => {
                if (tag && tag.tag_id !== undefined) {
                    // The feed uses a flat `tag_name`, so it is fed through the same shape the
                    // tag route returns nested — `toTags` already understands both.
                    rows.push({ tag_id: tag.tag_id, tag_name: tag.tag_name });
                }
            });
        });
        return toTags(rows);
    }

    /**
     * Read the tags of one Juejin article by its rendered page.
     *
     * This is the escape hatch for a tag the directory will not list (e.g. a niche technology):
     * the server-rendered article page embeds the full tag objects in its SSR payload, and page
     * HTML is not subject to the API downgrade that hides paging and search. The `tag_id` and
     * `tag_name` keys sit next to each other in that payload, in both the quoted JSON and the
     * unquoted object-literal form, so one tolerant pattern covers both.
     */
    async fetchArticleTags(url: string): Promise<JuejinTag[]> {
        const match = /\/post\/(\d{6,25})/.exec(url) ?? /^(\d{6,25})$/.exec(url.trim());
        if (!match) {
            throw new SyncError(ErrorKind.PARAM_INVALID, {
                i18nKey: "sync.dialog.tagImportInvalid",
                raw: { endpoint: "post.page", errMsg: "not a Juejin article link" },
            });
        }
        const articleId = match[1];
        const response = await this.proxy.request({
            url: ENDPOINTS.postPage(articleId),
            method: "GET",
            headers: { Accept: "text/html,application/xhtml+xml" },
        });
        const rows: TagRow[] = [];
        const seen = new Set<string>();
        const pattern = /["']?tag_id["']?\s*:\s*["']?(\d{6,25})["']?\s*,\s*["']?tag_name["']?\s*:\s*"([^"]+)"/g;
        let hit = pattern.exec(response.body);
        while (hit) {
            if (!seen.has(hit[1])) {
                seen.add(hit[1]);
                rows.push({ tag_id: hit[1], tag_name: hit[2] });
            }
            hit = pattern.exec(response.body);
        }
        return toTags(rows);
    }

    /**
     * `POST /tag_api/v1/query_tag_list` with `key_word` — server-side tag search.
     *
     * 【实测 2026-11-26】The route answers `err_no: 0` but ignores `key_word` and returns the same
     * popular page as {@link fetchTags}, i.e. it is downgraded for a non-browser client. It is kept
     * because the downgrade is server-side and can be lifted; callers must therefore treat an
     * empty/irrelevant answer as "unknown", never as proof that the tag does not exist, and must
     * not clear an existing suggestion list when it comes back empty.
     */
    async searchTags(keyword: string, limit = 20): Promise<JuejinTag[]> {
        const trimmed = keyword.trim();
        if (trimmed.length === 0) {
            return [];
        }
        const envelope = await this.callEnvelope<TagRow[]>({
            name: "tag.search",
            method: "POST",
            url: ENDPOINTS.tagList,
            body: { cursor: "0", limit, key_word: trimmed },
        });
        return toTags(envelope.data ?? []);
    }

    /* ---------------- drafts ---------------- */

    /**
     * Body shape is 【据推断】: field names come from a public reference implementation,
     * the route itself is verified. `edit_type: 10` means "markdown editor".
     */
    private draftBody(input: DraftInput): Record<string, unknown> {
        return {
            category_id: input.categoryId,
            tag_ids: input.tagIds,
            link_url: "",
            cover_image: input.coverImage ?? "",
            title: input.title,
            brief_content: input.briefContent,
            edit_type: 10,
            html_content: "deprecated",
            mark_content: input.markdown,
            theme_ids: [],
        };
    }

    async createDraft(input: DraftInput): Promise<JuejinDraftRef> {
        const data = await this.callData<{ id?: string | number; draft_id?: string | number }>({
            name: "draft.create",
            method: "POST",
            url: ENDPOINTS.draftCreate,
            body: this.draftBody(input),
        });
        const draftId = String(data?.id ?? data?.draft_id ?? "");
        if (!draftId) {
            throw new SyncError(ErrorKind.API_CHANGED, {
                raw: { endpoint: shortEndpoint(ENDPOINTS.draftCreate), errMsg: "missing draft id" },
            });
        }
        return { draftId };
    }

    /**
     * 【待验证】 the draft id field is `id` in some builds and `draft_id` in others.
     *
     * Also the place where FR-10② gets its signal: a "successful" envelope whose `err_msg`
     * says the article is already published / not editable is turned into a `SyncError` so the
     * engine can mark the binding `status: "unknown"` instead of retrying forever.
     */
    async updateDraft(draftId: string, input: DraftInput): Promise<JuejinDraftRef> {
        const base = this.draftBody(input);
        const attempt = async (field: "id" | "draft_id", label: string): Promise<JuejinDraftRef> => {
            const envelope = await this.callEnvelope<{ id?: string | number; draft_id?: string | number }>({
                name: label,
                method: "POST",
                url: ENDPOINTS.draftUpdate,
                body: { ...base, [field]: draftId },
            });
            const errMsg = String(envelope.err_msg ?? "");
            if (hasPublishedHintText(errMsg)) {
                throw new SyncError(ErrorKind.UNKNOWN, {
                    i18nKey: "sync.hint.maybePublished",
                    raw: { endpoint: shortEndpoint(ENDPOINTS.draftUpdate), errMsg },
                });
            }
            return { draftId: String(envelope.data?.id ?? envelope.data?.draft_id ?? draftId) };
        };

        try {
            return await attempt("id", "draft.update");
        } catch (error) {
            // Only a *parameter* rejection justifies the alternate field name; auth/network
            // failures must surface immediately (D4 forbids blind retries).
            if (!(error instanceof SyncError) || error.kind !== ErrorKind.PARAM_INVALID) {
                throw error;
            }
            this.logger.warn("draft.update rejected `id`, retrying with `draft_id`");
            return await attempt("draft_id", "draft.update(draft_id)");
        }
    }

    /**
     * Read one draft.
     *
     * Live shape (verified 2026-11-26): `data = { draft_id, article_draft:{...}, category, tags,
     * user_interact, columns, theme_list }` — the readable fields live one level down in
     * `article_draft`, not at the top level. `draft` / flat shapes are kept as fallbacks because
     * the route has already changed once.
     */
    async getDraft(draftId: string): Promise<JuejinDraftDetail> {
        const data = await this.callData<{
            draft?: DraftPayload;
            article_draft?: DraftPayload;
            draft_id?: string;
        } & DraftPayload>({
            name: "draft.detail",
            method: "POST",
            url: ENDPOINTS.draftDetail,
            body: { draft_id: draftId },
        });
        const draft = data?.article_draft ?? data?.draft ?? data;
        return {
            draftId: String(draft?.id ?? draft?.draft_id ?? data?.draft_id ?? draftId),
            title: String(draft?.title ?? ""),
            markdown: String(draft?.mark_content ?? ""),
            categoryId: String(draft?.category_id ?? ""),
            tagIds: (draft?.tag_ids ?? []).map((tagId) => String(tagId)),
            articleId: draft?.article_id === undefined ? undefined : String(draft.article_id),
        };
    }

    async publishDraft(draftId: string, meta: DraftInput): Promise<JuejinArticleRef> {
        const data = await this.callData<{ article_id?: string | number; id?: string | number }>({
            name: "article.publish",
            method: "POST",
            url: ENDPOINTS.articlePublish,
            body: {
                draft_id: draftId,
                sync_to_org: false,
                column_ids: [],
                theme_ids: [],
                encrypted_word_count: 0,
                category_id: meta.categoryId,
                tag_ids: meta.tagIds,
                cover_image: meta.coverImage ?? "",
                brief_content: meta.briefContent,
            },
        });
        const articleId = String(data?.article_id ?? data?.id ?? "");
        if (!articleId) {
            throw new SyncError(ErrorKind.API_CHANGED, {
                raw: { endpoint: shortEndpoint(ENDPOINTS.articlePublish), errMsg: "missing article id" },
            });
        }
        return { articleId, draftId };
    }

    /** 【待验证】 every probe of this route answered `404 内容为空` on 2026-11-25. */
    async getArticle(articleId: string): Promise<JuejinArticleDetail> {
        const data = await this.callData<{
            article_info?: { article_id?: string | number; title?: string; mark_content?: string; status?: number };
            article_id?: string | number;
            title?: string;
            mark_content?: string;
            status?: number;
        }>({
            name: "article.detail",
            method: "POST",
            url: ENDPOINTS.articleDetail,
            body: { article_id: articleId },
        });
        const info = data?.article_info ?? data;
        return {
            articleId: String(info?.article_id ?? articleId),
            title: String(info?.title ?? ""),
            markdown: String(info?.mark_content ?? ""),
            status: Number(info?.status ?? 0),
        };
    }

    /* ---------------- images ---------------- */

    /** Step ①: STS credentials from `imagex/v2/gen_token`. */
    private async imageToken(): Promise<ImagexToken> {
        const uuid = this.uuid();
        const url = `${ENDPOINTS.genToken}?aid=${AID}&uuid=${uuid}&client=web`;
        const data = await this.callData<{ token?: ImagexToken }>({
            name: "imagex.gen_token",
            method: "GET",
            url,
        });
        const token = data?.token;
        if (!token || !token.AccessKeyId || !token.SecretAccessKey || !token.SessionToken) {
            throw new SyncError(ErrorKind.API_CHANGED, {
                raw: { endpoint: shortEndpoint(ENDPOINTS.genToken), errMsg: "missing sts token" },
            });
        }
        return token;
    }

    /** Signed GET against the ImageX host (steps ② and ④). */
    private async imagexSigned(name: string, query: Record<string, string>, token: ImagexToken): Promise<unknown> {
        const sig = buildSigV4({
            accessKeyId: token.AccessKeyId,
            secretAccessKey: token.SecretAccessKey,
            sessionToken: token.SessionToken,
            host: IMAGEX_HOST,
            path: "/",
            method: "GET",
            query,
            region: IMAGEX_REGION,
            service: IMAGEX_SERVICE,
        });
        const url = `${ENDPOINTS.imagex}?${canonicalQueryString(query)}`;
        const headers = {
            authorization: sig.authorization,
            "x-amz-date": sig["x-amz-date"],
            "x-amz-security-token": sig["x-amz-security-token"],
        };
        const endpoint = shortEndpoint(ENDPOINTS.imagex);
        try {
            const response = await this.proxy.getJson(url, headers);
            this.logger.info(`${name} -> http=${response.status} elapsed=${response.elapsedMs}ms`);
            return JSON.parse(response.body);
        } catch (error) {
            throw attachContext(error, endpoint);
        }
    }

    /**
     * Full ImageX chain, steps ①–⑤ (§1.4).
     *
     * @returns The CDN URL to write into the article body.
     */
    async uploadImage(bytes: ArrayBuffer, mime: string, _filename: string): Promise<string> {
        const token = await this.imageToken();
        const uuid = this.uuid();

        // ② ApplyImageUpload
        const apply = (await this.imagexSigned(
            "imagex.apply",
            { Action: "ApplyImageUpload", Version: IMAGEX_VERSION, ServiceId: IMAGEX_SERVICE_ID },
            token,
        )) as ImagexApplyResult;
        const address = apply?.Result?.UploadAddress;
        const storeInfo = address?.StoreInfos?.[0];
        const storeUri = storeInfo?.StoreUri ?? "";
        const storeAuth = storeInfo?.Auth ?? "";
        const sessionKey = address?.SessionKey ?? "";
        if (!storeUri || !storeAuth || !sessionKey) {
            throw new SyncError(ErrorKind.API_CHANGED, {
                raw: {
                    endpoint: shortEndpoint(ENDPOINTS.imagex),
                    errMsg: describeImagexError(apply) ?? "missing upload address",
                },
                i18nKey: "image.err.imagex",
            });
        }

        // ③ Binary upload to the TOS host; CRC32 is mandatory.
        //
        // Byte order is not pinned down by any observation we have: §1.4 of the architecture
        // says little-endian, while the ubiquitous `%08x` form is big-endian. Instead of
        // betting on one, upload with the big-endian form and retry the *same* image once with
        // the little-endian form when the service complains about the checksum. Both spellings
        // are valid CRC32 values, only the byte order differs (see `knownDeviations.test.ts`).
        const uploadHost = decodeSessionKeyHost(sessionKey, DEFAULT_UPLOAD_HOST);
        const view = new Uint8Array(bytes);
        const crc32BigEndian = crc32Hex(view);
        const uploadUrl = `https://${uploadHost}/${storeUri}`;
        const put = async (checksum: string): Promise<void> => {
            await this.proxy.postBinary(uploadUrl, bytes, {
                authorization: storeAuth,
                "Content-CRC32": checksum,
                "Content-Type": mime || "application/octet-stream",
            });
        };

        let usedChecksum = crc32BigEndian;
        try {
            await put(crc32BigEndian);
        } catch (error) {
            if (!isChecksumMismatch(error)) {
                throw attachContext(error, uploadHost);
            }
            usedChecksum = crc32HexLittleEndian(view);
            // No credential material is logged: host + byte counts only.
            this.logger.warn(
                `imagex.put checksum rejected, retrying once with little-endian CRC32 (${shortEndpoint(uploadUrl)})`,
            );
            try {
                await put(usedChecksum);
            } catch (retryError) {
                throw attachContext(retryError, uploadHost);
            }
        }
        this.logger.info(`imagex.put ${shortEndpoint(uploadUrl)} bytes=${bytes.byteLength} crc32=${usedChecksum}`);

        // ④ CommitImageUpload — `201007 bad gateway` is transient, retry once.
        const commit = await this.commitWithRetry(sessionKey, token);
        const uriStatus = commit?.Result?.Results?.[0]?.UriStatus;
        if (uriStatus !== 2000) {
            throw new SyncError(ErrorKind.API_CHANGED, {
                raw: {
                    endpoint: shortEndpoint(ENDPOINTS.imagex),
                    errMsg: describeImagexError(commit) ?? `UriStatus=${String(uriStatus)}`,
                },
                i18nKey: "image.err.imagex",
            });
        }

        // ⑤ Resolve the CDN URL.
        const imgUrl = `${ENDPOINTS.getImgUrl}?aid=${AID}&uuid=${uuid}&uri=${encodeURIComponent(storeUri)}&img_type=private`;
        const data = await this.callData<{ main_url?: string }>({
            name: "imagex.get_img_url",
            method: "GET",
            url: imgUrl,
        });
        const mainUrl = data?.main_url ?? "";
        if (!mainUrl) {
            throw new SyncError(ErrorKind.API_CHANGED, {
                raw: { endpoint: shortEndpoint(ENDPOINTS.getImgUrl), errMsg: "missing main_url" },
                i18nKey: "image.err.imagex",
            });
        }
        return mainUrl;
    }

    private async commitWithRetry(sessionKey: string, token: ImagexToken): Promise<ImagexCommitResult> {
        const query = {
            Action: "CommitImageUpload",
            Version: IMAGEX_VERSION,
            ServiceId: IMAGEX_SERVICE_ID,
            SessionKey: sessionKey,
        };
        const first = (await this.imagexSigned("imagex.commit", query, token)) as ImagexCommitResult;
        if (first?.Result?.Results?.[0]?.UriStatus === 2000) {
            return first;
        }
        this.logger.warn(`imagex.commit not committed, retrying once: ${describeImagexError(first) ?? ""}`);
        // One retry only, and only with a *fresh* token: the STS credentials are short lived.
        const refreshed = await this.imageToken();
        return (await this.imagexSigned("imagex.commit(retry)", query, refreshed)) as ImagexCommitResult;
    }

    /* ---------------- reverse import helpers ---------------- */

    /** Download any binary resource through the proxy (architecture §4.2 step "getBinary"). */
    async downloadBinary(url: string): Promise<ArrayBuffer> {
        try {
            const response = await this.proxy.getBinary(url, { "User-Agent": DEFAULT_USER_AGENT });
            return base64ToArrayBuffer(response.body);
        } catch (error) {
            throw attachContext(error, shortEndpoint(url));
        }
    }

    /** Fetch the rendered article page HTML (A4 fallback). */
    async fetchArticlePage(articleId: string): Promise<string> {
        const url = ENDPOINTS.postPage(articleId);
        try {
            const response = await this.proxy.getJson(url, {
                "User-Agent": DEFAULT_USER_AGENT,
                Accept: "text/html,application/xhtml+xml",
            });
            return response.body;
        } catch (error) {
            throw attachContext(error, shortEndpoint(url));
        }
    }

    /* ---------------- diagnostics ---------------- */

    /**
     * Probe every endpoint the plugin depends on (A5).
     *
     * Never throws: each probe records `reachable` plus the verbatim `err_no` / `err_msg`.
     */
    async probeEndpoints(): Promise<EndpointProbe[]> {
        const probes: EndpointProbe[] = [];
        for (const spec of PROBE_SPECS) {
            probes.push(await this.runProbe(spec));
        }
        return probes;
    }

    /**
     * Best-effort removal of a draft the self-check accidentally created.
     *
     * Never throws: a failed cleanup must not turn a healthy probe into a red row, but it is logged
     * so the leftover draft can still be found by hand.
     */
    private async discardProbeDraft(draftId: string): Promise<void> {
        try {
            await this.callEnvelope<unknown>({
                name: "probe.draft.cleanup",
                method: "POST",
                url: ENDPOINTS.draftDelete,
                body: { draft_id: draftId },
            });
            this.logger.info(`self-check removed the temporary draft it created (${draftId})`);
        } catch (error) {
            this.logger.warn(`self-check could not remove draft ${draftId}; delete it manually: ${String(error)}`);
        }
    }

    private async runProbe(spec: ProbeSpec): Promise<EndpointProbe> {
        const base: EndpointProbe = {
            name: spec.name,
            url: spec.url,
            reachable: false,
            determinism: spec.determinism,
        };
        try {
            const envelope = await this.callEnvelope<{ id?: string | number; draft_id?: string | number }>({
                name: `probe.${spec.name}`,
                method: spec.method,
                url: spec.url,
                body: spec.body,
                allowAnonymous: true,
            });
            if (spec.cleanupCreatedDraft) {
                const created = envelope.data?.id ?? envelope.data?.draft_id;
                if (created !== undefined && String(created).length > 0) {
                    await this.discardProbeDraft(String(created));
                }
            }
            return { ...base, reachable: true, observed: "err_no=0 err_msg=" };
        } catch (error) {
            const issue = toIssueParts(error);
            const errNo = issue.raw.errNo;
            const errMsg = issue.raw.errMsg ?? "";
            const httpStatus = issue.raw.httpStatus;
            const routeMissing = (errNo === 2 && errMsg.indexOf("\u8def\u7531\u4e0d\u5b58\u5728") >= 0) ||
                (httpStatus === 404 && /page not found/i.test(errMsg));
            return {
                ...base,
                reachable: !routeMissing,
                observed: formatObserved(errNo, errMsg, httpStatus),
            };
        }
    }
}

/* ------------------------------------------------------------------ *
 * Probe table
 * ------------------------------------------------------------------ */

export interface ProbeSpec {
    name: string;
    url: string;
    method: "GET" | "POST";
    body?: unknown;
    determinism: ProbeDeterminism;
    /** Set when the route can create a resource even from a throw-away body, so the probe cleans up. */
    cleanupCreatedDraft?: boolean;
}

/**
 * Probe table for the advanced self-check (A5).
 *
 * Exported so tests can guard two rules that are invisible at runtime: no probe may create a real
 * resource, and routes Juejin does not have must be labelled `known-missing` rather than red.
 */
export const PROBE_SPECS: ProbeSpec[] = [
    { name: "user.get", url: ENDPOINTS.userGet, method: "GET", determinism: "verified" },
    { name: "category.briefs", url: `${ENDPOINTS.categoryBriefs}?aid=${AID}`, method: "GET", determinism: "verified" },
    { name: "tag.list", url: ENDPOINTS.tagList, method: "POST", body: { cursor: "0", limit: 1, key_word: "" }, determinism: "verified" },
    /*
     * `{}` is NOT a safe probe here: it succeeds and leaves an empty draft in the account (verified
     * 2026-11-26 — one junk draft per self-check run). A deliberately ill-typed `title` still proves
     * the route exists (`json: cannot unmarshal object into Go struct field ArticleDraftReq.title`)
     * while creating nothing. `cleanupCreatedDraft` is the belt for the day Juejin relaxes the type.
     */
    {
        name: "draft.create",
        url: ENDPOINTS.draftCreate,
        method: "POST",
        body: { title: { probe: true } },
        determinism: "verified",
        cleanupCreatedDraft: true,
    },
    { name: "draft.update", url: ENDPOINTS.draftUpdate, method: "POST", body: {}, determinism: "verified" },
    { name: "draft.detail", url: ENDPOINTS.draftDetail, method: "POST", body: { draft_id: "" }, determinism: "verified" },
    { name: "draft.delete", url: ENDPOINTS.draftDelete, method: "POST", body: {}, determinism: "verified" },
    { name: "article.publish", url: ENDPOINTS.articlePublish, method: "POST", body: {}, determinism: "verified" },
    { name: "article.query_list", url: ENDPOINTS.articleQueryList, method: "POST", body: { cursor: "0", limit: 1 }, determinism: "verified" },
    /* Route exists, but answers `err_no=404 内容为空` even for an article the same session owns. */
    { name: "article.detail", url: ENDPOINTS.articleDetail, method: "POST", body: { article_id: "" }, determinism: "unverified" },
    { name: "article.update", url: ENDPOINTS.articleUpdate, method: "POST", body: {}, determinism: "known-missing" },
    { name: "article.unpublish", url: ENDPOINTS.articleUnpublish, method: "POST", body: {}, determinism: "known-missing" },
    { name: "imagex.gen_token", url: `${ENDPOINTS.genToken}?aid=${AID}&uuid=${Date.now()}&client=web`, method: "GET", determinism: "verified" },
];

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Turn a full URL into the short form used in logs and `raw.endpoint`. */
function shortEndpoint(url: string): string {
    const withoutQuery = url.split("?")[0];
    return withoutQuery
        .replace(/^https?:\/\//, "")
        .replace(/^api\.juejin\.cn\//, "")
        .replace(/^juejin\.cn\//, "");
}

function parseEnvelope<T>(body: string): JuejinEnvelope<T> {
    try {
        const parsed: unknown = JSON.parse(body);
        if (parsed && typeof parsed === "object") {
            return parsed as JuejinEnvelope<T>;
        }
    } catch {
        // Fall through: a non-JSON body means the route changed to HTML or the host 404'd.
    }
    return { err_no: -1, err_msg: body.slice(0, 200) };
}

/** Attach endpoint + elapsed context to any thrown value, preserving the classified kind. */
/**
 * Does this failure look like a `Content-CRC32` rejection (`4007 MismatchChecksum`)?
 *
 * Kept separate from {@link attachContext} because the caller needs the *raw* status/body
 * before the error model flattens it into an i18n key.
 */
export function isChecksumMismatch(error: unknown): boolean {
    const body = error instanceof ProxyError ? error.body : "";
    const status = error instanceof ProxyError ? error.status : 0;
    const message = error instanceof Error ? error.message : "";
    if (status !== 400 && status !== 403 && status !== 0) {
        return false;
    }
    return /4007|mismatch\s*checksum|checksum/i.test(`${body} ${message}`);
}

function attachContext(error: unknown, endpoint: string): SyncError {
    if (error instanceof SyncError) {
        return error.withContext({ endpoint });
    }
    if (error instanceof ProxyError) {
        return mapProxyError(error).withContext({ endpoint, httpStatus: error.status || undefined });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new SyncError(ErrorKind.UNKNOWN, { raw: { endpoint, errMsg: message } });
}

/** Local shape with `raw` guaranteed present (used by probe / credential classification). */
function toIssueParts(error: unknown): { kind: ErrorKind; raw: { errNo?: number; errMsg?: string; httpStatus?: number; elapsedMs?: number } } {
    const syncError = attachContext(error, "");
    return { kind: syncError.kind, raw: syncError.raw };
}

function formatObserved(errNo?: number, errMsg?: string, httpStatus?: number): string {
    const parts: string[] = [];
    if (errNo !== undefined) {
        parts.push(`err_no=${errNo}`);
    }
    if (errMsg) {
        parts.push(`err_msg=${errMsg.slice(0, 120)}`);
    }
    if (httpStatus !== undefined) {
        parts.push(`http=${httpStatus}`);
    }
    return parts.join(" ");
}

function describeImagexError(result: { ResponseMetadata?: { Error?: { Code?: string; Message?: string } } }): string | null {
    const error = result?.ResponseMetadata?.Error;
    if (!error) {
        return null;
    }
    return `${error.Code ?? ""} ${error.Message ?? ""}`.trim();
}

/** Re-exported so upper layers never import `juejinSign` directly. */
export { bytesToBase64 };
