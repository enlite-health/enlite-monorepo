import { useTranslation } from 'react-i18next';
import { useAuth } from '@presentation/hooks/useAuth';
import { useState, useEffect } from 'react';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';
import { AppLayout } from '@presentation/components/templates/DashboardLayout';
import { JobsEmbeddedSection } from '@presentation/components/features/worker/JobsEmbeddedSection';
import { useWorkerNavItems } from '@presentation/config/workerNavigation';
import { TopNavbar } from '@presentation/components/templates/DashboardLayout/TopNavbar';
import { PendingTasksCard } from '@presentation/components/organisms/PendingTasksCard';
import { useWorkerRegistrationStore } from '@presentation/stores/workerRegistrationStore';
import { identifyClarity } from '@infrastructure/analytics/clarity';
import type { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';

export const WorkerHome = (): JSX.Element => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { getProgress, getAvailability } = useWorkerApi();
  const [workerData, setWorkerData] = useState<WorkerProgressResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const navItems = useWorkerNavItems();
  const profilePhoto = useWorkerRegistrationStore((state) => state.data.generalInfo.profilePhoto);

  // Completude SÓ do servidor (Fase 1/DD1) — `missingFields` é a MESMA
  // função que decide a postulação (fn_worker_missing_fields), nunca
  // recalculada aqui. `null`/ausente = "não apurei" (camada 0, D302):
  // fail-closed, nunca tratado como completo.
  const missingFields = workerData?.missingFields;
  const isCompletenessKnown = Array.isArray(missingFields);
  const isFullyRegistered = isCompletenessKnown && missingFields.length === 0;
  const hasPendingTasks = isCompletenessKnown && missingFields.length > 0;

  useEffect(() => {
    const fetchWorkerData = async () => {
      if (!user?.id) return;

      try {
        const [data, availability] = await Promise.all([
          getProgress(),
          getAvailability(),
        ]);
        setWorkerData({ ...data, availability: availability.length > 0 ? { slots: availability } : undefined });
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

  return (
    <AppLayout navItems={navItems} userName={user?.name || t('common.userFallback')} userAvatar={profilePhoto || undefined}>
      <TopNavbar userName={user?.name || t('common.userFallback')} className="w-full mb-6" />

      {!isLoading && hasPendingTasks && (
        <PendingTasksCard
          missingFields={missingFields as string[]}
          profession={workerData?.profession}
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
