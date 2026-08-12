/**
 * MergeCompareModal
 *
 * Shell — Compare & Merge modal for the Deduplication Center.
 *
 * Pattern: fixed inset-0 z-40 bg-black/40 + X lucide close.
 * Closes on: X button / backdrop click / ESC key.
 * NO Modal atom (TD-054 — see FOLLOWUPS.md).
 *
 * --- DRY dual-mode (Onda 4b) ---
 * Props accept two mutually exclusive modes via discriminated union:
 *
 *   Mode A — phone flow (Onda 2/3):
 *     { phoneNormalized: string }
 *     Delegates to MergePhoneModeBody, which fetches detail via
 *     useDedupGroupDetail and shows field-level comparison (Advanced section).
 *
 *   Mode B — direct accounts (Onda 4b imported groups):
 *     { directAccounts, survivorSuggestedId, survivorReason }
 *     Delegates to MergeDirectModeBody — no HTTP fetch, Advanced section hidden.
 *     survivor_reason='conflict_multiple_real_accounts' → merge disabled.
 *
 * This shell owns only: the backdrop overlay, the white card frame,
 * the header (title + close), and the ESC-key handler.
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, GitMerge, Info } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { MergePhoneModeBody } from './MergePhoneModeBody';
import { MergeDirectModeBody } from './MergeDirectModeBody';
import type { ImportedDedupAccount, SurvivorReason } from '@domain/entities/DedupGroup';

// ── Props (discriminated union) ───────────────────────────────────────────────

interface PhoneModeProps {
  /** Phone flow (Onda 2/3): detail fetched from backend. */
  phoneNormalized: string;
  directAccounts?: never;
  survivorSuggestedId?: never;
  survivorReason?: never;
}

interface DirectAccountsModeProps {
  /** Imported-group flow (Onda 4b): accounts supplied directly, no fetch. */
  phoneNormalized?: never;
  directAccounts: ImportedDedupAccount[];
  survivorSuggestedId: string;
  survivorReason: SurvivorReason;
}

type MergeCompareModalProps = (PhoneModeProps | DirectAccountsModeProps) & {
  onClose: () => void;
  onMergeSuccess: () => void;
  /**
   * Direct mode only: clicking a real account's name in the conflict banner
   * jumps to that account's group in the Fila tab. Ignored in phone mode.
   */
  onNavigateToPhoneGroup?: (phoneNormalized: string) => void;
};

// ── Shell ─────────────────────────────────────────────────────────────────────

export function MergeCompareModal(props: MergeCompareModalProps) {
  const { t } = useTranslation();
  const { onClose, onMergeSuccess } = props;
  const isDirectMode = props.directAccounts !== undefined;

  // ESC key closes modal
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="dedup-merge-modal"
    >
      <div
        className="bg-white rounded-card shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label={t('admin.dedup.merge.dialogLabel', 'Comparar y unificar cuentas')}
      >
        {/* Header — shared across both modes */}
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

        {/* Explanatory banner — tells the operator what this screen does and
            what "Principal" means. Simple es-AR copy; shown in both modes. */}
        <div
          className="mx-6 mt-4 flex items-start gap-3 rounded-xl bg-blue-50 border border-blue-100 p-3 shrink-0"
          data-testid="merge-intro-banner"
        >
          <Info className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-0.5">
            <Text size="sm" weight="semibold" color="inherit" as="p">
              {t(
                'admin.dedup.merge.introTitle',
                'Estas cuentas parecen ser la misma persona.',
              )}
            </Text>
            <Text size="xs" color="muted" as="p">
              {t(
                'admin.dedup.merge.introDesc',
                'Elegí cuál es la cuenta PRINCIPAL (la que se queda). Las demás se unen a ella — no se pierde nada.',
              )}
            </Text>
            {isDirectMode && (
              <Text size="xs" color="inherit" as="p" className="text-amber-700 mt-0.5">
                {t(
                  'admin.dedup.merge.introNameMatch',
                  'Coincidencia por NOMBRE: revisá que sean realmente la misma persona antes de unificar.',
                )}
              </Text>
            )}
          </div>
        </div>

        {/* Mode-specific body */}
        {isDirectMode ? (
          <MergeDirectModeBody
            accounts={props.directAccounts}
            survivorSuggestedId={props.survivorSuggestedId}
            survivorReason={props.survivorReason}
            onClose={onClose}
            onMergeSuccess={onMergeSuccess}
            onNavigateToPhoneGroup={props.onNavigateToPhoneGroup}
          />
        ) : (
          <MergePhoneModeBody
            phoneNormalized={props.phoneNormalized}
            onClose={onClose}
            onMergeSuccess={onMergeSuccess}
          />
        )}
      </div>
    </div>
  );
}
