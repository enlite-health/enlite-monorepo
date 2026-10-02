/**
 * useOpenPatientDocument — "Ver" da aba "Documentos" (spec 031, FR-006): pede a URL assinada A CADA
 * CLIQUE (300 s, nunca guardada) e abre em aba nova.
 *
 * 🔒 Mesmo desenho do download de anexo do chat (`MessageAttachments.useAttachmentDownload`, que já
 * fechou estes achados em prd): a aba abre NO MESMO TICK do clique (antes do `await`, senão o
 * bloqueador de pop-up barra), SEM `noopener` no `window.open` (devolveria `null` e não haveria como
 * apontar a aba para a URL) — `popup.opener = null` logo depois cobre o mesmo risco — e fecha sozinha
 * depois de um tempo fixo porque a URL do servidor vem com `Content-Disposition: attachment` (o
 * navegador baixa o arquivo e a aba em branco ficaria sobrando).
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminPatientDocumentsApiService } from '@infrastructure/http/AdminPatientDocumentsApiService';

const CLOSE_AFTER_MS = 2000;

export function useOpenPatientDocument(patientId: string): {
  viewError: string | null;
  openDocument: (docId: string) => Promise<void>;
} {
  const { t } = useTranslation();
  const [viewError, setViewError] = useState<string | null>(null);

  const openDocument = useCallback(async (docId: string): Promise<void> => {
    setViewError(null);
    const popup = window.open('', '_blank');
    if (!popup) {
      setViewError(t('admin.patients.detail.documentsTab.popupBlocked'));
      return;
    }
    popup.opener = null;
    try {
      const { url } = await AdminPatientDocumentsApiService.getPatientDocumentUrl(patientId, docId);
      popup.location.href = url;
      window.setTimeout(() => {
        if (!popup.closed) popup.close();
      }, CLOSE_AFTER_MS);
    } catch {
      popup.close();
      setViewError(t('admin.patients.detail.documentsTab.viewError'));
    }
  }, [patientId, t]);

  return { viewError, openDocument };
}
