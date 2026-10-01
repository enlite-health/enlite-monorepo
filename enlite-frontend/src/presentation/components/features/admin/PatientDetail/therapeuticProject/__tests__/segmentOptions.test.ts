import { describe, it, expect } from 'vitest';
import { segmentOptions } from '../segmentOptions';

const ITENS = [
  { id: 'o1', label: 'Sem vínculo A' },
  { id: 'o2', label: 'Do segmento X', segmentId: 'sx' },
  { id: 'o3', label: 'Do segmento Y', segmentId: 'sy' },
  { id: 'o4', label: 'Sem vínculo B', segmentId: null },
  { id: 'o5', label: 'Outro do X', segmentId: 'sx' },
];
const ids = (o: { value: string }[]) => o.map((x) => x.value);

describe('segmentOptions (spec 030, FR-007)', () => {
  it('sem segmento escolhido → todos os itens, na ordem do catálogo', () => {
    expect(ids(segmentOptions(ITENS, '', []))).toEqual(['o1', 'o2', 'o3', 'o4', 'o5']);
  });

  it('com segmento → itens do segmento primeiro, depois os sem segmentId (ordem relativa preservada)', () => {
    expect(ids(segmentOptions(ITENS, 'sx', []))).toEqual(['o2', 'o5', 'o1', 'o4']);
  });

  it('item de OUTRO segmento sai da lista', () => {
    expect(ids(segmentOptions(ITENS, 'sx', []))).not.toContain('o3');
  });

  it('segmento sem nenhum item vinculado nunca devolve lista vazia: ficam os sem segmentId', () => {
    expect(ids(segmentOptions(ITENS, 'sz', []))).toEqual(['o1', 'o4']);
  });

  it('selecionado que saiu do filtro (outro segmento ou inativo) permanece, com o rótulo congelado', () => {
    const out = segmentOptions(ITENS, 'sx', [{ id: 'o3', label: 'Do segmento Y' }, { id: 'velho', label: 'Inativo antigo' }]);
    expect(ids(out)).toEqual(['o2', 'o5', 'o1', 'o4', 'o3', 'velho']);
    expect(out.find((o) => o.value === 'velho')?.label).toBe('Inativo antigo');
  });

  it('selecionado que já está na lista não duplica', () => {
    expect(ids(segmentOptions(ITENS, 'sx', [{ id: 'o2', label: 'Do segmento X' }])).filter((i) => i === 'o2')).toHaveLength(1);
  });
});
