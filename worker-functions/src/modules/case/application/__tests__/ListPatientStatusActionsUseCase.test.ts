/**
 * ListPatientStatusActionsUseCase (F3): a lista sai da MESMA avaliação da escrita (`avaliarTroca` + completude + trava de alocação).
 * Dublês de port puros. Nem a mais, nem a menos: o que o escritor recusaria por transição/permissão não é oferecido; a alocação viva
 * bloqueia TODA ação (D489/D530).
 */
import { ListPatientStatusActionsUseCase } from '../ListPatientStatusActionsUseCase';
import type { EntradaDerivacao } from '../../domain/derivarEstadoPaciente';
import type { PatientCompletenessCode } from '../../domain/PatientCompleteness';
import type { PatientStatus } from '../../domain/enums/PatientStatus';
import type { StatusTx } from '../ports/patientStatusPorts';

const TX = {} as StatusTx;
const PID = '22222222-2222-4222-8222-222222222222';
const COBRE = [{ temVacanteViva: true, cobertas: 8, total: 8 }];
// FSM de prd (migrations 315/428/479/485/486/498 + a 595 da F3) para os estados que o teste usa.
const FSM: Record<string, PatientStatus[]> = {
  ACTIVE: ['ON_HOLD', 'REPLACEMENT', 'SUSPENDED', 'DISCHARGED', 'SEARCHING', 'ALTA'],
  ON_HOLD: ['ACTIVE', 'SEARCHING', 'REPLACEMENT', 'DISCHARGED', 'ALTA'],
  SUSPENDED: ['ACTIVE', 'DISCHARGED', 'SEARCHING', 'REPLACEMENT', 'ON_HOLD', 'ALTA'],
  DISCHARGED: ['ACTIVE', 'SEARCHING', 'REPLACEMENT', 'ALTA'],
  REPLACEMENT: ['ACTIVE', 'SEARCHING', 'SUSPENDED', 'DISCHARGED', 'ALTA'],
};

function montar(status: string, opts: { vivas?: number; missing?: PatientCompletenessCode[]; servicos?: EntradaDerivacao['servicos']; montado?: boolean } = {}) {
  const missingFor = jest.fn(async () => opts.missing ?? []);
  const countLive = jest.fn(async () => opts.vivas ?? 0);
  const uc = new ListPatientStatusActionsUseCase({
    transaction: { run: (fn) => fn(TX) },
    horas: { load: async () => ({ status, montado: opts.montado ?? true, servicos: opts.servicos ?? [] }) },
    catalog: { destinosDe: async (_tx, from) => FSM[from as string] ?? [] },
    completeness: { missingFor },
    allocation: { countLive },
  });
  return { uc, missingFor, countLive };
}
const acoes = async (uc: ListPatientStatusActionsUseCase, cells: readonly string[] | null = null) =>
  (await uc.execute({ patientId: PID, cells })).actions;

describe('ListPatientStatusActionsUseCase', () => {
  it('ACTIVE: oferece as 4 ações do painel (dentro da FSM), com `exige` do pausar; nunca retomar/reativar', async () => {
    const a = await acoes(montar('ACTIVE').uc);
    expect(a.map((x) => x.acao)).toEqual(['pausar', 'suspender', 'dar_alta', 'dar_baja']);
    expect(a.every((x) => x.via === 'fluxo' && x.blockedBy === undefined)).toBe(true);
    expect(a.find((x) => x.acao === 'pausar')?.exige).toEqual(['onHoldReason']);
  });

  it('ON_HOLD sem itinerário: retomar leva a SEARCHING (re-derivado); com itinerário cobrindo tudo, a ACTIVE', async () => {
    const sem = (await acoes(montar('ON_HOLD', { montado: false }).uc)).find((x) => x.acao === 'retomar');
    expect(sem).toMatchObject({ destino: 'SEARCHING', via: 'fluxo', exige: [] });
    const com = (await acoes(montar('ON_HOLD', { servicos: COBRE }).uc)).find((x) => x.acao === 'retomar');
    expect(com?.destino).toBe('ACTIVE');
  });

  it('SUSPENDED: retomar exige o motivo de saída; DISCHARGED: só reativar (re-derivado) e dar_alta', async () => {
    const s = await acoes(montar('SUSPENDED', { montado: false }).uc);
    expect(s.find((x) => x.acao === 'retomar')?.exige).toEqual(['suspensionExitReason']);
    const d = await acoes(montar('DISCHARGED', { montado: false }).uc);
    expect(d.map((x) => x.acao)).toEqual(['dar_alta', 'reativar']); // pausar/suspender não têm seta de DISCHARGED e o ator não tem a célula
    expect(d.find((x) => x.acao === 'reativar')).toMatchObject({ destino: 'SEARCHING', via: 'fluxo' });
    expect(d.some((x) => x.acao === 'retomar')).toBe(false);
  });

  it('fora da FSM sem a célula do destino NÃO é oferecida; com a célula, via=permissao', async () => {
    // REPLACEMENT → ON_HOLD não tem seta: precisa de patient_status:move_to_on_hold
    const sem = await acoes(montar('REPLACEMENT').uc, []);
    expect(sem.map((x) => x.acao)).toEqual(['suspender', 'dar_alta', 'dar_baja']);
    const com = await acoes(montar('REPLACEMENT').uc, ['patient_status:move_to_on_hold']);
    expect(com.find((x) => x.acao === 'pausar')).toMatchObject({ destino: 'ON_HOLD', via: 'permissao' });
  });

  it('engine neutro (cells=null) → só a FSM, como o PUT: a ação fora da FSM não aparece', async () => {
    const a = await acoes(montar('REPLACEMENT').uc, null);
    expect(a.some((x) => x.acao === 'pausar')).toBe(false);
  });

  it('S4: alocação viva bloqueia TODA ação (ACTIVE_ALLOCATION) e a completude nem é lida', async () => {
    const { uc, missingFor } = montar('ON_HOLD', { vivas: 2, servicos: COBRE });
    const a = await acoes(uc);
    expect(a.length).toBeGreaterThan(0);
    expect(a.every((x) => x.blockedBy?.length === 1 && x.blockedBy[0] === 'ACTIVE_ALLOCATION')).toBe(true);
    expect(missingFor).not.toHaveBeenCalled();
  });

  it('a completude que falta bloqueia só o destino que a exige (retomar → ACTIVE cobra; dar_alta não)', async () => {
    const { uc } = montar('ON_HOLD', { servicos: COBRE, missing: ['ADDRESS'] });
    const a = await acoes(uc);
    expect(a.find((x) => x.acao === 'retomar')?.blockedBy).toEqual(['ADDRESS']);
    expect(a.find((x) => x.acao === 'dar_alta')?.blockedBy).toBeUndefined();
  });

  it('paciente inexistente → "not found"', async () => {
    const uc = new ListPatientStatusActionsUseCase({
      transaction: { run: (fn) => fn(TX) }, horas: { load: async () => null }, catalog: { destinosDe: async () => [] },
      completeness: { missingFor: async () => [] }, allocation: { countLive: async () => 0 },
    });
    await expect(uc.execute({ patientId: PID, cells: null })).rejects.toThrow(/not found/i);
  });
});

// Cobertura 100% de `avaliarTroca`: a guarda D469 (funil → SEARCHING fora do foguete) recusa ANTES da FSM — o ramo que só este
// ponto de entrada exercita desde que a lista de destinos saiu (F5).
describe('avaliarTroca — guarda D469 antes da FSM', () => {
  it('funil → SEARCHING por admin_panel é recusa_de_transicao, mesmo com o par na FSM', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { avaliarTroca } = require('../PatientStatusWriter');
    expect(avaliarTroca({ from: 'ADMISSION', to: 'SEARCHING', naFsm: true, cells: null, changeSource: 'admin_panel' })).toEqual({
      resultado: 'recusa_de_transicao',
    });
  });
});
