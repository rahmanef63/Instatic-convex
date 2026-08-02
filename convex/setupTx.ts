/**
 * First-run setup bootstrap — Convex functions.
 *
 * The cross-domain `setup.ts` handler transaction (docs/CONVEX-MIGRATION.md §3
 * #2) collapses into the single atomic `bootstrapInstall` mutation here: it
 * creates the singleton site row, the first owner user, the `user.create`
 * audit event, and the seed homepage `data_row` — every `ctx.db` write inline,
 * so a crash mid-bootstrap rolls the whole thing back (no half-provisioned
 * install). The handler does all HTTP validation + password hashing Bun-side
 * and passes the prepared records (owner `password_hash`, generated nanoid ids)
 * in; crypto never touches the Convex V8 runtime (§5).
 *
 * `publicSiteRow` is the unauthenticated site-identity read the login / setup
 * screen renders its brand from — the Convex replacement for the handler's old
 * raw `select … from site` (the parse/validation of `settings_json` stays
 * Bun-side in the handler).
 *
 * Conventions (docs/CONVEX-MIGRATION.md §2, §4, §6):
 * - The site row is the `id = 'default'` singleton; the upsert is a read-by
 *   `by_app_id` → patch-or-insert (mirrors `convex/setup.ts createSite`).
 * - App identity is the nanoid `id` (owner + homepage ids generated Bun-side
 *   and passed in; the audit-event id is minted here). `created_at` /
 *   `updated_at` replace SQL column defaults and are stamped here.
 * - `*_json` blobs are opaque `v.string()` at rest — `settings`, the audit
 *   `metadata`, and the homepage `cells` are `JSON.stringify`d on write.
 * - The partial-unique `users_email_normalized_active_idx WHERE deleted_at IS
 *   NULL` has no Convex equivalent (§4.6): an explicit pre-write read of the
 *   `by_email_normalized` index enforces it inside the mutation.
 * - Both functions declare `args` AND `returns` validators.
 *
 * @see server/handlers/cms/setup.ts — the handler that prepares + calls these
 */

import { v } from 'convex/values'
import { nanoid } from 'nanoid'
import { mutation, query } from './_generated/server'

const statusValidator = v.union(v.literal('active'), v.literal('suspended'))

/** The raw `site` projection the public-identity read returns (parsed Bun-side). */
const publicSiteRowValidator = v.union(
  v.null(),
  v.object({
    id: v.string(),
    name: v.string(),
    settings_json: v.string(),
    created_at: v.string(),
    updated_at: v.string(),
  }),
)

/**
 * The singleton `site` row (app id `'default'`), or `null`. Replaces the
 * handler's raw `select id, name, settings_json, created_at, updated_at from
 * site where id = 'default'`. The favicon/name parsing of `settings_json`
 * stays in the handler (`loadPublicSiteIdentity`).
 */
export const publicSiteRow = query({
  args: {},
  returns: publicSiteRowValidator,
  handler: async (ctx) => {
    const site = await ctx.db
      .query('site')
      .withIndex('by_app_id', (q) => q.eq('id', 'default'))
      .unique()
    if (!site) return null
    return {
      id: site.id,
      name: site.name,
      settings_json: site.settings_json,
      created_at: site.created_at,
      updated_at: site.updated_at,
    }
  },
})

/**
 * Bootstrap a fresh install in ONE atomic mutation: upsert the site row, create
 * the owner user, log the `user.create` audit event, and seed the homepage row.
 *
 * The handler has already verified `needsSetup` and validated the body; it
 * passes the owner's `password_hash` (hashed Bun-side) and the pre-generated
 * owner / homepage ids so the audit `target_id` and the homepage author can
 * reference the owner id consistently.
 */
export const bootstrapInstall = mutation({
  args: {
    siteName: v.string(),
    siteSettings: v.any(),
    owner: v.object({
      id: v.string(),
      email: v.string(),
      emailNormalized: v.string(),
      displayName: v.string(),
      passwordHash: v.string(),
      roleId: v.string(),
      status: statusValidator,
    }),
    audit: v.object({
      action: v.string(),
      targetType: v.union(v.null(), v.string()),
      metadata: v.any(),
      ipAddress: v.union(v.null(), v.string()),
      userAgent: v.union(v.null(), v.string()),
    }),
    homePage: v.object({
      id: v.string(),
      cells: v.any(),
      slug: v.string(),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = new Date().toISOString()

    // 1. Upsert the singleton site row (mirror of convex/setup.ts createSite).
    const existingSite = await ctx.db
      .query('site')
      .withIndex('by_app_id', (q) => q.eq('id', 'default'))
      .unique()
    const settingsJson = JSON.stringify(args.siteSettings)
    if (existingSite) {
      await ctx.db.patch(existingSite._id, {
        name: args.siteName,
        settings_json: settingsJson,
        updated_at: now,
      })
    } else {
      await ctx.db.insert('site', {
        id: 'default',
        name: args.siteName,
        settings_json: settingsJson,
        created_at: now,
        updated_at: now,
      })
    }

    // 2. Create the owner user (mirror of convex/users.ts create, incl. the
    //    active-email uniqueness guard that replaces the partial-unique index).
    const dup = await ctx.db
      .query('users')
      .withIndex('by_email_normalized', (q) =>
        q.eq('email_normalized', args.owner.emailNormalized),
      )
      .collect()
    if (dup.some((u) => u.deleted_at === null)) {
      throw new Error('A user with this email already exists')
    }
    await ctx.db.insert('users', {
      id: args.owner.id,
      email: args.owner.email,
      email_normalized: args.owner.emailNormalized,
      display_name: args.owner.displayName,
      password_hash: args.owner.passwordHash,
      status: args.owner.status,
      role_id: args.owner.roleId,
      last_login_at: null,
      failed_login_count: 0,
      locked_until: null,
      password_updated_at: null,
      mfa_enabled: false,
      mfa_enabled_at: null,
      mfa_totp_secret_ciphertext: null,
      mfa_totp_secret_iv: null,
      mfa_totp_secret_key_fingerprint: null,
      mfa_recovery_code_hashes_json: '[]',
      created_at: now,
      updated_at: now,
      deleted_at: null,
      avatar_media_id: null,
      step_up_auth_mode: 'required',
      step_up_window_minutes: 15,
    })

    // 3. Audit event (mirror of server/repositories/audit.ts createAuditEvent).
    await ctx.db.insert('audit_events', {
      id: nanoid(),
      actor_user_id: null,
      action: args.audit.action,
      target_type: args.audit.targetType,
      target_id: args.owner.id,
      metadata_json: JSON.stringify(args.audit.metadata ?? {}),
      ip_address: args.audit.ipAddress,
      user_agent: args.audit.userAgent,
      created_at: now,
    })

    // 4. Seed the starter homepage as a `pages` data row (mirror of
    //    convex/dataRows.ts create; the owner is the author/creator/updater).
    await ctx.db.insert('data_rows', {
      id: args.homePage.id,
      table_id: 'pages',
      cells_json: JSON.stringify(args.homePage.cells),
      slug: args.homePage.slug,
      status: 'draft',
      active_version_id: null,
      author_user_id: args.owner.id,
      created_by_user_id: args.owner.id,
      updated_by_user_id: args.owner.id,
      published_by_user_id: null,
      created_at: now,
      updated_at: now,
      published_at: null,
      scheduled_publish_at: null,
      deleted_at: null,
      plugin_actor_id: null,
    })

    return null
  },
})
