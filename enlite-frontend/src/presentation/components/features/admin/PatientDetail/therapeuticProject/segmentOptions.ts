/**
 * Opções de objetivos/atividades do form do PTI filtradas pelo segmento escolhido (spec 030, FR-007).
 * Sem segmento → todos. Com segmento → os do segmento primeiro, depois os SEM `segmentId` (o
 * catálogo ainda não está todo vinculado: nunca devolve lista vazia por falta de vínculo); item de
 * outro segmento fica de fora. Selecionado que saiu do filtro (ou foi desativado) continua visível,
 * com o rótulo que a versão congelou.
 */
export interface SegmentedItem {
  id: string;
  label: string;
  segmentId?: string | null;
}

export function segmentOptions(
  items: readonly SegmentedItem[],
  segmentId: string,
  chosen: readonly { id: string; label: string }[] | undefined,
): { value: string; label: string }[] {
  const visible = segmentId
    ? [...items.filter((i) => i.segmentId === segmentId), ...items.filter((i) => !i.segmentId)]
    : [...items];
  const options = visible.map((i) => ({ value: i.id, label: i.label }));
  for (const c of chosen ?? []) if (!options.some((o) => o.value === c.id)) options.push({ value: c.id, label: c.label });
  return options;
}
