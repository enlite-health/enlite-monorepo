/**
 * UndoConfirmModal
 *
 * Confirmation modal for undoing a merge in the Deduplication Center.
 *
 * Pattern mirrors MergeCompareModal:
 *   - fixed inset-0 z-40 bg-black/40 backdrop
 *   - Closes on: X button / backdrop click / ESC key
 *   - NO Modal atom (TD-054)
 *
 * Props:
 *   auditId   — the merge audit record to undo
 *   phone     — shown in the dialog to confirm context
 *   isUndoing — disables the confirm button while the request is in-flight
 *   onConfirm — called with auditId when user confirms
 *   onClose   — called to close the modal without acting
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Undo2, RefreshCw } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

export interface UndoConfirmModalProps {
  auditId: string;
  phone: string;
  isUndoing: boolean;
  onConfirm: (auditId: string) => void;
  onClose: () => void;
}

export function UndoConfirmModal({
  auditId,
  phone,
  isUndoing,
  onConfirm,
  onClose,
}: UndoConfirmModalProps) {
  const { t } = useTranslation();
  const h = (key: string) => t(`admin.dedup.history.undo.${key}`);

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
      data-testid="undo-confirm-modal"
    >
      <div
        className="bg-white rounded-card shadow-xl w-full max-w-md flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label={h('dialogLabel')}
      >
        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 shrink-0">
          <div className="flex items-center gap-3">
            <Undo2 className="w-5 h-5 text-primary" />
            <Heading level={2} weight="semibold" color="primary">
              {h('title')}
            </Heading>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-primary transition-colors"
            aria-label={h('close')}
            disabled={isUndoing}
          >
            <X size={24} />
          </button>
        </div>

        {/* ── Body ───────────────────────────────────────────────────────────── */}
        <div className="px-6 py-5 flex flex-col gap-3">
          <Text size="sm" color="inherit">
            {h('description')}
          </Text>
          <div className="bg-slate-50 rounded-xl px-4 py-3">
            <Text size="xs" weight="semibold" color="muted" as="p">
              {t('admin.dedup.table.phone')}
            </Text>
            <Text size="sm" weight="semibold" as="p">
              {phone}
            </Text>
          </div>
          <Text size="xs" color="muted">
            {h('warning')}
          </Text>
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={isUndoing}
          >
            {h('cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => onConfirm(auditId)}
            disabled={isUndoing}
            aria-label={h('confirmAriaLabel')}
            data-testid="undo-confirm-button"
          >
            {isUndoing ? (
              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Undo2 className="w-4 h-4 mr-2" />
            )}
            {isUndoing ? h('undoing') : h('confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
