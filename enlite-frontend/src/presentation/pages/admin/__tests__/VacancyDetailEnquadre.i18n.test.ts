import { describe, it, expect } from 'vitest';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import es from '@infrastructure/i18n/locales/es.json';

type Tree = { [key: string]: string | Tree };

const esNs = (es as unknown as { admin: { vacancyDetail: { enquadre: Tree } } }).admin.vacancyDetail.enquadre;
const ptNs = (ptBR as unknown as { admin: { vacancyDetail: { enquadre: Tree } } }).admin.vacancyDetail.enquadre;

function leaves(tree: Tree, prefix = ''): Record<string, string> {
  return Object.entries(tree).reduce<Record<string, string>>((acc, [k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'string' ? { ...acc, [path]: v } : { ...acc, ...leaves(v, path) };
  }, {});
}

const esLeaves = leaves(esNs);
const ptLeaves = leaves(ptNs);

// Valores da Fase 0 que o enquadre introduz fora do namespace (aba nova e coluna nova).
const extra = {
  es: {
    'tabs.enquadre': (es as unknown as { admin: { vacancyDetail: { tabs: Record<string, string> } } }).admin.vacancyDetail.tabs.enquadre,
    'columns.CONVOKED': (es as unknown as { admin: { kanban: { columns: Record<string, string> } } }).admin.kanban.columns.CONVOKED,
  },
  pt: {
    'tabs.enquadre': (ptBR as unknown as { admin: { vacancyDetail: { tabs: Record<string, string> } } }).admin.vacancyDetail.tabs.enquadre,
    'columns.CONVOKED': (ptBR as unknown as { admin: { kanban: { columns: Record<string, string> } } }).admin.kanban.columns.CONVOKED,
  },
};

describe('VacancyDetail enquadre i18n — paridade es × pt-BR', () => {
  it('es e pt-BR têm exatamente as mesmas chaves em admin.vacancyDetail.enquadre', () => {
    expect(Object.keys(ptLeaves).sort()).toEqual(Object.keys(esLeaves).sort());
  });

  it.each(Object.keys(esLeaves))('chave %s tem texto não vazio nos dois idiomas', (key) => {
    expect(esLeaves[key].trim().length).toBeGreaterThan(0);
    expect(ptLeaves[key].trim().length).toBeGreaterThan(0);
  });

  it('as chaves de contagem usam {{count}} nos dois idiomas', () => {
    for (const key of ['unassignedCount', 'kanban.closeConfirm.body', 'cancel.body', 'convoked.add']) {
      expect(esLeaves[key]).toContain('{{count}}');
      expect(ptLeaves[key]).toContain('{{count}}');
    }
  });
});

describe('VacancyDetail enquadre i18n — vocabulário', () => {
  const all = [...Object.values(esLeaves), ...Object.values(ptLeaves), ...Object.values(extra.es), ...Object.values(extra.pt)];

  it('nenhum valor novo contém Invitad/Convidad (enquadre é "Convocados")', () => {
    expect(all.filter((v) => /invitad|convidad/i.test(v))).toEqual([]);
  });

  it('"Convocados" está presente (coluna do kanban e cabeçalho da tabela)', () => {
    expect(extra.es['columns.CONVOKED']).toBe('Convocados');
    expect(extra.pt['columns.CONVOKED']).toBe('Convocados');
    expect(esLeaves['columns.convoked']).toBe('Convocados');
    expect(ptLeaves['columns.convoked']).toBe('Convocados');
  });

  it('a aba nova é Encuadre/Enquadre e a antiga virou Reclutamiento/Recrutamento', () => {
    expect(extra.es['tabs.enquadre']).toBe('Encuadre');
    expect(extra.pt['tabs.enquadre']).toBe('Enquadre');
    const tabs = (l: unknown) => (l as { admin: { vacancyDetail: { tabs: Record<string, string> } } }).admin.vacancyDetail.tabs;
    expect(tabs(es).encuadres).toBe('Reclutamiento');
    expect(tabs(ptBR).encuadres).toBe('Recrutamento');
  });
});
