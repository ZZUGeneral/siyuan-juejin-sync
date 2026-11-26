# Juejin Sync (SiYuan plugin)

Sync SiYuan Note documents to **Juejin drafts** (掘金) with one click, relocating local
`assets/` images to the Juejin image host, and — optionally — import a Juejin article
back into your SiYuan workspace.

> **This plugin is not affiliated with Juejin.** It drives Juejin's *web private APIs*
> with a cookie copied from your own browser session. Endpoints may change or disappear
> at any time, and high-frequency usage may trigger the platform's risk control.
> Read [Risks](#risks) before you configure a credential.

---

## Features

| Area | What you get |
| --- | --- |
| Forward sync | Document → Juejin **draft** (title, excerpt, category, tags, body) |
| Images | Every `assets/…` image is read from the SiYuan kernel, uploaded to the Juejin image host (ByteDance ImageX, SigV4 + CRC32), and rewritten in the body |
| Idempotency | The document ↔ article mapping lives in block attributes (`custom-juejin-*`), so syncing the same document again **updates** the same draft instead of creating duplicates |
| Sandboxing | Default mode is **draft only**. Public publishing requires an explicit switch *and* a second confirmation on every sync |
| Degradation | SiYuan-only syntax (block refs, IAL, super blocks, database blocks, widgets…) is degraded to readable text with counters surfaced in the result panel |
| Reverse import (P2) | Paste a `https://juejin.cn/post/<id>` link, preview it, pick a target notebook and import the body **plus images** as a local note |
| i18n | Chinese and English UI (`zh_CN`, `en_US`) |

## Requirements

* SiYuan **3.8.5+** (the plugin uses `saveData(storageName, content)` / `loadData(storageName)`)
* A Juejin account with at least **one category** and **one tag** already created on the website

## Getting a credential

1. Sign in to <https://juejin.cn> in a desktop browser.
2. `F12` → **Application** → **Cookies** → `https://juejin.cn`.
3. Copy the value of `sessionid_ss` (or `sessionid`).
4. In SiYuan: **Settings → Juejin Sync** → accept the risk notice → paste → **Test connection** → **Fetch categories & tags** → pick a default category and at least one tag → **Save**.

Optional, recommended: store the cookie in SiYuan's **secret vault** (Settings → Secret and
variable) under the name `juejin-sessionid-ss`. The plugin reads it first and the UI labels it
as *stored in the SiYuan secret vault*. The plugin API can only **read** secrets, never write
them, so a value pasted into the plugin settings is *stored in plain text in the local data
directory* and the UI says exactly that — no wording ever claims encryption.

## Usage

* The document icon left of the title (top-left of the editor) → **Sync to Juejin**
* `Dock` panel → **Sync** tab → *Sync current document*
* Command palette → *Sync current document to Juejin* (`⌥⌘J`)

The first sync opens a confirmation dialog for title / excerpt / category / tags. The excerpt
is editable, counted in **Unicode code points**, with a live `N/100` counter next to the
field; the confirm button stays disabled outside 50–100.

The result panel has a fixed order: the **failed-image list comes first, expanded and never
collapsible**, followed by status, image counters, degradation counts and warnings. The raw
Juejin response is passed through verbatim in a separate collapsed block at the bottom. When
the list is non-empty, *Retry failed images only* re-uploads just those files and updates the
same draft.

Finish the layout on Juejin and publish there.

Reverse import: `Dock` → **Import from Juejin** tab → paste a link → *Parse link* →
*Fetch article* → choose notebook and path → *Import*. If the private endpoint yields no body,
the plugin degrades to parsing the rendered page and says so right next to the preview
(*degraded to page parsing; formulas / code highlighting may be lost*).

### Degradation rules

| SiYuan syntax | What happens |
| --- | --- |
| Block attributes `{: id="…" }`, IAL | Removed |
| Block references `((id "text"))` | Replaced by the plain text |
| Document references `[[id]]`, `siyuan://` links | Replaced by plain text |
| Super block / widget / database block / `iframe` / video / audio | Replaced by a `> [SiYuan … block, not supported yet]` placeholder |
| Local images `assets/…` | Uploaded and rewritten to the Juejin CDN URL |
| Remote images `![](https://…)` | **Kept as-is** (P0) with a warning — hotlink protection may hide them on Juejin |
| Footnotes, inline extensions | Kept when Juejin accepts them, otherwise degraded to plain text |

## Risks

1. **Private APIs.** No official open API exists for publishing. Everything relies on the
   web session cookie. A Juejin change can break the plugin; the *Endpoint self-check*
   button in the advanced settings group tells you which endpoint stopped answering.
2. **Account risk.** Only the operations you trigger are performed, requests are serialized
   with a minimum interval, and `4xx` responses are never retried automatically — but risk
   control is a platform-side decision the plugin cannot guarantee against.
3. **Credential storage.** The cookie is equivalent to your account permissions. It is kept
   in the local SiYuan data directory only; the plugin uploads nothing anywhere else.
   *Clear credential* removes it in one click.
4. **Content fidelity.** SiYuan's Kramdown dialect is richer than what Juejin renders. The
   plugin degrades explicitly (never silently) and defaults to drafts so you can review
   before publishing.
5. **Reverse import copyright.** Only import articles you wrote yourself. The plugin
   provides no batch or crawling capability.

## Development

```bash
npm install        # devDependencies only — zero third-party runtime code
npm run build      # tsc --noEmit + vite build  → dist/
npm run test       # vitest (pure functions only, no network)
npm run check      # type check only
npm run test:i18n  # the three i18n gates (key parity / no CJK literals / manifest)
```

`dist/` contains: `index.js`, `index.css`, `plugin.json`, `icon.png`, `preview.png`,
`i18n/zh_CN.json`, `i18n/en_US.json` and both READMEs.

Link the build into SiYuan:

```bash
ln -s "$(pwd)/dist" ~/SiYuan/data/plugins/siyuan-juejin-sync
```

`npm run dev` rebuilds on change (`vite build --watch`).

## Known limitations

1. **The plugin cannot see a publish performed on the website.** Forward sync only records
   state in local block attributes; if you publish the draft on Juejin, the plugin still thinks
   it is a draft and the next sync tries to update a published article. Juejin refuses, and the
   plugin then records *status unknown (possibly published)* and asks you to confirm on the
   website. The dock and the confirmation dialog also show a standing hint while the status is
   *draft*.
2. **Import "overwrite" relies on `POST /api/block/updateBlock`.** If the kernel rejects that
   block type the importer falls back to creating a new document, logs why, and still reports
   the import as successful.
3. **SiYuan super blocks / database blocks / widgets are not restored natively** — see
   *Degradation rules* above.
4. **The repository URL is a placeholder.** `url` and `author` in `plugin.json` are samples;
   replace them with your own before publishing to the marketplace.

## Known unverified areas

The following require a **real Juejin account** and could not be exercised during
development. Each one has an explicit failure branch and a user-readable error, and each is
covered by a probe in *Endpoint self-check*:

* `article_draft/create` body field names (`edit_type`, `theme_ids`, …) — route verified,
  payload inferred.
* `article_draft/update` — whether the draft id field is `id` or `draft_id`; both are tried.
* `article_draft/detail` parameter shape.
* `article/publish` body and the returned article id field.
* `article/detail` — observed to answer `404 内容为空` for every id, so reverse import falls
  back to extracting `mark_content` from the rendered page (`__NUXT__`).
* ImageX `ServiceId` / `uploadHost`, and whether the SigV4 canonical request needs more
  than `x-amz-date;x-amz-security-token`.
* Whether `forwardProxy` works on mobile frontends (desktop verified).
* Reverse import *overwrite* uses `POST /api/block/updateBlock` (`dataType=markdown`). If the
  kernel rejects that block type, the importer falls back to creating a new document and logs
  why; the import itself still succeeds.

Diagnostic helper: every probe is implemented as a manually triggerable function
(`JuejinApi.probeEndpoints()`), so you can run it after updating the plugin to see exactly
what Juejin answers today.

## License

MIT
