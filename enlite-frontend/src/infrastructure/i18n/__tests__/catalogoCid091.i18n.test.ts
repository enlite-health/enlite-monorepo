/**
 * Spec 091 (T305 + T405) — chaves admin.therapeuticCatalog.* (§9.7) e therapeuticProjectForm.* (§9.8)
 * existem em es e pt-BR, com o texto exato do design.md (valor fixo, não só presença).
 */
import { describe, it, expect } from 'vitest';
import esJson from '../locales/es.json';
import ptBRJson from '../locales/pt-BR.json';

const get = (json: unknown, path: string): unknown => path.split('.').reduce((o, k) => (o as Record<string, unknown> | undefined)?.[k], json);

const FORM_CASCADE: Record<string, { es: string; ptBR: string }> = {
  stepService: { es: 'Paso 1 · Servicio', ptBR: 'Passo 1 · Serviço' },
  stepDiagnoses: { es: 'Paso 2 · Diagnósticos', ptBR: 'Passo 2 · Diagnósticos' },
  stepObjectives: { es: 'Paso 3 · Objetivos específicos', ptBR: 'Passo 3 · Objetivos específicos' },
  stepActivities: { es: 'Paso 4 · Actividades', ptBR: 'Passo 4 · Atividades' },
  noCatalog: {
    es: 'No hay catálogo para este diagnóstico y servicio. Usá Objetivo general y Contexto clínico.',
    ptBR: 'Não há catálogo para este diagnóstico e serviço. Use Objetivo geral e Contexto clínico.',
  },
  pickObjectiveFirst: { es: 'Elegí al menos un objetivo para ver sus actividades.', ptBR: 'Escolha ao menos um objetivo para ver as atividades.' },
  planIncomplete: { es: 'Elegí al menos un objetivo y una actividad en este diagnóstico.', ptBR: 'Escolha ao menos um objetivo e uma atividade neste diagnóstico.' },
  chooseServiceFirst: { es: 'Elegí el servicio para continuar.', ptBR: 'Escolha o serviço para continuar.' },
  frequency: { es: 'Frecuencia: {{value}}', ptBR: 'Frequência: {{value}}' },
  noCatalogAt: { es: 'Sin catálogo para este diagnóstico y servicio al {{date}}', ptBR: 'Sem catálogo para este diagnóstico e serviço em {{date}}' },
  catalogChanged: { es: 'El catálogo de este diagnóstico cambió. Revisá los objetivos y actividades marcados.', ptBR: 'O catálogo deste diagnóstico mudou. Revise os objetivos e atividades marcados.' },
  formatMismatch: { es: 'Esta versión usa otro formato de objetivos. Recargá la página e intentá de nuevo.', ptBR: 'Esta versão usa outro formato de objetivos. Recarregue a página e tente de novo.' },
  cascadeError: { es: 'No pudimos cargar el catálogo. Intentá de nuevo.', ptBR: 'Não foi possível carregar o catálogo. Tente de novo.' },
};

const ADMIN_TC: Record<string, { es: string; ptBR: string }> = {
  service: { es: 'Servicio', ptBR: 'Serviço' },
  serviceAT: { es: 'Acompañante terapéutico', ptBR: 'Acompanhante terapêutico' },
  serviceCAREGIVER: { es: 'Cuidado', ptBR: 'Cuidado' },
  icdCategories: { es: 'CIE-11', ptBR: 'CID-11' },
  icdCount: { es: '{{count}} categorías', ptBR: '{{count}} categorias' },
  icdPanelTitle: { es: 'Diagnósticos CIE-11 donde aparece', ptBR: 'Diagnósticos CID-11 onde aparece' },
  icdSearch: { es: 'Buscar código o diagnóstico', ptBR: 'Buscar código ou diagnóstico' },
  icdAdd: { es: 'Agregar', ptBR: 'Adicionar' },
  icdRemove: { es: 'Quitar', ptBR: 'Remover' },
  icdRemoveCascade: { es: 'Se quitarán también {{count}} vínculos de actividades', ptBR: 'Também serão removidos {{count}} vínculos de atividades' },
  icdNotInRelease: { es: 'No está en la versión CIE-11 vigente', ptBR: 'Não está na versão CID-11 vigente' },
  objective: { es: 'Objetivo', ptBR: 'Objetivo' },
  frequency: { es: 'Frecuencia sugerida', ptBR: 'Frequência sugerida' },
  filterIcd: { es: 'Vinculado a CIE-11', ptBR: 'Vinculado a CID-11' },
  icdError: { es: 'No se pudo completar la operación.', ptBR: 'Não foi possível concluir a operação.' },
};

describe('catálogo CID-11 (091 T305) — admin.therapeuticCatalog.* em es + pt-BR', () => {
  it.each(Object.keys(ADMIN_TC))('admin.therapeuticCatalog.%s: texto exato nos 2 idiomas', (key) => {
    const path = `admin.therapeuticCatalog.${key}`;
    expect(get(esJson, path)).toBe(ADMIN_TC[key].es);
    expect(get(ptBRJson, path)).toBe(ADMIN_TC[key].ptBR);
  });

  it('as chaves novas existem nos dois idiomas com a mesma interpolação {{count}}', () => {
    for (const key of Object.keys(ADMIN_TC)) {
      const path = `admin.therapeuticCatalog.${key}`;
      const esVars = [...String(get(esJson, path)).matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]).sort();
      const ptVars = [...String(get(ptBRJson, path)).matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]).sort();
      expect(ptVars, key).toEqual(esVars);
    }
  });

  it.each(Object.keys(FORM_CASCADE))('therapeuticProjectForm.%s: texto exato nos 2 idiomas', (key) => {
    const path = `therapeuticProjectForm.${key}`;
    expect(get(esJson, path)).toBe(FORM_CASCADE[key].es);
    expect(get(ptBRJson, path)).toBe(FORM_CASCADE[key].ptBR);
  });
});
