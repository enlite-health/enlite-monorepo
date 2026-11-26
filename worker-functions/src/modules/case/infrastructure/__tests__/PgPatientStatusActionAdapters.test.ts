/** Adapters Pg das ações dos estados humanos (F3): leitura das horas pela MESMA avaliação da derivação e catálogo da FSM. */
import { PgHorasDoItinerario, PgTransitionCatalog } from '../PgPatientStatusActionAdapters';
import type { StatusTx } from '../../application/ports/patientStatusPorts';

describe('PgHorasDoItinerario', () => {
  it('devolve só a entrada da regra pura (sem o sujeito) e repassa client, paciente e relógio; avaliação nula → null', async () => {
    const tx = {} as StatusTx;
    const now = new Date('2026-11-25T12:00:00Z');
    const input = { status: 'ON_HOLD', montado: true, servicos: [] };
    const avalia = jest.fn().mockResolvedValueOnce({ subject: { status: 'ON_HOLD', country: 'AR', montado: true }, input }).mockResolvedValueOnce(null);
    const a = new PgHorasDoItinerario(avalia);
    expect(await a.load(tx, 'p1', now)).toBe(input);
    expect(avalia).toHaveBeenCalledWith(tx, 'p1', now);
    expect(await a.load(tx, 'p2', now)).toBeNull();
  });
});

describe('PgTransitionCatalog', () => {
  it('lê os destinos da FSM do estado de partida', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ to_status: 'ACTIVE' }, { to_status: 'SEARCHING' }], rowCount: 2 });
    expect(await new PgTransitionCatalog().destinosDe({ query } as unknown as StatusTx, 'ON_HOLD')).toEqual(['ACTIVE', 'SEARCHING']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('patient_status_transitions'), ['ON_HOLD']);
  });
});
