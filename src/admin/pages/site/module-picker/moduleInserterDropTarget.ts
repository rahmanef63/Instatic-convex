const CANVAS_VIEWPORT_SELECTOR = '[data-breakpoint-id]'

export function findCanvasViewportAtPoint(
  clientX: number,
  clientY: number,
): HTMLElement | null {
  const viewports = document.querySelectorAll<HTMLElement>(CANVAS_VIEWPORT_SELECTOR)
  for (const viewport of viewports) {
    const rect = viewport.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      return viewport
    }
  }
  return null
}
