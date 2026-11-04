/**
 * contractedServiceContractLinkWriter (§E; spec 058 §3.2, plan §1.3.1) — a ORDEM de escrita que as triggers T1/T2 esperam, o lock do paciente
 * antes de tudo, o refine `SAME_START_USE_CORRECTION` ANTES do banco, e o retry de 40P01 -> 409. O que o banco ACEITA é provado nos e2e de banco
 * (`tests/e2e/058a-vinculo.e2e.test.ts`); aqui o cliente é falso e registra o SQL na ordem em que sai.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockClientQuery = jest.fn();
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: jest.fn(async (_pool: unknown, fn: (c: unknown) => Promise<unknown>) => fn({ query: mockClientQuery })),
}));
jest.mock('@shared/database/DatabaseConnection', () => ({ DatabaseConnection: { getInstance: () => ({ getPool: () => ({}) }) } }));

import { ConcurrencyConflictError } from '@shared/database/withSerializationRetry';
import {
  ContractedServiceContractLinkWriter,
  ServiceNotFoundForLinkError,
  ContractNotFoundForLinkError,
  NoLiveLinkError,
} from '../contractedServiceContractLinkWriter';
import { SameStartUseCorrectionError, RangeInvalidError } from '../../domain/rangeWriteErrors';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const SERVICE = '22222222-2222-4222-8222-222222222222';
const OLD_CONTRACT = '33333333-3333-4333-8333-333333333333';
const NEW_CONTRACT = '44444444-4444-4444-8444-444444444444';
const ACTOR = 'uid-operadora';

interface Script {
  owner?: boolean;
  contract?: boolean;
  live?: { id: string; contract_id: string; valid: string } | null;
  lives?: Array<{ id: string; contract_id: string; valid: string }>;
  failOn?: (sql: string) => unknown;
}

function script(s: Script = {}): void {
  const { owner = true, contract = true, live = { id: 'L1', contract_id: OLD_CONTRACT, valid: '[2026-03-01,)' } } = s;
  mockClientQuery.mockImplementation(async (sql: string) => {
    const f = s.failOn?.(sql);
    if (f) throw f;
    if (/FROM patient_contracted_services/.test(sql)) return { rows: owner ? [{ '?column?': 1 }] : [], rowCount: owner ? 1 : 0 };
    if (/FROM insurance_contracts/.test(sql)) return { rows: contract ? [{ '?column?': 1 }] : [], rowCount: contract ? 1 : 0 };
    if (/FROM contracted_service_contract/.test(sql)) { const rows = s.lives ?? (live ? [live] : []); return { rows, rowCount: rows.length }; }
    return { rows: [], rowCount: 1 };
  });
}

const sqls = (): string[] => mockClientQuery.mock.calls.map(([sql]) => sql as string);
const writes = (): Array<[string, unknown[]]> =>
  mockClientQuery.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE)/.test(sql as string)).map(([sql, p]) => [sql as string, p as unknown[]]);

describe('ContractedServiceContractLinkWriter', () => {
  const writer = new ContractedServiceContractLinkWriter();
  beforeEach(() => {
    mockClientQuery.mockReset();
    script();
  });

  it('create: posse e LOCK do paciente antes de qualquer escrita; vigência vem do wire (validTo inclusivo)', async () => {
    await writer.create(PATIENT, SERVICE, { contractId: NEW_CONTRACT, validFrom: '2026-10-19', validTo: '2026-12-31' }, ACTOR);
    const all = sqls();
    const lock = all.findIndex((s) => /pg_advisory_xact_lock\(hashtext\('contract-link:patient:'/.test(s));
    const firstWrite = all.findIndex((s) => /^\s*INSERT/.test(s));
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(firstWrite);
    expect(writes()).toEqual([[expect.stringMatching(/^\s*INSERT INTO contracted_service_contract/), [SERVICE, NEW_CONTRACT, '[2026-10-19,2027-01-01)', ACTOR]]]);
  });

  it('create sem fim: vigência aberta [desde,)', async () => {
    await writer.create(PATIENT, SERVICE, { contractId: NEW_CONTRACT, validFrom: '2026-10-19', validTo: null }, ACTOR);
    expect(writes()[0][1][2]).toBe('[2026-10-19,)');
  });

  it('serviço que não é deste paciente → 404 e nada é escrito nem travado', async () => {
    script({ owner: false });
    await expect(writer.create(PATIENT, SERVICE, { contractId: NEW_CONTRACT, validFrom: '2026-10-19', validTo: null }, ACTOR)).rejects.toBeInstanceOf(ServiceNotFoundForLinkError);
    expect(writes()).toEqual([]);
    expect(sqls().some((s) => /advisory/.test(s))).toBe(false);
  });

  it('contrato inexistente → 404 CONTRACT_NOT_FOUND, sem escrita', async () => {
    script({ contract: false });
    await expect(writer.create(PATIENT, SERVICE, { contractId: NEW_CONTRACT, validFrom: '2026-10-19', validTo: null }, ACTOR)).rejects.toBeInstanceOf(ContractNotFoundForLinkError);
    expect(writes()).toEqual([]);
  });

  it('SAME_START: troca (SWITCHED) com validFrom igual ao início do vivo é recusada ANTES do banco — nada marcado, nada inserido', async () => {
    await expect(
      writer.supersede(PATIENT, SERVICE, { reason: 'SWITCHED', contractId: NEW_CONTRACT, validFrom: '2026-03-01', validTo: null }, ACTOR),
    ).rejects.toBeInstanceOf(SameStartUseCorrectionError);
    expect(writes()).toEqual([]);
  });

  it('supersede SWITCHED: lock → lê a viva → marca (só superseded_by/reason) → reinsert [início, novo) do contrato ANTIGO → INSERT do novo', async () => {
    await writer.supersede(PATIENT, SERVICE, { reason: 'SWITCHED', contractId: NEW_CONTRACT, validFrom: '2026-06-15', validTo: null }, ACTOR);
    const w = writes();
    expect(w).toHaveLength(3);
    expect(w[0][0]).toMatch(/UPDATE contracted_service_contract SET superseded_by = \$2, superseded_reason = \$3 WHERE id = \$1/);
    expect(w[0][1]).toEqual(['L1', ACTOR, 'SWITCHED']);
    expect(w[1][1]).toEqual([SERVICE, OLD_CONTRACT, '[2026-03-01,2026-06-15)', ACTOR]);
    expect(w[2][1]).toEqual([SERVICE, NEW_CONTRACT, '[2026-06-15,)', ACTOR]);
    // o carimbo de quando/quem-xid é do TRIGGER: o escritor nunca escreve superseded_at/superseded_xact nem um relógio
    expect(w.map(([sql]) => sql).join('\n')).not.toMatch(/superseded_at|superseded_xact|now\(\)|CURRENT_DATE/i);
    const all = sqls();
    expect(all.findIndex((s) => /advisory/.test(s))).toBeLessThan(all.findIndex((s) => /FROM contracted_service_contract/.test(s)));
  });

  it('supersede CORRECTION no mesmo início do vivo: troca a linha inteira, sem reinsert (só a marca e o novo)', async () => {
    await writer.supersede(PATIENT, SERVICE, { reason: 'CORRECTION', contractId: NEW_CONTRACT, validFrom: '2026-03-01', validTo: null }, ACTOR);
    const w = writes();
    expect(w).toHaveLength(2);
    expect(w[0][1]).toEqual(['L1', ACTOR, 'CORRECTION']);
    expect(w[1][1]).toEqual([SERVICE, NEW_CONTRACT, '[2026-03-01,)', ACTOR]);
  });

  it('supersede SWITCHED fora da vigência do vivo → LINK_RANGE_INVALID, nada escrito', async () => {
    script({ live: { id: 'L1', contract_id: OLD_CONTRACT, valid: '[2026-03-01,2026-05-01)' } });
    const err = await writer.supersede(PATIENT, SERVICE, { reason: 'SWITCHED', contractId: NEW_CONTRACT, validFrom: '2026-07-01', validTo: null }, ACTOR).catch((e) => e);
    expect(err).toBeInstanceOf(RangeInvalidError);
    expect(err.code).toBe('LINK_RANGE_INVALID');
    expect(writes()).toEqual([]);
    const antes = await writer.supersede(PATIENT, SERVICE, { reason: 'SWITCHED', contractId: NEW_CONTRACT, validFrom: '2026-02-01', validTo: null }, ACTOR).catch((e) => e);
    expect(antes).toBeInstanceOf(RangeInvalidError);
  });

  it('end: marca ENDED e re-insere o trecho fechado do MESMO contrato, fim inclusivo', async () => {
    await writer.end(PATIENT, SERVICE, { validTo: '2026-09-30' }, ACTOR);
    const w = writes();
    expect(w).toHaveLength(2);
    expect(w[0][1]).toEqual(['L1', ACTOR, 'ENDED']);
    expect(w[1][1]).toEqual([SERVICE, OLD_CONTRACT, '[2026-03-01,2026-10-01)', ACTOR]);
  });

  it('end: fim antes do início, ou que não encurta um vínculo já fechado → LINK_RANGE_INVALID', async () => {
    await expect(writer.end(PATIENT, SERVICE, { validTo: '2026-02-28' }, ACTOR)).rejects.toBeInstanceOf(RangeInvalidError);
    script({ live: { id: 'L1', contract_id: OLD_CONTRACT, valid: '[2026-03-01,2026-05-01)' } });
    await expect(writer.end(PATIENT, SERVICE, { validTo: '2026-04-30' }, ACTOR)).rejects.toBeInstanceOf(RangeInvalidError);
    expect(writes()).toEqual([]);
  });

  it('end/supersede sem vínculo vivo → 404 NO_LIVE_LINK', async () => {
    script({ live: null });
    await expect(writer.end(PATIENT, SERVICE, { validTo: '2026-09-30' }, ACTOR)).rejects.toBeInstanceOf(NoLiveLinkError);
    await expect(writer.supersede(PATIENT, SERVICE, { reason: 'CORRECTION', contractId: NEW_CONTRACT, validFrom: '2026-09-30', validTo: null }, ACTOR)).rejects.toBeInstanceOf(NoLiveLinkError);
  });

  it('erro P0001 da trigger (REQUIRES_NEW_SERVICE) passa CRU para o mapa de erros — o escritor não o disfarça', async () => {
    const p0001 = Object.assign(new Error('REQUIRES_NEW_SERVICE'), { code: 'P0001' });
    script({ failOn: (sql) => (/^\s*INSERT/.test(sql) ? p0001 : null) });
    await expect(writer.create(PATIENT, SERVICE, { contractId: NEW_CONTRACT, validFrom: '2026-10-19', validTo: null }, ACTOR)).rejects.toBe(p0001);
  });

  it('retry: 40P01 três vezes seguidas → ConcurrencyConflictError (409); uma só e depois sucesso → passa', async () => {
    const dead = Object.assign(new Error('deadlock'), { code: '40P01' });
    script({ failOn: (sql) => (/^\s*INSERT/.test(sql) ? dead : null) });
    await expect(writer.create(PATIENT, SERVICE, { contractId: NEW_CONTRACT, validFrom: '2026-10-19', validTo: null }, ACTOR)).rejects.toBeInstanceOf(ConcurrencyConflictError);
    expect(writes()).toHaveLength(3);
    mockClientQuery.mockReset();
    let falhou = false;
    script({ failOn: (sql) => (/^\s*INSERT/.test(sql) && !falhou ? ((falhou = true), dead) : null) });
    await expect(writer.create(PATIENT, SERVICE, { contractId: NEW_CONTRACT, validFrom: '2026-10-19', validTo: null }, ACTOR)).resolves.toBeUndefined();
  });

  it('D-43: o arquivo do escritor não tem CURRENT_DATE nem now() em SQL, nem conversão de daterange própria', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'contractedServiceContractLinkWriter.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    expect(src).not.toMatch(/CURRENT_DATE|now\(\)|NOW\(\)|::daterange/);
  });

  describe('endOnServiceClose (baixa do serviço, na transação do chamador; fim EXCLUSIVO em hoje)', () => {
    const cli = { query: mockClientQuery } as never;
    const liveRow = (valid: string, id = 'L1') => ({ id, contract_id: OLD_CONTRACT, valid });
    const TODAY = '2026-10-18';

    it('vínculo aberto que começou antes: marca ENDED e re-insere [início, hoje) do MESMO contrato — hoje fica livre', async () => {
      script({ live: liveRow('[2026-03-01,)') });
      await writer.endOnServiceClose(cli, SERVICE, TODAY, ACTOR);
      const w = writes();
      expect(w).toHaveLength(2);
      expect(w[0][1]).toEqual(['L1', ACTOR, 'ENDED']);
      expect(w[1][1]).toEqual([SERVICE, OLD_CONTRACT, '[2026-03-01,2026-10-18)', ACTOR]);
    });

    it('vínculo que começa HOJE ou depois: só marca ENDED (reinsert ficaria vazio)', async () => {
      for (const desde of ['2026-10-18', '2099-01-01']) {
        mockClientQuery.mockReset();
        script({ live: liveRow(`[${desde},)`) });
        await writer.endOnServiceClose(cli, SERVICE, TODAY, ACTOR);
        expect(writes().map(([sql]) => sql.trim().split(' ')[0])).toEqual(['UPDATE']);
      }
    });

    it('sem vínculo vivo, ou vínculo que já terminou antes de hoje: nada escrito', async () => {
      script({ live: null });
      await writer.endOnServiceClose(cli, SERVICE, TODAY, ACTOR);
      script({ live: liveRow('[2026-01-01,2026-10-18)') }); // último dia vigente = 17/10
      await writer.endOnServiceClose(cli, SERVICE, TODAY, ACTOR);
      expect(writes()).toEqual([]);
    });

    it('vínculo fechado que termina DEPOIS de hoje: encurta para [início, hoje)', async () => {
      script({ live: liveRow('[2026-01-01,2027-01-01)') });
      await writer.endOnServiceClose(cli, SERVICE, TODAY, ACTOR);
      expect(writes()[1][1]).toEqual([SERVICE, OLD_CONTRACT, '[2026-01-01,2026-10-18)', ACTOR]);
    });

    it('N4 — troca programada: encerra TODAS as vivas (a que vale hoje com reinsert; a futura sem), a já terminada fica', async () => {
      script({ lives: [liveRow('[2025-01-01,2026-01-01)', 'L0'), liveRow('[2026-01-01,2026-12-01)', 'L1'), liveRow('[2026-12-01,)', 'L2')] });
      await writer.endOnServiceClose(cli, SERVICE, TODAY, ACTOR);
      const w = writes();
      expect(w.map(([sql, p]) => `${sql.trim().split(' ')[0]}:${String(p[0])}`)).toEqual(['UPDATE:L1', 'INSERT:' + SERVICE, 'UPDATE:L2']);
      expect(w[1][1]).toEqual([SERVICE, OLD_CONTRACT, '[2026-01-01,2026-10-18)', ACTOR]);
    });
  });
});
