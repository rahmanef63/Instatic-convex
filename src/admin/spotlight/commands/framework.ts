/**
 * Framework commands (colors / typography / spacing) — §4.6 of the master plan.
 *
 * Open the design-token panels. Creation/editing of individual tokens
 * is handled inside those panels; the spotlight just provides quick-jump access.
 *
 * Capability: `site.style.edit` — these panels exist to manage design tokens,
 * which is a style-edit operation. A read-only viewer would surface them too,
 * but at present opening the panel implies the user intends to edit.
 */

import type { Command } from '../types'

const FRAMEWORK_CAPABILITY = 'site.style.edit'

export function getFrameworkCommands(): Command[] {
  return [
    // ── Open Colors panel ────────────────────────────────────────────────────
    {
      id: 'framework.openColors',
      title: 'Open Colors panel',
      subtitle: 'Browse and manage color design tokens',
      group: 'framework',
      iconName: 'colors-swatch-solid',
      keywords: ['colors', 'tokens', 'palette', 'design', 'framework', 'open'],
      workspaces: ['site'],
      capability: FRAMEWORK_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().setLeftSidebarPanel('colors')
        } catch (err) {
          console.error('[spotlight] openColors failed:', err)
        }
      },
    },

    // ── Open Typography panel ────────────────────────────────────────────────
    {
      id: 'framework.openTypography',
      title: 'Open Typography panel',
      subtitle: 'Browse and manage typography design tokens',
      group: 'framework',
      iconName: 'braces',
      keywords: ['typography', 'fonts', 'type', 'tokens', 'design', 'framework', 'open'],
      workspaces: ['site'],
      capability: FRAMEWORK_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().setLeftSidebarPanel('typography')
        } catch (err) {
          console.error('[spotlight] openTypography failed:', err)
        }
      },
    },

    // ── Open Spacing panel ───────────────────────────────────────────────────
    {
      id: 'framework.openSpacing',
      title: 'Open Spacing panel',
      subtitle: 'Browse and manage spacing design tokens',
      group: 'framework',
      iconName: 'proportions-solid',
      keywords: ['spacing', 'gaps', 'padding', 'margin', 'tokens', 'design', 'framework', 'open'],
      workspaces: ['site'],
      capability: FRAMEWORK_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().setLeftSidebarPanel('spacing')
        } catch (err) {
          console.error('[spotlight] openSpacing failed:', err)
        }
      },
    },
  ]
}
