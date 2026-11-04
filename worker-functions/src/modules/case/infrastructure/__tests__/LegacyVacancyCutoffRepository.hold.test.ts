/** Grupo e (spec 084 F3/R18): "En espera" guarda SEARCHING como status de antes — "Reanudar" para CLOSED seria 409 (R4). */
import { LegacyVacancyCutoffRepository } from '../LegacyVacancyCutoffRepository';
import { authorizeVacancyUpdate } from '../../../matching/interfaces/controllers/vacancyCrudHelpers';

describe('LegacyVacancyCutoffRepository.putOnHold', () => {
  it("grava status_before_hold = 'SEARCHING' (nunca o CLOSED de antes) e só toca CLOSED de serviço ATIVO", async () => {
    const query = jest.fn(async () => ({ rows: [{ id: 'v1' }] }));
    expect(await new LegacyVacancyCutoffRepository().putOnHold({ query } as never, ['v1'])).toEqual(['v1']);
    const sql = String((query.mock.calls[0] as unknown[])[0]);
    expect(sql).toContain("status_before_hold = 'SEARCHING'");
    expect(sql).not.toMatch(/status_before_hold = jp\.status/);
    expect(sql).toMatch(/jp\.status = 'CLOSED'/);
    expect(sql).toMatch(/s\.active/);
  });

  it('o destino do "Reanudar" que isto produz (SEARCHING) o servidor ACEITA; CLOSED ele recusa (por isso não se guarda CLOSED)', async () => {
    const db = { query: jest.fn(async () => ({ rows: [{ status: 'ON_HOLD', is_draft: false, patient_id: 'p', contracted_service_id: 's', service_active: true }] })) } as never;
    expect(await authorizeVacancyUpdate(db, 'v', { status: 'SEARCHING' })).toMatchObject({ kind: 'ok' });
    expect(await authorizeVacancyUpdate(db, 'v', { status: 'CLOSED' })).toMatchObject({ kind: 'error', status: 409 });
  });

  it('lista vazia não toca o banco', async () => {
    const query = jest.fn();
    expect(await new LegacyVacancyCutoffRepository().putOnHold({ query } as never, [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
