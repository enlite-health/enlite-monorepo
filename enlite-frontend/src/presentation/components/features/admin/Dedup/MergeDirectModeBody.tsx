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
 * - survivor_reason='conflict_multiple_real_accounts' (2+ real accounts):
 *   · Importados tab (allowConflictOverride falsy) → BLOCKS the merge and shows
 *     a red banner naming the real accounts; each name links to its Fila group
 *     when onNavigateToPhoneGroup is provided.
 *   · Manual-merge flow (allowConflictOverride=true) → does NOT block. The
 *     operator picked these accounts on purpose (same person, maybe different
 *     phone/surname). Shows an amber warning naming which account is KEPT
 *     (principal) and which is DELETED (absorbed), and requires an explicit
 *     "es la misma persona" confirmation before the merge button enables.
 *
 * Extracted from MergeCompareModal to keep each file ≤400 lines.
 */

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { GitMerge, RefreshCw, AlertTriangle } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
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
  /**
   * Called when the operator clicks a real account's name in the conflict
   * banner. The host closes this modal, switches to the Fila tab and opens the
   * phone-group popup for that account's phone. Omitted → names render as plain
   * text (no link).
   */
  onNavigateToPhoneGroup?: (phoneNormalized: string) => void;
  /**
   * Manual-merge flow only. When true, a 2+ real-accounts conflict is NOT
   * hard-blocked: the operator deliberately picked these accounts (same person
   * with a different phone/surname/email), so we show a warning that names which
   * account is kept (principal) and which is deleted (absorbed), and let them
   * confirm explicitly before unifying. The Importados tab leaves this false →
   * keeps the block-and-route-to-Fila behaviour.
   */
  allowConflictOverride?: boolean;
}

/** Nome exibível de uma conta no banner: prioriza nome decriptado, cai no email. */
function accountLabel(account: DedupAccount): string {
  return account.name?.trim() || account.email || account.id;
}

export function MergeDirectModeBody({
  accounts,
  survivorSuggestedId,
  survivorReason,
  onClose,
  onMergeSuccess,
  fieldComparisons,
  onNavigateToPhoneGroup,
  allowConflictOverride,
}: MergeDirectModeBodyProps) {
  const { t } = useTranslation();
  const [survivorId, setSurvivorId] = useState<string>(survivorSuggestedId);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeSuccess, setMergeSuccess] = useState(false);
  const [fieldChoices, setFieldChoices] = useState<Record<string, string>>({});
  // Manual override: operator must tick "es la misma persona" before merging.
  const [confirmedSamePerson, setConfirmedSamePerson] = useState(false);

  // survivor_reason='conflict_multiple_real_accounts' → 2+ contas reais.
  const isConflict = survivorReason === 'conflict_multiple_real_accounts';

  // Manual flow deixa o operador confirmar e unificar; Importados continua
  // bloqueando (manda revisar na Fila).
  const allowOverride = allowConflictOverride === true;
  const blocked = isConflict && !allowOverride;
  const needsConfirm = isConflict && allowOverride;

  // Contas "reais" = não-importadas (mesma regra do backend que dispara o
  // conflito). São essas que o operador precisa revisar — as nomeamos no banner.
  const realAccounts = accounts.filter((a) => !a.is_imported);

  // Quem fica (principal) vs quem é absorvida/eliminada — pro aviso do override.
  const survivorAccount = accounts.find((a) => a.id === survivorId) ?? null;
  const absorbedAccounts = accounts.filter((a) => a.id !== survivorId);

  const handleFieldChoiceChange = useCallback(
    (field: string, accountId: string) => {
      setFieldChoices((prev) => ({ ...prev, [field]: accountId }));
    },
    [],
  );

  async function handleMerge() {
    // Defense-in-depth: button is disabled in these states, so these branches
    // are unreachable in normal UI flow (disabled button doesn't fire onClick).
    if (blocked) return; // Importados conflict → routed to Fila, never merges here.
    if (needsConfirm && !confirmedSamePerson) return; // manual override not confirmed.

    const absorbedIds = accounts
      .map((a) => a.id)
      .filter((id) => id !== survivorId);

    const payload: MergeRequest = {
      survivorId,
      absorbedIds,
      // Auditoria: distingue o fluxo (manual vs aba Importados) e registra a
      // confirmação explícita quando o admin força o merge de 2+ contas reais.
      source: allowOverride ? 'manual' : 'imported',
      ...(needsConfirm ? { confirmedSamePerson } : {}),
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
      {/* Conflict banner (BLOCKED — Importados tab) — fixed above scrollable area.
          Names the real accounts so the operator knows WHO is in conflict; each
          name links to its group in the Fila when a navigation handler exists.
          Manual-merge flow uses the override banner below instead. */}
      {blocked && (
        <div
          className="mx-6 mt-4 bg-red-50 border border-red-200 rounded-xl p-4 flex gap-3 items-start shrink-0"
          data-testid="imported-conflict-banner"
        >
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <Text size="sm" weight="semibold" color="inherit" as="p">
              {t('admin.dedup.imported.conflictTitle', 'Revisión manual requerida')}
            </Text>
            <Text size="xs" color="muted" as="p">
              {t('admin.dedup.imported.conflictDesc', {
                count: realAccounts.length,
                defaultValue:
                  'Hay {{count}} cuentas reales en este grupo — pueden ser personas distintas. Revisalas en la pestaña Fila antes de unificar:',
              })}
            </Text>

            {/* Quién: lista das contas reais. Clicável quando há navegação +
                telefone (abre o popup daquela conta na Fila). */}
            <ul className="mt-2 flex flex-col gap-1" data-testid="conflict-real-accounts">
              {realAccounts.map((account) => {
                const label = accountLabel(account);
                const phone = account.phone_normalized;
                const canNavigate = !!onNavigateToPhoneGroup && !!phone;

                return (
                  <li key={account.id} className="min-w-0">
                    {canNavigate ? (
                      <button
                        type="button"
                        onClick={() => onNavigateToPhoneGroup?.(phone as string)}
                        className="text-left text-red-700 underline underline-offset-2 hover:text-red-900 transition-colors max-w-full truncate"
                        data-testid={`conflict-account-link-${account.id}`}
                        aria-label={t('admin.dedup.imported.conflictAccountAriaLabel', {
                          name: label,
                          defaultValue: 'Ver a {{name}} en la Fila',
                        })}
                      >
                        <Text as="span" size="xs" weight="medium" color="inherit">
                          {label}
                        </Text>
                      </button>
                    ) : (
                      <Text as="span" size="xs" weight="medium" color="inherit" className="text-red-700">
                        {label}
                      </Text>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {/* Conflict banner (OVERRIDE — manual-merge flow). The operator picked these
          accounts on purpose (same person, maybe different phone/surname). We do
          NOT block: we warn that they are different accounts, name which one is
          KEPT (principal) and which is DELETED (absorbed), and require an explicit
          "es la misma persona" confirmation before enabling the merge. */}
      {needsConfirm && (
        <div
          className="mx-6 mt-4 bg-amber-50 border border-amber-300 rounded-xl p-4 flex flex-col gap-3 shrink-0"
          data-testid="manual-conflict-confirm"
        >
          <div className="flex gap-3 items-start">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <Text size="sm" weight="semibold" color="inherit" as="p" className="text-amber-900">
                {t('admin.dedup.merge.conflictManualTitle', 'Atención: son dos cuentas distintas con acceso real')}
              </Text>
              <Text size="xs" color="muted" as="p">
                {t(
                  'admin.dedup.merge.conflictManualDesc',
                  'Al unificar, una cuenta absorbe a la otra: una se queda y la otra se elimina. Confirmá solo si estás seguro de que son la misma persona.',
                )}
              </Text>
            </div>
          </div>

          {/* Quién queda / quién se elimina */}
          <div className="flex flex-col gap-1 pl-8" data-testid="manual-conflict-outcome">
            <Text size="xs" color="inherit" as="p" className="text-green-800">
              {t('admin.dedup.merge.conflictKeeps', 'Se queda')}:{' '}
              <Text as="span" size="xs" weight="semibold" color="inherit">
                {survivorAccount ? accountLabel(survivorAccount) : '—'}
              </Text>{' '}
              {t('admin.dedup.merge.conflictPrincipalLabel', '(principal)')}
            </Text>
            {absorbedAccounts.map((a) => (
              <Text key={a.id} size="xs" color="inherit" as="p" className="text-red-800">
                {t('admin.dedup.merge.conflictDeletes', 'Se elimina')}:{' '}
                <Text as="span" size="xs" weight="semibold" color="inherit">
                  {accountLabel(a)}
                </Text>
              </Text>
            ))}
            <Text size="xs" color="muted" as="p">
              {t(
                'admin.dedup.merge.conflictDeletesHint',
                'Sus datos (postulaciones, documentos, entrevistas) pasan a la cuenta principal. Es reversible desde el Historial.',
              )}
            </Text>
            <Text size="xs" color="muted" as="p">
              {t('admin.dedup.merge.conflictChangePrincipalHint', 'Usá «Hacer principal» en cada tarjeta para elegir cuál se queda.')}
            </Text>
          </div>

          {/* Confirmación explícita */}
          <label className="flex items-center gap-2 pl-8 cursor-pointer select-none">
            <Checkbox
              checked={confirmedSamePerson}
              onChange={() => setConfirmedSamePerson((v) => !v)}
              aria-label={t('admin.dedup.merge.conflictConfirmCheckbox', 'Confirmo que son la misma persona')}
              data-testid="manual-conflict-confirm-checkbox"
            />
            <Text as="span" size="xs" weight="medium" color="inherit">
              {t('admin.dedup.merge.conflictConfirmCheckbox', 'Confirmo que son la misma persona')}
            </Text>
          </label>
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
              onSelectSurvivor={() => !blocked && setSurvivorId(account.id)}
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
            disabled={isMerging || blocked || (needsConfirm && !confirmedSamePerson)}
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
