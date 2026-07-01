import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, ChevronRight, X, AlertCircle } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ProfileCompletionCard } from '@presentation/components/organisms/ProfileCompletionCard';
import { useWorkerProfileProgress } from '@presentation/hooks/useWorkerProfileProgress';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';
import { validateRegistrationSteps } from '@presentation/utils/workerProgressValidation';
import { areAllRequiredDocsComplete } from '@presentation/utils/workerDocumentRequirements';
import { DocumentApiService } from '@infrastructure/http/DocumentApiService';
import type { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';
import type { WorkerDocumentsResponse } from '@infrastructure/http/DocumentApiService';
import type { TabId } from '@presentation/utils/incompleteFieldDestinations';

interface ProfileCompletionSummaryProps {
  /** Fecha o resumo e volta a editar o perfil. */
  onClose: () => void;
  /** Leva direto à aba pendente dentro do perfil. */
  onGoToTab: (tab: TabId) => void;
}

interface PendingTab {
  tab: TabId;
  label: string;
}

/**
 * Resumo de finalização do cadastro do prestador (P0 do UX review).
 *
 * Fecha o ciclo do fluxo: ao tocar "Finalizar" na última aba, o prestador vê
 * o que ainda falta (com link direto pra cada aba pendente) ou a confirmação
 * de que o cadastro está completo + CTA pra ver vacantes. Reusa o cálculo de
 * progresso canônico (`useWorkerProfileProgress`) já usado na Home.
 *
 * Ver docs/features/worker-registration-ux/ux-review-2026-06-28.md.
 */
export function ProfileCompletionSummary({
  onClose,
  onGoToTab,
}: ProfileCompletionSummaryProps): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { getProgress, getAvailability } = useWorkerApi();

  const [workerData, setWorkerData] = useState<WorkerProgressResponse | null>(null);
  const [documentsData, setDocumentsData] = useState<WorkerDocumentsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const { progress, isComplete } = useWorkerProfileProgress(workerData, documentsData);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const [data, docs, availability] = await Promise.all([
          getProgress(),
          DocumentApiService.getDocuments(),
          getAvailability(),
        ]);
        if (cancelled) return;
        setWorkerData({
          ...data,
          availability: availability.length > 0 ? { slots: availability } : undefined,
        });
        setDocumentsData(docs);
      } catch {
        if (!cancelled) setWorkerData(null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [getProgress, getAvailability]);

  const pendingTabs: PendingTab[] = (() => {
    if (!workerData) return [];
    const steps = validateRegistrationSteps(workerData);
    const out: PendingTab[] = [];
    if (!steps.step1) out.push({ tab: 'general', label: t('profile.tabs.general', 'Información General') });
    if (!steps.step2) out.push({ tab: 'address', label: t('profile.tabs.address', 'Dirección de Atención') });
    if (!steps.step3) out.push({ tab: 'availability', label: t('profile.tabs.availability', 'Disponibilidad') });
    if (!areAllRequiredDocsComplete(documentsData, workerData.profession)) {
      out.push({ tab: 'documents', label: t('profile.tabs.documents', 'Documentos') });
    }
    return out;
  })();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4"
      onClick={onClose}
      data-testid="profile-completion-summary"
    >
      <div
        className="bg-white rounded-2xl shadow-xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <Heading level={2} weight="semibold" color="primary">
            {t('profile.summary.title', 'Resumen de tu registro')}
          </Heading>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close', 'Cerrar')}
            data-testid="summary-close"
            className="p-1 rounded-full hover:bg-gray-100 transition-colors"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {isLoading ? (
          <div className="animate-pulse space-y-3" data-testid="summary-loading">
            <div className="h-6 bg-gray-200 rounded w-2/3" />
            <div className="h-24 bg-gray-200 rounded" />
          </div>
        ) : isComplete ? (
          <div className="flex flex-col items-center text-center gap-3 py-4" data-testid="summary-complete">
            <CheckCircle2 className="w-14 h-14 text-green-500" />
            <Heading level={3} weight="semibold" color="secondary">
              {t('profile.summary.allDone', '¡Tu registro está completo!')}
            </Heading>
            <Text size="sm" color="muted">
              {t('profile.summary.allDoneBody', 'Ya podés postularte a las vacantes disponibles.')}
            </Text>
            <Button
              type="button"
              variant="primary"
              size="md"
              className="mt-2"
              data-testid="summary-view-vacancies"
              onClick={() => navigate('/')}
            >
              {t('profile.summary.viewVacancies', 'Ver vacantes')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4" data-testid="summary-pending">
            <ProfileCompletionCard progress={progress} />

            <div className="flex flex-col gap-2">
              <Text size="sm" weight="semibold" color="primary">
                {t('profile.summary.pendingIntro', 'Te falta completar:')}
              </Text>
              {pendingTabs.map((p) => (
                <button
                  key={p.tab}
                  type="button"
                  data-testid={`summary-pending-${p.tab}`}
                  onClick={() => onGoToTab(p.tab)}
                  className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-left transition-colors hover:bg-amber-100 group"
                >
                  <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                  <Text as="span" size="sm" weight="medium" color="inherit" className="text-amber-900 flex-1">
                    {p.label}
                  </Text>
                  <ChevronRight className="w-4 h-4 text-amber-500 shrink-0 group-hover:translate-x-0.5 transition-transform" />
                </button>
              ))}
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="ghost" size="sm" onClick={onClose} data-testid="summary-keep-editing">
                {t('profile.summary.keepEditing', 'Seguir editando')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
