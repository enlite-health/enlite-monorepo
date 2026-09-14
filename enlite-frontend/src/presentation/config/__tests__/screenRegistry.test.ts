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
import { SCREEN_REGISTRY, cellsOfScreen, containersOfTab, screenById, screenByRoute, screensByCell } from '../screenRegistry';
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
      'catalog_therapeutic_segments:read',
      'catalog_therapeutic_segments:write',
      'integration:execute',
      'interview:delete',
      'interview:read',
      'interview:write',
      'patient_therapeutic_project:export',
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
  it('containersOfTab: tela sem containers e container sem abas (tela sem abas) devolvem vazio, sem lançar', () => {
    expect(containersOfTab({ id: 'x.semContainers', route: '/admin/x', cells: ['x:read'] }, 'qualquer')).toEqual([]);
    expect(containersOfTab({ id: 'x.semAbas', route: '/admin/x', containers: [{ id: 'c', resource: 'x', cells: ['x:read'] }] }, 'qualquer')).toEqual([]);
  });

  it('célula compartilhada aparece em TODAS as telas que a consomem — é uma só', () => {
    const telas = todasAsCelulas().get('patient:read') ?? [];
    expect(telas).toEqual(expect.arrayContaining(['dashboard', 'patients.list', 'patients.kanban', 'patients.detail', 'patients.chatRoles']));
    expect(todasAsCelulas().get('patient_address:read')).toEqual(['patients.detail', 'map']);
    // D286 fase 2: o endereço do prestador é UMA célula — card da ficha e aba Prestadores do mapa
    expect(todasAsCelulas().get('worker_address:read')).toEqual(['map', 'workers.detail']);
  });

  it('as abas do detalhe do paciente: cada uma sabe os seus containers; Matching saiu (05/09)', () => {
    const s = screenById('patients.detail');
    expect(containersOfTab(s, 'clinicalData').map((c) => c.resource)).toEqual(['patient_clinical', 'patient_care_team', 'patient_therapeutic_project']);
    expect(containersOfTab(s, 'supportNetwork').map((c) => c.resource)).toEqual(['patient_family', 'patient_chat']);
    // D293: o valor-hora é container próprio (célula de DADO), na mesma aba do serviço.
    expect(containersOfTab(s, 'contractedService').map((c) => c.resource)).toEqual(['patient_coverage', 'patient_address', 'patient_services', 'patient_contract_value']);
    expect(s.tabs).toEqual(['clinicalData', 'supportNetwork', 'contractedService', 'vacancies', 'history']);
    expect(containersOfTab(s, 'vacancies').map((c) => c.resource)).toEqual(['vacancy']);
    expect(containersOfTab(s, 'history').map((c) => c.resource)).toEqual(['patient']);
    // o operacional (cabeçalho + histórico) é UMA linha: nada de célula solta no nível da tela
    expect(s.cells).toBeUndefined();
  });

  it('D286 fase 2 — prestador: dossiê e contato sem aba (cabeçalho); documentos/encuadres por aba; placeholders sem container', () => {
    const s = screenById('workers.detail');
    expect(s.tabs).toEqual(['encuadres', 'documents', 'availability', 'financial', 'history']);
    expect(containersOfTab(s, 'documents').map((c) => c.resource)).toEqual(['worker_document']);
    expect(containersOfTab(s, 'encuadres').map((c) => c.resource)).toEqual(['match']);
    expect(containersOfTab(s, 'availability').map((c) => c.resource)).toEqual(['worker']);
    expect(containersOfTab(s, 'financial')).toEqual([]);
    expect(s.containers?.map((c) => c.resource)).toEqual(['worker', 'worker_contact', 'worker_pii', 'worker_address', 'worker_document', 'match']);
  });

  it('D286 fase 2 — vaga: o card Paciente é célula do PACIENTE (patient_identity); Links é a vaga', () => {
    const s = screenById('vacancies.detail');
    expect(s.containers?.find((c) => c.id === 'patient')?.resource).toBe('patient_identity');
    expect(containersOfTab(s, 'links').map((c) => c.resource)).toEqual(['vacancy']);
    expect(containersOfTab(s, 'encuadres').map((c) => c.resource)).toEqual(['funnel', 'match', 'messaging']);
    expect(containersOfTab(s, 'talentum').map((c) => c.resource)).toEqual(['prescreening', 'talentum']);
    // patient_identity:read é UMA célula: ficha do paciente, lista, kanban, vaga
    expect(todasAsCelulas().get('patient_identity:read')).toEqual(expect.arrayContaining(['patients.detail', 'vacancies.detail']));
  });

  it('D286 fase 2 — mapa: uma aba por titular, cada uma com a célula de endereço dele', () => {
    const s = screenById('map');
    expect(containersOfTab(s, 'workers').map((c) => c.resource)).toEqual(['worker_address']);
    expect(containersOfTab(s, 'patients').map((c) => c.resource)).toEqual(['patient_address']);
  });

  it('D286 — Gestión a la Vista: abrir a tela é dashboard:read; cada BLOCO tem a sua célula', () => {
    const s = screenById('dashboard');
    expect(s.cells).toEqual(['dashboard:read']);
    expect(s.containers?.map((c) => [c.id, c.resource])).toEqual([
      ['numbers', 'dashboard_numbers'], ['team', 'dashboard_team'], ['priorities', 'dashboard_priorities'],
      ['registrations', 'dashboard_registrations'], ['funnel', 'dashboard_funnel'], ['zones', 'dashboard_zones'], ['patients', 'patient'],
    ]);
  });

  it('cellsOfScreen — as próprias mais as de todos os containers, na ordem do registro', () => {
    expect(cellsOfScreen(screenById('patients.list'))).toEqual(['patient:read', 'patient:write', 'patient:delete', 'patient_identity:read', 'patient_clinical:read']);
    expect(cellsOfScreen(screenById('map'))).toEqual(['worker_address:read', 'patient_address:read']);
    expect(cellsOfScreen(screenById('dashboard'))).toEqual([
      'dashboard:read', 'dashboard_numbers:read', 'dashboard_team:read', 'dashboard_priorities:read',
      'dashboard_registrations:read', 'dashboard_funnel:read', 'dashboard_zones:read', 'patient:read',
    ]);
  });

  it('screenByRoute — rota exata (o href do item de menu); rota que nenhuma tela declara é undefined', () => {
    expect(screenByRoute('/admin/patients')?.id).toBe('patients.list');
    expect(screenByRoute('/admin')?.id).toBe('users');
    expect(screenByRoute('/admin/mapa')?.id).toBe('map');
    expect(screenByRoute('/admin/api-docs')).toBeUndefined();
    expect(screenByRoute('/admin/patients/', [])).toBeUndefined();
    expect(screenByRoute(undefined)).toBeUndefined();
  });

  it('tela desconhecida é erro, não undefined silencioso', () => {
    expect(() => screenById('nao.existe')).toThrow(/desconhecida/);
  });
});
