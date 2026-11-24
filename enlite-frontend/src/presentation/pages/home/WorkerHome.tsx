import { useTranslation } from 'react-i18next';
import { useAuth } from '@presentation/hooks/useAuth';
import { useState, useEffect, useMemo } from 'react';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';
import { AppLayout } from '@presentation/components/templates/DashboardLayout';
import { JobsEmbeddedSection } from '@presentation/components/features/worker/JobsEmbeddedSection';
import { JobsRadiusMap } from '@presentation/components/features/worker/JobsRadiusMap';
import { RegistrationLockedNotice } from '@presentation/components/features/worker/JobsRadiusMap/RegistrationLockedNotice';
import { HomeLoadErrorNotice } from '@presentation/components/features/worker/JobsRadiusMap/HomeLoadErrorNotice';
import { DEFAULT_RADIUS_KM, itemsWithin, nearestFallback } from '@presentation/components/features/worker/JobsRadiusMap/radiusScope';
import { useWorkerJobsByRadius } from '@presentation/hooks/useWorkerJobsByRadius';
import type { JobRadiusKm } from '@domain/entities/WorkerJobByRadius';
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
  // Falha ao carregar /me ou a disponibilidade ≠ cadastro incompleto: cartão de erro com "Reintentar", nunca o bloco de cadastro.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
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

  // 096: mapa por raio. Uma chamada (100 km, perfil de match); o slider filtra no cliente. Cadastro incompleto ⇒ bloco
  // genérico (sem listar o que falta) NO LUGAR do mapa e da lista (nem a pública). Falha da rota ⇒ FALHA
  // FECHADA: cartão de erro com "Reintentar", sem mapa, vagas nem lista pública. Conta inativa ⇒ `radiusScope` null e a lista
  // pública segue inteira, com o cartão do mapa no topo.
  const [attempt, setAttempt] = useState(0);
  // Cadastro incompleto (ou ainda não apurado = fail-closed) ⇒ bloco genérico no lugar do mapa e da lista, e a rota
  // `/workers/me/jobs` (e o Google Maps) nem são acionados: o hook só é habilitado com o cadastro COMPLETO segundo o servidor.
  const radiusState = useWorkerJobsByRadius(Boolean(user?.id) && !isLoading && isFullyRegistered, attempt);
  const isLocked = !isLoading && !loadFailed && (!isFullyRegistered || radiusState.status === 'incomplete');

  const [radiusKm, setRadiusKm] = useState<JobRadiusKm>(DEFAULT_RADIUS_KM);
  // Nada em 100 km mas há vagas mais longe (`nearest`): a lista mostra as mais próximas, em vez de vazia.
  const nearest = radiusState.status === 'ok' ? nearestFallback(radiusState.data) : null;
  const radiusScope = useMemo(() => {
    if (radiusState.status !== 'ok') return null;
    const scoped = nearestFallback(radiusState.data) ?? itemsWithin(radiusState.data.items, radiusKm);
    return Object.fromEntries(scoped.map((i) => [i.id, i.distance_km]));
  }, [radiusState, radiusKm]);

  useEffect(() => {
    const fetchWorkerData = async () => {
      if (!user?.id) return;
      setIsLoading(true);
      setLoadFailed(false);

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
        setLoadFailed(true);
      } finally {
        setIsLoading(false);
      }
    };

    fetchWorkerData();
  }, [user?.id, getProgress, getAvailability, loadAttempt]);

  return (
    <AppLayout navItems={navItems} userName={user?.name || t('common.userFallback')} userAvatar={profilePhoto || undefined}>
      <TopNavbar userName={user?.name || t('common.userFallback')} className="w-full mb-6" />

      {!isLoading && !loadFailed && hasPendingTasks && (
        <PendingTasksCard
          missingFields={missingFields as string[]}
          profession={workerData?.profession}
          country={workerData?.country}
          className="mb-8"
        />
      )}

      {isLoading && <div data-testid="radius-loading" className="mb-6 h-24 animate-pulse rounded-[20px] bg-gray-100" />}
      {isLocked && <RegistrationLockedNotice />}
      {!isLoading && loadFailed && <HomeLoadErrorNotice onRetry={() => setLoadAttempt((n) => n + 1)} />}
      {!isLoading && !isLocked && !loadFailed && radiusState.status === 'error' && <HomeLoadErrorNotice onRetry={() => setAttempt((n) => n + 1)} />}
      {!isLoading && !isLocked && !loadFailed && <JobsRadiusMap state={radiusState} radiusKm={radiusKm} onRadiusChange={setRadiusKm} />}

      {/* Sem lista enquanto carrega (evita o "pisca" da lista pública), com cadastro incompleto ou com a rota da home falhando. */}
      {!isLoading && !isLocked && !loadFailed && radiusState.status !== 'error' && radiusState.status !== 'loading' && (
        <JobsEmbeddedSection
          radiusScope={radiusScope}
          nearestFallback={nearest !== null}
          isRegistrationComplete={isFullyRegistered}
          missingFields={workerData?.missingFields ?? null}
          profession={workerData?.profession}
        />
      )}
    </AppLayout>
  );
};
