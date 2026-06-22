/**
 * MergeAdvancedFields
 *
 * Collapsible "Avanzado" section that shows field-level comparison.
 * Only rendered when there are conflicts.
 * PII-encrypted fields show 🔒 — never the raw value.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Lock } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import type { DedupFieldComparison, DedupAccount } from '@domain/entities/DedupGroup';

interface MergeAdvancedFieldsProps {
  fieldComparisons: DedupFieldComparison[];
  accounts: DedupAccount[];
  survivorId: string;
  fieldChoices: Record<string, string>;
  onFieldChoiceChange: (field: string, accountId: string) => void;
}

export function MergeAdvancedFields({
  fieldComparisons,
  accounts,
  survivorId,
  fieldChoices,
  onFieldChoiceChange,
}: MergeAdvancedFieldsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // Defensive default: never assume the array is present (belt-and-suspenders
  // against an unexpected backend payload — see MergePhoneModeBody guard).
  const conflictingFields = (fieldComparisons ?? []).filter((f) => f.has_conflict);

  if (conflictingFields.length === 0) return null;

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      {/* Toggle header */}
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <Text as="span" size="sm" weight="semibold">
          {t('admin.dedup.merge.advanced', 'Avanzado')}{' '}
          <span className="text-amber-600">
            ({conflictingFields.length}{' '}
            {t('admin.dedup.merge.conflicts', {
              count: conflictingFields.length,
              defaultValue: `conflicto${conflictingFields.length !== 1 ? 's' : ''}`,
            })})
          </span>
        </Text>
        {open ? (
          <ChevronUp className="w-4 h-4 text-slate-500" />
        ) : (
          <ChevronDown className="w-4 h-4 text-slate-500" />
        )}
      </button>

      {/* Field-level rows */}
      {open && (
        <div className="divide-y divide-slate-100">
          {conflictingFields.map((field) => {
            const chosenId = fieldChoices[field.field] ?? survivorId;

            return (
              <div key={field.field} className="px-4 py-3 flex flex-col gap-2">
                <Text as="span" size="xs" weight="semibold" color="muted">
                  {t(`admin.dedup.field.${field.field}`, {
                    defaultValue: field.field,
                  })}
                </Text>

                <div className="flex flex-wrap gap-2">
                  {accounts.map((account) => {
                    const rawValue = field.values[account.id];
                    const isChosen = chosenId === account.id;

                    return (
                      <button
                        key={account.id}
                        type="button"
                        onClick={() =>
                          !field.is_encrypted &&
                          onFieldChoiceChange(field.field, account.id)
                        }
                        disabled={field.is_encrypted}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-left transition-all ${
                          isChosen
                            ? 'border-primary bg-primary/5'
                            : 'border-slate-200 bg-white hover:border-slate-300'
                        } ${field.is_encrypted ? 'cursor-default' : 'cursor-pointer'}`}
                        aria-pressed={isChosen}
                        aria-label={
                          field.is_encrypted
                            ? t('admin.dedup.merge.encryptedField', 'Campo cifrado')
                            : `${account.email ?? account.id}: ${rawValue ?? '—'}`
                        }
                      >
                        {field.is_encrypted ? (
                          <Lock className="w-3.5 h-3.5 text-slate-400" />
                        ) : null}
                        <Text as="span" size="xs" color={isChosen ? 'primary' : undefined}>
                          {field.is_encrypted
                            ? '🔒'
                            : (rawValue ?? (
                                <span className="text-slate-400 italic">
                                  {t('admin.dedup.merge.emptyValue', 'vacío')}
                                </span>
                              ))}
                        </Text>
                        <Text as="span" size="xs" color="muted">
                          ({account.email ?? account.id.slice(0, 8)})
                        </Text>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
