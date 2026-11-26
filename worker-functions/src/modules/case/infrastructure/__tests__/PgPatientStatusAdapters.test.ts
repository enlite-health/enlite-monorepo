/**
 * Adapters Pg do escritor de estado (estado-automatico-do-paciente, D2/D7). O banco é de mentira, mas ele MODELA o paciente:
 * 2 serviços ativos, o 2º sem horário. A contagem de "serviço sem horário" que a leitura devolve depende do filtro por
 * `pcs.id` que o adapter pede — ignorar o `serviceId` faz o serviço completo herdar a falta do outro (a recusa que o foguete
 * levava). A prova com SQL real está em `tests/e2e/foguete-unico-gatilho.e2e.test.ts`.
 */
import { PgCompletenessReader } from '../PgPatientStatusAdapters';
import type { StatusTx } from '../../application/ports/patientStatusPorts';

const PID = '11111111-1111-4111-8111-111111111111';
const SERVICO_COMPLETO = '22222222-2222-4222-8222-222222222222';
const SERVICO_SEM_HORARIO = '33333333-3333-4333-8333-333333333333';

const FICHA = {
  birth_date: '1980-01-01', has_consent: true, insurance_informed: 'OSDE',
  active_address_count: '1', active_responsible_count: '0', active_service_count: '2',
  services_without_address_count: '0', status: 'ADMISSION', active_diagnosis_count: '1',
};
const SEM_HORARIO = [SERVICO_SEM_HORARIO];

/** O banco aplica o filtro `$2` como o SQL faz: sem `$2` conta todos os serviços sem horário; com `$2`, só se for o dele. */
function bancoComDoisServicos(): StatusTx {
  return {
    query: jest.fn(async (_sql: string, params?: readonly unknown[]) => {
      const serviceId = params?.[1] as string | null | undefined;
      const semHorario = SEM_HORARIO.filter((id) => serviceId == null || id === serviceId).length;
      return { rows: [{ ...FICHA, services_without_schedule_count: String(semHorario) }], rowCount: 1 } as never;
    }) as never,
  };
}

describe('PgCompletenessReader — escopo da completude', () => {
  const reader = new PgCompletenessReader();

  it('escopo paciente: o serviço sem horário do paciente aparece em SERVICE_SCHEDULE', async () => {
    const missing = await reader.missingFor(bancoComDoisServicos(), PID, { kind: 'paciente' });
    expect(missing).toContain('SERVICE_SCHEDULE');
  });

  it('escopo servico do serviço COMPLETO: SERVICE_SCHEDULE NÃO aparece (o outro serviço não conta)', async () => {
    const missing = await reader.missingFor(bancoComDoisServicos(), PID, { kind: 'servico', serviceId: SERVICO_COMPLETO });
    expect(missing).not.toContain('SERVICE_SCHEDULE');
  });

  it('escopo servico do serviço SEM horário: SERVICE_SCHEDULE aparece (o filtro não afrouxa o que é dele)', async () => {
    const missing = await reader.missingFor(bancoComDoisServicos(), PID, { kind: 'servico', serviceId: SERVICO_SEM_HORARIO });
    expect(missing).toContain('SERVICE_SCHEDULE');
  });

  it('item 19 — escopo servicos_com_vaga_viva: pede o filtro de vaga viva ($3 = true) e não filtra por serviceId ($2 = null)', async () => {
    const tx = bancoComDoisServicos();
    await reader.missingFor(tx, PID, { kind: 'servicos_com_vaga_viva' });
    expect((tx.query as jest.Mock).mock.calls[0][1]).toEqual([PID, null, true]);
  });

  it('o serviceId vai por parâmetro ($2), nunca interpolado no SQL', async () => {
    const tx = bancoComDoisServicos();
    await reader.missingFor(tx, PID, { kind: 'servico', serviceId: SERVICO_COMPLETO });
    const [sql, params] = (tx.query as jest.Mock).mock.calls[0];
    expect(String(sql)).not.toContain(SERVICO_COMPLETO);
    expect(params).toEqual([PID, SERVICO_COMPLETO, false]);
  });
});
