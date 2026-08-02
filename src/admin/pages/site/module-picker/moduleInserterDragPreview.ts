import type { CSSProperties } from 'react'
import type { CanvasInsertionTarget } from '@site/canvas/canvasDnd'
import type { ModuleInserterItem } from './moduleInserterModel'

export interface CanvasDropPreview {
  left: number
  top: number
  width: number
  height: number
  position: CanvasInsertionTarget['position'] | 'inside'
  label: string
}

export interface DragVisualState {
  item: ModuleInserterItem
  x: number
  y: number
  preview: CanvasDropPreview | null
}

export function fixedPreviewForTarget(
  viewport: HTMLElement,
  target: CanvasInsertionTarget,
  label: string,
): CanvasDropPreview {
  const viewportRect = viewport.getBoundingClientRect()
  const scale = viewport.offsetWidth > 0 ? viewportRect.width / viewport.offsetWidth : 1
  return {
    left: viewportRect.left + target.rect.left * scale,
    top: viewportRect.top + target.rect.top * scale,
    width: target.rect.width * scale,
    height: target.rect.height * scale,
    position: target.position,
    label,
  }
}

export function fixedPreviewForViewport(
  viewport: HTMLElement,
  position: CanvasDropPreview['position'],
  label: string,
): CanvasDropPreview {
  const viewportRect = viewport.getBoundingClientRect()
  return {
    left: viewportRect.left,
    top: viewportRect.top,
    width: viewportRect.width,
    height: viewportRect.height,
    position,
    label,
  }
}

export function dropPreviewStyle(preview: CanvasDropPreview): CSSProperties {
  return {
    '--drop-left': `${preview.left}px`,
    '--drop-top': `${preview.top}px`,
    '--drop-width': `${preview.width}px`,
    '--drop-height': `${preview.height}px`,
  } as CSSProperties
}

export function ghostStyle(drag: DragVisualState): CSSProperties {
  return {
    '--ghost-x': `${drag.x}px`,
    '--ghost-y': `${drag.y}px`,
  } as CSSProperties
}
