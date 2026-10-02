/**
 * usePatientDocuments — lista e mutações da aba "Documentos" da ficha (spec 031, D463).
 *
 * A lista tem UMA fonte (o GET). Cada mutação atualiza o estado local com o que o servidor devolveu
 * (subir → no topo, a ordem é `created_at` desc; renomear → troca o item; excluir → tira o item),
 * sem refazer o GET. Erro de mutação PROPAGA — quem chama decide a mensagem (nunca `catch` mudo).
 * Falha da carga inicial vira `status: 'error'`.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  AdminPatientDocumentsApiService,
  type PatientDocument,
} from '@infrastructure/http/AdminPatientDocumentsApiService';

export type PatientDocumentsStatus = 'loading' | 'ok' | 'error';

export interface UsePatientDocumentsResult {
  documents: PatientDocument[];
  status: PatientDocumentsStatus;
  upload: (label: string, file: File) => Promise<void>;
  rename: (docId: string, label: string) => Promise<void>;
  remove: (docId: string) => Promise<void>;
}

export function usePatientDocuments(patientId: string): UsePatientDocumentsResult {
  const [documents, setDocuments] = useState<PatientDocument[]>([]);
  const [status, setStatus] = useState<PatientDocumentsStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    AdminPatientDocumentsApiService.listPatientDocuments(patientId)
      .then((list) => {
        if (cancelled) return;
        setDocuments(list);
        setStatus('ok');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => { cancelled = true; };
  }, [patientId]);

  const upload = useCallback(async (label: string, file: File): Promise<void> => {
    const created = await AdminPatientDocumentsApiService.uploadPatientDocument(patientId, label, file);
    setDocuments((prev) => [created, ...prev]);
  }, [patientId]);

  const rename = useCallback(async (docId: string, label: string): Promise<void> => {
    const updated = await AdminPatientDocumentsApiService.renamePatientDocument(patientId, docId, label);
    setDocuments((prev) => prev.map((d) => (d.id === docId ? updated : d)));
  }, [patientId]);

  const remove = useCallback(async (docId: string): Promise<void> => {
    await AdminPatientDocumentsApiService.deletePatientDocument(patientId, docId);
    setDocuments((prev) => prev.filter((d) => d.id !== docId));
  }, [patientId]);

  return { documents, status, upload, rename, remove };
}
