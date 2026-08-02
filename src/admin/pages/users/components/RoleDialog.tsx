/**
 * RoleDialog — create / edit / view modal for CMS roles.
 *
 * `mode === 'view'` is read-only: every input is `disabled`, the submit
 * button is omitted, and the cancel button reads "Close". `'create'` and
 * `'edit'` share the same form layout and submit through `onSubmit`.
 *
 * The capability picker shows every CMS capability grouped by feature area
 * (`CAPABILITY_GROUPS`). Each capability renders with a human-readable label
 * + description (`CAPABILITY_META`) instead of the raw permission string. A
 * sticky summary header at the top of the picker shows total selected count
 * and provides a master "Select all / Clear all" toggle; each group also has
 * its own per-group toggle in its header. The whole picker scrolls with the
 * Dialog body — no inner scroll, no double scrollbar.
 */
import { useId, type FormEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { SaveSolidIcon } from 'pixel-art-icons/icons/save-solid'
import dialogStyles from '../../../shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import styles from '../UsersPage.module.css'
import type { CapabilityGroup, RoleDialogMode, RoleFormState } from '../types'
import {
  ALL_PICKER_CAPABILITIES,
  CAPABILITY_GROUPS,
  CAPABILITY_META,
  capabilityLabel,
} from '../utils/capabilities'

interface RoleDialogProps {
  mode: RoleDialogMode
  form: RoleFormState
  busy: boolean
  error: string | null
  onChange: (form: RoleFormState) => void
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onToggleCapability: (capability: string, checked: boolean) => void
  onSetCapabilityGroup: (group: CapabilityGroup, checked: boolean) => void
}

const ROLE_FORM_ID = 'users-page-role-form'

export function RoleDialog({
  mode,
  form,
  busy,
  error,
  onChange,
  onClose,
  onSubmit,
  onToggleCapability,
  onSetCapabilityGroup,
}: RoleDialogProps) {
  const title = mode === 'create' ? 'Create Role' : mode === 'edit' ? 'Edit Role' : 'View Role'
  const readonly = mode === 'view'
  const selectedCapabilities = new Set(form.capabilities)
  const totalCount = ALL_PICKER_CAPABILITIES.length
  const selectedCount = ALL_PICKER_CAPABILITIES.reduce(
    (n, cap) => (selectedCapabilities.has(cap) ? n + 1 : n),
    0,
  )
  const allSelected = selectedCount === totalCount

  const nameId = useId()
  const slugId = useId()
  const descriptionId = useId()

  function setAllCapabilities(checked: boolean) {
    onChange({
      ...form,
      capabilities: checked ? [...ALL_PICKER_CAPABILITIES] : [],
    })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="xl"
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            <span>{readonly ? 'Close' : 'Cancel'}</span>
          </Button>
          {!readonly && (
            <Button type="submit" form={ROLE_FORM_ID} variant="primary" size="sm" disabled={busy}>
              <SaveSolidIcon size={14} aria-hidden="true" />
              <span>{mode === 'create' ? 'Create Role' : 'Save Role'}</span>
            </Button>
          )}
        </>
      }
    >
      <form id={ROLE_FORM_ID} className={dialogStyles.form} onSubmit={(event) => void onSubmit(event)}>
        <div className={styles.roleIdentityGrid}>
          <div className={dialogStyles.field}>
            <label htmlFor={nameId} className={dialogStyles.label}>Name</label>
            <Input
              id={nameId}
              value={form.name}
              required
              disabled={readonly}
              placeholder="Content editor"
              onChange={(event) => onChange({ ...form, name: event.currentTarget.value })}
            />
          </div>
          <div className={dialogStyles.field}>
            <label htmlFor={slugId} className={dialogStyles.label}>Slug</label>
            <Input
              id={slugId}
              value={form.slug}
              disabled={readonly}
              placeholder="content-editor"
              onChange={(event) => onChange({ ...form, slug: event.currentTarget.value })}
            />
          </div>
        </div>
        <div className={dialogStyles.field}>
          <label htmlFor={descriptionId} className={dialogStyles.label}>Description</label>
          <Input
            id={descriptionId}
            value={form.description}
            disabled={readonly}
            placeholder="What can someone with this role do?"
            onChange={(event) => onChange({ ...form, description: event.currentTarget.value })}
          />
        </div>

        <section className={styles.capabilityPicker} aria-label="Capabilities">
          <header className={styles.capabilityPickerHeader}>
            <div className={styles.capabilityPickerSummary}>
              <h3 className={styles.capabilityPickerTitle}>Capabilities</h3>
              <p className={styles.capabilityPickerCount}>
                <strong>{selectedCount}</strong> of {totalCount} selected
              </p>
            </div>
            {!readonly && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={allSelected ? 'Clear all capabilities' : 'Select all capabilities'}
                onClick={() => setAllCapabilities(!allSelected)}
              >
                <span>{allSelected ? 'Clear all' : 'Select all'}</span>
              </Button>
            )}
          </header>

          <div className={styles.capabilityGroups}>
            {CAPABILITY_GROUPS.map((group) => {
              const groupSelected = group.capabilities.filter((cap) => selectedCapabilities.has(cap)).length
              const groupTotal = group.capabilities.length
              const groupAllSelected = groupSelected === groupTotal
              return (
                <section key={group.title} className={styles.capabilityGroup}>
                  <header className={styles.capabilityGroupHeader}>
                    <div className={styles.capabilityGroupHeading}>
                      <h4>{group.title}</h4>
                      <span
                        className={styles.capabilityGroupCount}
                        data-state={groupAllSelected ? 'full' : groupSelected > 0 ? 'partial' : 'empty'}
                      >
                        {groupSelected}/{groupTotal}
                      </span>
                    </div>
                    {!readonly && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        aria-label={
                          groupAllSelected
                            ? `Clear ${group.title} capabilities`
                            : `Select all ${group.title} capabilities`
                        }
                        onClick={() => onSetCapabilityGroup(group, !groupAllSelected)}
                      >
                        <span>{groupAllSelected ? 'Clear' : 'Select all'}</span>
                      </Button>
                    )}
                  </header>
                  <ul className={styles.capabilityList}>
                    {group.capabilities.map((capability) => {
                      const meta = CAPABILITY_META[capability]
                      const checked = selectedCapabilities.has(capability)
                      return (
                        <li key={capability} className={styles.capabilityItem} data-checked={checked}>
                          <label className={styles.capabilityRow}>
                            <Checkbox
                              checked={checked}
                              disabled={readonly}
                              onCheckedChange={(next) => onToggleCapability(capability, next)}
                            />
                            <span className={styles.capabilityRowText}>
                              <span className={styles.capabilityRowLabel}>
                                {meta?.label ?? capabilityLabel(capability)}
                              </span>
                              {meta && (
                                <span className={styles.capabilityRowDescription}>{meta.description}</span>
                              )}
                            </span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
          </div>
        </section>

        {error && <p role="alert" className={dialogStyles.errorText}>{error}</p>}
      </form>
    </Dialog>
  )
}
