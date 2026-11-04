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

  describe('alphabetical=true (spec 060)', () => {
    const CAT = [
      { id: 'a1', label: 'Zeta' },
      { id: 'a2', label: 'Árbol do X', segmentId: 'sx' },
      { id: 'a3', label: 'Nube do Y', segmentId: 'sy' },
      { id: 'a4', label: 'Abeja', segmentId: null },
      { id: 'a5', label: 'Zorro do X', segmentId: 'sx' },
      { id: 'a6', label: 'Mesa do X', segmentId: 'sx' },
    ];

    it('(a) sem segmento, com escolhido desativado fora do catálogo → tudo A–Z, escolhido no lugar alfabético', () => {
      const out = segmentOptions(CAT, '', [{ id: 'velho', label: 'Casa antiga' }], true);
      expect(out.map((o) => o.label)).toEqual(['Abeja', 'Árbol do X', 'Casa antiga', 'Mesa do X', 'Nube do Y', 'Zeta', 'Zorro do X']);
    });

    it('(b) com segmento → bloco do segmento A–Z, depois sem-vínculo + escolhidos A–Z; outro segmento fora', () => {
      const out = segmentOptions(CAT, 'sx', [{ id: 'velho', label: 'Casa antiga' }], true);
      expect(out.map((o) => o.label)).toEqual(['Árbol do X', 'Mesa do X', 'Zorro do X', 'Abeja', 'Casa antiga', 'Zeta']);
      expect(ids(out)).not.toContain('a3');
    });

    it('(c) mesma entrada sem o 4º argumento → ordem de entrada intacta', () => {
      expect(ids(segmentOptions(CAT, '', []))).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
      expect(ids(segmentOptions(CAT, 'sx', []))).toEqual(['a2', 'a5', 'a6', 'a1', 'a4']);
      expect(ids(segmentOptions(CAT, '', undefined))).toHaveLength(6);
    });

    it('(d) escolhido que já está no catálogo não duplica e a ordem é A–Z', () => {
      const out = segmentOptions(CAT, 'sx', [{ id: 'a4', label: 'Abeja' }, { id: 'a2', label: 'Árbol do X' }], true);
      expect(ids(out)).toEqual(['a2', 'a6', 'a5', 'a4', 'a1']);
      expect(ids(segmentOptions(CAT, '', undefined, true))).toHaveLength(6);
    });
  });
});
