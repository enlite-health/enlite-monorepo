import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@presentation/hooks/useAuth';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';
import { Text } from '@presentation/components/atoms';
import { WorkerInitOutcomePanel } from '@presentation/components/features/auth/WorkerInitOutcomePanel';
import { clearInitOutcome, readInitOutcome, runWorkerInit, type WorkerInitOutcome } from '@presentation/utils/workerInitOutcome';

/**
 * 1º login cujo init não deu `ok` (DP-20): código do claim, "Revisá tu correo" ou espera do 429.
 * Lê o resultado que o `useAreaDestination` deixou (o OTP já saiu); sem ele (página recarregada),
 * refaz o init. Resolvido, volta ao `/login`, que com a sessão ativa refaz a decisão de destino.
 */
export function WorkerAccountCheckPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { initWorker } = useWorkerApi();
  const [outcome, setOutcome] = useState<Exclude<WorkerInitOutcome, { kind: 'ok' }> | null>(() => readInitOutcome());
  // Um init só por montagem (o StrictMode roda o efeito duas vezes: seriam dois SMS).
  const initStarted = useRef(false);

  const backToDestination = (): void => {
    clearInitOutcome();
    navigate('/login', { replace: true });
  };

  useEffect(() => {
    if (outcome || !user?.id || initStarted.current) return;
    initStarted.current = true;
    let cancelled = false;
    runWorkerInit(() => initWorker({}))
      .then((o) => {
        if (cancelled) return;
        if (o.kind === 'ok') backToDestination();
        else setOutcome(o);
      })
      .catch(() => { if (!cancelled) backToDestination(); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só no 1º render com usuário
  }, [user?.id]);

  return (
    <div className="flex min-h-screen w-screen items-center justify-center bg-gray-50" data-testid="worker-account-check">
      {outcome && user ? (
        <WorkerInitOutcomePanel
          outcome={outcome}
          authUid={user.id}
          email={user.email}
          onResolved={backToDestination}
          onRetry={backToDestination}
          onCancel={() => { clearInitOutcome(); void logout().then(() => navigate('/login', { replace: true })); }}
        />
      ) : (
        <Text size="sm" color="secondary">{t('claim.checkPage.loading')}</Text>
      )}
    </div>
  );
}
