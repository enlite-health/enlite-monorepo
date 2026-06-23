/**
 * MergeDirectModeBody
 *
 * Direct-accounts flow body for MergeCompareModal (Onda 4b imported groups)
 * AND the manual-merge flow (ManualMergeModal).
 * Accounts are supplied directly — no HTTP fetch needed.
 *
 * Notes:
 * - Advanced (field-level) section is shown ONLY when fieldComparisons is
 *   provided and non-empty (manual-merge flow). Importados tab does not supply
 *   field_comparisons — the section stays hidden, preserving existing behaviour.
 * - survivor_reason='conflict_multiple_real_accounts' disables the merge button
 *   and shows a blocking banner directing the operator to the Fila tab.
 *
 * Extracted from MergeCompareModal to keep each file ≤400 lines.
 */

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { GitMerge, RefreshCw, AlertTriangle } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { AdminDedupApiService } from '@infrastructure/http/AdminDedupApiService';
import { MergeAccountCard } from './MergeAccountCard';
import { MergeAdvancedFields } from './MergeAdvancedFields';
import type {
  DedupAccount,
  DedupFieldComparison,
  ImportedDedupAccount,
  MergeRequest,
  SurvivorReason,
} from '@domain/entities/DedupGroup';

export interface MergeDirectModeBodyProps {
  accounts: ImportedDedupAccount[];
  survivorSuggestedId: string;
  survivorReason: SurvivorReason;
  onClose: () => void;
  onMergeSuccess: () => void;
  /**
   * Field-level comparisons for the advanced chooser.
   * Provided only by the manual-merge flow (POST /manual-group now returns
   * field_comparisons). When undefined or empty the section stays hidden,
   * keeping the Importados tab behaviour unchanged.
   */
  fieldComparisons?: DedupFieldComparison[];
}

export function MergeDirectModeBody({
  accounts,
  survivorSuggestedId,
  survivorReason,
  onClose,
  onMergeSuccess,
  fieldComparisons,
}: MergeDirectModeBodyProps) {
  const { t } = useTranslation();
  const [survivorId, setSurvivorId] = useState<string>(survivorSuggestedId);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeSuccess, setMergeSuccess] = useState(false);
  const [fieldChoices, setFieldChoices] = useState<Record<string, string>>({});

  // survivor_reason='conflict_multiple_real_accounts' → block merge
  const isConflict = survivorReason === 'conflict_multiple_real_accounts';

  const handleFieldChoiceChange = useCallback(
    (field: string, accountId: string) => {
      setFieldChoices((prev) => ({ ...prev, [field]: accountId }));
    },
    [],
  );

  async function handleMerge() {
    // Defense-in-depth: button is disabled when isConflict=true so this
    // branch is unreachable in normal UI flow (disabled button doesn't fire onClick).
    if (isConflict) return;

    const absorbedIds = accounts
      .map((a) => a.id)
      .filter((id) => id !== survivorId);

    const payload: MergeRequest = {
      survivorId,
      absorbedIds,
      // Include field choices only when the advanced section was shown and used.
      // Mirrors MergePhoneModeBody pattern: spread only when non-empty.
      ...(Object.keys(fieldChoices).length > 0 ? { fieldChoices } : {}),
    };

    setIsMerging(true);
    setMergeError(null);

    try {
      await AdminDedupApiService.merge(payload);
      setMergeSuccess(true);
      setTimeout(() => {
        onMergeSuccess();
        onClose();
      }, 1200);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Error al ejecutar el merge';
      setMergeError(message);
    } finally {
      setIsMerging(false);
    }
  }

  // Cast to base DedupAccount for MergeAccountCard (is_imported is extra)
  const baseAccounts: DedupAccount[] = accounts;

  return (
    // Root: flex column that fills the remaining card space (flex-1) and allows
    // shrink below its content size (min-h-0) — essential for overflow-y-auto
    // on the scrollable child to actually kick in inside a flex container.
    <div className="flex flex-col flex-1 min-h-0">
      {/* Conflict banner — fixed above scrollable area, does not scroll */}
      {isConflict && (
        <div
          className="mx-6 mt-4 bg-red-50 border border-red-200 rounded-xl p-4 flex gap-3 items-start shrink-0"
          data-testid="imported-conflict-banner"
        >
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <Text size="sm" weight="semibold" color="inherit" as="p">
              {t('admin.dedup.imported.conflictTitle', 'Revisión manual requerida')}
            </Text>
            <Text size="xs" color="muted" as="p">
              {t(
                'admin.dedup.imported.conflictDesc',
                'Este grupo tiene más de una cuenta real. Unificá manualmente en la pestaña Fila.',
              )}
            </Text>
          </div>
        </div>
      )}

      {/* Scrollable body — grows to fill available space and scrolls when content
          overflows (e.g. many account cards or the Advanced field-chooser section). */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 mt-4 flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {baseAccounts.map((account) => (
            <MergeAccountCard
              key={account.id}
              account={account}
              isSurvivor={account.id === survivorId}
              onSelectSurvivor={() => !isConflict && setSurvivorId(account.id)}
            />
          ))}
        </div>

        {/* Advanced field-chooser: rendered only for the manual-merge flow when
            the backend supplies field_comparisons. Importados groups do not
            provide this prop → section stays hidden (no regression). */}
        {(fieldComparisons?.length ?? 0) > 0 && (
          <MergeAdvancedFields
            fieldComparisons={fieldComparisons ?? []}
            accounts={baseAccounts}
            survivorId={survivorId}
            fieldChoices={fieldChoices}
            onFieldChoiceChange={handleFieldChoiceChange}
          />
        )}

        {mergeError && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3">
            <Text size="sm" color="inherit">{mergeError}</Text>
          </div>
        )}

        {mergeSuccess && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <GitMerge className="w-10 h-10 text-green-500" />
            <Text size="sm" weight="semibold" color="inherit">
              {t('admin.dedup.merge.success', 'Unificación realizada con éxito')}
            </Text>
          </div>
        )}
      </div>

      {/* Footer — fixed below the scrollable area, always visible */}
      {!mergeSuccess && (
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 shrink-0">
          <Button variant="outline" size="sm" onClick={onClose} disabled={isMerging}>
            {t('admin.dedup.merge.cancel', 'Cancelar')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleMerge}
            disabled={isMerging || isConflict}
            aria-label={t('admin.dedup.merge.confirmAriaLabel', 'Confirmar unificación')}
            data-testid="imported-merge-confirm-btn"
          >
            {isMerging ? (
              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <GitMerge className="w-4 h-4 mr-2" />
            )}
            {isMerging
              ? t('admin.dedup.merge.merging', 'Unificando...')
              : t('admin.dedup.merge.confirm', 'Confirmar unificación')}
          </Button>
        </div>
      )}
    </div>
  );
}
