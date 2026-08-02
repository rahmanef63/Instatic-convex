/**
 * Panels commands — §4.4 of the Command Spotlight master plan.
 *
 * Toggle/open editor side-panels, cycle panel focus, toggle the code editor.
 * All gated to workspace: ['site'] since panels only exist in the site editor.
 *
 * Capability: `site.read` — every panel is a read-only UI affordance. The
 * underlying mutations the panels expose are themselves capability-gated.
 */

import type { Command } from '../types'

const PANEL_CAPABILITY = 'site.read'

export function getPanelsCommands(): Command[] {
  return [
    // ── Layers panel ─────────────────────────────────────────────────────────
    {
      id: 'panels.toggleLayers',
      title: 'Toggle Layers panel',
      subtitle: 'Show or hide the DOM tree / layers panel',
      group: 'editor',
      iconName: 'list-box-solid',
      keywords: ['panel', 'layers', 'dom', 'tree', 'toggle', 'show', 'hide'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleDomTreePanel()
        } catch (err) {
          console.error('[spotlight] toggleDomTreePanel failed:', err)
        }
      },
    },

    // ── Site explorer panel ──────────────────────────────────────────────────
    {
      id: 'panels.toggleSiteExplorer',
      title: 'Toggle Site Explorer panel',
      subtitle: 'Show or hide the site explorer in the sidebar',
      group: 'editor',
      iconName: 'layout-solid',
      keywords: ['panel', 'site', 'explorer', 'sidebar', 'toggle'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleLeftSidebarPanel('site')
        } catch (err) {
          console.error('[spotlight] toggleLeftSidebarPanel site failed:', err)
        }
      },
    },

    // ── Selectors panel ──────────────────────────────────────────────────────
    {
      id: 'panels.toggleSelectors',
      title: 'Toggle Selectors panel',
      subtitle: 'Show or hide the CSS selectors panel',
      group: 'editor',
      iconName: 'code',
      keywords: ['panel', 'selectors', 'css', 'classes', 'toggle'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleLeftSidebarPanel('selectors')
        } catch (err) {
          console.error('[spotlight] toggleLeftSidebarPanel selectors failed:', err)
        }
      },
    },

    // ── Colors panel ─────────────────────────────────────────────────────────
    {
      id: 'panels.toggleColors',
      title: 'Toggle Colors panel',
      subtitle: 'Show or hide the design token colors panel',
      group: 'editor',
      iconName: 'colors-swatch-solid',
      keywords: ['panel', 'colors', 'tokens', 'palette', 'toggle'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleLeftSidebarPanel('colors')
        } catch (err) {
          console.error('[spotlight] toggleLeftSidebarPanel colors failed:', err)
        }
      },
    },

    // ── Typography panel ─────────────────────────────────────────────────────
    {
      id: 'panels.toggleTypography',
      title: 'Toggle Typography panel',
      subtitle: 'Show or hide the typography design tokens panel',
      group: 'editor',
      iconName: 'braces',
      keywords: ['panel', 'typography', 'fonts', 'type', 'tokens', 'toggle'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleLeftSidebarPanel('typography')
        } catch (err) {
          console.error('[spotlight] toggleLeftSidebarPanel typography failed:', err)
        }
      },
    },

    // ── Spacing panel ────────────────────────────────────────────────────────
    {
      id: 'panels.toggleSpacing',
      title: 'Toggle Spacing panel',
      subtitle: 'Show or hide the spacing design tokens panel',
      group: 'editor',
      iconName: 'proportions-solid',
      keywords: ['panel', 'spacing', 'gaps', 'padding', 'margin', 'tokens', 'toggle'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleLeftSidebarPanel('spacing')
        } catch (err) {
          console.error('[spotlight] toggleLeftSidebarPanel spacing failed:', err)
        }
      },
    },

    // ── Media panel ──────────────────────────────────────────────────────────
    {
      id: 'panels.toggleMedia',
      title: 'Toggle Media panel',
      subtitle: 'Show or hide the media / asset library panel',
      group: 'editor',
      iconName: 'image-solid',
      keywords: ['panel', 'media', 'assets', 'images', 'files', 'toggle'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleLeftSidebarPanel('media')
        } catch (err) {
          console.error('[spotlight] toggleLeftSidebarPanel media failed:', err)
        }
      },
    },

    // ── Dependencies panel ───────────────────────────────────────────────────
    {
      id: 'panels.toggleDependencies',
      title: 'Toggle Dependencies panel',
      subtitle: 'Show or hide the site dependencies panel',
      group: 'editor',
      iconName: 'package-solid',
      keywords: ['panel', 'dependencies', 'packages', 'plugins', 'toggle'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleLeftSidebarPanel('dependencies')
        } catch (err) {
          console.error('[spotlight] toggleLeftSidebarPanel dependencies failed:', err)
        }
      },
    },

    // ── AI Assistant panel ───────────────────────────────────────────────────
    {
      id: 'panels.toggleAgent',
      title: 'Toggle AI Assistant panel',
      subtitle: 'Show or hide the AI assistant panel',
      group: 'editor',
      iconName: 'sparkles-solid',
      keywords: ['panel', 'ai', 'assistant', 'agent', 'claude', 'toggle'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleLeftSidebarPanel('agent')
        } catch (err) {
          console.error('[spotlight] toggleLeftSidebarPanel agent failed:', err)
        }
      },
    },

    // ── Properties panel ─────────────────────────────────────────────────────
    {
      id: 'panels.toggleProperties',
      title: 'Toggle Properties panel',
      subtitle: 'Show or hide the properties panel',
      group: 'editor',
      iconName: 'sliders-horizontal',
      keywords: ['panel', 'properties', 'inspector', 'toggle'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().togglePropertiesPanel()
        } catch (err) {
          console.error('[spotlight] togglePropertiesPanel failed:', err)
        }
      },
    },

    // ── Code editor panel ────────────────────────────────────────────────────
    {
      id: 'panels.toggleCodeEditor',
      title: 'Toggle Code editor panel',
      subtitle: 'Show or hide the floating code editor',
      group: 'editor',
      iconName: 'code',
      keywords: ['panel', 'code', 'editor', 'file', 'toggle'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          const store = useEditorStore.getState()
          store.setCodeEditorPanelOpen(!store.codeEditorPanelOpen)
        } catch (err) {
          console.error('[spotlight] toggleCodeEditorPanel failed:', err)
        }
      },
    },

    // ── Cycle panel focus ────────────────────────────────────────────────────
    {
      id: 'panels.cycleFocus',
      title: 'Cycle panel focus',
      subtitle: 'Move keyboard focus between canvas, layers, and properties',
      group: 'editor',
      iconName: 'arrows-horizontal',
      keywords: ['panel', 'focus', 'cycle', 'keyboard', 'navigate'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      keepOpenAfterRun: false,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().cycleFocusedPanel()
        } catch (err) {
          console.error('[spotlight] cycleFocusedPanel failed:', err)
        }
      },
    },
  ]
}
