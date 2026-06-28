/**
 * CRUD for data tables.
 *
 *   listDataTables       — read every non-deleted table. System tables sort
 *                          first in a fixed order (pages, posts, components,
 *                          layouts); custom tables follow, ordered by created_at.
 *   listDataTablesWithCounts — as above, each enriched with its live row count.
 *   getDataTable         — read a single table by id (or null)
 *   getDataTableBySlug   — read a single table by slug (indexed; or null)
 *   createDataTable      — insert a new table
 *   updateDataTable      — partial update (all fields optional)
 *   softDeleteDataTable      — set deleted_at; refuses if rows exist or if the
 *                             table is a system table
 *   insertDataTableIfAbsent  — insert only if id absent; used by merge-add / merge-overwrite
 *
 * Convex port: this file is now a thin adapter over `convex/dataTables.ts`
 * (docs/CONVEX-MIGRATION.md §2). The exported signatures are frozen — the
 * leading SQL `DbClient` handle is retained (named `_db`, intentionally unused)
 * so handlers keep calling these unchanged while the rest of the runtime is
 * still on the SQL path; it is dropped wholesale when `server/db/*` is retired
 * (§7).
 *
 * What stays here, on the Bun side: `mapTable` — the single mapper from the
 * Convex wire row to the camelCase `DataTable`. It applies the `@core`
 * normalisers (`normalizeRouteBase`, `normalizeDataTableFields`) which we keep
 * out of the Convex V8 runtime (§4.2). The Convex functions own id/timestamp
 * generation, slug-uniqueness enforcement, the row-count subselect, and the
 * collapsed soft-delete guards.
 *
 * @see convex/dataTables.ts — the Convex query/mutation functions
 */
import { normalizeRouteBase } from '@core/templates/templateMatching'
import { normalizeDataTableFields } from '@core/data/fields'
import type {
  DataField,
  DataTable,
  DataTableKind,
  DataTableListItem,
} from '@core/data/schemas'
import { isoDate } from '@core/utils/isoDate'
import type { DbClient } from '../../db/client'
import { api, getConvex } from '../../convex/client'

interface CreateDataTableInput {
  id?: string
  name: string
  slug: string
  kind?: DataTableKind
  routeBase?: string
  singularLabel: string
  pluralLabel: string
  primaryFieldId?: string
  fields?: DataField[]
  createdByUserId?: string | null
  updatedByUserId?: string | null
}

interface UpdateDataTableInput {
  name?: string
  slug?: string
  routeBase?: string
  singularLabel?: string
  pluralLabel?: string
  primaryFieldId?: string
  fields?: DataField[]
  updatedByUserId?: string | null
}

/**
 * The raw wire row as it arrives from `convex/dataTables.ts`: `fields_json` is
 * the opaque JSON blob (parsed below), `system` is a concrete boolean, dates are
 * ISO strings. `listDataTablesWithCounts` additionally carries `row_count`, but
 * `mapTable` ignores it (structurally compatible — extra fields are fine).
 */
interface DataTableWireRow {
  id: string
  name: string
  slug: string
  kind: DataTableKind
  route_base: string
  singular_label: string
  plural_label: string
  primary_field_id: string
  fields_json: string
  system: boolean
  created_by_user_id: string | null
  updated_by_user_id: string | null
  created_at: string
  updated_at: string
}

/** Parse the opaque `fields_json` blob; corrupt persisted JSON falls back to []. */
function parseFieldsJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (_err) {
    // Soft fallback for corrupted persisted fields_json — normalizeDataTableFields
    // then yields [] (CLAUDE.md: persisted-data parse failures degrade softly).
    return []
  }
}

function mapTable(row: DataTableWireRow): DataTable {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    routeBase: row.route_base ? normalizeRouteBase(row.route_base) : normalizeRouteBase(row.slug),
    singularLabel: row.singular_label,
    pluralLabel: row.plural_label,
    primaryFieldId: row.primary_field_id,
    fields: normalizeDataTableFields(parseFieldsJson(row.fields_json)),
    system: Boolean(row.system),
    createdByUserId: row.created_by_user_id ?? null,
    updatedByUserId: row.updated_by_user_id ?? null,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  }
}

export async function listDataTables(_db: DbClient): Promise<DataTable[]> {
  const rows = await getConvex().query(api.dataTables.list, {})
  return rows.map(mapTable)
}

/**
 * Like `listDataTables` but enriches each table with the current non-deleted
 * row count, computed inside the Convex query (one `by_table_updated` scan per
 * table — fine given the tiny number of tables).
 */
export async function listDataTablesWithCounts(_db: DbClient): Promise<DataTableListItem[]> {
  const rows = await getConvex().query(api.dataTables.listWithCounts, {})
  return rows.map((row) => ({ ...mapTable(row), rowCount: row.row_count }))
}

export async function getDataTable(_db: DbClient, tableId: string): Promise<DataTable | null> {
  const row = await getConvex().query(api.dataTables.get, { tableId })
  return row ? mapTable(row) : null
}

/**
 * Read a single non-deleted table by slug. One indexed lookup (`by_slug`) — so
 * per-call code paths (every `cms.content.*` plugin api-call resolves its table
 * this way) never scan and re-parse the whole table list.
 */
export async function getDataTableBySlug(_db: DbClient, slug: string): Promise<DataTable | null> {
  const row = await getConvex().query(api.dataTables.getBySlug, { slug })
  return row ? mapTable(row) : null
}

export async function createDataTable(
  _db: DbClient,
  input: CreateDataTableInput,
): Promise<DataTable> {
  // NOTE: table creation is pure data access. Entry templates are ordinary
  // page rows and are created explicitly through the site editor.
  const row = await getConvex().mutation(api.dataTables.create, {
    id: input.id,
    name: input.name,
    slug: input.slug,
    kind: input.kind ?? 'data',
    routeBase: normalizeRouteBase(input.routeBase ?? input.slug),
    singularLabel: input.singularLabel,
    pluralLabel: input.pluralLabel,
    primaryFieldId: input.primaryFieldId ?? 'title',
    fieldsJson: JSON.stringify(normalizeDataTableFields(input.fields ?? [])),
    createdByUserId: input.createdByUserId ?? null,
    updatedByUserId: input.updatedByUserId ?? input.createdByUserId ?? null,
  })
  return mapTable(row)
}

export async function updateDataTable(
  _db: DbClient,
  tableId: string,
  input: UpdateDataTableInput,
): Promise<DataTable | null> {
  const row = await getConvex().mutation(api.dataTables.update, {
    tableId,
    name: input.name,
    slug: input.slug,
    routeBase: input.routeBase === undefined ? undefined : normalizeRouteBase(input.routeBase),
    singularLabel: input.singularLabel,
    pluralLabel: input.pluralLabel,
    primaryFieldId: input.primaryFieldId,
    fieldsJson:
      input.fields === undefined
        ? undefined
        : JSON.stringify(normalizeDataTableFields(input.fields)),
    // `null` / absent means "keep existing" (the old `coalesce(? ?? null, col)`),
    // so only a concrete string is sent through.
    updatedByUserId: input.updatedByUserId == null ? undefined : input.updatedByUserId,
  })
  return row ? mapTable(row) : null
}

/**
 * Insert a table only if its id does not already exist. Returns `true` when
 * the table was inserted, `false` when it was skipped (id conflict). Used by
 * the `merge-add` and `merge-overwrite` import strategies.
 */
export async function insertDataTableIfAbsent(
  _db: DbClient,
  input: CreateDataTableInput,
): Promise<boolean> {
  return getConvex().mutation(api.dataTables.insertIfAbsent, {
    id: input.id,
    name: input.name,
    slug: input.slug,
    kind: input.kind ?? 'data',
    routeBase: normalizeRouteBase(input.routeBase ?? input.slug),
    singularLabel: input.singularLabel,
    pluralLabel: input.pluralLabel,
    primaryFieldId: input.primaryFieldId ?? 'title',
    fieldsJson: JSON.stringify(normalizeDataTableFields(input.fields ?? [])),
    createdByUserId: input.createdByUserId ?? null,
    updatedByUserId: input.updatedByUserId ?? input.createdByUserId ?? null,
  })
}

/**
 * Refuses to delete system tables or any table that still has non-deleted
 * rows. Both guards live in the Convex mutation so other callers (CLI tools,
 * future migrations) inherit the safety check, and so the row-count check and
 * the delete are one atomic step.
 *
 * System status is determined by `table.system === true` (the `system` column,
 * `not null default false`).
 */
export async function softDeleteDataTable(
  _db: DbClient,
  tableId: string,
  actorUserId: string | null = null,
): Promise<DataTable | null> {
  const row = await getConvex().mutation(api.dataTables.softDelete, { tableId, actorUserId })
  return row ? mapTable(row) : null
}
