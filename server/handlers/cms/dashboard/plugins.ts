/**
 * Plugins widget reader — aggregate health counts (active / disabled /
 * errored) plus the 8 most-recently-installed rows with their resolved
 * icon URLs.
 */
import { listInstalledPlugins } from '../../../repositories/plugins'
import type { PluginsStats, PluginsStatsRow } from './types'

const ROW_LIMIT = 8

/**
 * Aggregated plugin stats for the Plugins dashboard widget.
 *
 *   • total       — every installed plugin row
 *   • active      — rows with enabled=true AND lifecycle_status='active'
 *   • disabled    — rows with enabled=false OR lifecycle_status='disabled'
 *   • errored     — rows with lifecycle_status='error' (problem state),
 *                   plus rows whose manifest failed to parse (broken).
 *   • rows        — up to 8 most-recently-installed plugins (id/name/
 *                   version/state/icon) for the widget's body list
 *
 * `state` collapses `enabled` × `lifecycle_status` into a single value
 * the widget can dot-color directly. `'installed'` lifecycle rows show
 * as `'disabled'` for the widget (not yet activated). The repository
 * returns plugins newest-installed first.
 */
export async function readPluginsStats(): Promise<PluginsStats> {
  const installed = await listInstalledPlugins()

  let active = 0
  let disabled = 0
  let errored = 0
  const out: PluginsStatsRow[] = []

  for (const result of installed) {
    let row: PluginsStatsRow
    if (result.kind === 'broken') {
      row = { id: result.id, name: result.name, version: result.version, state: 'error', iconUrl: null }
    } else {
      const p = result.plugin
      row = {
        id: p.id,
        name: p.name,
        version: p.version,
        state: computeRowState(p.enabled, p.lifecycleStatus),
        iconUrl: resolveManifestIconUrl(p.manifest),
      }
    }

    if (row.state === 'active') active += 1
    else if (row.state === 'error') errored += 1
    else disabled += 1

    // Cap the per-row payload at the 8 most recent; the counts above
    // include every plugin so the widget can show "12 plugins · 3
    // disabled" alongside the truncated list.
    if (out.length < ROW_LIMIT) out.push(row)
  }

  return {
    total: installed.length,
    active,
    disabled,
    errored,
    rows: out,
  }
}

/**
 * Collapse `enabled` × `lifecycleStatus` into the single state value
 * the widget renders as a dot color.
 */
function computeRowState(
  enabled: boolean,
  lifecycle: string,
): PluginsStatsRow['state'] {
  if (lifecycle === 'error') return 'error'
  if (enabled && lifecycle === 'active') return 'active'
  return 'disabled'
}

/**
 * Resolve the public URL of a plugin's manifest-declared icon
 * (`manifest.icon`) against its `manifest.assetBasePath`. The same
 * resolution rule the Plugins admin card uses — keep them in lockstep
 * so the dashboard widget shows the same glyph the operator picked.
 *
 * Returns `null` when:
 *   - the manifest has no `icon` field, or
 *   - the manifest has no `assetBasePath` (broken / dev plugin), or
 *   - the column value is not a parseable JSON object.
 *
 * The SQLite adapter auto-parses `*_json` strings on read, so the
 * value normally arrives as an object on both dialects. The defensive
 * `JSON.parse` covers the edge case of a corrupted row that the
 * SQLite adapter handed back as the raw string.
 */
function resolveManifestIconUrl(manifestJson: unknown): string | null {
  let manifest: unknown = manifestJson
  if (typeof manifest === 'string') {
    try {
      manifest = JSON.parse(manifest)
    } catch {
      return null
    }
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null
  const m = manifest as Record<string, unknown>
  const icon = typeof m.icon === 'string' && m.icon.trim() ? m.icon.trim() : null
  const assetBasePath =
    typeof m.assetBasePath === 'string' && m.assetBasePath.trim() ? m.assetBasePath : null
  if (!icon || !assetBasePath) return null
  return `${assetBasePath.replace(/\/+$/, '')}/${icon.replace(/^\/+/, '')}`
}
