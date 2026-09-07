/**
 * adminNavigation.test.tsx
 *
 * Verifica que:
 *  - Admin (role===ADMIN) recebe adminItems com sectionStart no 1º item
 *  - Não-admin NÃO recebe adminItems (logo sem sectionStart)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAdminNavItems } from './adminNavigation';
import { EnliteRole } from '@domain/entities/EnliteRole';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: vi.fn(),
}));

import { useAdminAuth } from '@presentation/hooks/useAdminAuth';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useAdminNavItems — sectionStart nos adminItems', () => {
  it('admin (ADMIN role) recebe sectionStart no primeiro adminItem', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.ADMIN } as ReturnType<typeof useAdminAuth>['adminProfile'],
    } as ReturnType<typeof useAdminAuth>);

    const { result } = renderHook(() => useAdminNavItems());
    const items = result.current;

    // Deve existir pelo menos 1 adminItem
    const adminItems = items.filter((item) => item.sectionStart !== undefined);
    expect(adminItems.length).toBeGreaterThan(0);

    // O primeiro adminItem deve ter sectionStart preenchido
    const firstAdminItem = adminItems[0];
    expect(firstAdminItem.sectionStart).toBeTruthy();
    // O valor deve conter "Administr" (es: "Administración" / pt-BR: "Administração")
    expect(firstAdminItem.sectionStart).toMatch(/Administr/i);
  });

  it('admin recebe Etiquetas como primeiro item admin', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.ADMIN } as ReturnType<typeof useAdminAuth>['adminProfile'],
    } as ReturnType<typeof useAdminAuth>);

    const { result } = renderHook(() => useAdminNavItems());
    const items = result.current;

    const firstWithSection = items.find((item) => item.sectionStart !== undefined);
    expect(firstWithSection).toBeDefined();
    // O item com sectionStart é "Etiquetas" (ou equivalente i18n)
    expect(firstWithSection?.href).toBe('/admin/tags');
  });

  it('não-admin (RECRUITER) NÃO recebe nenhum item com sectionStart', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.RECRUITER } as ReturnType<typeof useAdminAuth>['adminProfile'],
    } as ReturnType<typeof useAdminAuth>);

    const { result } = renderHook(() => useAdminNavItems());
    const items = result.current;

    const withSection = items.filter((item) => item.sectionStart !== undefined);
    expect(withSection).toHaveLength(0);
  });

  it('sem perfil (null) NÃO recebe nenhum item com sectionStart', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: null,
    } as ReturnType<typeof useAdminAuth>);

    const { result } = renderHook(() => useAdminNavItems());
    const items = result.current;

    const withSection = items.filter((item) => item.sectionStart !== undefined);
    expect(withSection).toHaveLength(0);
  });
});

describe('useAdminNavItems — Postulaciones bloqueadas é admin-only', () => {
  const BLOCKED_HREF = '/admin/recruitment/blocked-attempts';

  it('admin vê o item dentro da seção Administración (após o primeiro sectionStart)', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.ADMIN } as ReturnType<typeof useAdminAuth>['adminProfile'],
    } as ReturnType<typeof useAdminAuth>);

    const { result } = renderHook(() => useAdminNavItems());
    const items = result.current;

    const blockedIdx = items.findIndex((item) => item.href === BLOCKED_HREF);
    const sectionIdx = items.findIndex((item) => item.sectionStart !== undefined);

    expect(blockedIdx).toBeGreaterThan(-1);
    expect(sectionIdx).toBeGreaterThan(-1);
    // O item de bloqueadas fica DENTRO da seção admin (no ou após o item que abre a seção)
    expect(blockedIdx).toBeGreaterThanOrEqual(sectionIdx);
  });

  it('não-admin (RECRUITER) NÃO vê o item de postulaciones bloqueadas', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.RECRUITER } as ReturnType<typeof useAdminAuth>['adminProfile'],
    } as ReturnType<typeof useAdminAuth>);

    const { result } = renderHook(() => useAdminNavItems());
    const items = result.current;

    expect(items.some((item) => item.href === BLOCKED_HREF)).toBe(false);
  });

  it('sem perfil (null) NÃO vê o item de postulaciones bloqueadas', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: null,
    } as ReturnType<typeof useAdminAuth>);

    const { result } = renderHook(() => useAdminNavItems());
    const items = result.current;

    expect(items.some((item) => item.href === BLOCKED_HREF)).toBe(false);
  });
});

describe('useAdminNavItems — B1 (D268): blocked-attempts é sub-rota de screen:funnel e some junto', () => {
  const BLOCKED_HREF = '/admin/recruitment/blocked-attempts';

  const authzComFunnel = (funnelEnabled: boolean): AuthzContract => ({
    uid: 'u',
    tenantId: 't',
    status: 'ACTIVE',
    // D269 — com enforcement 'on', tags/dedup/roles-de-grupo/bloqueadas passaram a
    // exigir célula de leitura própria (ver adminNavigation.tsx). Estas 4 aqui
    // garantem que o teste continua isolando SÓ o efeito de screen:funnel, sem se
    // confundir com a ausência de célula.
    permissions: ['worker:read', 'dedup:read', 'patient:read', 'recruitment:read'],
    countries: ['AR'],
    groups: [],
    features: { AR: { 'screen:funnel': { enabled: funnelEnabled, config: null } } },
    enforcement: 'on',
  });

  afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('screen:funnel DESLIGADA no país do ator remove blocked-attempts do menu admin (App.tsx já negava a rota — o link agora some junto)', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.ADMIN } as ReturnType<typeof useAdminAuth>['adminProfile'],
    } as ReturnType<typeof useAdminAuth>);
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: authzComFunnel(false) });

    const { result } = renderHook(() => useAdminNavItems());
    expect(result.current.some((item) => item.href === BLOCKED_HREF)).toBe(false);
    // O resto do menu admin-only não é afetado — só a chave screen:funnel.
    expect(result.current.some((item) => item.href === '/admin/tags')).toBe(true);
  });

  it('screen:funnel LIGADA mantém blocked-attempts no menu admin', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.ADMIN } as ReturnType<typeof useAdminAuth>['adminProfile'],
    } as ReturnType<typeof useAdminAuth>);
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: authzComFunnel(true) });

    const { result } = renderHook(() => useAdminNavItems());
    expect(result.current.some((item) => item.href === BLOCKED_HREF)).toBe(true);
  });
});

// ── Vindos do main (sync 06/09): itens novos do menu — com engine OFF/contrato ausente, a régua é `role`, como antes. ──
describe('useAdminNavItems — Mensajes por etapa (DEC-12 / PEND-14) é admin-only', () => {
  const HREF = '/admin/mensajes-por-etapa';

  it('admin vê o item dentro da seção Administración, com o rótulo "Mensajes por etapa"', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.ADMIN } as ReturnType<typeof useAdminAuth>['adminProfile'],
    } as ReturnType<typeof useAdminAuth>);

    const items = renderHook(() => useAdminNavItems()).result.current;
    const idx = items.findIndex((item) => item.href === HREF);
    const sectionIdx = items.findIndex((item) => item.sectionStart !== undefined);

    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeGreaterThanOrEqual(sectionIdx);
    expect(items[idx].label).toMatch(/Mensajes por etapa|Mensagens por etapa/);
  });

  it.each([
    ['RECRUITER', EnliteRole.RECRUITER],
    ['sem perfil', null],
  ])('%s NÃO vê o item', (_label, role) => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: role ? ({ role } as ReturnType<typeof useAdminAuth>['adminProfile']) : null,
    } as ReturnType<typeof useAdminAuth>);

    const items = renderHook(() => useAdminNavItems()).result.current;
    expect(items.some((item) => item.href === HREF)).toBe(false);
  });
});

describe('useAdminNavItems — Mapa (REQ-04) é item base, para todo staff', () => {
  it.each([EnliteRole.ADMIN, EnliteRole.RECRUITER])('%s vê "Mapa" apontando para /admin/mapa, depois de Pacientes', (role) => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role } as ReturnType<typeof useAdminAuth>['adminProfile'],
    } as ReturnType<typeof useAdminAuth>);

    const { result } = renderHook(() => useAdminNavItems());
    const items = result.current;

    const mapIdx = items.findIndex((item) => item.href === '/admin/mapa');
    expect(mapIdx).toBeGreaterThan(-1);
    expect(items[mapIdx].label).toBe('Mapa');
    expect(items[mapIdx].icon).toBeTruthy();
    expect(items[mapIdx].sectionStart).toBeUndefined();
    expect(mapIdx).toBe(items.findIndex((item) => item.href === '/admin/patients') + 1);
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
  const comoStaff = () =>
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.RECRUITER } as ReturnType<typeof useAdminAuth>['adminProfile'],
    } as ReturnType<typeof useAdminAuth>);
  const hrefs = () => renderHook(() => useAdminNavItems()).result.current.map((i) => i.href);

  afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('só `patient_family:read` (uma célula de container do detalhe): vê só o que essa célula abre', () => {
    comoStaff();
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
    comoStaff();
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: authzCom(['patient:read']) });
    const visiveis = hrefs();
    expect(visiveis).toContain('/admin/patients');
    // `patient:read` também é célula de um bloco do dashboard — mas ABRIR a tela é `dashboard:read`;
    // pela regra "qualquer célula da tela", o item aparece. Registrado de propósito: é a D286 literal.
    expect(visiveis).toContain('/admin/dashboard');
    for (const h of ['/admin', '/admin/vacancies', '/admin/workers', '/admin/mapa', '/admin/recruitment']) {
      expect(visiveis, `${h} apareceu sem célula`).not.toContain(h);
    }
  });

  it('o Mapa só tem containers (sem célula própria): aparece com QUALQUER célula de endereço', () => {
    comoStaff();
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: authzCom(['worker_address:read']) });
    expect(hrefs()).toContain('/admin/mapa');
  });

  it('com o engine OFF a régua é a de antes: todos os itens de topo aparecem (freio D268)', () => {
    comoStaff();
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: { ...authzCom([]), enforcement: 'off' } });
    const visiveis = hrefs();
    for (const h of ['/admin/dashboard', '/admin', '/admin/vacancies', '/admin/workers', '/admin/patients', '/admin/mapa', '/admin/recruitment', '/admin/api-docs']) {
      expect(visiveis).toContain(h);
    }
  });

  it('item cujo href não está no registro de telas (API Docs) NÃO é gateado por célula — nomeado, não esquecido', () => {
    comoStaff();
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: authzCom([]) });
    // A rota `/api/docs` do back exige só staff (index.ts), sem célula: o menu espelha o back.
    expect(hrefs()).toEqual(['/admin/api-docs']);
  });
});
