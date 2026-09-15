import { useState, useEffect, useCallback } from 'react';
import { AdminPatientsApiService } from '@infrastructure/http/AdminPatientsApiService';
import type { PatientVacancySummary } from '@domain/entities/PatientDetail';

export function usePatientVacancies(patientId: string | undefined) {
  const [vacancies, setVacancies] = useState<PatientVacancySummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!patientId) return;

    let cancelled = false;

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
    AdminPatientsApiService.getPatientVacancies(patientId)
      .then((data) => {
        setVacancies(data);
        setError(null);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Error al cargar vacantes';
        setError(msg);
      });
  }, [patientId]);

  return { vacancies, isLoading, error, refetch };
}
