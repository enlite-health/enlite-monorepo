/**
 * AddressHasVacancyDialog
 *
 * Warns the operator that the selected `patient_address_id` already has at
 * least one vacancy attached (not soft-deleted, not CLOSED).
 *
 * Behavior split by vacancy status:
 *   - Drafts (`is_draft = true`) → mostly handled by ResumeDraftVacancyDialog
 *     (per-patient). This dialog focuses on the published/operational case.
 *   - Published (status in SEARCHING / SEARCHING_REPLACEMENT / RAPID_RESPONSE)
 *     OR ACTIVE / PENDING_ACTIVATION post-create → operator is invited to
 *     edit the existing vacancy or close it before creating a new one.
 *
 * UX:
 *   - Blocking modal (operator must explicitly choose "Edit existing" or
 *     "Continue creating anyway").
 *   - Click "Edit existing" navigates to /admin/vacancies/:id/edit (drafts)
 *     or /admin/vacancies/:id (operational) — caller wires the navigation.
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowUpRight } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import type { VacancyByAddressSummary } from '@domain/entities/VacancyDraft';

export interface AddressHasVacancyDialogProps {
  isOpen: boolean;
  vacancies: VacancyByAddressSummary[];
  /** Called when the operator clicks "Edit existing" for one of the vacancies */
  onEditExisting: (vacancy: VacancyByAddressSummary) => void;
  /** Called when the operator chooses to create a new vacancy anyway */
  onContinueCreating: () => void;
  /** Called when the operator closes / cancels — reverts the address selection */
  onCancel: () => void;
}

export function AddressHasVacancyDialog({
  isOpen,
  vacancies,
  onEditExisting,
  onContinueCreating,
  onCancel,
}: AddressHasVacancyDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const k = (key: string, opts?: Record<string, unknown>) =>
    t(`admin.createVacancyV2.addressHasVacancyDialog.${key}`, opts);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen || vacancies.length === 0) return null;

  const count = vacancies.length;
  const titleKey = count === 1 ? 'titleSingular' : 'titlePlural';

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"
      data-testid="address-has-vacancy-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="address-has-vacancy-title"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-[10px] p-6 max-w-lg w-full mx-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 mb-4">
          <div className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-full bg-amber-100">
            <AlertTriangle size={20} className="text-amber-600" aria-hidden="true" />
          </div>
          <Heading level={3} id="address-has-vacancy-title" weight="semibold" color="primary">
            {k(titleKey)}
          </Heading>
        </div>

        {/* Description */}
        <Text size="sm" color="secondary" className="mb-5">
          {k('description', { count })}
        </Text>

        {/* Vacancy list */}
        <ul className="flex flex-col gap-3 mb-5" role="list">
          {vacancies.map((vac) => {
            const statusLabel = t(
              `admin.vacancyDetail.vacancyForm.statusOptions.${vac.status}`,
              { defaultValue: vac.status },
            );
            return (
              <li
                key={vac.id}
                data-testid={`address-vacancy-item-${vac.id}`}
                className="flex items-center justify-between gap-4 rounded-[10px] border border-gray-200 bg-gray-50 px-4 py-3"
              >
                <div className="flex flex-col min-w-0">
                  <Text size="sm" weight="semibold" color="primary">
                    {vac.title}
                  </Text>
                  <Text size="xs" color="muted">
                    {statusLabel}
                    {vac.is_draft ? ` · ${k('draftBadge')}` : ''}
                  </Text>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onEditExisting(vac)}
                  data-testid={`address-vacancy-edit-${vac.id}`}
                  className="flex items-center gap-1"
                >
                  {k('editButton')}
                  <ArrowUpRight size={14} aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>

        {/* Footer actions */}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            data-testid="address-has-vacancy-cancel"
          >
            {k('cancelButton')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onContinueCreating}
            data-testid="address-has-vacancy-continue"
          >
            {k('continueButton')}
          </Button>
        </div>
      </div>
    </div>
  );
}
