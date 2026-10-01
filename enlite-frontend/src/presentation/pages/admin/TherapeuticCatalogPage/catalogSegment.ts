/**
 * Segmento Ana Care no catálogo de objetivos/atividades (spec 030, F4): rótulo resolvido por id no
 * front (a lista de segmentos já vem da página) e opções do select do modal. Segmento DESATIVADO
 * segue resolvendo — vira "<rótulo> (inactivo)" — porque o vínculo existe até alguém limpá-lo.
 */
import type { TherapeuticCatalogItem } from '@domain/entities/TherapeuticProject';

type Inactive = (label: string) => string;

/** `null` = id fora da lista (sem vínculo, ou o segmento não veio). */
export function segmentDisplayLabel(
  segments: readonly TherapeuticCatalogItem[],
  id: string | null | undefined,
  inactive: Inactive,
): string | null {
  const s = id ? segments.find((x) => x.id === id) : undefined;
  if (!s) return null;
  return s.active ? s.label : inactive(s.label);
}

/** Ativos + o vínculo atual (mesmo desativado), para o operador ver e poder trocar/limpar. */
export function segmentSelectOptions(
  segments: readonly TherapeuticCatalogItem[],
  currentId: string,
  inactive: Inactive,
): { value: string; label: string }[] {
  return segments
    .filter((s) => s.active || s.id === currentId)
    .map((s) => ({ value: s.id, label: segmentDisplayLabel(segments, s.id, inactive) ?? s.label }));
}
