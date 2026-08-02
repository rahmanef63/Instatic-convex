import { useRef } from 'react'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { ControlRow } from '@ui/components/ControlRow'
import { NumericInput } from './controls/NumericInput'
import { RatioField } from './controls/RatioField'
import { RatioModeToggle } from './controls/RatioModeToggle'
import type { GeneratorShape, GroupShape, ScaleAdapter } from './adapter'
import styles from './BaseSettings.module.css'

/**
 * Two-column grid of fluid-mode settings: min/max base size, min/max ratio,
 * base step picker, and the editable comma-separated step list. The whole
 * grid acts as the menu anchor for the ratio Selects so their long preset
 * labels can span both columns instead of being clipped to a single cell.
 */
export function BaseSettings<G extends GroupShape, C extends GeneratorShape>({
  group,
  adapter,
  baseScaleIndex,
  stepLabels,
  fieldId,
}: {
  group: G
  adapter: ScaleAdapter<G, C>
  baseScaleIndex: number
  stepLabels: string[]
  fieldId: (key: string) => string
}) {
  // Anchor element for the ratio Selects' dropdowns. Each Select trigger lives
  // in a 2-column grid cell that's too narrow for the long ratio labels
  // ("Augmented Fourth (1.414...)" etc.), so we let their menus span the full
  // width of `.baseSettings` instead of getting truncated to one column.
  const baseSettingsRef = useRef<HTMLDivElement>(null)
  const baseSizeLabel = adapter.baseSizeLabel.toLowerCase()

  return (
    <div ref={baseSettingsRef} className={styles.baseSettings}>
      <ControlRow
        propKey="min-base-size"
        inputId={fieldId('min-base-size')}
        label={`Min ${baseSizeLabel}`}
        layout="stacked"
      >
        <NumericInput
          inputId={fieldId('min-base-size')}
          value={adapter.readBaseSize(group, 'min')}
          ariaLabel={`Min ${baseSizeLabel}`}
          onChange={(next) => adapter.onUpdateGroup(group.id, adapter.patchBaseSize('min', next))}
          unit="px"
        />
      </ControlRow>
      <ControlRow
        propKey="max-base-size"
        inputId={fieldId('max-base-size')}
        label={`Max ${baseSizeLabel}`}
        layout="stacked"
      >
        <NumericInput
          inputId={fieldId('max-base-size')}
          value={adapter.readBaseSize(group, 'max')}
          ariaLabel={`Max ${baseSizeLabel}`}
          onChange={(next) => adapter.onUpdateGroup(group.id, adapter.patchBaseSize('max', next))}
          unit="px"
        />
      </ControlRow>

      <ControlRow
        propKey="min-ratio"
        inputId={fieldId('min-ratio')}
        label="Min ratio"
        layout="stacked"
        labelSuffix={
          <RatioModeToggle
            isCustom={Boolean(group.min.isCustomScaleRatio)}
            ariaLabel="Toggle custom min scale ratio"
            onToggle={() =>
              adapter.onUpdateGroup(group.id, {
                min: {
                  ...group.min,
                  isCustomScaleRatio: !group.min.isCustomScaleRatio,
                  scaleRatioInputValue:
                    group.min.scaleRatioInputValue ?? Number(group.min.scaleRatio),
                },
              })
            }
          />
        }
      >
        <RatioField
          inputId={fieldId('min-ratio')}
          scaleRatio={group.min.scaleRatio}
          isCustom={group.min.isCustomScaleRatio}
          customValue={group.min.scaleRatioInputValue}
          options={adapter.ratioOptions}
          ariaLabel="Min scale ratio"
          menuAnchorRef={baseSettingsRef}
          onChange={(patch) =>
            adapter.onUpdateGroup(group.id, { min: { ...group.min, ...patch } })
          }
        />
      </ControlRow>
      <ControlRow
        propKey="max-ratio"
        inputId={fieldId('max-ratio')}
        label="Max ratio"
        layout="stacked"
        labelSuffix={
          <RatioModeToggle
            isCustom={Boolean(group.max.isCustomScaleRatio)}
            ariaLabel="Toggle custom max scale ratio"
            onToggle={() =>
              adapter.onUpdateGroup(group.id, {
                max: {
                  ...group.max,
                  isCustomScaleRatio: !group.max.isCustomScaleRatio,
                  scaleRatioInputValue:
                    group.max.scaleRatioInputValue ?? Number(group.max.scaleRatio),
                },
              })
            }
          />
        }
      >
        <RatioField
          inputId={fieldId('max-ratio')}
          scaleRatio={group.max.scaleRatio}
          isCustom={group.max.isCustomScaleRatio}
          customValue={group.max.scaleRatioInputValue}
          options={adapter.ratioOptions}
          ariaLabel="Max scale ratio"
          menuAnchorRef={baseSettingsRef}
          onChange={(patch) =>
            adapter.onUpdateGroup(group.id, { max: { ...group.max, ...patch } })
          }
        />
      </ControlRow>

      <div className={styles.fieldRowWide}>
        <ControlRow
          propKey="base-step"
          inputId={fieldId('base-step')}
          label="Base step"
          layout="stacked"
        >
          <Select
            id={fieldId('base-step')}
            fieldSize="sm"
            aria-label="Base scale index"
            value={String(baseScaleIndex)}
            options={stepLabels.map((label, idx) => ({ value: String(idx), label }))}
            onChange={(event) =>
              adapter.onUpdateGroup(group.id, { baseScaleIndex: Number(event.currentTarget.value) })
            }
          />
        </ControlRow>
      </div>
      <div className={styles.fieldRowWide}>
        <ControlRow
          propKey="steps"
          inputId={fieldId('steps')}
          label="Steps"
          layout="stacked"
        >
          <Input
            id={fieldId('steps')}
            fieldSize="sm"
            aria-label="Step labels"
            value={group.steps}
            onChange={(event) => adapter.onUpdateGroup(group.id, { steps: event.target.value })}
            monospace
          />
        </ControlRow>
      </div>
    </div>
  )
}
