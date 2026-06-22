/**
 * MergeCompareModal
 *
 * Compare & Merge modal for the Deduplication Center.
 *
 * Pattern: fixed inset-0 z-40 bg-black/40 + X lucide close.
 * Closes on: X button / backdrop click / ESC key.
 * NO Modal atom (TD-054 — see FOLLOWUPS.md).
 *
 * Hybrid model:
 *   - Default: survivor-takes-all + fills empty fields from absorbed accounts
 *   - Advanced (collapsed): field-level picker, shown only when conflicts exist
 */

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, GitMerge, RefreshCw, AlertCircle } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { useDedupGroupDetail } from '@hooks/admin/useDedupGroupDetail';
import { MergeAccountCard } from './MergeAccountCard';
import { MergeAdvancedFields } from './MergeAdvancedFields';
import { MergeMismatchAlert } from './MergeMismatchAlert';
import type { MergeRequest } from '@domain/entities/DedupGroup';

interface MergeCompareModalProps {
  phoneNormalized: string;
  onClose: () => void;
  onMergeSuccess: () => void;
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-4 animate-pulse p-6">
      <div className="h-6 bg-slate-100 rounded w-1/2" />
      <div className="flex gap-4">
        <div className="h-40 bg-slate-100 rounded-xl flex-1" />
        <div className="h-40 bg-slate-100 rounded-xl flex-1" />
      </div>
      <div className="h-24 bg-slate-50 rounded-xl" />
    </div>
  );
}

export function MergeCompareModal({
  phoneNormalized,
  onClose,
  onMergeSuccess,
}: MergeCompareModalProps) {
  const { t } = useTranslation();
  const {
    detail,
    isLoading,
    error,
    refetch,
    isMerging,
    mergeError,
    merge,
  } = useDedupGroupDetail(phoneNormalized);

  const [survivorId, setSurvivorId] = useState<string | null>(null);
  const [fieldChoices, setFieldChoices] = useState<Record<string, string>>({});
  const [mergeSuccess, setMergeSuccess] = useState(false);

  // Set default survivor when detail loads
  useEffect(() => {
    if (detail && !survivorId) {
      setSurvivorId(detail.survivor_suggested);
    }
  }, [detail, survivorId]);

  // ESC key closes modal
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleFieldChoiceChange = useCallback(
    (field: string, accountId: string) => {
      setFieldChoices((prev) => ({ ...prev, [field]: accountId }));
    },
    [],
  );

  async function handleMerge() {
    if (!detail || !survivorId) return;

    const absorbedIds = detail.accounts
      .map((a) => a.id)
      .filter((id) => id !== survivorId);

    const payload: MergeRequest = {
      survivorId,
      absorbedIds,
      ...(Object.keys(fieldChoices).length > 0 ? { fieldChoices } : {}),
    };

    try {
      await merge(payload);
      setMergeSuccess(true);
      setTimeout(() => {
        onMergeSuccess();
        onClose();
      }, 1200);
    } catch {
      // mergeError is set by the hook
    }
  }

  const conflictCount =
    detail?.field_comparisons.filter((f) => f.has_conflict).length ?? 0;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="dedup-merge-modal"
    >
      <div
        className="bg-white rounded-card shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label={t('admin.dedup.merge.dialogLabel', 'Comparar y unificar cuentas')}
      >
        {/* ── Header ─────────────────────────────────────────────────────────── */}
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

        {/* ── Phone label ────────────────────────────────────────────────────── */}
        <div className="px-6 pt-4 shrink-0">
          <Text size="sm" color="muted">
            {t('admin.dedup.merge.phone', 'Teléfono')}: {' '}
            <Text as="span" size="sm" weight="semibold">{phoneNormalized}</Text>
          </Text>
        </div>

        {/* ── Body ───────────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-6 pb-6 mt-4 flex flex-col gap-4">
          {isLoading && <LoadingSkeleton />}

          {!isLoading && error && (
            <div className="flex flex-col items-center gap-4 py-12 text-center">
              <AlertCircle className="w-10 h-10 text-red-400" />
              <Text size="sm" color="muted">{error}</Text>
              <Button variant="outline" size="sm" onClick={refetch}>
                <RefreshCw className="w-4 h-4 mr-1" />
                {t('admin.dedup.merge.retry', 'Reintentar')}
              </Button>
            </div>
          )}

          {!isLoading && !error && detail && survivorId && (
            <>
              {/* Mismatch alert */}
              <MergeMismatchAlert conflictCount={conflictCount} />

              {/* Account cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {detail.accounts.map((account) => (
                  <MergeAccountCard
                    key={account.id}
                    account={account}
                    isSurvivor={account.id === survivorId}
                    onSelectSurvivor={() => setSurvivorId(account.id)}
                  />
                ))}
              </div>

              {/* Reparent preview */}
              {detail.reparent_preview.length > 0 && (
                <div className="bg-slate-50 rounded-xl p-4">
                  <Text size="xs" weight="semibold" color="muted" as="p">
                    {t('admin.dedup.merge.reparentTitle', 'Se van a reasignar al principal:')}
                  </Text>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {detail.reparent_preview.map((rp) => (
                      <span
                        key={rp.entity}
                        className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full"
                      >
                        <Text as="span" size="xs" weight="medium" color="inherit">
                          {rp.count}{' '}
                          {t(`admin.dedup.entity.${rp.entity}`, {
                            defaultValue: rp.entity,
                          })}
                        </Text>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Advanced field picker */}
              <MergeAdvancedFields
                fieldComparisons={detail.field_comparisons}
                accounts={detail.accounts}
                survivorId={survivorId}
                fieldChoices={fieldChoices}
                onFieldChoiceChange={handleFieldChoiceChange}
              />

              {/* Merge error */}
              {mergeError && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                  <Text size="sm" color="inherit">
                    {mergeError}
                  </Text>
                </div>
              )}
            </>
          )}

          {/* Success state */}
          {mergeSuccess && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <GitMerge className="w-10 h-10 text-green-500" />
              <Text size="sm" weight="semibold" color="inherit">
                {t('admin.dedup.merge.success', 'Unificación realizada con éxito')}
              </Text>
            </div>
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────────── */}
        {!isLoading && !error && detail && !mergeSuccess && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 shrink-0">
            <Button variant="outline" size="sm" onClick={onClose} disabled={isMerging}>
              {t('admin.dedup.merge.cancel', 'Cancelar')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleMerge}
              disabled={isMerging || !survivorId}
              aria-label={t('admin.dedup.merge.confirmAriaLabel', 'Confirmar unificación')}
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
    </div>
  );
}
