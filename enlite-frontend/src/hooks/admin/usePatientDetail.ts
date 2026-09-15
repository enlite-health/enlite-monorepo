import { useState, useEffect, useCallback } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientDetail } from '@domain/entities/PatientDetail';

export function usePatientDetail(patientId: string | undefined) {
  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!patientId) return;

    let cancelled = false;

    async function fetchPatient() {
      try {
        setIsLoading(true);
        setError(null);
        const data = await AdminApiService.getPatientById(patientId!);
        if (!cancelled) setPatient(data);
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Falha ao carregar paciente');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchPatient();
    return () => { cancelled = true; };
  }, [patientId]);

  // Item 1+4 (A1): o refetch pós-salvamento é SILENCIOSO — não liga `isLoading`. Ligar
  // `isLoading` aqui fazia a página inteira cair para `<DetailSkeleton/>` (PatientDetailPage.tsx)
  // toda vez que um card salvava, mesmo sem troca de paciente. `isLoading` continua existindo
  // só para o carregamento inicial / troca de `patientId`, acima. Erro no refetch silencioso NÃO
  // apaga a ficha: `patient` some do `setPatient` só é chamado em caso de SUCESSO — falha só seta
  // `error` (mesmo canal que o hook já expõe), mantendo os dados anteriores na tela.
  const refetch = useCallback(() => {
    if (!patientId) return;
    AdminApiService.getPatientById(patientId)
      .then((data) => {
        setPatient(data);
        setError(null);
      })
      .catch((err) => setError(err.message || 'Falha ao carregar paciente'));
  }, [patientId]);

  return { patient, isLoading, error, refetch };
}
