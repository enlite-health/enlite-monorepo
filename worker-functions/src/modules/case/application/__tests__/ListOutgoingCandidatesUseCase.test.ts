/**
 * ListOutgoingCandidatesUseCase — spec 069, US3: UMA linha por pessoa, nome pela MESMA projeção (célula `worker_contact:read`).
 */
import { ListOutgoingCandidatesUseCase } from '../ListOutgoingCandidatesUseCase';
import { SubstitutionServiceNotFoundError } from '../substitutionRequestErrors';

const CLIENT = { marker: 'client' } as never;
const runInTransaction = (async (fn: (c: never) => Promise<unknown>) => fn(CLIENT)) as never;
/** KMS dublê: decifra `v` como `dec:v`. */
const kms = () => ({ decrypt: jest.fn(async (v: string) => `dec:${v}`) });

const W = (workerId: string, f: string | null, l: string | null) => ({ workerId, firstNameEncrypted: f, lastNameEncrypted: l });

function readerWith(rows: { country: string; workers: ReturnType<typeof W>[] } | null) {
  return { readOutgoingCandidatesWith: jest.fn(async (_c: unknown, _p: string, _s: string, todayFor: (country: string) => string) => (todayFor('AR'), rows)) };
}

describe('ListOutgoingCandidatesUseCase', () => {
  it('uma linha por pessoa, nome decifrado COM a célula, ordenado por nome; pessoa sem nome vai ao fim', async () => {
    const reader = readerWith({ country: 'AR', workers: [W('w-2', 'f2', 'l2'), W('w-3', null, null), W('w-1', 'f1', 'l1')] });
    const result = await new ListOutgoingCandidatesUseCase(reader, kms(), runInTransaction).execute({ patientId: 'p', serviceId: 's', cells: ['worker_contact:read'] });
    expect(result).toEqual([
      { workerId: 'w-1', displayName: 'dec:f1 dec:l1' },
      { workerId: 'w-2', displayName: 'dec:f2 dec:l2' },
      { workerId: 'w-3', displayName: null },
    ]);
  });

  it('SEM a célula: nenhum decrypt, nome null, a pessoa continua na lista (escolha por id), em ordem estável por id', async () => {
    const k = kms();
    const reader = readerWith({ country: 'AR', workers: [W('w-b', 'x', 'y'), W('w-a', 'x', 'y')] });
    const result = await new ListOutgoingCandidatesUseCase(reader, k, runInTransaction).execute({ patientId: 'p', serviceId: 's', cells: ['patient_services:read'] });
    expect(k.decrypt).not.toHaveBeenCalled();
    expect(result).toEqual([{ workerId: 'w-a', displayName: null }, { workerId: 'w-b', displayName: null }]);
  });

  it('"hoje" vem da data de operação do PAÍS do serviço (fuso), não do relógio do processo; `now` e `cells` omitidos usam o padrão (engine OFF = nome aparece)', async () => {
    const madrugada = new Date('2026-11-03T02:30:00Z');
    expect(madrugada.toISOString().slice(0, 10)).toBe('2026-11-03'); // sanidade
    let hoje = '';
    const reader = { readOutgoingCandidatesWith: jest.fn(async (_c: unknown, _p: string, _s: string, todayFor: (c: string) => string) => ((hoje = todayFor('AR')), { country: 'AR', workers: [W('w-1', 'f', 'l')] })) };
    const result = await new ListOutgoingCandidatesUseCase(reader, kms(), runInTransaction).execute({ patientId: 'p', serviceId: 's', now: madrugada });
    expect(hoje).toBe('2026-11-02');
    expect(result[0].displayName).toBe('dec:f dec:l');
  });

  it('serviço inexistente → SubstitutionServiceNotFoundError; construtor sem argumentos monta as portas reais', async () => {
    await expect(new ListOutgoingCandidatesUseCase(readerWith(null), kms(), runInTransaction).execute({ patientId: 'p', serviceId: 's' })).rejects.toThrow(SubstitutionServiceNotFoundError);
    expect(() => new ListOutgoingCandidatesUseCase()).not.toThrow();
  });

  it('o mesmo `now` do relógio real quando omitido', async () => {
    const reader = readerWith({ country: 'AR', workers: [] });
    await expect(new ListOutgoingCandidatesUseCase(reader, kms(), runInTransaction).execute({ patientId: 'p', serviceId: 's' })).resolves.toEqual([]);
  });
});
