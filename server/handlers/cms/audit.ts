/**
 * Audit log read endpoint (gated by `audit.read`).
 *
 *   GET /admin/api/cms/audit — list every audit event in reverse-chronological
 *                              order. The repository handles the actual ordering
 *                              and the (currently unbounded) result limit.
 */
import { requireCapability } from '../../auth/authz'
import { listAuditEvents } from '../../repositories/audit'
import { jsonResponse, methodNotAllowed } from '../../http'
import { CMS_API_PREFIX } from './shared'

export async function handleAuditRoutes(req: Request): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/audit`) return null

  const actor = await requireCapability(req, 'audit.read')
  if (actor instanceof Response) return actor
  if (req.method !== 'GET') return methodNotAllowed()
  return jsonResponse({ events: await listAuditEvents() })
}
