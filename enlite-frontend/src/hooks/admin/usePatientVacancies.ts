import { useState, useEffect } from 'react';
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

  return { vacancies, isLoading, error };
}
