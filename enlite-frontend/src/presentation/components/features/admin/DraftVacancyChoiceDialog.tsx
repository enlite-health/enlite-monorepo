/**
 * DraftVacancyChoiceDialog
 *
 * Fase 3 (`completar-vacante-em-rascunho`, D425/D426, F25) — clique numa linha em rascunho
 * na lista de vagas, para quem tem `talentum:update` + `vacancy:update`: "¿Qué querés hacer
 * con este borrador?", com duas ações — "Completar vacante" (→ `/edit`, o wizard) e "Solo
 * visualizar" (→ `/borrador`, a tela própria da Fase 2) — mais "Cancelar". Quem não tem as
 * células nunca vê este modal (`AdminVacanciesPage.tsx` decide antes de abrir).
 *
 * Mesmo padrão de `VacancyModal/ResumeDraftVacancyDialog.tsx`: `role="dialog"`, Escape fecha,
 * clique no backdrop fecha (mesma ação de "Cancelar").
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Button } from '@presentation/components/atoms/Button';

export interface DraftVacancyChoiceDialogProps {
  isOpen: boolean;
  vacancyId: string | null;
  onComplete: (vacancyId: string) => void;
  onViewOnly: (vacancyId: string) => void;
  onCancel: () => void;
}

export function DraftVacancyChoiceDialog({
  isOpen,
  vacancyId,
  onComplete,
  onViewOnly,
  onCancel,
}: DraftVacancyChoiceDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const k = (key: string) => t(`admin.vacancies.draftChoiceDialog.${key}`);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen || !vacancyId) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"
      data-testid="draft-vacancy-choice-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="draft-vacancy-choice-title"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-[10px] p-6 max-w-md w-full mx-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-5">
          <div className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-full bg-[#180149]/10">
            <FileText size={20} className="text-[#180149]" aria-hidden="true" />
          </div>
          <Heading level={3} id="draft-vacancy-choice-title" weight="semibold" color="primary">
            {k('title')}
          </Heading>
        </div>

        <div className="flex flex-col gap-3 mb-5">
          <Button
            variant="primary"
            size="md"
            data-testid="choice-complete"
            onClick={() => onComplete(vacancyId)}
            className="w-full rounded-full h-11 bg-[#180149] hover:bg-[#180149]/90"
          >
            {t('admin.vacancies.completeVacancy')}
          </Button>
          <Button
            variant="outline"
            size="md"
            data-testid="choice-view"
            onClick={() => onViewOnly(vacancyId)}
            className="w-full rounded-full h-11"
          >
            {k('viewOnly')}
          </Button>
        </div>

        <hr className="border-gray-200 mb-4" />

        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            data-testid="draft-vacancy-choice-cancel"
            onClick={onCancel}
          >
            {k('cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
}
