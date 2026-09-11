import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';
import type { WorkerProfileProgress, ProgressSection } from '../../types/workerProgress';
import {
  validateRegistrationSteps,
  getStep1Progress,
  getStep2Progress,
  getStep3Progress,
} from '../utils/workerProgressValidation';

interface UseWorkerProfileProgressResult {
  progress: WorkerProfileProgress;
  isComplete: boolean;
}

/**
 * Progresso do cadastro do worker — SÓ a parte de REGISTRO (informação
 * geral, endereço de atendimento, disponibilidade).
 *
 * Documentos saíram deste hook na Fase 2 de postulacao-documento-pendente
 * (DD1/DD2, fecha F4). Antes havia DUAS fontes de "documento pendente" na
 * mesma tela: este cálculo local (tratava `profession` NULL como Cuidador —
 * 2 docs) e o portão do servidor (`fn_worker_missing_fields`, trata NULL
 * como AT — 4 docs). A divergência não foi conciliada: foi REMOVIDA — quem
 * precisa saber qual documento falta lê `missingFields` (com os tokens
 * `doc_*` que a Fase 1 já expande no servidor) direto, via `PendingTasksCard`
 * na home. O parâmetro dos documentos do worker que este hook recebia foi
 * removido, não substituído.
 */
export function useWorkerProfileProgress(
  workerData: WorkerProgressResponse | null,
): UseWorkerProfileProgressResult {
  const { t } = useTranslation();

  const progress = useMemo((): WorkerProfileProgress => {
    if (!workerData) {
      return {
        overallPercentage: 0,
        sections: [],
      };
    }

    const stepValidation = validateRegistrationSteps(workerData);
    const step1Progress = getStep1Progress(workerData);
    const step2Progress = getStep2Progress(workerData);
    const step3Progress = getStep3Progress(workerData);

    const registrationSteps = [
      { id: 'step1', label: t('profile.progress.step1'), completed: stepValidation.step1 },
      { id: 'step2', label: t('profile.progress.step2'), completed: stepValidation.step2 },
      { id: 'step3', label: t('profile.progress.step3'), completed: stepValidation.step3 },
    ];

    const registrationCompletedSteps = registrationSteps.filter((s) => s.completed).length;
    const registrationTotalSteps = registrationSteps.length;

    const registrationCompletedFields =
      step1Progress.completedFields + step2Progress.completedFields + step3Progress.completedFields;
    const registrationTotalFields =
      step1Progress.totalFields + step2Progress.totalFields + step3Progress.totalFields;

    const sections: ProgressSection[] = [
      {
        id: 'registration',
        title: t('profile.progress.registration'),
        icon: '📋',
        steps: registrationSteps.map((step) => ({
          id: step.id,
          label: step.label,
          status: step.completed ? 'completed' : 'pending',
        })),
        completedCount: registrationCompletedSteps,
        totalCount: registrationTotalSteps,
        // registrationTotalFields nunca é 0: é a SOMA dos totalFields de step1/2/3, e cada um
        // é TOKENS_BY_TAB[tab].length (workerProgressValidation.ts) — toda aba tem token.
        percentage: Math.round((registrationCompletedFields / registrationTotalFields) * 100),
      },
    ];

    const allStepsComplete = stepValidation.step1 && stepValidation.step2 && stepValidation.step3;

    const nextAction = allStepsComplete
      ? undefined
      : { label: t('profile.progress.completeRegistration'), route: '/worker-registration' };

    return {
      overallPercentage: sections[0].percentage,
      sections,
      nextAction,
    };
  }, [workerData, t]);

  const isComplete = progress.overallPercentage === 100;

  return { progress, isComplete };
}
