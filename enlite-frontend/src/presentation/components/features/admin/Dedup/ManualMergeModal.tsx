/**
 * ManualMergeModal
 *
 * Allows an operator to manually select two accounts (by name or phone search)
 * and open the existing MergeDirectModeBody for comparison and merge.
 *
 * Flow:
 *   1. Operator searches and picks Account A (CandidateAutocomplete).
 *   2. Operator searches and picks Account B (same component, disables A's id).
 *   3. "Comparar y unificar" calls buildManualGroup([a.id, b.id]).
 *   4. MergeDirectModeBody opens with the returned accounts + survivor data.
 *   5. On merge success → onMergeSuccess() + onClose().
 *
 * Handles:
 *   - Loading state while calling buildManualGroup.
 *   - API errors (shown inline).
 *   - Duplicate id guard (disabledIds prop on each autocomplete).
 *   - ESC key closes modal.
 *
 * Conflict (2+ real accounts) is NOT blocked here: this is a deliberate manual
 * action, so MergeDirectModeBody receives allowConflictOverride and shows a
 * warning naming which account is kept vs deleted, gated by an explicit
 * "es la misma persona" confirmation (unlike the Importados tab, which blocks).
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Users, GitMerge, RefreshCw } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { AdminDedupApiService } from '@infrastructure/http/AdminDedupApiService';
import { CandidateAutocomplete } from './CandidateAutocomplete';
import { MergeDirectModeBody } from './MergeDirectModeBody';
import type { CandidateItem, ManualGroupResult } from '@domain/entities/DedupGroup';

interface ManualMergeModalProps {
  onClose: () => void;
  onMergeSuccess: () => void;
}

export function ManualMergeModal({
  onClose,
  onMergeSuccess,
}: ManualMergeModalProps) {
  const { t } = useTranslation();
  const [accountA, setAccountA] = useState<CandidateItem | null>(null);
  const [accountB, setAccountB] = useState<CandidateItem | null>(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [manualGroup, setManualGroup] = useState<ManualGroupResult | null>(null);

  // ESC closes the modal
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Stable search handler passed to both autocompletes
  const handleSearch = useCallback(async (q: string) => {
    return AdminDedupApiService.searchCandidates(q);
  }, []);

  async function handleCompare() {
    if (!accountA || !accountB) return;
    setIsBuilding(true);
    setBuildError(null);
    try {
      const result = await AdminDedupApiService.buildManualGroup([accountA.id, accountB.id]);
      setManualGroup(result);
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : t('admin.dedup.manualMerge.buildError', 'Error al construir el grupo. Intentá de nuevo.');
      setBuildError(message);
    } finally {
      setIsBuilding(false);
    }
  }

  const canCompare = accountA !== null && accountB !== null && accountA.id !== accountB.id;

  // ── Render: comparison step (MergeDirectModeBody) ─────────────────────────────

  if (manualGroup) {
    return (
      <div
        className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        data-testid="manual-merge-modal"
      >
        <div
          className="bg-white rounded-card shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-label={t('admin.dedup.manualMerge.compareDialogLabel', 'Comparar y unificar cuentas')}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-200 shrink-0">
            <div className="flex items-center gap-3">
              <GitMerge className="w-5 h-5 text-primary" />
              <Heading level={2} weight="semibold" color="primary">
                {t('admin.dedup.merge.title', 'Comparar y unificar')}
              </Heading>
            </div>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-primary transition-colors"
              aria-label={t('admin.dedup.merge.close', 'Cerrar')}
            >
              <X size={24} />
            </button>
          </div>

          <MergeDirectModeBody
            accounts={manualGroup.accounts}
            survivorSuggestedId={manualGroup.survivor_suggested_id ?? manualGroup.accounts[0]?.id ?? ''}
            survivorReason={manualGroup.survivor_reason}
            fieldComparisons={manualGroup.field_comparisons}
            onClose={onClose}
            onMergeSuccess={() => {
              onMergeSuccess();
              onClose();
            }}
            allowConflictOverride
          />
        </div>
      </div>
    );
  }

  // ── Render: selection step ────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="manual-merge-modal"
    >
      <div
        className="bg-white rounded-card shadow-xl w-full max-w-lg flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label={t('admin.dedup.manualMerge.dialogLabel', 'Unificación manual de cuentas')}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 shrink-0">
          <div className="flex items-center gap-3">
            <Users className="w-5 h-5 text-primary" />
            <Heading level={2} weight="semibold" color="primary">
              {t('admin.dedup.manualMerge.title', 'Unificar manualmente')}
            </Heading>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-primary transition-colors"
            aria-label={t('admin.dedup.merge.close', 'Cerrar')}
          >
            <X size={24} />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-5 p-6">
          <Text size="sm" color="muted" as="p">
            {t(
              'admin.dedup.manualMerge.description',
              'Buscá dos cuentas por nombre o teléfono y compará para unificarlas, aunque no estén en la fila automática.',
            )}
          </Text>

          {/* Account A */}
          <div className="relative">
            <CandidateAutocomplete
              id="manual-account-a"
              label={t('admin.dedup.manualMerge.accountA', 'Primera cuenta')}
              selected={accountA}
              onSearch={handleSearch}
              onSelect={setAccountA}
              onClear={() => setAccountA(null)}
              disabledIds={accountB ? [accountB.id] : []}
            />
          </div>

          {/* Account B */}
          <div className="relative">
            <CandidateAutocomplete
              id="manual-account-b"
              label={t('admin.dedup.manualMerge.accountB', 'Segunda cuenta')}
              selected={accountB}
              onSearch={handleSearch}
              onSelect={setAccountB}
              onClear={() => setAccountB(null)}
              disabledIds={accountA ? [accountA.id] : []}
            />
          </div>

          {/* Same-id guard */}
          {accountA && accountB && accountA.id === accountB.id && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <Text size="sm" color="inherit" className="text-amber-800">
                {t(
                  'admin.dedup.manualMerge.sameAccountError',
                  'Las dos cuentas elegidas son la misma. Elegí cuentas distintas.',
                )}
              </Text>
            </div>
          )}

          {/* API error */}
          {buildError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <Text size="sm" color="inherit" className="text-red-700">
                {buildError}
              </Text>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 shrink-0">
          <Button variant="outline" size="sm" onClick={onClose} disabled={isBuilding}>
            {t('admin.dedup.merge.cancel', 'Cancelar')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleCompare}
            disabled={!canCompare || isBuilding}
            data-testid="manual-compare-btn"
            aria-label={t('admin.dedup.manualMerge.compareAriaLabel', 'Comparar y unificar las dos cuentas seleccionadas')}
          >
            {isBuilding ? (
              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <GitMerge className="w-4 h-4 mr-2" />
            )}
            {isBuilding
              ? t('admin.dedup.manualMerge.comparing', 'Cargando...')
              : t('admin.dedup.manualMerge.compare', 'Comparar y unificar')}
          </Button>
        </div>
      </div>
    </div>
  );
}
