/**
 * screenRegistry × catálogo do back × rotas do App — as três réguas que impedem o mapa por tela
 * de mentir (D286):
 *  1. toda célula listada por uma tela EXISTE no catálogo do back (fixture gerada do código);
 *  2. toda rota de tela existe em `App.tsx` (tela fantasma = bloco morto no painel);
 *  3. a tabela de "quem consome" é derivada do registro, e célula compartilhada aparece nas duas.
 * O que o back tem e nenhuma tela lista NÃO reprova — cai em "Outras células" (celulasForaDasTelas),
 * e o teste só exige que isso seja pequeno e nomeado, para a lista não crescer calada.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fixture from '../../../test/fixtures/permission-catalog.json';
import { SCREEN_REGISTRY, containersOfTab, screenById, screensByCell } from '../screenRegistry';
import { celulasForaDasTelas } from '@presentation/components/features/access/screenTreeModel';

const CATALOGO = new Set<string>(fixture.cells);
const APP_TSX = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');

function todasAsCelulas(): Map<string, string[]> {
  return screensByCell(SCREEN_REGISTRY);
}

describe('SCREEN_REGISTRY — paridade com o catálogo do back', () => {
  it('🔴 toda célula de toda tela existe no catálogo (fixture derivada do código do back)', () => {
    const orfas = [...todasAsCelulas().keys()].filter((c) => !CATALOGO.has(c));
    expect(orfas, `células que o back não conhece: ${JSON.stringify(orfas)}`).toEqual([]);
  });

  it('toda célula é `recurso:ação` e o recurso do container é o das suas células', () => {
    for (const s of SCREEN_REGISTRY) {
      for (const cell of s.cells ?? []) expect(cell).toMatch(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/);
      for (const ct of s.containers ?? []) {
        for (const cell of ct.cells) expect(cell.startsWith(`${ct.resource}:`)).toBe(true);
        if (ct.tabs) for (const tab of ct.tabs) expect(s.tabs, `${s.id}/${ct.id}: aba ${tab} não declarada`).toContain(tab);
      }
    }
  });

  it('ids de tela são únicos e cada tela lista ao menos uma célula', () => {
    const ids = SCREEN_REGISTRY.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SCREEN_REGISTRY) {
      const n = (s.cells?.length ?? 0) + (s.containers ?? []).reduce((acc, ct) => acc + ct.cells.length, 0);
      expect(n, `${s.id} sem célula`).toBeGreaterThan(0);
    }
  });

  it('o que o back tem e nenhuma tela lista é pequeno e NOMEADO (vai para "Outras células")', () => {
    const catalog = [{ category: 'x', cells: [...CATALOGO].map((k) => { const [resource, action] = k.split(':'); return { resource, action, category: 'x', ownerService: 'wf' }; }) }];
    expect(celulasForaDasTelas(catalog)).toEqual([
      // sem consumidor no front (ui-gate-debt.json), ferramentas de operação sem tela, ou
      // decididas no back abaixo da rota (worker:disable)
      'analytics:export',
      'analytics:read',
      'api_docs:read',
      'integration:execute',
      'interview:delete',
      'interview:read',
      'interview:write',
      'recruitment:write',
      'test_fixtures:execute',
      'upload:read',
      'upload:write',
      'vacancy:delete',
      'worker:delete',
      'worker:disable',
    ]);
  });
});

describe('SCREEN_REGISTRY — rotas', () => {
  it('🔴 toda rota do registro existe em App.tsx (tela fantasma = bloco morto no painel)', () => {
    const faltando = SCREEN_REGISTRY.filter((s) => {
      const sub = s.route.replace(/^\/admin\/?/, '');
      // `/admin` é a rota `index` do shell admin (Usuários).
      if (sub === '') return !/<Route index /.test(APP_TSX);
      return !new RegExp(`path="${sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(APP_TSX);
    }).map((s) => s.route);
    expect(faltando).toEqual([]);
  });
});

describe('screensByCell / containersOfTab / screenById', () => {
  it('célula compartilhada aparece em TODAS as telas que a consomem — é uma só', () => {
    const telas = todasAsCelulas().get('patient:read') ?? [];
    expect(telas).toEqual(expect.arrayContaining(['dashboard', 'patients.list', 'patients.kanban', 'patients.detail', 'patients.chatRoles']));
    expect(todasAsCelulas().get('patient_address:read')).toEqual(['patients.detail', 'map']);
  });

  it('as abas do detalhe do paciente: cada uma sabe os seus containers; Matching partilha Serviços', () => {
    const s = screenById('patients.detail');
    expect(containersOfTab(s, 'clinicalData').map((c) => c.resource)).toEqual(['patient_clinical', 'patient_care_team']);
    expect(containersOfTab(s, 'supportNetwork').map((c) => c.resource)).toEqual(['patient_family', 'patient_chat']);
    expect(containersOfTab(s, 'contractedService').map((c) => c.resource)).toEqual(['patient_coverage', 'patient_address', 'patient_services']);
    expect(containersOfTab(s, 'matching').map((c) => c.resource)).toEqual(['patient_services']);
    expect(containersOfTab(s, 'vacancies').map((c) => c.resource)).toEqual(['vacancy']);
    expect(containersOfTab(s, 'history').map((c) => c.resource)).toEqual(['patient']);
    // o operacional (cabeçalho + histórico) é UMA linha: nada de célula solta no nível da tela
    expect(s.cells).toBeUndefined();
  });

  it('tela desconhecida é erro, não undefined silencioso', () => {
    expect(() => screenById('nao.existe')).toThrow(/desconhecida/);
  });
});
