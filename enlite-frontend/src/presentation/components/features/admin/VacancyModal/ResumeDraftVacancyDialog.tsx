/**
 * ResumeDraftVacancyDialog
 *
 * Modal shown when a patient is selected in create mode and the backend
 * already has one or more PENDING_ACTIVATION vacancies for that patient.
 * Gives the user three options:
 *   - Retomar: navigate to /admin/vacancies/:id/edit for a specific draft
 *   - Crear nueva vacante: close modal and keep patient selection (create fresh)
 *   - Cancelar: deselect patient and close modal
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import type { VacancyDraftSummary } from '@domain/entities/VacancyDraft';

// ---------------------------------------------------------------------------
// Relative date helper — native Intl, no date-fns needed
// ---------------------------------------------------------------------------

function formatRelativeTime(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHrs = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHrs / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);

  const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

  if (diffSec < 60) return rtf.format(-diffSec, 'second');
  if (diffMin < 60) return rtf.format(-diffMin, 'minute');
  if (diffHrs < 24) return rtf.format(-diffHrs, 'hour');
  if (diffDays < 7) return rtf.format(-diffDays, 'day');
  if (diffWeeks < 5) return rtf.format(-diffWeeks, 'week');
  return rtf.format(-diffMonths, 'month');
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ResumeDraftVacancyDialogProps {
  isOpen: boolean;
  drafts: VacancyDraftSummary[];
  onResume: (vacancyId: string) => void;
  onCreateNew: () => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ResumeDraftVacancyDialog({
  isOpen,
  drafts,
  onResume,
  onCreateNew,
  onCancel,
}: ResumeDraftVacancyDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const k = (key: string, opts?: Record<string, unknown>) =>
    t(`admin.createVacancyV2.resumeDraftDialog.${key}`, opts);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const count = drafts.length;
  const titleKey = count === 1 ? 'titleSingular' : 'titlePlural';

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"
      data-testid="resume-draft-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="resume-draft-title"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-[10px] p-6 max-w-lg w-full mx-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 mb-4">
          <div className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-full bg-[#180149]/10">
            <Info size={20} className="text-[#180149]" aria-hidden="true" />
          </div>
          <Heading level={3} id="resume-draft-title" weight="semibold" color="primary">
            {k(titleKey)}
          </Heading>
        </div>

        {/* Description */}
        <Text size="sm" color="secondary" className="mb-5">
          {k('description', { count })}
        </Text>

        {/* Draft list */}
        <ul className="flex flex-col gap-3 mb-5" role="list">
          {drafts.map((draft) => (
            <li
              key={draft.id}
              data-testid={`resume-draft-item-${draft.id}`}
              className="flex items-center justify-between gap-4 rounded-[10px] border border-gray-100 bg-gray-50 px-4 py-3"
            >
              <div className="flex flex-col min-w-0">
                <Text size="sm" weight="semibold" color="primary">
                  {draft.title}
                </Text>
                <Text size="xs" color="muted">
                  {k('lastEditedLabel')} {formatRelativeTime(draft.updated_at)}
                </Text>
              </div>
              <Button
                variant="primary"
                size="sm"
                data-testid={`resume-draft-btn-${draft.id}`}
                onClick={() => onResume(draft.id)}
                className="flex-shrink-0 rounded-full h-10 bg-[#180149] hover:bg-[#180149]/90"
              >
                {k('resume')}
              </Button>
            </li>
          ))}
        </ul>

        {/* Divider */}
        <hr className="border-gray-200 mb-4" />

        {/* Footer */}
        <div className="flex flex-col-reverse sm:flex-row items-center justify-end gap-3">
          <Button
            variant="ghost"
            size="sm"
            data-testid="resume-draft-cancel"
            onClick={onCancel}
          >
            {k('cancel')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="resume-draft-create-new"
            onClick={onCreateNew}
          >
            {k('createNew')}
          </Button>
        </div>
      </div>
    </div>
  );
}
