import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// Instatic CMS — Convex schema migrated from the SQLite/Postgres repositories.
//
// Conventions:
// - Every row uses an APP-GENERATED string id (nanoid). We keep the original
//   primary-key column as an explicit `v.string()` field and index it with
//   `by_<col>`. We never use Convex's built-in `_id` for app identity, and we
//   never use `v.id(...)` for foreign keys (those point at app string ids, not
//   Convex document ids).
// - `*_json` columns stay raw JSON text (`v.string()`); the application parses
//   them. (SQLite stored these as TEXT.)
// - SQLite blob columns (ciphertext / iv) are base64-encoded strings here,
//   except `published_runtime_assets.content_bytes` which is true binary
//   (`v.bytes()`) per its spec.
// - SQL CHECK enums become `v.union(v.literal(...))`.
// - SQL partial / conditional unique indexes cannot be expressed in Convex;
//   the equivalent plain index is created and uniqueness is enforced in app code.

export default defineSchema({
  // ---------------------------------------------------------------------------
  // Identity domain
  // ---------------------------------------------------------------------------
  roles: defineTable({
    id: v.string(),
    slug: v.string(),
    name: v.string(),
    description: v.string(),
    is_system: v.boolean(),
    capabilities_json: v.string(),
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index('by_app_id', ['id'])
    .index('by_slug', ['slug']),

  users: defineTable({
    id: v.string(),
    email: v.string(),
    email_normalized: v.string(),
    display_name: v.string(),
    password_hash: v.string(),
    status: v.union(v.literal('active'), v.literal('suspended')),
    role_id: v.string(),
    last_login_at: v.union(v.null(), v.string()),
    failed_login_count: v.number(),
    locked_until: v.union(v.null(), v.string()),
    password_updated_at: v.union(v.null(), v.string()),
    mfa_enabled: v.boolean(),
    mfa_enabled_at: v.union(v.null(), v.string()),
    mfa_totp_secret_ciphertext: v.union(v.null(), v.string()),
    mfa_totp_secret_iv: v.union(v.null(), v.string()),
    mfa_totp_secret_key_fingerprint: v.union(v.null(), v.string()),
    mfa_recovery_code_hashes_json: v.string(),
    created_at: v.string(),
    updated_at: v.string(),
    deleted_at: v.union(v.null(), v.string()),
    avatar_media_id: v.union(v.null(), v.string()),
    step_up_auth_mode: v.union(v.literal('required'), v.literal('disabled')),
    step_up_window_minutes: v.union(
      v.literal(5),
      v.literal(15),
      v.literal(30),
      v.literal(60),
    ),
  })
    .index('by_app_id', ['id'])
    .index('by_email_normalized', ['email_normalized'])
    .index('by_role_id', ['role_id']),

  sessions: defineTable({
    id_hash: v.string(),
    user_id: v.string(),
    created_at: v.string(),
    last_seen_at: v.string(),
    expires_at: v.string(),
    revoked_at: v.union(v.null(), v.string()),
    ip_address: v.union(v.null(), v.string()),
    user_agent: v.union(v.null(), v.string()),
    device_label: v.string(),
    mfa_passed_at: v.union(v.null(), v.string()),
    step_up_expires_at: v.union(v.null(), v.string()),
  })
    .index('by_id_hash', ['id_hash'])
    .index('by_user_last_seen', ['user_id', 'last_seen_at'])
    .index('by_user_expires', ['user_id', 'expires_at']),

  user_preferences: defineTable({
    user_id: v.string(),
    key: v.string(),
    value_json: v.string(),
    updated_at: v.string(),
  })
    .index('by_user_key', ['user_id', 'key'])
    .index('by_user', ['user_id']),

  login_attempts: defineTable({
    id: v.string(),
    attempted_at: v.string(),
    email_norm: v.union(v.null(), v.string()),
    ip_address: v.union(v.null(), v.string()),
    user_agent: v.union(v.null(), v.string()),
    user_id: v.union(v.null(), v.string()),
    result: v.union(
      v.literal('success'),
      v.literal('bad_password'),
      v.literal('no_user'),
      v.literal('account_disabled'),
      v.literal('locked'),
      v.literal('rate_limited'),
      v.literal('mfa_failed'),
    ),
  })
    .index('by_app_id', ['id'])
    .index('by_ip_attempted', ['ip_address', 'attempted_at'])
    .index('by_email_attempted', ['email_norm', 'attempted_at'])
    .index('by_user_attempted', ['user_id', 'attempted_at']),

  // ---------------------------------------------------------------------------
  // Site / audit domain
  // ---------------------------------------------------------------------------
  site: defineTable({
    id: v.string(),
    name: v.string(),
    settings_json: v.string(),
    created_at: v.string(),
    updated_at: v.string(),
  }).index('by_app_id', ['id']),

  site_snapshots: defineTable({
    id: v.string(),
    site_json: v.string(),
    content_hash: v.string(),
    importmap_body: v.union(v.null(), v.string()),
    importmap_sha256: v.union(v.null(), v.string()),
    created_at: v.string(),
  })
    .index('by_app_id', ['id'])
    .index('by_content_hash', ['content_hash']),

  audit_events: defineTable({
    id: v.string(),
    actor_user_id: v.union(v.null(), v.string()),
    action: v.string(),
    target_type: v.union(v.null(), v.string()),
    target_id: v.union(v.null(), v.string()),
    metadata_json: v.string(),
    ip_address: v.union(v.null(), v.string()),
    user_agent: v.union(v.null(), v.string()),
    created_at: v.string(),
  })
    .index('by_app_id', ['id'])
    .index('by_created', ['created_at']),

  // ---------------------------------------------------------------------------
  // Data tables / rows domain
  // ---------------------------------------------------------------------------
  data_tables: defineTable({
    id: v.string(),
    name: v.string(),
    slug: v.string(),
    kind: v.union(
      v.literal('postType'),
      v.literal('data'),
      v.literal('page'),
      v.literal('component'),
      v.literal('layout'),
    ),
    route_base: v.string(),
    singular_label: v.string(),
    plural_label: v.string(),
    primary_field_id: v.string(),
    fields_json: v.string(),
    system: v.boolean(),
    created_by_user_id: v.union(v.string(), v.null()),
    updated_by_user_id: v.union(v.string(), v.null()),
    created_at: v.string(),
    updated_at: v.string(),
    deleted_at: v.union(v.string(), v.null()),
  })
    .index('by_app_id', ['id'])
    .index('by_slug', ['slug']),

  data_rows: defineTable({
    id: v.string(),
    table_id: v.string(),
    cells_json: v.string(),
    slug: v.string(),
    status: v.union(
      v.literal('draft'),
      v.literal('published'),
      v.literal('unpublished'),
      v.literal('scheduled'),
    ),
    active_version_id: v.union(v.null(), v.string()),
    author_user_id: v.union(v.null(), v.string()),
    created_by_user_id: v.union(v.null(), v.string()),
    updated_by_user_id: v.union(v.null(), v.string()),
    published_by_user_id: v.union(v.null(), v.string()),
    created_at: v.string(),
    updated_at: v.string(),
    published_at: v.union(v.null(), v.string()),
    scheduled_publish_at: v.union(v.null(), v.string()),
    deleted_at: v.union(v.null(), v.string()),
    plugin_actor_id: v.union(v.null(), v.string()),
  })
    .index('by_app_id', ['id'])
    .index('by_table_slug', ['table_id', 'slug'])
    .index('by_table_updated', ['table_id', 'updated_at'])
    .index('by_table_status_updated', ['table_id', 'status', 'updated_at'])
    .index('by_table_author_updated', ['table_id', 'author_user_id', 'updated_at'])
    .index('by_scheduled_publish', ['scheduled_publish_at'])
    .index('by_active_version', ['active_version_id']),

  data_row_versions: defineTable({
    id: v.string(),
    row_id: v.string(),
    version_number: v.number(),
    cells_json: v.string(),
    slug: v.string(),
    published_by_user_id: v.union(v.null(), v.string()),
    published_at: v.string(),
    created_at: v.string(),
    site_snapshot_id: v.union(v.null(), v.string()),
    runtime_assets_json: v.union(v.null(), v.string()),
  })
    .index('by_app_id', ['id'])
    .index('by_row_version', ['row_id', 'version_number'])
    .index('by_slug', ['slug']),

  data_row_redirects: defineTable({
    id: v.string(),
    table_id: v.string(),
    from_route_base: v.string(),
    from_slug: v.string(),
    target_row_id: v.string(),
    created_at: v.string(),
  })
    .index('by_app_id', ['id'])
    .index('by_source', ['from_route_base', 'from_slug'])
    .index('by_target', ['target_row_id', 'created_at'])
    .index('by_table', ['table_id']),

  // ---------------------------------------------------------------------------
  // Media domain
  // (FK columns kept as v.string() — they reference app nanoid ids, not _id.)
  // ---------------------------------------------------------------------------
  media_assets: defineTable({
    id: v.string(),
    filename: v.string(),
    mime_type: v.string(),
    size_bytes: v.number(),
    storage_path: v.string(),
    public_path: v.string(),
    uploaded_by_user_id: v.union(v.null(), v.string()),
    alt_text: v.string(),
    caption: v.string(),
    title: v.string(),
    tags_json: v.string(),
    width: v.union(v.null(), v.number()),
    height: v.union(v.null(), v.number()),
    duration_ms: v.union(v.null(), v.number()),
    dominant_color: v.union(v.null(), v.string()),
    blur_hash: v.union(v.null(), v.string()),
    variants_json: v.string(),
    poster_path: v.union(v.null(), v.string()),
    deleted_at: v.union(v.null(), v.string()),
    replaced_at: v.union(v.null(), v.string()),
    created_at: v.string(),
    storage_adapter_id: v.string(),
    externally_hosted: v.boolean(),
  })
    .index('by_app_id', ['id'])
    .index('by_deleted', ['deleted_at'])
    .index('by_public_path', ['public_path'])
    .index('by_storage_adapter', ['storage_adapter_id'])
    .index('by_uploaded_by', ['uploaded_by_user_id']),

  media_folders: defineTable({
    id: v.string(),
    parent_id: v.union(v.null(), v.string()),
    name: v.string(),
    slug: v.string(),
    sort_order: v.number(),
    created_by_user_id: v.union(v.null(), v.string()),
    created_at: v.string(),
  })
    .index('by_app_id', ['id'])
    .index('by_parent_slug', ['parent_id', 'slug'])
    .index('by_parent', ['parent_id']),

  media_asset_folders: defineTable({
    asset_id: v.string(),
    folder_id: v.string(),
  })
    .index('by_asset', ['asset_id'])
    .index('by_folder', ['folder_id'])
    .index('by_asset_folder', ['asset_id', 'folder_id']),

  media_smart_folders: defineTable({
    id: v.string(),
    name: v.string(),
    query_json: v.string(),
    created_by_user_id: v.union(v.null(), v.string()),
    created_at: v.string(),
  }).index('by_app_id', ['id']),

  media_usage_refs: defineTable({
    asset_id: v.string(),
    ref_kind: v.string(),
    ref_id: v.string(),
    ref_path: v.string(),
    computed_at: v.string(),
  })
    .index('by_asset', ['asset_id'])
    .index('by_ref', ['ref_kind', 'ref_id']),

  published_runtime_assets: defineTable({
    id: v.string(),
    data_row_version_id: v.string(),
    asset_path: v.string(),
    public_path: v.string(),
    content_type: v.string(),
    content_bytes: v.bytes(),
    created_at: v.string(),
  })
    .index('by_app_id', ['id'])
    .index('by_public_path', ['public_path'])
    .index('by_data_row_version', ['data_row_version_id']),

  active_media_storage_adapter: defineTable({
    role: v.string(),
    adapter_id: v.string(),
    elected_at: v.string(),
    elected_by_user_id: v.union(v.null(), v.string()),
  }).index('by_role', ['role']),

  active_media_variant_delegate: defineTable({
    singleton: v.literal(1),
    delegate_id: v.string(),
    variant_url_template: v.string(),
    widths_json: v.string(),
    formats_json: v.string(),
    elected_at: v.string(),
    elected_by_user_id: v.union(v.null(), v.string()),
  }).index('by_singleton', ['singleton']),

  // ---------------------------------------------------------------------------
  // Plugins domain
  // ---------------------------------------------------------------------------
  installed_plugins: defineTable({
    id: v.string(),
    name: v.string(),
    version: v.string(),
    enabled: v.boolean(),
    granted_permissions_json: v.string(),
    manifest_json: v.string(),
    lifecycle_status: v.union(
      v.literal('installed'),
      v.literal('active'),
      v.literal('disabled'),
      v.literal('error'),
    ),
    last_error: v.union(v.null(), v.string()),
    settings_json: v.string(),
    installed_at: v.string(),
    updated_at: v.string(),
  })
    .index('by_app_id', ['id'])
    .index('by_enabled_installed', ['enabled', 'installed_at']),

  plugin_records: defineTable({
    id: v.string(),
    plugin_id: v.string(),
    resource_id: v.string(),
    data_json: v.string(),
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index('by_app_id', ['id'])
    .index('by_resource', ['plugin_id', 'resource_id', 'created_at'])
    .index('by_plugin', ['plugin_id']),

  plugin_crash_events: defineTable({
    id: v.string(),
    plugin_id: v.string(),
    occurred_at: v.string(),
    reason: v.string(),
    stack: v.union(v.null(), v.string()),
  })
    .index('by_app_id', ['id'])
    .index('by_plugin_occurred', ['plugin_id', 'occurred_at']),

  plugin_schedules: defineTable({
    plugin_id: v.string(),
    schedule_id: v.string(),
    cadence_json: v.string(),
    overlap: v.union(
      v.literal('skip'),
      v.literal('queue'),
      v.literal('parallel'),
    ),
    max_duration_ms: v.number(),
    enabled: v.boolean(),
    paused: v.boolean(),
    consecutive_failures: v.number(),
    last_run_at: v.union(v.null(), v.string()),
    last_finished_at: v.union(v.null(), v.string()),
    last_status: v.union(
      v.null(),
      v.union(
        v.literal('ok'),
        v.literal('error'),
        v.literal('timeout'),
        v.literal('never_run'),
      ),
    ),
    last_error: v.union(v.null(), v.string()),
    last_duration_ms: v.union(v.null(), v.number()),
    next_run_at: v.string(),
    running_token: v.union(v.null(), v.string()),
    lock_until: v.union(v.null(), v.string()),
    claimed_at: v.union(v.null(), v.string()),
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index('by_plugin_schedule', ['plugin_id', 'schedule_id'])
    .index('by_due', ['enabled', 'paused', 'next_run_at'])
    .index('by_plugin', ['plugin_id']),

  plugin_schedule_runs: defineTable({
    id: v.string(),
    plugin_id: v.string(),
    schedule_id: v.string(),
    started_at: v.string(),
    finished_at: v.union(v.null(), v.string()),
    status: v.union(
      v.literal('ok'),
      v.literal('error'),
      v.literal('timeout'),
      v.literal('never_run'),
    ),
    error: v.union(v.null(), v.string()),
    duration_ms: v.union(v.null(), v.number()),
    triggered_by: v.union(v.literal('tick'), v.literal('run-now')),
  })
    .index('by_app_id', ['id'])
    .index('by_lookup', ['plugin_id', 'schedule_id', 'started_at'])
    .index('by_plugin', ['plugin_id']),

  plugin_secrets: defineTable({
    plugin_id: v.string(),
    setting_id: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    key_fingerprint: v.string(),
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index('by_plugin_setting', ['plugin_id', 'setting_id'])
    .index('by_plugin', ['plugin_id']),

  // ---------------------------------------------------------------------------
  // AI domain
  // ---------------------------------------------------------------------------
  ai_provider_credentials: defineTable({
    id: v.string(),
    user_id: v.string(),
    provider_id: v.string(),
    auth_mode: v.union(v.literal('apiKey'), v.literal('baseUrl')),
    display_label: v.string(),
    ciphertext: v.union(v.null(), v.string()),
    iv: v.union(v.null(), v.string()),
    base_url: v.union(v.null(), v.string()),
    key_fingerprint: v.union(v.null(), v.string()),
    created_at: v.string(),
    updated_at: v.string(),
    last_used_at: v.union(v.null(), v.string()),
  })
    .index('by_app_id', ['id'])
    .index('by_user', ['user_id'])
    .index('by_user_label', ['user_id', 'provider_id', 'display_label']),

  ai_defaults: defineTable({
    scope: v.union(
      v.literal('site'),
      v.literal('content'),
      v.literal('data'),
      v.literal('plugin'),
    ),
    credential_id: v.string(),
    model_id: v.string(),
    updated_at: v.string(),
    updated_by: v.union(v.null(), v.string()),
  })
    .index('by_scope', ['scope'])
    .index('by_credential', ['credential_id']),

  ai_conversations: defineTable({
    id: v.string(),
    user_id: v.string(),
    scope: v.union(
      v.literal('site'),
      v.literal('content'),
      v.literal('data'),
      v.literal('plugin'),
    ),
    title: v.string(),
    credential_id: v.union(v.null(), v.string()),
    model_id: v.string(),
    prompt_tokens_total: v.number(),
    completion_tokens_total: v.number(),
    cost_usd_total: v.number(),
    cache_read_tokens_total: v.number(),
    cache_creation_tokens_total: v.number(),
    context_tokens: v.number(),
    created_at: v.string(),
    updated_at: v.string(),
    deleted_at: v.union(v.null(), v.string()),
  })
    .index('by_app_id', ['id'])
    .index('by_user_scope_updated', ['user_id', 'scope', 'updated_at'])
    .index('by_deleted', ['deleted_at']),

  ai_messages: defineTable({
    id: v.string(),
    conversation_id: v.string(),
    position: v.number(),
    role: v.union(
      v.literal('user'),
      v.literal('assistant'),
      v.literal('tool'),
    ),
    content_json: v.string(),
    tool_call_id: v.union(v.null(), v.string()),
    tool_name: v.union(v.null(), v.string()),
    prompt_tokens: v.number(),
    completion_tokens: v.number(),
    cost_usd: v.number(),
    cache_read_tokens: v.number(),
    cache_creation_tokens: v.number(),
    created_at: v.string(),
  })
    .index('by_app_id', ['id'])
    .index('by_conversation_position', ['conversation_id', 'position']),

  ai_model_pricing: defineTable({
    pricing_key: v.string(),
    input_per_mtok: v.number(),
    output_per_mtok: v.number(),
    cache_read_per_mtok: v.union(v.null(), v.number()),
    cache_write_per_mtok: v.union(v.null(), v.number()),
    context_window: v.union(v.null(), v.number()),
    refreshed_at: v.string(),
  }).index('by_pricing_key', ['pricing_key']),
});
