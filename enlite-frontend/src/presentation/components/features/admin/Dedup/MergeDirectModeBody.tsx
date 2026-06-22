/**
 * MergeDirectModeBody
 *
 * Direct-accounts flow body for MergeCompareModal (Onda 4b imported groups).
 * Accounts are supplied directly — no HTTP fetch needed.
 *
 * Notes:
 * - Advanced (field-level) section is intentionally hidden: name-based groups
 *   don't return field_comparisons from the backend in v1.
 * - survivor_reason='conflict_multiple_real_accounts' disables the merge button
 *   and shows a blocking banner directing the operator to the Fila tab.
 *
 * Extracted from MergeCompareModal to keep each file ≤400 lines.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitMerge, RefreshCw, AlertTriangle } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { AdminDedupApiService } from '@infrastructure/http/AdminDedupApiService';
import { MergeAccountCard } from './MergeAccountCard';
import type {
  DedupAccount,
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
}

export function MergeDirectModeBody({
  accounts,
  survivorSuggestedId,
  survivorReason,
  onClose,
  onMergeSuccess,
}: MergeDirectModeBodyProps) {
  const { t } = useTranslation();
  const [survivorId, setSurvivorId] = useState<string>(survivorSuggestedId);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeSuccess, setMergeSuccess] = useState(false);

  // survivor_reason='conflict_multiple_real_accounts' → block merge
  const isConflict = survivorReason === 'conflict_multiple_real_accounts';

  async function handleMerge() {
    // Defense-in-depth: button is disabled when isConflict=true so this
    // branch is unreachable in normal UI flow (disabled button doesn't fire onClick).
    if (isConflict) return;

    const absorbedIds = accounts
      .map((a) => a.id)
      .filter((id) => id !== survivorId);

    const payload: MergeRequest = { survivorId, absorbedIds };

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
    <>
      {/* Conflict banner — shown when multiple real accounts exist */}
      {isConflict && (
        <div
          className="mx-6 mt-4 bg-red-50 border border-red-200 rounded-xl p-4 flex gap-3 items-start"
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

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 pb-6 mt-4 flex flex-col gap-4">
        {/* Advanced section intentionally hidden in direct-accounts mode v1:
            name-based groups don't provide field_comparisons from backend. */}

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

      {/* Footer */}
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
    </>
  );
}
