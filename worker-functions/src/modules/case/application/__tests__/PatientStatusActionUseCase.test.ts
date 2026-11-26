/**
 * PatientStatusActionUseCase (F3): só ports, dublês puros. Prova: o destino sai da tabela (fixo nas 4 do painel; re-derivado em
 * retomar/reativar), a origem é a da tabela (`admin_panel`/`resume`), o cliente não tem como escolher o destino, e a ação fora do
 * estado de partida é recusada ANTES de escrever.
 */
import { PatientStatusActionUseCase, PatientStatusActionNotAvailableError } from '../PatientStatusActionUseCase';
import type { EntradaDerivacao } from '../../domain/derivarEstadoPaciente';
import type { MovePatientStatus } from '../PatientStatusWriter';
import type { StatusTx } from '../ports/patientStatusPorts';

const TX = { query: jest.fn() } as unknown as StatusTx;
const COBRE = [{ temVacanteViva: true, cobertas: 8, total: 8 }];

function montar(horas: EntradaDerivacao | null) {
  const moveStatus = jest.fn(async (id: string, status: string) => ({ id, status })) as unknown as jest.MockedFunction<MovePatientStatus>;
  const load = jest.fn(async () => horas);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = jest.fn((fn: (tx: StatusTx) => Promise<any>) => fn(TX));
  const uc = new PatientStatusActionUseCase({ transaction: { run: run as never }, horas: { load }, moveStatus, clock: () => new Date('2026-11-25T12:00:00Z') });
  return { uc, moveStatus, load, run };
}
const horasDe = (status: string, montado = true, servicos: EntradaDerivacao['servicos'] = []): EntradaDerivacao => ({ status, montado, servicos });
const PID = '11111111-1111-4111-8111-111111111111';

describe('PatientStatusActionUseCase', () => {
  it.each([
    ['pausar', 'ACTIVE', 'ON_HOLD'],
    ['suspender', 'ACTIVE', 'SUSPENDED'],
    ['dar_alta', 'ACTIVE', 'ALTA'],
    ['dar_baja', 'ACTIVE', 'DISCHARGED'],
  ] as const)('%s: destino fixo %s, origem admin_panel, na MESMA transação (tx repassada ao escritor)', async (acao, de, destino) => {
    const { uc, moveStatus, run } = montar(horasDe(de));
    const r = await uc.execute({ patientId: PID, acao, onHoldReason: 'SCHOOL', cells: ['x'], actorUid: 'uid-1' });
    expect(r).toEqual({ id: PID, acao, from: de, status: destino });
    expect(run).toHaveBeenCalledTimes(1);
    expect(moveStatus).toHaveBeenCalledWith(PID, destino, expect.objectContaining({ changeSource: 'admin_panel', onHoldReason: 'SCHOOL', cells: ['x'], actorUid: 'uid-1' }), TX);
  });

  it('retomar com itinerário cobrindo tudo → ACTIVE (derivado), origem resume', async () => {
    const { uc, moveStatus } = montar(horasDe('ON_HOLD', true, COBRE));
    expect((await uc.execute({ patientId: PID, acao: 'retomar' })).status).toBe('ACTIVE');
    expect(moveStatus).toHaveBeenCalledWith(PID, 'ACTIVE', expect.objectContaining({ changeSource: 'resume' }), TX);
  });

  it.each([['retomar', 'ON_HOLD'], ['retomar', 'SUSPENDED'], ['reativar', 'DISCHARGED']] as const)(
    '%s de %s sem itinerário → SEARCHING (a regra de horas não decide; nada consulta a trilha)', async (acao, de) => {
      const { uc, moveStatus } = montar(horasDe(de, false));
      expect((await uc.execute({ patientId: PID, acao })).status).toBe('SEARCHING');
      expect(moveStatus).toHaveBeenCalledWith(PID, 'SEARCHING', expect.objectContaining({ changeSource: 'resume' }), TX);
    });

  it('reativar com itinerário cobrindo tudo → ACTIVE (derivado), sem destino do cliente', async () => {
    const { uc, moveStatus } = montar(horasDe('DISCHARGED', true, COBRE));
    expect((await uc.execute({ patientId: PID, acao: 'reativar' })).status).toBe('ACTIVE');
    expect(moveStatus).toHaveBeenCalledWith(PID, 'ACTIVE', expect.objectContaining({ changeSource: 'resume' }), TX);
  });

  it('reativar com `destino` imposto no objeto de entrada: o escritor recebe o DERIVADO, nunca o imposto', async () => {
    const { uc, moveStatus } = montar(horasDe('DISCHARGED', false));
    await uc.execute({ patientId: PID, acao: 'reativar', destino: 'ACTIVE' } as never);
    expect(moveStatus).toHaveBeenCalledWith(PID, 'SEARCHING', expect.anything(), TX);
  });

  it.each([['retomar', 'ACTIVE'], ['retomar', 'DISCHARGED'], ['reativar', 'ACTIVE'], ['reativar', 'ON_HOLD'], ['pausar', 'ON_HOLD'], ['pausar', 'ADMISSION']] as const)(
    '%s com o paciente em %s → recusa ANTES de escrever (PatientStatusActionNotAvailableError)', async (acao, de) => {
      const { uc, moveStatus } = montar(horasDe(de));
      await expect(uc.execute({ patientId: PID, acao })).rejects.toBeInstanceOf(PatientStatusActionNotAvailableError);
      expect(moveStatus).not.toHaveBeenCalled();
    });

  it('paciente inexistente → "Patient not found" (o controller devolve 404)', async () => {
    const { uc, moveStatus } = montar(null);
    await expect(uc.execute({ patientId: PID, acao: 'retomar' })).rejects.toThrow(/not found/i);
    expect(moveStatus).not.toHaveBeenCalled();
  });
});
