/**
 * MergePhoneModeBody
 *
 * Phone-flow body for MergeCompareModal (Onda 2/3).
 * Fetches detail via useDedupGroupDetail; shows field-level comparison
 * (Advanced section) when conflicts exist.
 *
 * Extracted from MergeCompareModal to keep each file ≤400 lines.
 */

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, AlertCircle, GitMerge } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { useDedupGroupDetail } from '@hooks/admin/useDedupGroupDetail';
import { MergeAccountCard } from './MergeAccountCard';
import { MergeAdvancedFields } from './MergeAdvancedFields';
import { MergeMismatchAlert } from './MergeMismatchAlert';
import type { MergeRequest } from '@domain/entities/DedupGroup';

interface MergePhoneModeBodyProps {
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

export function MergePhoneModeBody({
  phoneNormalized,
  onClose,
  onMergeSuccess,
}: MergePhoneModeBodyProps) {
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

  useEffect(() => {
    if (detail && !survivorId) {
      setSurvivorId(detail.survivor_suggested);
    }
  }, [detail, survivorId]);

  const handleFieldChoiceChange = useCallback(
    (field: string, accountId: string) => {
      setFieldChoices((prev) => ({ ...prev, [field]: accountId }));
    },
    [],
  );

  async function handleMerge() {
    // Guard: detail/survivorId null only during loading/error states — the
    // confirm button is rendered only when both are truthy (line 129 condition).
    // This is an exhaustiveness guard; dead branch in normal UI flow.
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

  // Defensive: backend contract is field_comparisons (plural). Optional-chaining
  // + default so an unexpected/legacy payload never crashes the modal
  // (prod incident: undefined.filter when backend sent the singular key).
  const conflictCount =
    detail?.field_comparisons?.filter((f) => f.has_conflict)?.length ?? 0;

  return (
    // Root: flex column that fills the remaining card space (flex-1) and allows
    // shrink below its content size (min-h-0) — essential for overflow-y-auto
    // on the scrollable child to actually kick in inside a flex container.
    <div className="flex flex-col flex-1 min-h-0">
      {/* Phone label — fixed, does not scroll */}
      <div className="px-6 pt-4 shrink-0">
        <Text size="sm" color="muted">
          {t('admin.dedup.merge.phone', 'Teléfono')}:{' '}
          <Text as="span" size="sm" weight="semibold">
            {phoneNormalized}
          </Text>
        </Text>
      </div>

      {/* Scrollable body — grows to fill available space and scrolls when content
          overflows (e.g. 9 conflicting fields in the Advanced section). */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 mt-4 flex flex-col gap-4">
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
            <MergeMismatchAlert conflictCount={conflictCount} />
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
            {(detail.reparent_preview?.length ?? 0) > 0 && (
              <div className="bg-slate-50 rounded-xl p-4">
                <Text size="xs" weight="semibold" color="muted" as="p">
                  {t('admin.dedup.merge.reparentTitle', 'Se van a reasignar al principal:')}
                </Text>
                <div className="flex flex-wrap gap-2 mt-2">
                  {(detail.reparent_preview ?? []).map((rp) => (
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
            <MergeAdvancedFields
              fieldComparisons={detail.field_comparisons ?? []}
              accounts={detail.accounts}
              survivorId={survivorId}
              fieldChoices={fieldChoices}
              onFieldChoiceChange={handleFieldChoiceChange}
            />
            {mergeError && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                <Text size="sm" color="inherit">{mergeError}</Text>
              </div>
            )}
          </>
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
  );
}
