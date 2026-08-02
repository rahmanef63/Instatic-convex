import { describe, expect, it } from 'bun:test'
import {
  buildDeleteExplorerPathPlan,
  buildMoveExplorerItemPlan,
  buildRenameExplorerFolderPlan,
  commitExplorerPathPlan,
} from '@core/page-tree'
import { DEFAULT_SCRIPT_RUNTIME_CONFIG, DEFAULT_STYLE_RUNTIME_CONFIG } from '@core/site-runtime'
import { makePage, makeSite } from '../fixtures'

describe('site explorer path plans', () => {
  it('plans exact descendant page slug rewrites for folder rename', () => {
    const site = makeSite({
      pages: [
        makePage({ id: 'home', slug: 'index', title: 'Home' }),
        makePage({ id: 'docs', slug: 'documentation', title: 'Documentation' }),
        makePage({ id: 'setup', slug: 'documentation/setup', title: 'Setup' }),
      ],
    })

    const plan = buildRenameExplorerFolderPlan(site, {
      sectionId: 'pages',
      folderPath: 'documentation',
      nextFolderPath: 'docs',
    })

    expect(plan.blockers).toEqual([])
    expect(plan.changes.map((change) => [change.id, change.from, change.to])).toEqual([
      ['docs', 'documentation', 'docs'],
      ['setup', 'documentation/setup', 'docs/setup'],
    ])
  })

  it('blocks page slug collisions instead of auto-suffixing', () => {
    const site = makeSite({
      pages: [
        makePage({ id: 'home', slug: 'index' }),
        makePage({ id: 'docs', slug: 'documentation' }),
        makePage({ id: 'setup', slug: 'documentation/setup' }),
        makePage({ id: 'collision', slug: 'docs/setup' }),
      ],
    })

    const plan = buildRenameExplorerFolderPlan(site, {
      sectionId: 'pages',
      folderPath: 'documentation',
      nextFolderPath: 'docs',
    })

    expect(plan.blockers).toEqual([
      { code: 'duplicate-page-slug', message: 'Page slug "/docs/setup" already exists.', target: 'docs/setup' },
    ])
  })

  it('plans exact script path rewrites and keeps file ids', () => {
    const site = makeSite({
      files: [
        { id: 'main', path: 'documentation/assets/js/main.js', type: 'script', content: '', createdAt: 1, updatedAt: 1 },
        { id: 'vendor', path: 'documentation/assets/js/vendor/jquery.min.js', type: 'script', content: '', createdAt: 1, updatedAt: 1 },
      ],
    })

    const plan = buildRenameExplorerFolderPlan(site, {
      sectionId: 'scripts',
      folderPath: 'documentation/assets/js',
      nextFolderPath: 'documentation/assets/scripts',
    })

    expect(plan.blockers).toEqual([])
    expect(plan.changes.map((change) => [change.id, change.from, change.to])).toEqual([
      ['main', 'documentation/assets/js/main.js', 'documentation/assets/scripts/main.js'],
      ['vendor', 'documentation/assets/js/vendor/jquery.min.js', 'documentation/assets/scripts/vendor/jquery.min.js'],
    ])
  })

  it('plans structural folder delete as descendant deletion', () => {
    const site = makeSite({
      pages: [
        makePage({ id: 'home', slug: 'index' }),
        makePage({ id: 'docs', slug: 'documentation' }),
        makePage({ id: 'setup', slug: 'documentation/setup' }),
        makePage({ id: 'pricing', slug: 'pricing' }),
      ],
    })

    const plan = buildDeleteExplorerPathPlan(site, { sectionId: 'pages', folderPath: 'documentation' })

    expect(plan.deletedItems.map((item) => [item.id, item.path])).toEqual([
      ['docs', 'documentation'],
      ['setup', 'documentation/setup'],
    ])
  })

  it('commits rewrite plans exactly', () => {
    const site = makeSite({
      pages: [
        makePage({ id: 'home', slug: 'index' }),
        makePage({ id: 'about', slug: 'about' }),
      ],
    })
    const plan = buildMoveExplorerItemPlan(site, {
      sectionId: 'pages',
      itemId: 'about',
      nextParentPath: 'documentation',
    })

    commitExplorerPathPlan(site, undefined, plan)

    expect(site.pages.find((page) => page.id === 'about')?.slug).toBe('documentation/about')
  })

  it('commits file delete plans and removes matching runtime config', () => {
    const site = makeSite({
      files: [
        { id: 'theme', path: 'documentation/assets/css/theme.css', type: 'style', content: '', createdAt: 1, updatedAt: 1 },
        { id: 'main', path: 'documentation/assets/js/main.js', type: 'script', content: '', createdAt: 1, updatedAt: 1 },
        { id: 'keep', path: 'marketing/assets/js/keep.js', type: 'script', content: '', createdAt: 1, updatedAt: 1 },
      ],
      runtime: {
        dependencyLock: { version: 1, packages: {}, updatedAt: 0 },
        styles: { theme: DEFAULT_STYLE_RUNTIME_CONFIG },
        scripts: {
          main: DEFAULT_SCRIPT_RUNTIME_CONFIG,
          keep: DEFAULT_SCRIPT_RUNTIME_CONFIG,
        },
      },
    })
    const liveRuntime = structuredClone(site.runtime)
    const stylesPlan = buildDeleteExplorerPathPlan(site, {
      sectionId: 'styles',
      folderPath: 'documentation/assets/css',
    })
    const scriptsPlan = buildDeleteExplorerPathPlan(site, {
      sectionId: 'scripts',
      folderPath: 'documentation/assets/js',
    })

    commitExplorerPathPlan(site, liveRuntime, stylesPlan)
    commitExplorerPathPlan(site, liveRuntime, scriptsPlan)

    expect(site.files.map((file) => file.id)).toEqual(['keep'])
    expect(site.runtime.styles.theme).toBeUndefined()
    expect(site.runtime.scripts.main).toBeUndefined()
    expect(site.runtime.scripts.keep).toEqual(DEFAULT_SCRIPT_RUNTIME_CONFIG)
    expect(liveRuntime.styles.theme).toBeUndefined()
    expect(liveRuntime.scripts.main).toBeUndefined()
    expect(liveRuntime.scripts.keep).toEqual(DEFAULT_SCRIPT_RUNTIME_CONFIG)
  })
})
