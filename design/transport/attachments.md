# Inbound Attachments `[proposed]`

How a photo or file a user sends becomes part of a stored message: the adapter stores the original, and `create-user-message` normalizes it and writes reference blocks. How the transcript renders, budgets and re-sends those blocks is [prompt-caching.md](../prompt-caching.md#sources-and-fixes) → source (d); the stored block shapes are its [Stored shapes](../prompt-caching.md#stored-shapes-confirmed).

## Research Base `[research]`

Surveyed September 2026.

| Route | Formats | Per image | Per request |
|-|-|-|-|
| Anthropic | JPEG, PNG, GIF, WebP; "Animations are unsupported, and only the first frame is used" | 8000 × 8000 px; 10 MB of base64, "5 MB (base64-encoded) on Amazon Bedrock and Google Cloud". Above 20 images in a request, resent ones included, "resize each image so that neither dimension exceeds 2000 px" | 32 MB ("Bedrock limits requests to 20 MB, and Google Cloud limits requests to 30 MB"); 100 images "for models with a 200k-token context window", 600 otherwise; PDF pages 600, "100 when the request's context window is under 1M tokens" |
| OpenAI | PNG, JPEG, WEBP, "non-animated GIF" | — | 512 MB; 1,500 images |
| OpenRouter | `image/png`, `image/jpeg`, `image/webp`, `image/gif` | — | "varies per provider and per model" |
| Gemini | PNG, JPEG, WEBP, HEIC, HEIF | — | 3,600 images; inline data "limits your total request size … to 20MB" |

- Claude "does not parse or receive any metadata from images", so an EXIF rotation never reaches it. Heavy JPEG compression "can make text difficult to read", "especially when multiple compression passes are applied".
- PDFs: "Standard PDF (no passwords/encryption)"; "Binary formats such as .xlsx or .docx are not supported in document blocks and must be converted to text or PDF first". A page costs 1,500–3,000 text tokens plus its image.
- sharp 0.35.5 (released 2026-09-27) bundles libvips 8.18.7 with mozjpeg, libpng, libwebp and libnsgif ([infrastructure.md](../infrastructure.md#image-processing-proposed)). The prebuilt reads "JPEG, PNG, Ultra HDR, WebP, AVIF, TIFF, GIF and SVG (input)", not HEIC. `failOn`: "Use the default 'warning' level with untrusted input". `limitInputPixels` defaults to 268,402,689 and "Assumes image dimensions contained in the input metadata can be trusted". Output drops all metadata by default and converts to sRGB. `sharp.block` / `unblock` restrict which libvips loaders run: blocking `VipsForeignLoad` blocks "all operations derived from `VipsForeignLoad` (so all loaders)", and unblocking a loader re-admits it alone.

## Where it runs `[proposed]`

- **Adapters store originals.** The Telegram handler downloads the file and calls `transport.uploadAttachment`, and the inbound block carries the `path`. No adapter decodes.
- **`create-user-message` normalizes.** For every attachment in the batch it reads the original, normalizes it, uploads the result under the `normalized` prefix, and inserts the row with refs, in one step that returns nothing. An inline attachment (bytes, no `path`) is uploaded there as the original first. A URL attachment, which no adapter produces, becomes a placeholder: fetching a user-supplied URL from the server is an SSRF surface, and its bytes can change.

Why that step: it is durable, as `transcribe-voice` is, and it bounds a decoder crash to the step's retry budget. In the Telegram handler, the update would still be unconfirmed when the process died, so every restart would receive it again. A retry after an upload orphans the earlier upload, which is accepted.

A turn's attachments are admitted in order while their base64 total stays within the Anthropic attachment budget (24 MB) and their count within 100; the rest become placeholders. A turn therefore fits the production route on its own; on a route with a smaller budget it can fail, and the next turn's cutoff covers its row.

## Images `[proposed]`

1. **Sniff.** A HEIC or HEIF file, by media type or by a `heic`, `heix` or `mif1` `ftyp` brand, gets the HEIC placeholder. `heic-decode` is a later option.
2. **Guard.** Inputs over 20 MB (Telegram's bot download ceiling) are refused unread. `limitInputPixels` is 100 megapixels, checked on the header before decoding: a 446 KB PNG declaring 12,000 × 12,000 was refused in 1 ms (measured). `failOn: "warning"`, `timeout` 10 s, first frame only (`pages: 1`, the default).
3. **Decode** through the loader allowlist ([Security](#security-proposed)): JPEG, PNG, WebP and GIF.
4. **Orient** from EXIF (`autoOrient`).
5. **Resize** to fit 2000 × 2000 (`fit: "inside"`, `withoutEnlargement`). That meets Anthropic's many-image rule on every request, whatever the count, and stays under the high-resolution tier's 2576 px.
6. **Encode.** PNG when the image has transparency (`hasAlpha` and not `stats().isOpaque`), at compression level 9. Otherwise JPEG, quality 85 with `mozjpeg`: one more lossy pass on an already compressed photo, kept light for legibility. Chroma is 4:4:4 for a PNG or GIF source, where colour fringing blurs screenshot text, and 4:2:0 otherwise, since a lossy source has already lost chroma resolution.
7. **Metadata.** None is written. EXIF (GPS included), XMP and IPTC are dropped and colour is converted to sRGB, so the model and the providers receive pixels only. The original keeps its metadata in storage.
8. **Cap** at 3.75 MB, which is 5 MB of base64: Bedrock's and Google Cloud's per-image limit, both of which OpenRouter can route Claude to. An image over it is re-encoded at JPEG quality 70 (a PNG is palette-quantized), then its long edge shrinks by a quarter per step until it fits.

Measured on sharp 0.35.5 with one thread: a 48-megapixel input normalizes in about half a second, with under 70 MB of extra resident memory.

## Documents `[proposed]`

- **PDFs** are stored as sent, as a `document_ref`: no rasterizing and no page parsing, which would add a second untrusted-input parser. A file without the `%PDF-` header, or with an `/Encrypt` entry, gets a placeholder. The page limit isn't budgeted, because at 1,500 tokens or more a page the context budget binds first. The exception is an image-only scan on a standard-tier model.
- **Text-like documents** (`text/*`, JSON, XML, YAML) are stored as sent. Anthropic sends them as a text source, and the OpenAI-compatible adapter inlines up to 100,000 characters.
- **Other binary documents** (`.docx`, `.xlsx`, archives, `application/octet-stream`) get a placeholder at arrival, not a stub at the wire. No route Cogmo serves reads them. A wire stub would read and base64-encode the bytes on every invocation for each adapter to discard, count them against the attachment budget, and send stub text that a deploy could change under a cached prefix. A placeholder is stored as sent, so the head stays the same on every route and nothing is re-read. The OpenAI-compatible adapter still stubs a PDF, which Anthropic reads.

## Placeholders `[proposed]`

A placeholder is a text block written into the row at arrival and stored as sent, like a turn context, so rewording one reaches new rows only. Each names the file, or `photo`, and says what to do:

| Case | Says |
|-|-|
| HEIC or HEIF | not supported; send it as a photo |
| Other image format, decode failure, timeout | couldn't be read; send it as a photo |
| Over 20 MB or 100 megapixels | too large |
| Unreadable PDF (no header, encrypted) | send an unlocked PDF |
| Other binary document | can't be read; send a PDF or text |
| URL attachment | not fetched |
| Past the per-turn cap | not attached; send fewer at a time |

Each is counted in `cogmo.attachments.placeholders{reason}`. A failure is never deferred to the provider, where it would be a 400 on every later turn that re-sends the row.

## Security `[proposed]`

libvips and its codecs run native code in the server process over bytes anyone can put in front of the user: a forwarded photo, or a file from a group. The sender is allowlisted, but the content isn't.

- **Loader allowlist.** At module load, `sharp.block({ operation: ["VipsForeignLoad"] })`, then unblock the JPEG, PNG, WebP and GIF buffer loaders. TIFF, AVIF and SVG buffers are refused as an unsupported format (measured). That takes librsvg and its XML parser, libtiff, libheif and libvips' own format, whose loader had CVE-2026-33327, out of reach.
- **Bounded work.** The pixel and byte caps come before decoding, with `failOn: "warning"`, the timeout, `sharp.cache(false)` (every input is unique), one libvips thread per image, and one image at a time.
- **Pixels out.** The output is re-encoded with no input metadata.
- **Patch channel.** The codecs ship inside `@img/sharp-libvips-*`, not as Debian packages, so the image's `apt-get upgrade` never reaches them. sharp releases, through Dependabot, are the only patch path.
- **Originals in the web UI.** When the web UI shows originals, it serves allowlisted image types inline with the sniffed type and `nosniff`, and anything else as a download.

**Residual.** A memory-safety bug in an allowed decoder, triggered by a crafted image, runs as the server process, which holds the master key and the database credentials. A crash fails the attempt of every run in flight. `[research]` Decode in a child process with a scrubbed environment, or through sharp's WebAssembly build, which confines a decoder bug to its linear memory at a speed cost. Worth measuring if an allowed codec's advisories become frequent.

## Tests `[proposed]`

- **Unit**, on fixtures sharp generates in the test:
  - EXIF orientation 6 comes out rotated, without EXIF; 4000 × 3000 becomes 2000 × 1500, and a small image isn't enlarged.
  - Transparency keeps PNG, and a fully opaque alpha channel gives JPEG; an animated GIF gives its first frame; WebP and CMYK come out as sRGB JPEG; chroma follows the source; a noise image over the cap steps down under it.
  - Every placeholder case, HEIC by media type and by brand. TIFF, AVIF and SVG are refused by the allowlist, the regression test for an unblocked loader; a truncated JPEG, zero bytes and a 144-megapixel header are refused before decoding.
  - A mislabelled media type decodes by content, and an Ultra HDR JPEG decodes, through the JPEG loader or an allowlisted Ultra HDR one.
  - `create-user-message` uploads inline originals and normalized copies and writes refs; cached, it does neither.
- **Boot.** The boot check covers the built image ([infrastructure.md](../infrastructure.md#image-processing-proposed)).
- **Integration.** `prompt-caching.integration.test.ts`'s image turn runs through sharp and the test bucket, and the turn after it extends the image turn's request ([prompt-caching.md](../prompt-caching.md#integration-tier-replay-every-pr)).
- **Live.** One request of 21 normalized 2000-px images returns 200 on Haiku 4.5 and Sonnet 5, which pins the many-image rule for this output. It costs cents.

## Open questions

- **Originals in the web UI.** `ChatHistoryMessage.attachments` names them. Serving the bytes needs an ownership-checked route.
- **PDFs on OpenAI-compatible routes.** OpenRouter accepts PDFs as `file` content parts, which would replace the stub on the `openrouter` dialect.

## Sources

- Anthropic, Vision — https://platform.claude.com/docs/en/build-with-claude/vision
- Anthropic, PDF support — https://platform.claude.com/docs/en/build-with-claude/pdf-support
- Anthropic, API overview (request size limits) — https://platform.claude.com/docs/en/api/overview
- OpenAI, Images and vision — https://developers.openai.com/api/docs/guides/images-vision
- OpenRouter, Image understanding — https://openrouter.ai/docs/guides/overview/multimodal/image-understanding
- Google, Gemini image understanding — https://ai.google.dev/gemini-api/docs/image-understanding
- sharp: installation, constructor, output, utilities, performance — https://sharp.pixelplumbing.com/install, /api-constructor, /api-output, /api-utility, /performance
- libvips, blocking untrusted operations (8.13) — https://www.libvips.org/2022/05/28/What's-new-in-8.13.html
- CVE-2026-33327, `vipsload` integer overflow, fixed in libvips 8.18.1 — https://www.sentinelone.com/vulnerability-database/cve-2026-33327/
