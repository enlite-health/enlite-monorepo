import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { useCellAccess, useHasCell, useActionGate, useContainerAccess, containersVisibleFor, tabsVisibleFor, screenVisibleFor } from '../useCellAccess';
import { screenById } from '@presentation/config/screenRegistry';
import type { AuthzContract } from '@domain/entities/Authz';

const contrato = (permissions: string[]): AuthzContract => ({
  uid: 'u1',
  tenantId: 't1',
  status: 'ACTIVE',
  permissions,
  countries: ['AR'],
  groups: [],
  features: {},
});

describe('useCellAccess', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('contrato ainda não carregado → hidden (fail-closed), com o status exposto', () => {
    const { result } = renderHook(() => useCellAccess('permission_management'));
    expect(result.current).toEqual({ level: 'hidden', canRead: false, canWrite: false, status: 'idle' });
  });

  it('🔴 contrato em ERRO → hidden mesmo que um contrato antigo tenha sobrado', () => {
    useAdminAuthStore.setState({ authz: contrato(['permission_management:write']), authzStatus: 'error' });
    const { result } = renderHook(() => useCellAccess('permission_management'));
    expect(result.current.level).toBe('hidden');
  });

  it('só read → read, sem write', () => {
    useAdminAuthStore.setState({ authz: contrato(['permission_management:read']), authzStatus: 'ready' });
    const { result } = renderHook(() => useCellAccess('permission_management'));
    expect(result.current).toMatchObject({ level: 'read', canRead: true, canWrite: false });
  });

  it('write → completo', () => {
    useAdminAuthStore.setState({ authz: contrato(['permission_management:write']), authzStatus: 'ready' });
    const { result } = renderHook(() => useCellAccess('permission_management'));
    expect(result.current).toMatchObject({ level: 'write', canRead: true, canWrite: true });
  });

  it('a mudança do contrato re-renderiza — revogação vale na hora', () => {
    useAdminAuthStore.setState({ authz: contrato(['permission_management:write']), authzStatus: 'ready' });
    const { result, rerender } = renderHook(() => useCellAccess('permission_management'));
    expect(result.current.level).toBe('write');
    useAdminAuthStore.setState({ authz: contrato([]) });
    rerender();
    expect(result.current.level).toBe('hidden');
  });
});

describe('useHasCell', () => {
  it('só responde com contrato pronto', () => {
    useAdminAuthStore.setState({ authz: contrato(['worker:export']), authzStatus: 'loading' });
    expect(renderHook(() => useHasCell('worker', 'export')).result.current).toBe(false);
    useAdminAuthStore.setState({ authzStatus: 'ready' });
    expect(renderHook(() => useHasCell('worker', 'export')).result.current).toBe(true);
  });
});

describe('contrato `ready` com authz nulo — estado impossível, mas o hook não pode explodir', () => {
  it('trata como hidden', () => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'ready' });
    expect(renderHook(() => useCellAccess('x')).result.current.level).toBe('hidden');
    expect(renderHook(() => useHasCell('x', 'read')).result.current).toBe(false);
  });
});

// D269 — a mesma decisão do `ActionButton`, para elemento que não é `<Button>` (switch, drag).
describe('useActionGate', () => {
  const comEnforcement = (permissions: string[], enforcement: AuthzContract['enforcement']) =>
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: { ...contrato(permissions), enforcement },
    });

  it('enforcement=on, sem célula: denied', () => {
    comEnforcement(['x:read'], 'on');
    const { result } = renderHook(() => useActionGate('x', 'write'));
    expect(result.current).toEqual({ allowed: false, denied: true });
  });

  it('enforcement=on, com a célula: allowed', () => {
    comEnforcement(['x:write'], 'on');
    const { result } = renderHook(() => useActionGate('x', 'write'));
    expect(result.current).toEqual({ allowed: true, denied: false });
  });

  it('enforcement OFF (ou ausente): sempre allowed, mesmo sem célula', () => {
    comEnforcement([], 'off');
    expect(renderHook(() => useActionGate('x', 'write')).result.current).toEqual({ allowed: true, denied: false });
    useAdminAuthStore.setState({ authz: contrato([]), authzStatus: 'ready' }); // enforcement ausente
    expect(renderHook(() => useActionGate('x', 'write')).result.current).toEqual({ allowed: true, denied: false });
  });
});

describe('useContainerAccess — o gate de CONTAINER (D286)', () => {
  beforeEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('enforcement=on, sem a célula de leitura: invisível (e sem escrita)', () => {
    useAdminAuthStore.setState({ authz: { ...contrato(['patient:read']), enforcement: 'on' }, authzStatus: 'ready' });
    expect(renderHook(() => useContainerAccess('patient_family')).result.current).toEqual({ visible: false, canWrite: false });
  });

  it('enforcement=on, só leitura: visível sem escrita; com escrita: os dois', () => {
    useAdminAuthStore.setState({ authz: { ...contrato(['patient_family:read']), enforcement: 'on' }, authzStatus: 'ready' });
    expect(renderHook(() => useContainerAccess('patient_family')).result.current).toEqual({ visible: true, canWrite: false });
    useAdminAuthStore.setState({ authz: { ...contrato(['patient_family:write']), enforcement: 'on' }, authzStatus: 'ready' });
    expect(renderHook(() => useContainerAccess('patient_family')).result.current).toEqual({ visible: true, canWrite: true });
  });

  it('🔴 enforcement OFF (ou contrato ausente): tudo visível e editável — as células novas nascem sem grupo', () => {
    useAdminAuthStore.setState({ authz: { ...contrato([]), enforcement: 'off' }, authzStatus: 'ready' });
    expect(renderHook(() => useContainerAccess('patient_family')).result.current).toEqual({ visible: true, canWrite: true });
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    expect(renderHook(() => useContainerAccess('patient_family')).result.current).toEqual({ visible: true, canWrite: true });
  });
});

describe('containersVisibleFor — a aba existe se QUALQUER container dela for legível', () => {
  it('on: some sem nenhuma célula, fica com uma; off: sempre', () => {
    expect(containersVisibleFor(['patient:read'], 'on', ['patient_family', 'patient_chat'])).toBe(false);
    expect(containersVisibleFor(['patient_chat:read'], 'on', ['patient_family', 'patient_chat'])).toBe(true);
    expect(containersVisibleFor(['patient_chat:write'], 'on', ['patient_chat'])).toBe(true);
    expect(containersVisibleFor([], 'off', ['patient_family'])).toBe(true);
    expect(containersVisibleFor(null, undefined, ['patient_family'])).toBe(true);
    // aba sem container nenhum, com enforcement on: não existe
    expect(containersVisibleFor(['patient:read'], 'on', [])).toBe(false);
  });
});

describe('tabsVisibleFor — as abas de uma tela para o ator (D286 fase 2)', () => {
  const prestador = screenById('workers.detail');
  const vaga = screenById('vacancies.detail');
  const TABS_P = ['encuadres', 'documents', 'availability', 'financial', 'history'] as const;

  it('aba com container: existe se algum for legível; aba SEM container (placeholder) existe sempre', () => {
    expect(tabsVisibleFor(prestador, TABS_P, ['worker:read'], 'on')).toEqual(['availability', 'financial', 'history']);
    expect(tabsVisibleFor(prestador, TABS_P, ['worker:read', 'match:read'], 'on')).toEqual(['encuadres', 'availability', 'financial', 'history']);
    expect(tabsVisibleFor(prestador, TABS_P, ['worker:read', 'worker_document:read'], 'on')).toEqual(['documents', 'availability', 'financial', 'history']);
  });

  it('na vaga: Links segue a própria vaga; Talentum com prescreening OU talentum; Encuadres com funil/match/convites', () => {
    const T = ['encuadres', 'talentum', 'links'] as const;
    expect(tabsVisibleFor(vaga, T, ['vacancy:read'], 'on')).toEqual(['links']);
    expect(tabsVisibleFor(vaga, T, ['vacancy:read', 'talentum:read'], 'on')).toEqual(['talentum', 'links']);
    expect(tabsVisibleFor(vaga, T, ['vacancy:read', 'messaging:send'], 'on')).toEqual(['encuadres', 'links']);
  });

  it('enforcement off ou indeciso: todas', () => {
    expect(tabsVisibleFor(prestador, TABS_P, [], 'off')).toEqual([...TABS_P]);
    expect(tabsVisibleFor(prestador, TABS_P, null, undefined)).toEqual([...TABS_P]);
  });
});

describe('screenVisibleFor — a TELA existe para quem tem qualquer célula dela (D286, item de menu)', () => {
  it('tela só com células próprias (lista): qualquer uma delas basta, em qualquer ação', () => {
    const lista = screenById('patients.list');
    expect(screenVisibleFor(lista, ['patient:read'], 'on')).toBe(true);
    expect(screenVisibleFor(lista, ['patient:delete'], 'on')).toBe(true);
    expect(screenVisibleFor(lista, ['patient_family:read'], 'on')).toBe(false);
    expect(screenVisibleFor(lista, [], 'on')).toBe(false);
  });

  it('tela só com containers (mapa): a célula de qualquer container basta', () => {
    const mapa = screenById('map');
    expect(screenVisibleFor(mapa, ['worker_address:read'], 'on')).toBe(true);
    expect(screenVisibleFor(mapa, ['patient_address:read'], 'on')).toBe(true);
    expect(screenVisibleFor(mapa, ['worker:read', 'patient:read'], 'on')).toBe(false);
  });

  it('tela com célula própria E containers (dashboard): uma de bloco basta, mesmo sem a de abrir', () => {
    const dash = screenById('dashboard');
    expect(screenVisibleFor(dash, ['dashboard_zones:read'], 'on')).toBe(true);
    expect(screenVisibleFor(dash, ['dashboard:read'], 'on')).toBe(true);
  });

  it('enforcement off ou indeciso, ou permissões ausentes: freio D268', () => {
    const lista = screenById('patients.list');
    expect(screenVisibleFor(lista, [], 'off')).toBe(true);
    expect(screenVisibleFor(lista, null, undefined)).toBe(true);
    expect(screenVisibleFor(lista, null, 'on')).toBe(false);
  });
});
