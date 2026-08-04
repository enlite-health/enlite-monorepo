/**
 * FieldChoiceList
 *
 * Núcleo COMPARTILHADO de escolha campo-a-campo entre contas — extraído de
 * MergeAdvancedFields (admin Dedup) para servir também o vínculo self-service
 * (PhoneConflictModal). Zero duplicação: o admin mantém o header colapsável e
 * delega as linhas pra cá; a modal consome direto (openspec task 3.1).
 *
 * O DOM dos chips é o MESMO do admin (aria-pressed, aria-label
 * "conta: valor", 🔒 em campo cifrado) — a suíte do Dedup segue valendo.
 */

import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';

export interface FieldChoiceComparison {
  field: string;
  /** Valores por account id (null = vazio). */
  values: Record<string, string | null>;
  is_encrypted: boolean;
  has_conflict: boolean;
}

export interface FieldChoiceOption {
  id: string;
  label: string;
}

interface FieldChoiceListProps {
  /** Comparações — só as com has_conflict são renderizadas. */
  comparisons: FieldChoiceComparison[];
  /** Contas, na ordem de exibição dos chips. */
  options: FieldChoiceOption[];
  /** Escolhas atuais (campo → account id). */
  choices: Record<string, string>;
  /** Pré-seleção quando o campo ainda não tem escolha (admin: survivor). */
  fallbackChoiceId: string;
  onChange: (field: string, accountId: string) => void;
  /** Rótulo humano do campo (i18n do caller). */
  fieldLabel: (field: string) => string;
  /** Valor humano (resolvers de enum do caller); null = vazio. */
  valueLabel: (field: string, raw: string | null) => string | null;
}

export function FieldChoiceList({
  comparisons,
  options,
  choices,
  fallbackChoiceId,
  onChange,
  fieldLabel,
  valueLabel,
}: FieldChoiceListProps): JSX.Element | null {
  const { t } = useTranslation();
  const conflicting = (comparisons ?? []).filter((f) => f.has_conflict);
  if (conflicting.length === 0) return null;

  return (
    <div className="divide-y divide-slate-100" data-testid="field-choice-list">
      {conflicting.map((field) => {
        const chosenId = choices[field.field] ?? fallbackChoiceId;

        return (
          <div key={field.field} className="px-4 py-3 flex flex-col gap-2" data-testid={`conflict-field-${field.field}`}>
            <Text as="span" size="xs" weight="semibold" color="muted">
              {fieldLabel(field.field)}
            </Text>

            <div className="flex flex-wrap gap-2">
              {options.map((account) => {
                const displayValue = valueLabel(field.field, field.values[account.id] ?? null);
                const isChosen = chosenId === account.id;

                return (
                  <button
                    key={account.id}
                    type="button"
                    onClick={() => onChange(field.field, account.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-left transition-all cursor-pointer ${
                      isChosen
                        ? 'border-primary bg-primary/5'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                    aria-pressed={isChosen}
                    aria-label={`${account.label}: ${displayValue ?? '—'}`}
                    data-testid={`conflict-${field.field}-${account.id}`}
                  >
                    {field.is_encrypted ? (
                      <Lock
                        className="w-3 h-3 text-slate-400 shrink-0"
                        aria-label={t('admin.dedup.merge.encryptedField', 'Campo cifrado')}
                      />
                    ) : null}
                    <Text as="span" size="xs" color={isChosen ? 'primary' : undefined}>
                      {displayValue ?? (
                        <span className="text-slate-400 italic">
                          {t('admin.dedup.merge.emptyValue', 'vacío')}
                        </span>
                      )}
                    </Text>
                    <Text as="span" size="xs" color="muted">
                      ({account.label})
                    </Text>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
