import type { SiteExplorerSectionId } from '@core/page-tree'
import type {
  SiteExplorerStructuralSectionModel,
  SiteExplorerTreeSectionModel,
} from './siteExplorerModel'

export type SiteExplorerContextTarget =
  | { kind: 'page'; id: string; title: string; slug: string }
  | { kind: 'component'; id: string; name: string }
  | { kind: 'file'; id: string; path: string }
  | { kind: 'folder'; sectionId: SiteExplorerSectionId; id: string; name: string }

export type SiteExplorerAnySectionModel =
  | SiteExplorerTreeSectionModel<SiteExplorerContextTarget>
  | SiteExplorerStructuralSectionModel<SiteExplorerContextTarget>
