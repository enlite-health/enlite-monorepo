import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminTherapeuticProjectsApiService } from '@infrastructure/http/AdminTherapeuticProjectsApiService';
import type { TherapeuticCatalogItem, TherapeuticCatalogKind, TherapeuticProjectVersion } from '@domain/entities/TherapeuticProject';

/**
 * As versões do projeto terapêutico de um paciente (spec 017) — rota própria, projetada por célula
 * no servidor; a lista já vem mais recente primeiro. `enabled=false` (container sem célula) não chama.
 */
export function useTherapeuticProjects(patientId: string | undefined, enabled = true) {
  const [versions, setVersions] = useState<TherapeuticProjectVersion[]>([]);
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
      const list = await AdminTherapeuticProjectsApiService.listVersions(patientId);
      if (mine === seq.current) setVersions(list);
    } catch (err: unknown) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === seq.current) setIsLoading(false);
    }
  }, [patientId, enabled]);

  useEffect(() => { fetchVersions(); }, [fetchVersions]);

  return { versions, isLoading, error, refetch: fetchVersions };
}

export type TherapeuticCatalogs = Record<TherapeuticCatalogKind, TherapeuticCatalogItem[]>;

/** Os 2 catálogos ATIVOS, para os multi-selects do formulário. Carrega uma vez por abertura do drawer. */
export function useTherapeuticCatalogs(enabled: boolean) {
  const [catalogs, setCatalogs] = useState<TherapeuticCatalogs | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    (async () => {
      try {
        const [so, ac] = await Promise.all([
          AdminTherapeuticProjectsApiService.listCatalog('specific-objectives'),
          AdminTherapeuticProjectsApiService.listCatalog('activities'),
        ]);
        if (alive) setCatalogs({ 'specific-objectives': so, activities: ac });
      } catch (err: unknown) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { alive = false; };
  }, [enabled]);

  return { catalogs, error };
}
