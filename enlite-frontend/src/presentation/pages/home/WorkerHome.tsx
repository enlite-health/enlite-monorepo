import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@presentation/hooks/useAuth';
import { useState, useEffect } from 'react';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';
import { AppLayout } from '@presentation/components/templates/DashboardLayout';
import { JobsEmbeddedSection } from '@presentation/components/features/worker/JobsEmbeddedSection';
import { useWorkerNavItems } from '@presentation/config/workerNavigation';
import { TopNavbar } from '@presentation/components/templates/DashboardLayout/TopNavbar';
import { ProfileCompletionCard } from '@presentation/components/organisms/ProfileCompletionCard';
import { useWorkerProfileProgress } from '@presentation/hooks/useWorkerProfileProgress';
import { useWorkerRegistrationStore } from '@presentation/stores/workerRegistrationStore';
import { DocumentApiService } from '@infrastructure/http/DocumentApiService';
import { validateRegistrationSteps } from '@presentation/utils/workerProgressValidation';
import { areAllRequiredDocsComplete } from '@presentation/utils/workerDocumentRequirements';
import { identifyClarity } from '@infrastructure/analytics/clarity';
import type { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';
import type { WorkerDocumentsResponse } from '@infrastructure/http/DocumentApiService';

export const WorkerHome = (): JSX.Element => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { getProgress, getAvailability } = useWorkerApi();
  const [workerData, setWorkerData] = useState<WorkerProgressResponse | null>(null);
  const [documentsData, setDocumentsData] = useState<WorkerDocumentsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const navItems = useWorkerNavItems();
  const profilePhoto = useWorkerRegistrationStore((state) => state.data.generalInfo.profilePhoto);
  const { progress, isComplete } = useWorkerProfileProgress(workerData, documentsData);
  const steps = workerData ? validateRegistrationSteps(workerData) : null;
  const isRegistrationStepsComplete = steps ? steps.step1 && steps.step2 && steps.step3 : false;
  const isFullyRegistered =
    isRegistrationStepsComplete &&
    areAllRequiredDocsComplete(documentsData, workerData?.profession);

  useEffect(() => {
    const fetchWorkerData = async () => {
      if (!user?.id) return;

      try {
        const [data, docs, availability] = await Promise.all([
          getProgress(),
          DocumentApiService.getDocuments(),
          getAvailability(),
        ]);
        setWorkerData({ ...data, availability: availability.length > 0 ? { slots: availability } : undefined });
        setDocumentsData(docs);
        // Tag do Clarity com identificadores OPACOS (sem PII) para tornar a
        // sessão do worker buscável no suporte — ex.: reproduzir "a app pede
        // documento de novo". Só workerId (UUID) e status.
        identifyClarity(data.authUid, { workerId: data.id, workerStatus: data.status ?? '' });
      } catch (error) {
        console.error('Failed to fetch worker data:', error);
        setWorkerData(null);
      } finally {
        setIsLoading(false);
      }
    };

    fetchWorkerData();
  }, [user?.id, getProgress, getAvailability]);

  // ProfileCompletionCard só desenha (e só chama) este botão quando
  // `progress.nextAction` existe (ProfileCompletionCard.tsx:48 —
  // `{progress.nextAction && (<button onClick={onActionClick}>`) — logo,
  // sempre que isto for de fato invocado, nextAction já é não-nulo.
  const handleActionClick = (): void => {
    navigate(progress.nextAction!.route);
  };

  return (
    <AppLayout navItems={navItems} userName={user?.name || t('common.userFallback')} userAvatar={profilePhoto || undefined}>
      <TopNavbar userName={user?.name || t('common.userFallback')} className="w-full mb-6" />
      
      {!isLoading && !isComplete && (
        <ProfileCompletionCard
          progress={progress}
          onActionClick={handleActionClick}
          className="mb-8"
        />
      )}

      <JobsEmbeddedSection
        isRegistrationComplete={isFullyRegistered}
        missingFields={workerData?.missingFields ?? null}
      />
    </AppLayout>
  );
};
