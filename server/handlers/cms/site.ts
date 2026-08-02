/**
 * Draft-site shell read/write endpoint.
 *
 *   GET /admin/api/cms/site — load the draft site shell (gated by `site.read`).
 *                              Returns the SiteShell without pages; the client
 *                              adapter fetches pages separately via GET /pages.
 *   PUT /admin/api/cms/site — replace the draft site shell. Requires at least
 *                              one of the three site-write capabilities. A
 *                              granular diff between the existing shell and the
 *                              incoming one rejects change categories the caller
 *                              is not allowed to make.
 *
 * Pages are intentionally excluded from this endpoint. They are managed by
 * the `/admin/api/cms/pages` endpoint so they can be reconciled atomically
 * without the shell round-trip.
 */
import { requireAnyCapability, requireCapability } from '../../auth/authz'
import type { CoreCapability } from '../../auth/capabilities'
import { getDraftSite, saveDraftSite } from '../../repositories/site'
import { validateSite, SiteValidationError } from '@core/persistence/validate'
import {
  ForbiddenSiteChangeError,
  validateSiteWriteDiff,
} from './siteDiff'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import { Type } from '@core/utils/typeboxHelpers'

/**
 * Any-of gate for the draft-site save endpoint: holding at least one of these
 * lets the caller PUT the shell. The granular diff in `validateSiteWriteDiff`
 * then enforces which change categories the caller is actually allowed to make.
 */
const SITE_WRITE_CAPABILITIES = [
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
] satisfies CoreCapability[]

export async function handleSiteRoutes(req: Request): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== '/admin/api/cms/site') return null

  const user = req.method === 'GET'
    ? await requireCapability(req, 'site.read')
    : await requireAnyCapability(req, SITE_WRITE_CAPABILITIES)
  if (user instanceof Response) return user

  if (req.method === 'GET') {
    const shell = await getDraftSite()
    if (!shell) return jsonResponse({ error: 'draft site not found' }, { status: 404 })
    return jsonResponse({ site: shell })
  }

  if (req.method === 'PUT') {
    const SiteBodySchema = Type.Object({ site: Type.Unknown() })
    const body = await readValidatedBody(req, SiteBodySchema)
    if (!body) return badRequest('Invalid request body')
    try {
      const nextShell = validateSite(body.site)
      // Granular diff gate: walk the changes between the saved draft shell and
      // the incoming one, and reject if any change category isn't covered by
      // the caller's capabilities.
      const previousShell = await getDraftSite()
      try {
        validateSiteWriteDiff(previousShell, nextShell, user.capabilities)
      } catch (err) {
        if (err instanceof ForbiddenSiteChangeError) {
          return jsonResponse(
            { error: err.message, kind: err.kind, path: err.path },
            { status: 403 },
          )
        }
        throw err
      }
      await saveDraftSite(nextShell, user.id)
      return jsonResponse({ ok: true })
    } catch (err) {
      if (err instanceof SiteValidationError) return badRequest(err.message)
      throw err
    }
  }

  return methodNotAllowed()
}
