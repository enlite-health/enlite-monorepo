/**
 * PatientCompletenessLoader — os CONTADORES do checklist, lidos dentro da transação que já
 * segurou a linha do paciente com `FOR UPDATE` (decisão do Gabriel 07/09).
 *
 * O que este teste guarda, e que o e2e não guardaria sozinho:
 *   - a REGRA continua sendo `computePatientCompleteness` — o loader só lê e delega. Se alguém
 *     reimplementar "o que falta" aqui, os casos abaixo continuariam verdes por coincidência,
 *     então o último teste afirma a delegação pelo veredito, não pela chamada;
 *   - o SELECT traz as DUAS formas de "sem horário" (NULL e array vazio) — o `jsonb_array_length`
 *     não é enfeite: o CHECK `pcs_schedule_is_array` aceita `'[]'::jsonb`;
 *   - o ramo "paciente não existe" (linha do `throw`), que os testes do `PatientStatusWriter`
 *     cobriam só de carona — o gate `revisao-pr` reprovou o arquivo por isto (0% de branches).
 */
import type { PoolClient } from 'pg';
import { loadPatientCompleteness } from '../PatientCompletenessLoader';

const PID = '11111111-1111-4111-8111-111111111111';

/** Linha do SELECT do loader — o Postgres devolve COUNT como string, e é assim que ela chega. */
const FICHA_COMPLETA = {
  birth_date: '1980-01-01',
  has_consent: true,
  insurance_informed: 'OSDE',
  active_address_count: '1',
  active_responsible_count: '0',
  active_service_count: '1',
  services_without_address_count: '0',
  services_without_schedule_count: '0',
};

function clientQueDevolve(rows: Array<Record<string, unknown>>): {
  client: PoolClient;
  sqls: string[];
} {
  const sqls: string[] = [];
  const client = {
    query: jest.fn(async (sql: string) => {
      sqls.push(String(sql));
      return { rows, rowCount: rows.length };
    }),
  } as unknown as PoolClient;
  return { client, sqls };
}

describe('loadPatientCompleteness', () => {
  it('ficha completa → missing vazio, canActivate true', async () => {
    const { client } = clientQueDevolve([FICHA_COMPLETA]);
    const r = await loadPatientCompleteness(client, PID);
    expect(r.missing).toEqual([]);
    expect(r.canActivate).toBe(true);
    expect(r.ready).toBe(true);
  });

  it('paciente inexistente (0 linhas) → lança "Patient not found" com o id, e não inventa veredito', async () => {
    const { client } = clientQueDevolve([]);
    await expect(loadPatientCompleteness(client, PID)).rejects.toThrow(`Patient not found: ${PID}`);
  });

  it('serviço ativo sem horário → SERVICE_SCHEDULE em missing E em blocking', async () => {
    const { client } = clientQueDevolve([{ ...FICHA_COMPLETA, services_without_schedule_count: '1' }]);
    const r = await loadPatientCompleteness(client, PID);
    expect(r.missing).toContain('SERVICE_SCHEDULE');
    expect(r.blocking).toContain('SERVICE_SCHEDULE');
    expect(r.canActivate).toBe(false);
  });

  it('os contadores chegam como STRING do Postgres e viram número — "0" não pode virar truthy', async () => {
    // Se o loader esquecesse o `Number(...)`, `'0'` seria truthy e NADA acusaria: o teste acima
    // passaria e este é o que separa "converteu" de "deu sorte".
    const { client } = clientQueDevolve([
      { ...FICHA_COMPLETA, active_address_count: '0', services_without_schedule_count: '2' },
    ]);
    const r = await loadPatientCompleteness(client, PID);
    expect(r.missing).toEqual(expect.arrayContaining(['ADDRESS', 'SERVICE_SCHEDULE']));
  });

  it('o SELECT lê as DUAS formas de "sem horário" (NULL e array vazio) e o endereço vivo', async () => {
    const { client, sqls } = clientQueDevolve([FICHA_COMPLETA]);
    await loadPatientCompleteness(client, PID);
    const sql = sqls[0];
    expect(sql).toMatch(/pcs\.schedule IS NULL OR jsonb_array_length\(pcs\.schedule\) = 0/);
    expect(sql).toMatch(/LEFT JOIN patient_addresses pa\s+ON pa\.id = pcs\.address_id AND pa\.archived_at IS NULL/);
    // só serviço ATIVO conta, nos dois subselects de serviço
    expect((sql.match(/pcs\.active/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // uma consulta só: a guarda roda dentro da transação, não pode virar N idas ao banco
    expect(sqls).toHaveLength(1);
  });

  it('lê o paciente pelo id e ignora apagado (deleted_at) — o parâmetro é o id, nunca interpolado', async () => {
    const { client, sqls } = clientQueDevolve([FICHA_COMPLETA]);
    await loadPatientCompleteness(client, PID);
    expect(sqls[0]).toMatch(/WHERE p\.id = \$1 AND p\.deleted_at IS NULL/);
    expect(sqls[0]).not.toContain(PID); // id vai por parâmetro, não concatenado
    expect((client.query as jest.Mock).mock.calls[0][1]).toEqual([PID]);
  });

  it('a REGRA é do domínio, não daqui: o mesmo insumo dá o mesmo veredito de computePatientCompleteness', async () => {
    // Delegação medida pelo VEREDITO (não por espiar a chamada): a ordem de `missing` é o
    // contrato de `PATIENT_COMPLETENESS_CODES`, e o loader não pode reordenar nem filtrar.
    const { client } = clientQueDevolve([
      {
        ...FICHA_COMPLETA,
        has_consent: false,
        services_without_address_count: '1',
        services_without_schedule_count: '1',
      },
    ]);
    const r = await loadPatientCompleteness(client, PID);
    expect(r.missing).toEqual(['SERVICE_ADDRESS', 'SERVICE_SCHEDULE', 'CONSENT']);
    expect(r.blocking).toEqual(['SERVICE_ADDRESS', 'SERVICE_SCHEDULE']);
  });

  it('menor sem responsável → RESPONSIBLE (a idade sai do birth_date que o SELECT traz)', async () => {
    const { client } = clientQueDevolve([
      { ...FICHA_COMPLETA, birth_date: '2015-01-01', active_responsible_count: '0' },
    ]);
    const r = await loadPatientCompleteness(client, PID);
    expect(r.missing).toContain('RESPONSIBLE');
  });
});
