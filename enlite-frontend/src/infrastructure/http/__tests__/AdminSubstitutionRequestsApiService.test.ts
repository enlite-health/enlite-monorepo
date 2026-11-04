/**
 * AdminSubstitutionRequestsApiService — spec 069, as 6 rotas do pedido de substituição.
 * Cada teste confere MÉTODO + URL + CORPO que vão ao `request` do serviço irmão (o fetch real é dele).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const request = vi.fn();
vi.mock('../AdminContractedServicesApiService', () => ({
  AdminContractedServicesApiService: { request: (...a: unknown[]) => request(...a) },
}));

import { AdminSubstitutionRequestsApiService as Api } from '../AdminSubstitutionRequestsApiService';

const BASE = '/api/admin/patients/p1/contracted-services/s1/substitution-requests';

describe('AdminSubstitutionRequestsApiService', () => {
  beforeEach(() => {
    request.mockReset();
  });

  it('list: GET com ?when= e devolve o corpo como veio', async () => {
    const body = { patientId: 'p1', serviceId: 's1', when: 'past', requests: [] };
    request.mockResolvedValue(body);
    expect(await Api.list('p1', 's1', 'past')).toBe(body);
    expect(request).toHaveBeenCalledWith('GET', `${BASE}?when=past`);
  });

  it('outgoingOptions: GET e devolve só o array `workers`', async () => {
    request.mockResolvedValue({ workers: [{ workerId: 'w1', displayName: 'Lucía' }] });
    expect(await Api.outgoingOptions('p1', 's1')).toEqual([{ workerId: 'w1', displayName: 'Lucía' }]);
    expect(request).toHaveBeenCalledWith('GET', `${BASE}/outgoing-options`);
  });

  it('preview: POST /preview com o corpo (candidatos inclusive)', async () => {
    const body = { type: 'DAYS' as const, outgoingWorkerId: 'w1', from: '2026-11-03', to: '2026-11-14', candidateWorkerIds: ['w2'] };
    request.mockResolvedValue({ shifts: [], conflicts: [], statusAfter: null });
    await Api.preview('p1', 's1', body);
    expect(request).toHaveBeenCalledWith('POST', `${BASE}/preview`, body);
  });

  it('create: POST na raiz com `substituteWorkerId: null` preservado (null = "Nadie todavía", chave nunca omitida)', async () => {
    const body = {
      type: 'DAYS' as const,
      outgoingWorkerId: 'w1',
      from: '2026-11-03',
      to: '2026-11-04',
      reasonCategory: 'VACATION',
      shifts: [{ date: '2026-11-03', slotId: 'sl1', substituteWorkerId: null }],
    };
    request.mockResolvedValue({ requestId: 'r1' });
    await Api.create('p1', 's1', body);
    expect(request).toHaveBeenCalledWith('POST', BASE, body);
    expect(request.mock.calls[0][2].shifts[0]).toHaveProperty('substituteWorkerId', null);
  });

  it('undo: POST /:rid/undo sem corpo', async () => {
    request.mockResolvedValue({ requestId: 'r1' });
    await Api.undo('p1', 's1', 'r1');
    expect(request).toHaveBeenCalledWith('POST', `${BASE}/r1/undo`);
  });

  it('cover: POST /:rid/cover com o substituto', async () => {
    request.mockResolvedValue({ requestId: 'r1', covered: 2 });
    await Api.cover('p1', 's1', 'r1', 'w9');
    expect(request).toHaveBeenCalledWith('POST', `${BASE}/r1/cover`, { substituteWorkerId: 'w9' });
  });

  it('erro do request (409/422 com code) sobe sem ser engolido', async () => {
    request.mockRejectedValue(Object.assign(new Error('x'), { code: 'REQUEST_NOT_UNDOABLE' }));
    await expect(Api.undo('p1', 's1', 'r1')).rejects.toMatchObject({ code: 'REQUEST_NOT_UNDOABLE' });
  });
});
