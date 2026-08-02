/**
 * Server-side SVG sanitizer (string-based).
 *
 * SVG is allowed through the media-library upload path so users can import
 * iconography, logos, and decorative assets from static-site bundles. But SVG
 * is XML with a script surface — anything stored in the media library is
 * served as `image/svg+xml` and can be embedded inline (`<img src=…>` or
 * directly) in published pages, so a malicious payload would execute in the
 * publisher's origin. The known active vectors:
 *
 *   1. `<script>…</script>` — direct JS execution.
 *   2. `<foreignObject>` — can embed arbitrary HTML (incl. <script>, iframes).
 *   3. `on*` event-handler attributes (`onload`, `onclick`, …).
 *   4. `javascript:` URLs inside `href` / `xlink:href`.
 *   5. `<a>` elements pointing at `javascript:` URLs.
 *
 * Why string-based rather than DOMPurify: the server runs on Bun with
 * happy-dom as its DOM. happy-dom does NOT parse SVG element trees the way
 * DOMPurify's SVG profile expects — DOMPurify drops EVERY SVG child element
 * (rect/circle/path/…), leaving only an empty `<svg></svg>` wrapper. That
 * gutting makes DOMPurify unusable for SVG in this runtime. SVG's dangerous
 * surface is small and well-defined, so a targeted string sanitizer is the
 * correct, predictable, dependency-free choice here. (Richtext HTML still
 * uses DOMPurify — happy-dom handles HTML fine; only SVG is broken.)
 *
 * Defense in depth: the sanitised bytes are what hit disk AND what the browser
 * receives, with no out-of-band cleaning step. Static assets are also served
 * with their own headers; this sanitiser is the content-level guard.
 */

// Each pattern targets one vector. The `gi` flags + `[\s\S]` (rather than `.`)
// make every pattern span newlines and match case-insensitively.

/** `<script …>…</script>` including any attributes / whitespace / newlines. */
const SCRIPT_BLOCK_RE = /<script\b[\s\S]*?<\/script\s*>/gi
/** A self-closing or unclosed `<script …/>` / `<script …>` with no close tag. */
const SCRIPT_OPEN_RE = /<script\b[^>]*\/?>/gi
/** `<foreignObject …>…</foreignObject>` — can carry arbitrary HTML. */
const FOREIGN_OBJECT_RE = /<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi
const FOREIGN_OBJECT_OPEN_RE = /<foreignObject\b[^>]*\/?>/gi
/** `<a …>` / `</a>` is allowed, but href values are scrubbed below. */
/** `on*="…"` / `on*='…'` / `on*=value` event-handler attributes. */
const EVENT_HANDLER_RE = /\son[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
/**
 * `href` / `xlink:href` / `src` whose value (after optional whitespace and
 * entity-encoding tricks) resolves to a `javascript:` scheme. We blank the
 * whole attribute rather than try to rewrite it.
 */
const JS_URL_ATTR_RE =
  /\s(?:xlink:href|href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi
/** `<style>…</style>` blocks — CSS can carry `@import url(javascript:…)`. */
const STYLE_BLOCK_RE = /<style\b[\s\S]*?<\/style\s*>/gi

function stripVectors(svg: string): string {
  return svg
    .replace(SCRIPT_BLOCK_RE, '')
    .replace(SCRIPT_OPEN_RE, '')
    .replace(FOREIGN_OBJECT_RE, '')
    .replace(FOREIGN_OBJECT_OPEN_RE, '')
    .replace(STYLE_BLOCK_RE, '')
    .replace(EVENT_HANDLER_RE, '')
    .replace(JS_URL_ATTR_RE, '')
}

/**
 * Sanitize an SVG byte buffer and return the re-encoded clean bytes.
 *
 * Decoding policy: UTF-8, BOM-tolerant, never throws on malformed input.
 * Re-encoding policy: UTF-8 without BOM.
 *
 * Idempotent: running twice removes nothing the first pass missed. A second
 * pass IS run, because removing one wrapper can reveal a nested vector (e.g.
 * `<scr<script>ipt>` collapses on the first pass into `<script>` which the
 * second pass then removes).
 *
 * Returns empty bytes only when the input decodes to an empty / whitespace
 * string — the caller treats that as "invalid SVG" and rejects the upload.
 */
export function sanitizeSvgBytes(bytes: Uint8Array): Uint8Array {
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })
  const original = decoder.decode(bytes)
  if (original.trim().length === 0) return new Uint8Array(0)

  let cleaned = stripVectors(original)
  // Second pass catches split-tag obfuscation (`<scr<script>ipt>`).
  cleaned = stripVectors(cleaned)

  if (cleaned.trim().length === 0) return new Uint8Array(0)
  return new TextEncoder().encode(cleaned)
}
