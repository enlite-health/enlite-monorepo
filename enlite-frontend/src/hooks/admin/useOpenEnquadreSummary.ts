/**
 * useOpenEnquadreSummary — "baixar resumo" da linha do evento de enquadre (spec 052, Fase 3): pede a URL assinada A CADA CLIQUE
 * (300 s, nunca guardada) e abre em aba nova. Mesmo desenho de `useOpenPatientDocument`: a aba abre NO MESMO TICK do clique (antes do
 * `await`, senão o bloqueador de pop-up barra), sem `noopener` (devolveria `null`) — `popup.opener = null` cobre o mesmo risco — e fecha
 * sozinha depois de um tempo fixo, porque a URL vem com `Content-Disposition: attachment`.
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminEnquadreSummaryApiService } from '@infrastructure/http/AdminEnquadreSummaryApiService';

const CLOSE_AFTER_MS = 2000;

export function useOpenEnquadreSummary(vacancyId: string, eventId: string): {
  error: string | null;
  open: () => Promise<void>;
} {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async (): Promise<void> => {
    setError(null);
    const popup = window.open('', '_blank');
    if (!popup) {
      setError(t('admin.vacancyDetail.enquadre.seals.popupBlocked'));
      return;
    }
    popup.opener = null;
    try {
      const { url } = await AdminEnquadreSummaryApiService.getSummaryUrl(vacancyId, eventId);
      popup.location.href = url;
      window.setTimeout(() => {
        if (!popup.closed) popup.close();
      }, CLOSE_AFTER_MS);
    } catch {
      popup.close();
      setError(t('admin.vacancyDetail.enquadre.seals.downloadError'));
    }
  }, [vacancyId, eventId, t]);

  return { error, open };
}
