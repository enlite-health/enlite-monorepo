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
      const { versions: list, fieldClass: fc } = await AdminTherapeuticProjectsApiService.listVersions(patientId);
      if (mine === seq.current) {
        setVersions(list);
        setFieldClass(fc);
      }
    } catch (err: unknown) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === seq.current) setIsLoading(false);
    }
  }, [patientId, enabled]);

  useEffect(() => { fetchVersions(); }, [fetchVersions]);

  return { versions, fieldClass, isLoading, error, refetch: fetchVersions };
}

export type TherapeuticCatalogs = Record<TherapeuticCatalogKind, TherapeuticCatalogItem[]>;

/**
 * Os 3 catálogos ATIVOS, para os multi-selects do formulário e o filtro de segmento (US-17, PR-7).
 * Carrega uma vez por abertura do drawer. `segments` pode chegar `[]` — a tela esconde o filtro
 * de segmento nesse caso (contrato §Catálogo de segmentos), nunca trata como erro.
 */
export function useTherapeuticCatalogs(enabled: boolean) {
  const [catalogs, setCatalogs] = useState<TherapeuticCatalogs | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    (async () => {
      try {
        const [so, ac, seg] = await Promise.all([
          AdminTherapeuticProjectsApiService.listCatalog('specific-objectives'),
          AdminTherapeuticProjectsApiService.listCatalog('activities'),
          AdminTherapeuticProjectsApiService.listCatalog('segments'),
        ]);
        if (alive) setCatalogs({ 'specific-objectives': so, activities: ac, segments: seg });
      } catch (err: unknown) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { alive = false; };
  }, [enabled]);

  return { catalogs, error };
}
