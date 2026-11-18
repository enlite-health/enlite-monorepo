import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useTherapeuticCascade } from '../useTherapeuticCascade';
import type { TherapeuticCatalogGateway } from '@domain/repositories/TherapeuticCatalogGateway';
import type { CascadeBlock, CascadeRequestBody, CascadeResponse } from '@domain/entities/TherapeuticProject';

const block = (uri: string): CascadeBlock => ({
  diagnosisUri: uri,
  categoryCode: 'AB12',
  status: 'ok',
  objectives: [{ id: `${uri}-o`, label: 'O', description: null, activities: [{ id: `${uri}-a`, label: 'A', description: null, suggestedFrequency: null }] }],
});

/** Fake da porta (não mock de fetch): responde um bloco por URI e registra as chamadas. */
class FakeGateway {
  calls: CascadeRequestBody[] = [];
  async cascade(body: CascadeRequestBody): Promise<CascadeResponse> {
    this.calls.push(body);
    return { serviceCode: body.serviceCode, serviceHasCatalog: true, blocks: body.diagnosisUris.map(block) };
  }
}

describe('useTherapeuticCascade', () => {
  let fake: FakeGateway;
  let gateway: TherapeuticCatalogGateway;
  beforeEach(() => {
    fake = new FakeGateway();
    gateway = fake as unknown as TherapeuticCatalogGateway;
  });

  it('chama a cascata com serviço e diagnósticos e expõe os blocos por URI, na ordem', async () => {
    const { result } = renderHook(() => useTherapeuticCascade('AT', ['u1', 'u2'], gateway));
    await waitFor(() => expect(result.current.blocks).toHaveLength(2));
    expect(fake.calls).toEqual([{ serviceCode: 'AT', diagnosisUris: ['u1', 'u2'] }]);
    expect(result.current.blocks.map((b) => b.diagnosisUri)).toEqual(['u1', 'u2']);
    expect(result.current.isLoading).toBe(false);
  });

  it.each([[null], [undefined], ['']])('não chama sem serviço (%s)', async (svc) => {
    const { result } = renderHook(() => useTherapeuticCascade(svc, ['u1'], gateway));
    await act(async () => {});
    expect(fake.calls).toHaveLength(0);
    expect(result.current.blocks).toEqual([]);
    expect(result.current.canSubmit).toBe(false);
  });

  it('não chama sem diagnósticos', async () => {
    renderHook(() => useTherapeuticCascade('AT', [], gateway));
    await act(async () => {});
    expect(fake.calls).toHaveLength(0);
  });

  it('refaz a chamada ao trocar o serviço e zera a seleção', async () => {
    const { result, rerender } = renderHook(({ s }) => useTherapeuticCascade(s, ['u1'], gateway), { initialProps: { s: 'AT' } });
    await waitFor(() => expect(result.current.blocks).toHaveLength(1));
    act(() => result.current.toggleObjective('u1', 'u1-o'));
    expect(result.current.cascade.isObjectiveSelected('u1', 'u1-o')).toBe(true);
    rerender({ s: 'OT' });
    await waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(fake.calls[1]).toEqual({ serviceCode: 'OT', diagnosisUris: ['u1'] });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.cascade.isObjectiveSelected('u1', 'u1-o')).toBe(false);
  });

  it('refaz a chamada ao mudar os diagnósticos; tirar um some com o bloco e mantém a seleção do outro', async () => {
    const { result, rerender } = renderHook(({ d }) => useTherapeuticCascade('AT', d, gateway), { initialProps: { d: ['u1', 'u2'] } });
    await waitFor(() => expect(result.current.blocks).toHaveLength(2));
    act(() => result.current.toggleObjective('u2', 'u2-o'));
    rerender({ d: ['u2'] });
    await waitFor(() => expect(fake.calls).toHaveLength(2));
    await waitFor(() => expect(result.current.blocks.map((b) => b.diagnosisUri)).toEqual(['u2']));
    expect(result.current.cascade.isObjectiveSelected('u2', 'u2-o')).toBe(true);
  });

  it('mesma lista de URIs em novo array não refaz a chamada', async () => {
    const { result, rerender } = renderHook(({ d }) => useTherapeuticCascade('AT', d, gateway), { initialProps: { d: ['u1'] } });
    await waitFor(() => expect(result.current.blocks).toHaveLength(1));
    rerender({ d: ['u1'] });
    await act(async () => {});
    expect(fake.calls).toHaveLength(1);
  });

  it('erro da porta vira error e bloqueia o salvar', async () => {
    const failing = { cascade: async () => { throw new Error('ptp_diagnosis_unknown'); } } as unknown as TherapeuticCatalogGateway;
    const { result } = renderHook(() => useTherapeuticCascade('AT', ['u1'], failing));
    await waitFor(() => expect(result.current.error).toBe('ptp_diagnosis_unknown'));
    expect(result.current.canSubmit).toBe(false);
  });

  it('canSubmit habilita com objetivo e atividade marcados e toRequestBody entrega diagnosisPlans', async () => {
    const { result } = renderHook(() => useTherapeuticCascade('AT', ['u1'], gateway));
    await waitFor(() => expect(result.current.blocks).toHaveLength(1));
    expect(result.current.canSubmit).toBe(false);
    act(() => result.current.toggleObjective('u1', 'u1-o'));
    act(() => result.current.toggleActivity('u1', 'u1-a'));
    expect(result.current.canSubmit).toBe(true);
    expect(result.current.toRequestBody()).toEqual([{ diagnosisUri: 'u1', specificObjectiveIds: ['u1-o'], activityIds: ['u1-a'] }]);
  });
});
