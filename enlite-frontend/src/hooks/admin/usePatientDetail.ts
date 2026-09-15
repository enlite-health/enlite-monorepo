import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientDetail } from '@domain/entities/PatientDetail';

export function usePatientDetail(patientId: string | undefined) {
  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Item A1 (regressão apontada pelo gate): guarda a requisição mais recente para o
  // patientId atual. `refetch` não passa pelo efeito de cima (que tem `cancelled` de
  // closure), então uma resposta atrasada de um refetch anterior — ou do refetch de um
  // patientId que já foi trocado — pode sobrescrever o estado depois de uma resposta mais
  // nova já ter chegado. `latestRequestRef` guarda {patientId, seq} do último refetch
  // disparado; só aplica a resposta se ainda for essa combinação no momento em que ela
  // chega.
  const latestRequestRef = useRef({ patientId, seq: 0 });

  useEffect(() => {
    if (!patientId) return;

    let cancelled = false;
    // Troca de `patientId` invalida qualquer refetch pendente do id anterior: zera o
    // contador para este id, então uma resposta atrasada com o patientId antigo nunca
    // bate no `current.patientId !== patientId` do refetch.
    latestRequestRef.current = { patientId, seq: 0 };

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
    const seq = latestRequestRef.current.seq + 1;
    latestRequestRef.current = { patientId, seq };
    AdminApiService.getPatientById(patientId)
      .then((data) => {
        const current = latestRequestRef.current;
        if (current.patientId !== patientId || current.seq !== seq) return;
        setPatient(data);
        setError(null);
      })
      .catch((err) => {
        const current = latestRequestRef.current;
        if (current.patientId !== patientId || current.seq !== seq) return;
        setError(err.message || 'Falha ao carregar paciente');
      });
  }, [patientId]);

  return { patient, isLoading, error, refetch };
}
