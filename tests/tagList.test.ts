/**
 * Regression for the tag list shape.
 *
 * `POST /tag_api/v1/query_tag_list` returns the readable name **nested** under `tag`, not as a
 * flat `tag_name`:
 *
 *   { "tag_id": "680…", "tag": { "tag_id": "680…", "tag_name": "Angular.js" }, … }
 *
 * Reading only the flat field does not fail loudly — every chip silently degrades to a
 * 19-digit id, which is exactly what the settings panel showed. These tests pin the nesting
 * and the fallback order so the silent degradation cannot come back.
 */
import { describe, expect, it } from "vitest";
import { JuejinClient } from "../src/api/juejin";
import type { Logger } from "../src/core/logger";

const silentLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

/** Envelope shape the proxy returns; `body` is the raw upstream payload. */
function envelope(payload: unknown) {
    return {
        status: 200,
        body: JSON.stringify(payload),
        headers: {},
        contentType: "application/json",
        elapsedMs: 1,
        encoding: "text" as const,
    };
}

function clientReturning(payload: unknown): JuejinClient {
    const proxy = {
        getJson: async () => {
            throw new Error("GET is not part of the tag list");
        },
        postJson: async () => envelope(payload),
        postBinary: async () => {
            throw new Error("no binary upload in this test");
        },
    };
    const client = new JuejinClient({
        getCredential: async () => null,
        proxy: proxy as never,
        logger: silentLogger,
        uuid: () => "1000000000000000001",
    });
    client.setCredentialOverride("session");
    return client;
}

describe("fetchTags · name resolution", () => {
    it("reads the display name from the nested `tag` object", async () => {
        const client = clientReturning({
            err_no: 0,
            err_msg: "success",
            data: [
                { tag_id: "6809637776909139982", tag: { tag_id: "6809637776909139982", tag_name: "Angular.js" } },
                { tag_id: "6809637776909139983", tag: { tag_name: "前端" } },
            ],
            has_more: false,
            cursor: "2",
        });

        const tags = await client.fetchTags();

        expect(tags).toEqual([
            { id: "6809637776909139982", name: "Angular.js" },
            { id: "6809637776909139983", name: "前端" },
        ]);
    });

    it("still accepts a flat tag_name, for responses that do not nest", async () => {
        const client = clientReturning({
            err_no: 0,
            data: [{ tag_id: "42", tag_name: "Java" }],
            has_more: false,
            cursor: "1",
        });

        await expect(client.fetchTags()).resolves.toEqual([{ id: "42", name: "Java" }]);
    });

    it("falls back to the id only when neither field exists", async () => {
        const client = clientReturning({ err_no: 0, data: [{ tag_id: "7" }], has_more: false, cursor: "1" });

        await expect(client.fetchTags()).resolves.toEqual([{ id: "7", name: "7" }]);
    });

    it("issues exactly one request even when the response claims has_more", async () => {
        // Upstream echoes `cursor: "10"` and `has_more: true` on every call while returning the
        // same ten tags. Paging on that signal produced ten identical requests and ten tags, so
        // the regression is "one call, no loop", not "keep paging".
        let calls = 0;
        const proxy = {
            getJson: async () => {
                throw new Error("unused");
            },
            postJson: async () => {
                calls += 1;
                return envelope({
                    err_no: 0,
                    data: [{ tag_id: "1", tag: { tag_name: "A" } }],
                    has_more: true,
                    cursor: "10",
                });
            },
            postBinary: async () => {
                throw new Error("unused");
            },
        };
        const client = new JuejinClient({
            getCredential: async () => null,
            proxy: proxy as never,
            logger: silentLogger,
            uuid: () => "1000000000000000001",
        });
        client.setCredentialOverride("session");

        await expect(client.fetchTags()).resolves.toEqual([{ id: "1", name: "A" }]);
        expect(calls).toBe(1);
    });
});

describe("fetchFeedTags · tags carried by the public feed", () => {
    function feedClient(payload: unknown): { client: JuejinClient; sent: Array<Record<string, unknown>> } {
        const sent: Array<Record<string, unknown>> = [];
        const proxy = {
            getJson: async () => {
                throw new Error("feed is a POST");
            },
            postJson: async (_url: string, body: Record<string, unknown>) => {
                sent.push(body);
                return envelope(payload);
            },
            postBinary: async () => {
                throw new Error("unused");
            },
        };
        const client = new JuejinClient({
            getCredential: async () => null,
            proxy: proxy as never,
            logger: silentLogger,
            uuid: () => "1000000000000000001",
        });
        client.setCredentialOverride("session");
        return { client, sent };
    }

    it("flattens `item_info.tags[]` and de-duplicates across articles", async () => {
        const { client, sent } = feedClient({
            err_no: 0,
            data: [
                {
                    item_info: {
                        tags: [
                            { tag_id: "1", tag_name: "前端" },
                            { tag_id: "2", tag_name: "TypeScript" },
                        ],
                    },
                },
                { item_info: { tags: [{ tag_id: "2", tag_name: "TypeScript" }, { tag_id: "3", tag_name: "算法" }] } },
            ],
        });

        await expect(client.fetchFeedTags()).resolves.toEqual([
            { id: "1", name: "前端" },
            { id: "2", name: "TypeScript" },
            { id: "3", name: "算法" },
        ]);
        expect(sent[0]).toMatchObject({ cursor: "0", limit: 20 });
    });

    it("skips items without tags instead of throwing", async () => {
        const { client } = feedClient({ err_no: 0, data: [{ item_info: {} }, { item_info: {} }] });

        await expect(client.fetchFeedTags()).resolves.toEqual([]);
    });
});

describe("fetchArticleTags · reading tags off a rendered article", () => {
    function htmlClient(body: string): { client: JuejinClient; urls: string[] } {
        const urls: string[] = [];
        const proxy = {
            request: async (req: { url: string }) => {
                urls.push(req.url);
                return {
                    status: 200,
                    body,
                    headers: {},
                    contentType: "text/html",
                    elapsedMs: 1,
                    encoding: "text" as const,
                };
            },
        };
        const client = new JuejinClient({
            getCredential: async () => null,
            proxy: proxy as never,
            logger: silentLogger,
            uuid: () => "1000000000000000001",
        });
        client.setCredentialOverride("session");
        return { client, urls };
    }

    it("extracts tag pairs from the unquoted SSR payload", async () => {
        // Shape taken verbatim from a live page: object literal keys are unquoted.
        const { client, urls } = htmlClient(
            'tags:[{id:"6809640407484334093",tag_id:"6809640407484334093",tag_name:"前端",color:"#60ADFF"},' +
                '{tag_id:"6809637773935378440",tag_name:"Kubernetes"}]',
        );

        await expect(client.fetchArticleTags("https://juejin.cn/post/7034323356459466760")).resolves.toEqual([
            { id: "6809640407484334093", name: "前端" },
            { id: "6809637773935378440", name: "Kubernetes" },
        ]);
        expect(urls[0]).toBe("https://juejin.cn/post/7034323356459466760");
    });

    it("accepts the quoted JSON form and a bare article id", async () => {
        const { client, urls } = htmlClient('{"tag_id":"6809637773935378440","tag_name":"Kubernetes"}');

        await expect(client.fetchArticleTags("7034323356459466760")).resolves.toEqual([
            { id: "6809637773935378440", name: "Kubernetes" },
        ]);
        expect(urls[0]).toBe("https://juejin.cn/post/7034323356459466760");
    });

    it("rejects a link that is not an article", async () => {
        const { client } = htmlClient("");

        await expect(client.fetchArticleTags("https://juejin.cn/tag/Kubernetes")).rejects.toMatchObject({
            kind: "param_invalid",
        });
    });

    it("returns an empty list when the page carries no tag", async () => {
        const { client } = htmlClient("<html><body>no tags here</body></html>");

        await expect(client.fetchArticleTags("https://juejin.cn/post/7034323356459466760")).resolves.toEqual([]);
    });
});

/**
 * `searchTags` is what keeps the tag picker honest: the cached list is a page of *popular* tags
 * (the real account had 10), so a local filter answers "no match" for tags that exist upstream.
 * Verified against the live route on 2026-11-26: `key_word: "kuber"` → `Kubernetes`.
 */
describe("searchTags · server-side keyword search", () => {
    /** Capture the body of the single request the search issues. */
    function searchingClient(payload: unknown): { client: JuejinClient; sent: Array<Record<string, unknown>> } {
        const sent: Array<Record<string, unknown>> = [];
        const proxy = {
            getJson: async () => {
                throw new Error("tag search is a POST");
            },
            postJson: async (_url: string, body: Record<string, unknown>) => {
                sent.push(body);
                return envelope(payload);
            },
            postBinary: async () => {
                throw new Error("unused");
            },
        };
        const client = new JuejinClient({
            getCredential: async () => null,
            proxy: proxy as never,
            logger: silentLogger,
            uuid: () => "1000000000000000001",
        });
        client.setCredentialOverride("session");
        return { client, sent };
    }

    it("sends the keyword as `key_word` and reads the nested name", async () => {
        const { client, sent } = searchingClient({
            err_no: 0,
            data: [{ tag_id: "6809640407484334093", tag: { tag_name: "Kubernetes" } }],
            has_more: false,
            cursor: "1",
        });

        await expect(client.searchTags("kuber")).resolves.toEqual([
            { id: "6809640407484334093", name: "Kubernetes" },
        ]);
        expect(sent[0]).toMatchObject({ cursor: "0", key_word: "kuber" });
    });

    it("trims the keyword before sending it", async () => {
        const { client, sent } = searchingClient({ err_no: 0, data: [], has_more: false, cursor: "0" });

        await client.searchTags("  docker  ");

        expect(sent[0]).toMatchObject({ key_word: "docker" });
    });

    it("does not hit the network for an empty keyword", async () => {
        const { client, sent } = searchingClient({ err_no: 0, data: [] });

        await expect(client.searchTags("   ")).resolves.toEqual([]);
        expect(sent).toEqual([]);
    });

    it("returns an empty list when the upstream has no match", async () => {
        const { client } = searchingClient({ err_no: 0, data: [], has_more: false, cursor: "0" });

        await expect(client.searchTags("zzzz-not-a-tag")).resolves.toEqual([]);
    });
});
