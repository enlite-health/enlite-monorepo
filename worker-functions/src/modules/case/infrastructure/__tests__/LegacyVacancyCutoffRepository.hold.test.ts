/**
 * Grupo e (spec 084 F3/R18): o corte legado põe CLOSED de serviço ativo em ON_HOLD e guarda SEARCHING como status de antes.
 * semaforo-da-vaga F4: o "Reanudar" (PUT status) saiu — ninguém grava status —, então a coluna `status_before_hold` ficou sem leitor
 * (LISTA do retorno da F4); o corte legado em si segue como estava.
 */
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

  it('a vaga que o corte deixa em ON_HOLD não volta por PUT: qualquer status (inclusive o SEARCHING guardado) é 400 — a saída é a baixa', async () => {
    const db = { query: jest.fn(async () => ({ rows: [{ status: 'ON_HOLD', is_draft: false, patient_id: 'p', contracted_service_id: 's', service_active: true }] })) } as never;
    expect(await authorizeVacancyUpdate(db, 'v', { status: 'SEARCHING' })).toMatchObject({ kind: 'error', status: 400, code: 'VACANCY_STATUS_NOT_WRITABLE' });
    expect(await authorizeVacancyUpdate(db, 'v', { status: 'CLOSED' })).toMatchObject({ kind: 'error', status: 400, code: 'VACANCY_STATUS_NOT_WRITABLE' });
  });

  it('lista vazia não toca o banco', async () => {
    const query = jest.fn();
    expect(await new LegacyVacancyCutoffRepository().putOnHold({ query } as never, [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
