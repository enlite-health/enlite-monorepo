/**
 * adminNavigation.test.tsx
 *
 * Verifica que:
 *  - com as células de leitura (engine ON) a seção Administración aparece,
 *    com `sectionStart` no 1º item;
 *  - sem as células (engine ON) a seção some inteira;
 *  - com o engine OFF/contrato ausente tudo aparece — a régua de rollout
 *    (D268) manda que o menu continue como sempre esteve.
 *
 * Papel (`role`) não decide mais nada aqui: quem decide é a célula.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAdminNavItems } from './adminNavigation';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** As células de leitura de TODOS os itens da seção Administración. */
const TODAS_AS_CELULAS = ['worker:read', 'dedup:read', 'patient:read', 'recruitment:read', 'messaging:read'];

const contrato = (
  permissions: string[],
  enforcement: AuthzContract['enforcement'],
  features: AuthzContract['features'] = {},
): AuthzContract => ({
  uid: 'u',
  tenantId: 't',
  status: 'ACTIVE',
  permissions,
  countries: ['AR'],
  groups: [],
  features,
  enforcement,
});

const comContrato = (permissions: string[], enforcement: AuthzContract['enforcement']) =>
  useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(permissions, enforcement) });

const itens = () => renderHook(() => useAdminNavItems()).result.current;

afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useAdminNavItems — sectionStart nos adminItems', () => {
  it('com as células (engine ON) o primeiro adminItem carrega o sectionStart', () => {
    comContrato(TODAS_AS_CELULAS, 'on');

    const adminItems = itens().filter((item) => item.sectionStart !== undefined);
    expect(adminItems.length).toBeGreaterThan(0);
    expect(adminItems[0].sectionStart).toBeTruthy();
    // O valor deve conter "Administr" (es: "Administración" / pt-BR: "Administração")
    expect(adminItems[0].sectionStart).toMatch(/Administr/i);
  });

  it('com as células, Etiquetas é o primeiro item admin', () => {
    comContrato(TODAS_AS_CELULAS, 'on');

    const firstWithSection = itens().find((item) => item.sectionStart !== undefined);
    expect(firstWithSection).toBeDefined();
    expect(firstWithSection?.href).toBe('/admin/tags');
  });

  it('engine ON sem célula nenhuma → nenhum item com sectionStart', () => {
    comContrato([], 'on');

    expect(itens().filter((item) => item.sectionStart !== undefined)).toHaveLength(0);
  });

  it('engine OFF sem célula nenhuma → a seção aparece igual (régua de rollout D268)', () => {
    comContrato([], 'off');

    expect(itens().filter((item) => item.sectionStart !== undefined).length).toBeGreaterThan(0);
  });

  it('sem contrato nenhum (authz null) → a seção aparece igual', () => {
    expect(itens().filter((item) => item.sectionStart !== undefined).length).toBeGreaterThan(0);
  });
});

describe('useAdminNavItems — Postulaciones bloqueadas depende de recruitment:read', () => {
  const BLOCKED_HREF = '/admin/recruitment/blocked-attempts';

  it('COM recruitment:read (engine ON) o item aparece dentro da seção Administración', () => {
    comContrato(TODAS_AS_CELULAS, 'on');
    const items = itens();

    const blockedIdx = items.findIndex((item) => item.href === BLOCKED_HREF);
    const sectionIdx = items.findIndex((item) => item.sectionStart !== undefined);

    expect(blockedIdx).toBeGreaterThan(-1);
    expect(sectionIdx).toBeGreaterThan(-1);
    expect(blockedIdx).toBeGreaterThanOrEqual(sectionIdx);
  });

  it('SEM recruitment:read (engine ON) o item some — as outras células não o trazem de volta', () => {
    comContrato(['worker:read', 'dedup:read', 'patient:read', 'messaging:read'], 'on');

    expect(itens().some((item) => item.href === BLOCKED_HREF)).toBe(false);
  });

  it('engine OFF sem célula nenhuma → o item aparece', () => {
    comContrato([], 'off');

    expect(itens().some((item) => item.href === BLOCKED_HREF)).toBe(true);
  });
});

describe('useAdminNavItems — B1 (D268): blocked-attempts é sub-rota de screen:funnel e some junto', () => {
  const BLOCKED_HREF = '/admin/recruitment/blocked-attempts';

  const authzComFunnel = (funnelEnabled: boolean): AuthzContract =>
    contrato(TODAS_AS_CELULAS, 'on', { AR: { 'screen:funnel': { enabled: funnelEnabled, config: null } } });

  it('screen:funnel DESLIGADA no país do ator remove blocked-attempts do menu admin (App.tsx já negava a rota — o link agora some junto)', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: authzComFunnel(false) });

    const items = itens();
    expect(items.some((item) => item.href === BLOCKED_HREF)).toBe(false);
    // O resto da seção não é afetado — só a chave screen:funnel.
    expect(items.some((item) => item.href === '/admin/tags')).toBe(true);
  });

  it('screen:funnel LIGADA mantém blocked-attempts no menu admin', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: authzComFunnel(true) });

    expect(itens().some((item) => item.href === BLOCKED_HREF)).toBe(true);
  });
});

describe('useAdminNavItems — Mensajes por etapa (DEC-12 / PEND-14) depende de messaging:read', () => {
  const HREF = '/admin/mensajes-por-etapa';

  it('COM messaging:read o item aparece na seção Administración, com o rótulo "Mensajes por etapa"', () => {
    comContrato(TODAS_AS_CELULAS, 'on');

    const items = itens();
    const idx = items.findIndex((item) => item.href === HREF);
    const sectionIdx = items.findIndex((item) => item.sectionStart !== undefined);

    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeGreaterThanOrEqual(sectionIdx);
    expect(items[idx].label).toMatch(/Mensajes por etapa|Mensagens por etapa/);
  });

  it('SEM messaging:read (engine ON) o item some', () => {
    comContrato(['worker:read', 'dedup:read', 'patient:read', 'recruitment:read'], 'on');

    expect(itens().some((item) => item.href === HREF)).toBe(false);
  });

  it('engine OFF sem célula nenhuma → o item aparece', () => {
    comContrato([], 'off');

    expect(itens().some((item) => item.href === HREF)).toBe(true);
  });
});

describe('useAdminNavItems — Mapa (REQ-04): item de topo, por célula da tela (D286/#313)', () => {
  it.each([
    // O mapa abre por célula de endereço (containers da tela `map`); `patient:read` abre a lista.
    ['com célula do mapa e de pacientes (engine ON)', ['patient:read', 'worker_address:read', 'patient_address:read'], 'on' as const],
    ['engine OFF sem célula nenhuma', [] as string[], 'off' as const],
  ])('%s: "Mapa" aponta para /admin/mapa, logo depois de Pacientes', (_label, permissions, enforcement) => {
    comContrato(permissions, enforcement);

    const items = itens();
    const mapIdx = items.findIndex((item) => item.href === '/admin/mapa');

    expect(mapIdx).toBeGreaterThan(-1);
    expect(items[mapIdx].label).toBe('Mapa');
    expect(items[mapIdx].icon).toBeTruthy();
    expect(items[mapIdx].sectionStart).toBeUndefined();
    expect(mapIdx).toBe(items.findIndex((item) => item.href === '/admin/patients') + 1);
  });

  it('sem célula nenhuma (engine ON): "Mapa" some — o item existe para quem tem alguma célula da tela', () => {
    comContrato([], 'on');
    expect(itens().some((item) => item.href === '/admin/mapa')).toBe(false);
  });
});

// ── Bug relatado pelo Gabriel na stage (07/09): usuário de um grupo com UMA célula via TODOS os
// itens de topo (Pacientes, Prestadores, Vacantes, Mapa…). Regra (D286): item de menu existe para
// quem tem QUALQUER célula da tela que ele abre — a mesma régua das abas (`tabsVisibleFor`).
describe('useAdminNavItems — D286: item de topo só existe para quem tem alguma célula da tela', () => {
  const authzCom = (permissions: string[]): AuthzContract => ({
    uid: 'u',
    tenantId: 't',
    status: 'ACTIVE',
    permissions,
    countries: ['AR'],
    groups: [],
    features: { AR: {} },
    enforcement: 'on',
  });
  // D293: o menu não lê papel — não há perfil a mockar; a decisão é só o contrato de authz.
  const hrefs = () => renderHook(() => useAdminNavItems()).result.current.map((i) => i.href);

  afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('só `patient_family:read` (uma célula de container do detalhe): vê só o que essa célula abre', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: authzCom(['patient_family:read']) });
    const visiveis = hrefs();
    // O item "Pacientes" abre a LISTA (`/admin/patients`), cujas células são as do operacional,
    // identidade e clínica — família não abre a lista: item some.
    expect(visiveis).not.toContain('/admin/patients');
    for (const h of ['/admin/dashboard', '/admin', '/admin/vacancies', '/admin/workers', '/admin/mapa', '/admin/recruitment']) {
      expect(visiveis, `${h} apareceu sem célula`).not.toContain(h);
    }
  });

  it('`patient:read` abre Pacientes (lista) e NADA mais dos itens de topo por célula', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: authzCom(['patient:read']) });
    const visiveis = hrefs();
    expect(visiveis).toContain('/admin/patients');
    // `patient:read` também é célula de um BLOCO do dashboard — mas abrir a tela é `dashboard:read`,
    // e sem ela a rota nega: o item não aparece (medido no e2e `admin-menu-por-celula`).
    for (const h of ['/admin/dashboard', '/admin', '/admin/vacancies', '/admin/workers', '/admin/mapa', '/admin/recruitment']) {
      expect(visiveis, `${h} apareceu sem célula`).not.toContain(h);
    }
  });

  it('o Mapa só tem containers (sem célula própria): aparece com QUALQUER célula de endereço', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: authzCom(['worker_address:read']) });
    expect(hrefs()).toContain('/admin/mapa');
  });

  it('com o engine OFF a régua é a de antes: todos os itens de topo aparecem (freio D268)', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: { ...authzCom([]), enforcement: 'off' } });
    const visiveis = hrefs();
    for (const h of ['/admin/dashboard', '/admin', '/admin/vacancies', '/admin/workers', '/admin/patients', '/admin/mapa', '/admin/recruitment', '/admin/api-docs']) {
      expect(visiveis).toContain(h);
    }
  });

  it('item cujo href não está no registro de telas (API Docs) NÃO é gateado por célula — nomeado, não esquecido', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: authzCom([]) });
    // A rota `/api/docs` do back exige só staff (index.ts), sem célula: o menu espelha o back.
    expect(hrefs()).toEqual(['/admin/api-docs']);
  });
});
