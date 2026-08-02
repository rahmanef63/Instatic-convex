import { type MouseEvent } from 'react'
import { Button } from '@ui/components/Button'
import { FilterBar, type FilterBarItem } from '@ui/components/FilterBar'
import { Input } from '@ui/components/Input'
import type { resolveFrameworkPreferences } from '@core/framework'
import type { FrameworkScaleMode } from '@core/framework-schema'
import { FluidEditor } from './FluidEditor'
import { ManualEditor } from './ManualEditor'
import type { GeneratorShape, GroupShape, ScaleAdapter } from './adapter'
import styles from './ScalesEditor.module.css'

interface ScalesEditorProps<G extends GroupShape, C extends GeneratorShape> {
  group: G
  groups: G[]
  adapter: ScaleAdapter<G, C>
  preferences: ReturnType<typeof resolveFrameworkPreferences>
  onContextMenu: (event: MouseEvent<HTMLElement>) => void
  onActivateGroup: (groupId: string) => void
  onAddGroup: () => void
}

/**
 * The "scale exists, module enabled" body of the Scales section: scale picker
 * filter bar, name/prefix inputs, mode toggle, and the fluid/manual editor.
 * The empty / disabled empty-states live one level up in `PanelBody` so that
 * the surrounding sections (extras, utilities) remain reachable.
 */
export function ScalesEditor<G extends GroupShape, C extends GeneratorShape>({
  group,
  groups,
  adapter,
  preferences,
  onContextMenu,
  onActivateGroup,
  onAddGroup,
}: ScalesEditorProps<G, C>) {
  return (
    <>
      <FilterBar<string>
        items={groups.map<FilterBarItem<string>>((g) => ({
          value: g.id,
          label: g.name,
        }))}
        value={group.id}
        onValueChange={onActivateGroup}
        groupLabel={`${adapter.title} scales`}
        inlineActions={
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Add ${adapter.title.toLowerCase()} scale`}
            onClick={onAddGroup}
          >
            Add scale
          </Button>
        }
      />

      <div className={styles.tabHeading} onContextMenu={onContextMenu}>
        <Input
          fieldSize="sm"
          aria-label="Scale name"
          value={group.name}
          onChange={(event) => adapter.onUpdateGroup(group.id, { name: event.target.value })}
        />
        <Input
          fieldSize="sm"
          aria-label="Variable prefix"
          value={group.namingConvention}
          onChange={(event) =>
            adapter.onUpdateGroup(group.id, { namingConvention: event.target.value })
          }
          monospace
        />
      </div>

      <ModeToggle
        mode={group.mode}
        onChange={(mode) => adapter.onUpdateGroup(group.id, { mode })}
      />

      {group.mode === 'fluid_manual' ? (
        <ManualEditor group={group} adapter={adapter} />
      ) : (
        <FluidEditor group={group} adapter={adapter} preferences={preferences} />
      )}
    </>
  )
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: FrameworkScaleMode
  onChange: (mode: FrameworkScaleMode) => void
}) {
  return (
    <FilterBar<FrameworkScaleMode>
      items={[
        { value: 'fluid', label: 'Automatic' },
        { value: 'fluid_manual', label: 'Manual' },
      ]}
      value={mode}
      onValueChange={onChange}
      groupLabel="Mode"
    />
  )
}
