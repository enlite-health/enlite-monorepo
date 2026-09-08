/**
 * useTherapeuticProjects / useTherapeuticCatalogs — spec 017 F4.
 *
 * O que estes testes seguram:
 *  · D286 (permissão por CONTAINER): `enabled=false` é o container SEM célula — o hook não pode
 *    chamar a rota. "Não chamou" é a asserção, não "a tela não mostrou": esconder na tela não é
 *    permissão, e um `listVersions` disparado já deixaria trilha e já traria dado projetado.
 *  · lex C7: erro do servidor vira string de tela; nada do corpo clínico entra em estado aqui.
 *  · A guarda `alive` do unmount: a resposta que chega DEPOIS do unmount não seta estado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { TherapeuticCatalogItem, TherapeuticProjectVersion } from '@domain/entities/TherapeuticProject';

const listVersions = vi.fn();
const listCatalog = vi.fn();

vi.mock('@infrastructure/http/AdminTherapeuticProjectsApiService', () => ({
  AdminTherapeuticProjectsApiService: {
    listVersions: (...a: unknown[]) => listVersions(...a),
    listCatalog: (...a: unknown[]) => listCatalog(...a),
  },
}));

import { useTherapeuticProjects, useTherapeuticCatalogs } from '../useTherapeuticProjects';

const VERSAO = {
  id: 'v1',
  patientId: 'p1',
  major: 1,
  minor: 0,
  version: 'V.1.0',
  editedFromVersionId: null,
  contractedServiceId: 'svc-1',
  contractedServiceCode: 'CAREGIVER',
  modality: 'IN_PERSON',
  diagnoses: [],
  clinicalContext: 'ctx',
  generalObjective: 'obj',
  specificObjectives: [],
  activities: [],
  pathologyTypes: [],
  startDate: '2026-09-01',
  endDate: '2026-12-01',
  annulledAt: null,
  annulledByName: null,
  annulReason: null,
  createdByName: 'Ana',
  createdAt: '2026-09-01T10:00:00Z',
  country: 'AR',
} satisfies TherapeuticProjectVersion;

const ITEM = (id: string): TherapeuticCatalogItem => ({
  id,
  label: `rótulo ${id}`,
  sortOrder: 1,
  active: true,
  deactivatedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
});

/** Promessa que só resolve quando o teste mandar — para observar o estado ANTES da resposta. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  listVersions.mockReset();
  listCatalog.mockReset();
});

describe('useTherapeuticProjects — as versões do paciente', () => {
  it('carrega a lista (enabled implícito) e devolve na ordem recebida do servidor', async () => {
    const segunda = { ...VERSAO, id: 'v2', version: 'V.2.0' };
    listVersions.mockResolvedValue([segunda, VERSAO]);

    const { result } = renderHook(() => useTherapeuticProjects('p1'));

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(listVersions).toHaveBeenCalledWith('p1');
    expect(result.current.versions.map((v) => v.id)).toEqual(['v2', 'v1']);
    expect(result.current.error).toBeNull();
  });

  it('🔒 D286: `enabled=false` (container sem célula) NÃO chama a rota e sai de loading', async () => {
    const { result } = renderHook(() => useTherapeuticProjects('p1', false));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(listVersions).not.toHaveBeenCalled();
    expect(result.current.versions).toEqual([]);
  });

  it('sem `patientId` também não chama (a ficha ainda não tem id)', async () => {
    const { result } = renderHook(() => useTherapeuticProjects(undefined));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(listVersions).not.toHaveBeenCalled();
  });

  it('erro `Error` do servidor vira a mensagem da tela (lex C7: só a frase, nada do corpo)', async () => {
    listVersions.mockRejectedValue(new Error('403 sem célula clínica'));

    const { result } = renderHook(() => useTherapeuticProjects('p1'));

    await waitFor(() => expect(result.current.error).toBe('403 sem célula clínica'));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.versions).toEqual([]);
  });

  it('rejeição que NÃO é Error (string crua) vira `String(err)` — não quebra a tela', async () => {
    listVersions.mockRejectedValue('caiu a rede');

    const { result } = renderHook(() => useTherapeuticProjects('p1'));

    await waitFor(() => expect(result.current.error).toBe('caiu a rede'));
  });

  it('`refetch` chama de novo e limpa o erro anterior', async () => {
    listVersions.mockRejectedValueOnce(new Error('falhou'));
    const { result } = renderHook(() => useTherapeuticProjects('p1'));
    await waitFor(() => expect(result.current.error).toBe('falhou'));

    listVersions.mockResolvedValueOnce([VERSAO]);
    await act(async () => { await result.current.refetch(); });

    expect(listVersions).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.versions).toEqual([VERSAO]);
  });
});

describe('useTherapeuticCatalogs — os 3 catálogos do formulário', () => {
  it('🔒 D286: `enabled=false` não busca catálogo nenhum', () => {
    const { result } = renderHook(() => useTherapeuticCatalogs(false));

    expect(listCatalog).not.toHaveBeenCalled();
    expect(result.current.catalogs).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('busca os 3 tipos e devolve indexado por tipo', async () => {
    listCatalog.mockImplementation(async (kind: string) => [ITEM(`${kind}-1`)]);

    const { result } = renderHook(() => useTherapeuticCatalogs(true));

    await waitFor(() => expect(result.current.catalogs).not.toBeNull());
    expect(listCatalog.mock.calls.map((c) => c[0])).toEqual(['specific-objectives', 'activities', 'pathology-types']);
    expect(result.current.catalogs!['specific-objectives'][0].id).toBe('specific-objectives-1');
    expect(result.current.catalogs!.activities[0].id).toBe('activities-1');
    expect(result.current.catalogs!['pathology-types'][0].id).toBe('pathology-types-1');
  });

  it('erro `Error` em qualquer um dos 3 vira a mensagem, e `catalogs` fica null', async () => {
    listCatalog.mockImplementation(async (kind: string) => {
      if (kind === 'activities') throw new Error('catálogo indisponível');
      return [];
    });

    const { result } = renderHook(() => useTherapeuticCatalogs(true));

    await waitFor(() => expect(result.current.error).toBe('catálogo indisponível'));
    expect(result.current.catalogs).toBeNull();
  });

  it('rejeição que não é Error vira `String(err)`', async () => {
    listCatalog.mockRejectedValue({ toString: () => 'objeto estranho' });

    const { result } = renderHook(() => useTherapeuticCatalogs(true));

    await waitFor(() => expect(result.current.error).toBe('objeto estranho'));
  });

  it('🔒 resposta que chega DEPOIS do unmount não seta estado (guarda `alive`)', async () => {
    const d = deferred<TherapeuticCatalogItem[]>();
    listCatalog.mockReturnValue(d.promise);

    const { result, unmount } = renderHook(() => useTherapeuticCatalogs(true));
    expect(listCatalog).toHaveBeenCalledTimes(3);

    unmount();
    await act(async () => { d.resolve([ITEM('tarde')]); await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.catalogs).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('🔒 erro que chega DEPOIS do unmount também não seta estado (guarda `alive` no catch)', async () => {
    const d = deferred<TherapeuticCatalogItem[]>();
    listCatalog.mockReturnValue(d.promise);

    const { result, unmount } = renderHook(() => useTherapeuticCatalogs(true));
    unmount();
    await act(async () => {
      d.reject(new Error('tarde demais'));
      await Promise.resolve().catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.catalogs).toBeNull();
  });
});
