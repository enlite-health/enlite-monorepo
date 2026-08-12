import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';
import type { WorkerDocumentsResponse } from '@infrastructure/http/DocumentApiService';
import type { WorkerProfileProgress, ProgressSection } from '../../types/workerProgress';
import {
  validateRegistrationSteps,
  getStep1Progress,
  getStep2Progress,
  getStep3Progress,
} from '../utils/workerProgressValidation';
import { getRequiredDocSlugs, getRequiredDocFields } from '../utils/workerDocumentRequirements';

interface UseWorkerProfileProgressResult {
  progress: WorkerProfileProgress;
  isComplete: boolean;
}

export function useWorkerProfileProgress(
  workerData: WorkerProgressResponse | null,
  documentsData?: WorkerDocumentsResponse | null,
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
      step1Progress.completedFields +
      step2Progress.completedFields +
      step3Progress.completedFields;
    const registrationTotalFields =
      step1Progress.totalFields + step2Progress.totalFields + step3Progress.totalFields;

    // Documentos obrigatórios dependem da profissão — regra centralizada em
    // workerDocumentRequirements (espelho frontend de workerDocumentPolicy no backend).
    const requiredSlugs = getRequiredDocSlugs(workerData.profession);
    const requiredFields = getRequiredDocFields(workerData.profession);

    const documentsSteps = requiredSlugs.map((slug, index) => ({
      id: `doc${index + 1}`,
      label: t(`documentTypes.${slug}`),
      completed: !!documentsData?.[requiredFields[index]],
    }));

    const documentsCompleted = documentsSteps.filter((s) => s.completed).length;
    const documentsTotal = documentsSteps.length;

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
        percentage: registrationTotalFields > 0
          ? Math.round((registrationCompletedFields / registrationTotalFields) * 100)
          : 0,
      },
      {
        id: 'documents',
        title: t('profile.progress.documents'),
        icon: '📄',
        steps: documentsSteps.map((step) => ({
          id: step.id,
          label: step.label,
          status: step.completed ? 'completed' : 'pending',
        })),
        completedCount: documentsCompleted,
        totalCount: documentsTotal,
        percentage: Math.round((documentsCompleted / documentsTotal) * 100),
      },
    ];

    const totalFields = registrationTotalFields + documentsTotal;
    const completedFields = registrationCompletedFields + documentsCompleted;
    const overallPercentage = totalFields > 0
      ? Math.round((completedFields / totalFields) * 100)
      : 0;

    const allStepsComplete = stepValidation.step1 && stepValidation.step2 && stepValidation.step3;

    let nextAction;
    if (!allStepsComplete) {
      nextAction = {
        label: t('profile.progress.completeRegistration'),
        route: '/worker-registration',
      };
    } else if (documentsCompleted < documentsTotal) {
      nextAction = {
        label: t('profile.progress.uploadDocuments'),
        route: '/worker/documents',
      };
    }

    return {
      overallPercentage,
      sections,
      nextAction,
    };
  }, [workerData, documentsData, t]);

  const isComplete = progress.overallPercentage === 100;

  return { progress, isComplete };
}
