/**
 * Architecture gate: plugin content handlers must reach the page-tree
 * mutation engine through the canonical `applyTreeOperation` barrel export,
 * NOT by deep-importing `mutations.ts` directly.
 *
 * The visual editor reaches the 11 named mutations via `mutateActiveTree`;
 * plugins reach them via `applyTreeOperation`. Both go through the same
 * dispatcher so plugin code rides the same gates the editor does (locked
 * nodes, container-only invariants, breakpoint-override rules).
 *
 * Mirrors the spirit of `no-vc-mode-branches-in-mutations.test.ts`.
 */

import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), 'utf-8')
}

describe('plugin content tree handler — via engine', () => {
  it('handlers/content.ts imports applyTreeOperation from the @core/page-tree barrel', async () => {
    const source = await read('server/plugins/host/handlers/content.ts')
    expect(source).toMatch(/from '@core\/page-tree'/)
    expect(source).toContain('applyTreeOperation')
  })

  it('handlers/content.ts does NOT import from mutations.ts directly', async () => {
    const source = await read('server/plugins/host/handlers/content.ts')
    expect(source).not.toMatch(/from '@core\/page-tree\/mutations'/)
    expect(source).not.toMatch(/from ['"][^'"]*page-tree\/mutations['"]/)
  })

  it('handleContentTreeMutate dispatches each op through applyTreeOperation', async () => {
    const source = await read('server/plugins/host/handlers/content.ts')
    // The handler runs operations through `applyTreeOperation(tree, op)` —
    // grep for the call site so future refactors that bypass the engine
    // (e.g. switch back to a per-op `kind` switch inline) fail this gate.
    expect(source).toContain('applyTreeOperation(tree')
  })
})
