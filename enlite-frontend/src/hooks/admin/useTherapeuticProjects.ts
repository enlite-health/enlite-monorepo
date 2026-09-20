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
      // As 3 chamadas continuam disparando JUNTAS (mesmo timing de antes — `listCatalog` é chamado
      // 3x de imediato). `segments` usa `allSettled` em vez de `all` (conserto do gate, achado do
      // PR-7): sem a célula `catalog_therapeutic_segments:read` a API devolve 403 SÓ nessa chamada,
      // e isso não pode derrubar `specific-objectives`/`activities` — o form tem de abrir mesmo
      // assim. Falha de `segments` vira catálogo VAZIO (mesmo tratamento do doc acima para `[]`:
      // filtro de segmento some, task 7.7), nunca `error`. `specific-objectives`/`activities` SEMPRE
      // estão juntas no grupo completo do form (contrato §Catálogo) — não há hoje célula parcial
      // entre as duas — então falha em qualquer uma delas continua sendo `error` de verdade.
      const [soRes, acRes, segRes] = await Promise.allSettled([
        AdminTherapeuticProjectsApiService.listCatalog('specific-objectives'),
        AdminTherapeuticProjectsApiService.listCatalog('activities'),
        AdminTherapeuticProjectsApiService.listCatalog('segments'),
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
      const seg: TherapeuticCatalogItem[] = segRes.status === 'fulfilled' ? segRes.value : [];
      setCatalogs({ 'specific-objectives': soRes.value, activities: acRes.value, segments: seg });
    })();
    return () => { alive = false; };
  }, [enabled]);

  return { catalogs, error };
}
