import { HttpAttendancePresenceReviewGateway } from '../HttpAttendancePresenceReviewGateway';
import { PresenceUnavailableError } from '../../application/ports/PresenceReaderPort';
import { PresenceReviewUpstreamError } from '../../application/ports/PresenceReviewPorts';

const UUID_A = 'a1b2c3d4-0000-4000-8000-000000000001';
const UUID_B = 'a1b2c3d4-0000-4000-8000-000000000002';
const item = (over: Record<string, unknown> = {}) => ({
  kind: 'EXCEPTION_PENDING', id: UUID_A, occurrence_id: UUID_A, worker_id: UUID_B, slot_id: null, on_date: '2026-11-25', occurred_at: '2026-11-25T14:00:00.123456Z',
  reason: 'GPS_INDOOR', exception_kind: 'GEO_DECLARED', distance_m: 180, accuracy_m: 40, ...over,
});
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const build = (fetchImpl: jest.Mock, extra: Record<string, unknown> = {}) =>
  new HttpAttendancePresenceReviewGateway({ baseUrl: 'http://att/', idToken: async () => ({ Authorization: 'Bearer tok' }), fetchImpl: fetchImpl as never, ...extra });

describe('HttpAttendancePresenceReviewGateway (emenda 077 §4.6)', () => {
  it('queue: GET com country/kind/cursor e o Authorization do ID token; devolve itens camelCase', async () => {
    const f = jest.fn().mockResolvedValue(json(200, { items: [item()], next_cursor: 'abc' }));
    const page = await build(f).queue({ country: 'AR', kind: 'EXCEPTION_PENDING', cursor: 'xyz' });
    expect(f).toHaveBeenCalledWith('http://att/internal/v1/presence/review-queue?country=AR&kind=EXCEPTION_PENDING&cursor=xyz', expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer tok' } }));
    expect(page).toEqual({ nextCursor: 'abc', items: [expect.objectContaining({ id: UUID_A, workerId: UUID_B, onDate: '2026-11-25', exceptionKind: 'GEO_DECLARED', distanceM: 180, accuracyM: 40 })] });
  });

  it('queue: ATTENDANCE_AUTH=none (fora de produção) não pede token; sem URL → sem_url', async () => {
    const f = jest.fn().mockResolvedValue(json(200, { items: [], next_cursor: null }));
    const idToken = jest.fn();
    await new HttpAttendancePresenceReviewGateway({ baseUrl: 'http://att', authNone: true, idToken, fetchImpl: f as never }).queue({ country: 'AR' });
    expect(idToken).not.toHaveBeenCalled();
    await expect(new HttpAttendancePresenceReviewGateway({ idToken, fetchImpl: f as never }).queue({ country: 'AR' })).rejects.toMatchObject({ reason: 'sem_url' });
  });

  it.each([
    ['item fora do contrato (kind estranho)', { items: [item({ kind: 'X' })], next_cursor: null }],
    ['distance_m fracionária', { items: [item({ distance_m: 1.5 })], next_cursor: null }],
    ['worker_id que não é uuid', { items: [item({ worker_id: 'w' })], next_cursor: null }],
    ['corpo sem items', { next_cursor: null }],
    ['next_cursor numérico', { items: [], next_cursor: 3 }],
  ])('queue: %s → resposta_invalida', async (_n, body) => {
    await expect(build(jest.fn().mockResolvedValue(json(200, body))).queue({ country: 'AR' })).rejects.toMatchObject({ reason: 'resposta_invalida' });
  });

  it('queue: 400 INVALID_CURSOR do attendance é repassado; 5xx e rede viram PresenceUnavailableError com código curto', async () => {
    await expect(build(jest.fn().mockResolvedValue(json(400, { code: 'INVALID_CURSOR', message: 'x' }))).queue({ country: 'AR', cursor: 'z' })).rejects.toEqual(new PresenceReviewUpstreamError(400, 'INVALID_CURSOR'));
    await expect(build(jest.fn().mockResolvedValue(json(502, {}))).queue({ country: 'AR' })).rejects.toMatchObject({ reason: 'http_502' });
    await expect(build(jest.fn().mockRejectedValue(new Error('boom'))).queue({ country: 'AR' })).rejects.toMatchObject({ reason: 'rede' });
  });

  it('queue: timeout aborta a chamada', async () => {
    const f = jest.fn((_u: string, init: { signal: AbortSignal }) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(new Error('abort')))));
    await expect(build(f as never, { timeoutMs: 5 }).queue({ country: 'AR' })).rejects.toBeInstanceOf(PresenceUnavailableError);
  });

  it('decide: POST com decision, resolution_code e decided_by_uid; devolve o resultado', async () => {
    const f = jest.fn().mockResolvedValue(json(200, { event_id: UUID_A, decision: 'REFUSED', resolution_code: 'NOT_AT_PATIENT' }));
    const r = await build(f).decide({ eventId: UUID_A, decision: 'REFUSED', resolutionCode: 'NOT_AT_PATIENT', decidedByUid: 'u1' });
    expect(f).toHaveBeenCalledWith(`http://att/internal/v1/presence/exceptions/${UUID_A}/decision`, expect.objectContaining({
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify({ decision: 'REFUSED', resolution_code: 'NOT_AT_PATIENT', decided_by_uid: 'u1' }),
    }));
    expect(r).toEqual({ eventId: UUID_A, decision: 'REFUSED', resolutionCode: 'NOT_AT_PATIENT' });
  });

  it('decide: 409 e 404 repassados com código fechado (corpo desconhecido cai no código do status); resposta fora do contrato → resposta_invalida', async () => {
    const input = { eventId: UUID_A, decision: 'APPROVED', resolutionCode: 'INDOOR_CONFIRMED', decidedByUid: 'u1' } as const;
    await expect(build(jest.fn().mockResolvedValue(json(409, { code: 'EXCEPTION_ALREADY_DECIDED', message: 'x' }))).decide(input)).rejects.toEqual(new PresenceReviewUpstreamError(409, 'EXCEPTION_ALREADY_DECIDED'));
    await expect(build(jest.fn().mockResolvedValue(json(404, { code: 'QUALQUER', message: 'Fulana' }))).decide(input)).rejects.toEqual(new PresenceReviewUpstreamError(404, 'EXCEPTION_NOT_FOUND'));
    const semCorpo = { ok: false, status: 409, json: async () => { throw new Error('vazio'); } } as unknown as Response;
    await expect(build(jest.fn().mockResolvedValue(semCorpo)).decide(input)).rejects.toEqual(new PresenceReviewUpstreamError(409, 'EXCEPTION_ALREADY_DECIDED'));
    await expect(build(jest.fn().mockResolvedValue(json(200, { event_id: 'x' }))).decide(input)).rejects.toMatchObject({ reason: 'resposta_invalida' });
  });
});
