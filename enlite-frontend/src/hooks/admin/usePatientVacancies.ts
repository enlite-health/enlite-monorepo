import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminPatientsApiService } from '@infrastructure/http/AdminPatientsApiService';
import type { PatientVacancySummary } from '@domain/entities/PatientDetail';

export function usePatientVacancies(patientId: string | undefined) {
  const [vacancies, setVacancies] = useState<PatientVacancySummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Item A1 (mesma classe de defeito de `usePatientDetail.refetch`): `refetch` não passa
  // pelo efeito de cima (guarda `cancelled` de closure). `latestRequestRef` guarda
  // {patientId, seq} do último refetch disparado; só aplica a resposta se ainda for essa
  // combinação quando ela chegar — cobre resposta fora de ordem entre dois refetches e
  // resposta atrasada depois de troca de `patientId`.
  const latestRequestRef = useRef({ patientId, seq: 0 });

  useEffect(() => {
    if (!patientId) return;

    let cancelled = false;
    // Troca de `patientId` invalida qualquer refetch pendente do id anterior: zera o
    // contador para este id, então uma resposta atrasada com o patientId antigo nunca
    // bate no `current.patientId !== patientId` do refetch.
    latestRequestRef.current = { patientId, seq: 0 };

    async function fetchVacancies() {
      try {
        setIsLoading(true);
        setError(null);
        const data = await AdminPatientsApiService.getPatientVacancies(patientId!);
        if (!cancelled) setVacancies(data);
      } catch (err: unknown) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Error al cargar vacantes';
          setError(msg);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchVacancies();
    return () => { cancelled = true; };
  }, [patientId]);

  // Item 1+4 (A1): mesma classe de defeito de `usePatientDetail.refetch` — o `refreshKey` reexecutava
  // o efeito de cima, que liga `isLoading`, e o card (`PatientVacanciesCard`) troca a lista por um
  // estado de loading a cada `onSaved` de `ServicosContratadosCard`. Refetch silencioso: mantém
  // `vacancies` na tela até a resposta chegar; falha só seta `error`, sem apagar a lista anterior.
  const refetch = useCallback(() => {
    if (!patientId) return;
    const seq = latestRequestRef.current.seq + 1;
    latestRequestRef.current = { patientId, seq };
    AdminPatientsApiService.getPatientVacancies(patientId)
      .then((data) => {
        const current = latestRequestRef.current;
        if (current.patientId !== patientId || current.seq !== seq) return;
        setVacancies(data);
        setError(null);
      })
      .catch((err: unknown) => {
        const current = latestRequestRef.current;
        if (current.patientId !== patientId || current.seq !== seq) return;
        const msg = err instanceof Error ? err.message : 'Error al cargar vacantes';
        setError(msg);
      });
  }, [patientId]);

  return { vacancies, isLoading, error, refetch };
}
