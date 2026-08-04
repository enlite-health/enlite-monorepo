/**
 * MergeAdvancedFields
 *
 * Collapsible "Avanzado" section that shows field-level comparison.
 * Only rendered when there are conflicts.
 *
 * PII-encrypted fields: the backend decrypts the value (admin-only endpoint —
 * same PII the admin already sees on the worker detail page), so here we show
 * the REAL value with a discreet 🔒 marker and make the field selectable like
 * any other. The admin picks which account wins per field.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { FieldChoiceList } from '@presentation/components/shared/FieldChoiceList/FieldChoiceList';
import {
  getSexLabel,
  getGenderLabel,
  getYearsExperienceLabel,
  getKnowledgeLevelLabel,
} from '../WorkerDetail/workerDetailLabels';
import type { DedupFieldComparison, DedupAccount } from '@domain/entities/DedupGroup';

/**
 * Per-field enum resolver map. Maps a field name to the resolver function that
 * converts the raw enum value to a human label via i18n.
 *
 * - sex_encrypted / gender_encrypted: uses SEX_GENDER_KEYS (covers EN+ES mixed-case prod values).
 * - years_experience: "0_2"→"0-2 años", "3_5"→"3-5 años", etc.
 * - knowledge_level: "SECONDARY"→"Secundario", "BACHELOR"→"Licenciatura", etc.
 *
 * Any field NOT listed here falls back to showing the raw value verbatim
 * (name, document number, etc. — not an enum).
 */
type FieldResolver = (t: TFunction, v: string | null) => string | null;

const FIELD_RESOLVERS: Record<string, FieldResolver> = {
  sex_encrypted: (t, v) => getSexLabel(t, v?.toLowerCase() ?? null),
  gender_encrypted: (t, v) => getGenderLabel(t, v?.toLowerCase() ?? null),
  years_experience: (t, v) => getYearsExperienceLabel(t, v),
  knowledge_level: (t, v) => getKnowledgeLevelLabel(t, v),
};

/**
 * Renders a comparison value as a human label. Enum-like fields are translated
 * via the FIELD_RESOLVERS map (reusing the worker-detail label SSOT);
 * everything else is shown verbatim. Returns null for empty/absent values.
 */
function renderFieldValue(t: TFunction, field: string, raw: string | null): string | null {
  if (raw == null || raw === '') return null;
  const resolver = FIELD_RESOLVERS[field];
  if (resolver) return resolver(t, raw) ?? raw;
  return raw;
}

/**
 * Rótulo humano da conta pro operador não-técnico: prioriza NOME; nunca mostra
 * o email sintético "@enlite.import" nem o UUID se houver algo melhor.
 */
function accountLabel(account: DedupAccount): string {
  const name = account.name?.trim();
  if (name) return name;
  const email = account.email;
  if (email && !email.toLowerCase().includes('@enlite.import')) return email;
  return account.id.slice(0, 8);
}

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
    // overflow-hidden foi removido: cortava as rows quando expandido dentro de
    // um flex container com min-h-0 (MergePhoneModeBody scrollable).
    // O rounded-xl funciona sem overflow-hidden para border+background normais.
    <div className="border border-slate-200 rounded-xl">
      {/* Toggle header */}
      <button
        type="button"
        className={`w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors rounded-t-xl${!open ? ' rounded-b-xl' : ''}`}
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

      {/* Field-level rows — núcleo compartilhado com o vínculo self-service */}
      {open && (
        <FieldChoiceList
          comparisons={fieldComparisons}
          options={accounts.map((a) => ({ id: a.id, label: accountLabel(a) }))}
          choices={fieldChoices}
          fallbackChoiceId={survivorId}
          onChange={onFieldChoiceChange}
          fieldLabel={(field) => t(`admin.dedup.field.${field}`, { defaultValue: field })}
          valueLabel={(field, raw) => renderFieldValue(t, field, raw)}
        />
      )}
    </div>
  );
}
