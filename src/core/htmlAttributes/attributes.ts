const HTML_ATTRIBUTE_NAME_RE = /^[a-z][a-z0-9_.:-]*$/i
const RESERVED_DATA_PREFIX_RE = /^data-(instatic|canvas)-/i
const RESERVED_DATA_NAMES = new Set([
  'data-node-id',
  'data-module-id',
  'data-hovered',
])
const RESERVED_HTML_ATTRIBUTE_NAMES = new Set(['class', 'style'])

export function normalizeHtmlAttributeName(name: string): string {
  return name.trim().toLowerCase()
}

export function isReservedRuntimeDataAttributeName(name: string): boolean {
  const normalised = normalizeHtmlAttributeName(name)
  return RESERVED_DATA_PREFIX_RE.test(normalised) || RESERVED_DATA_NAMES.has(normalised)
}

export function isEventHandlerAttributeName(name: string): boolean {
  return /^on[a-z]/i.test(normalizeHtmlAttributeName(name))
}

export function isRenderableHtmlAttributeName(name: string): boolean {
  const normalised = normalizeHtmlAttributeName(name)
  return (
    HTML_ATTRIBUTE_NAME_RE.test(normalised) &&
    !RESERVED_HTML_ATTRIBUTE_NAMES.has(normalised) &&
    !isEventHandlerAttributeName(normalised) &&
    !isReservedRuntimeDataAttributeName(normalised)
  )
}
