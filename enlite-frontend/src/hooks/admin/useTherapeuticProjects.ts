import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminTherapeuticProjectsApiService } from '@infrastructure/http/AdminTherapeuticProjectsApiService';
import type { TherapeuticCatalogItem, TherapeuticCatalogKind, TherapeuticFieldClass, TherapeuticProjectVersion } from '@domain/entities/TherapeuticProject';

/** Nenhum campo é MACRO/MICRO até a resposta chegar — o form trata isto como "ainda travado" (fail-closed). */
const EMPTY_FIELD_CLASS: TherapeuticFieldClass = { macro: [], micro: [] };

/**
 * As versões do projeto terapêutico de um paciente (spec 017) — rota própria, projetada por célula
 * no servidor; a lista já vem mais recente primeiro. `enabled=false` (container sem célula) não chama.
 * `fieldClass` (task 7.7) é o espelho de `THERAPEUTIC_FIELD_CLASS` do backend, dono único da lista.
 */
export function useTherapeuticProjects(patientId: string | undefined, enabled = true) {
  const [versions, setVersions] = useState<TherapeuticProjectVersion[]>([]);
  const [fieldClass, setFieldClass] = useState<TherapeuticFieldClass>(EMPTY_FIELD_CLASS);
  const [contactReminderDates, setContactReminderDates] = useState<string[] | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  // Só a ÚLTIMA busca escreve: dois `refetch` seguidos (salvar duas versões com o drawer aberto)
  // disparam duas chamadas, e a resposta mais lenta não pode vencer a mais nova.
  const seq = useRef(0);

  const fetchVersions = useCallback(async () => {
    if (!patientId || !enabled) {
      setIsLoading(false);
      return;
    }
    const mine = ++seq.current;
    setIsLoading(true);
    setError(null);
    try {
      const { versions: list, fieldClass: fc, contactReminderDates: reminders } = await AdminTherapeuticProjectsApiService.listVersions(patientId);
      if (mine === seq.current) {
        setVersions(list);
        setFieldClass(fc);
        setContactReminderDates(reminders ?? null);
      }
    } catch (err: unknown) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === seq.current) setIsLoading(false);
    }
  }, [patientId, enabled]);

  useEffect(() => { fetchVersions(); }, [fetchVersions]);

  return { versions, fieldClass, contactReminderDates, isLoading, error, refetch: fetchVersions };
}

export type TherapeuticCatalogs = Record<TherapeuticCatalogKind, TherapeuticCatalogItem[]>;

/**
 * Os 2 catálogos ATIVOS (objetivos e atividades), para os multi-selects do formulário em modo
 * plano/leitura. Carrega uma vez por abertura do drawer. Sem segmento (spec 091, DF-1).
 */
export function useTherapeuticCatalogs(enabled: boolean) {
  const [catalogs, setCatalogs] = useState<TherapeuticCatalogs | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    (async () => {
      // As 2 chamadas disparam JUNTAS. `specific-objectives`/`activities` estão sempre juntas no
      // grupo completo do form — falha em qualquer uma é `error` de verdade.
      const [soRes, acRes] = await Promise.allSettled([
        AdminTherapeuticProjectsApiService.listCatalog('specific-objectives'),
        AdminTherapeuticProjectsApiService.listCatalog('activities'),
      ]);
      if (!alive) return;
      if (soRes.status === 'rejected') {
        setError(soRes.reason instanceof Error ? soRes.reason.message : String(soRes.reason));
        return;
      }
      if (acRes.status === 'rejected') {
        setError(acRes.reason instanceof Error ? acRes.reason.message : String(acRes.reason));
        return;
      }
      setCatalogs({ 'specific-objectives': soRes.value, activities: acRes.value });
    })();
    return () => { alive = false; };
  }, [enabled]);

  return { catalogs, error };
}
