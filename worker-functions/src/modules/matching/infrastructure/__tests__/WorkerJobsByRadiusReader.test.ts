/**
 * WorkerJobsByRadiusReader — spec 077 C-37 (D661): SQL da lista de vagas por raio e mapeamento da linha.
 * Cliente `pg` falso (mesmo molde do WorkerItineraryReader.test); a prova contra o banco é o PREPARE e o curl em prd do PR.
 * Ids sintéticos.
 */
import { buildJobsByRadiusSql, readJobsByRadius, ZONE_SQL } from '../WorkerJobsByRadiusReader';

const W = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';

function fakeClient(opts: { zone: boolean; rows?: Array<Record<string, unknown>> }) {
  const query = jest.fn(async (sql: string) => {
    if (sql === ZONE_SQL) return { rows: opts.zone ? [{ '?column?': 1 }] : [] };
    return { rows: opts.rows ?? [] };
  });
  return { query } as unknown as import('pg').PoolClient & { query: jest.Mock };
}

const ROW = {
  id: JOB, case_number: 1301, vacancy_number: 6309, title: 'CASO 1301', service: 'AT', neighborhood: null,
  city: 'Mar del Plata', state: 'Buenos Aires', schedule: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
  worker_type: ['AT'], distance_km: '3.0', already_applied: false,
};

describe('WorkerJobsByRadiusReader', () => {
  it('T-F2a-33 raio a partir da zona viva do prestador (ST_DWithin sobre geography, metros = km × 1000)', () => {
    const { sql, params } = buildJobsByRadiusSql(W, 15);
    expect(params).toEqual(['AR', W, 15]);
    expect(sql).toContain('JOIN worker_service_areas wsa ON wsa.worker_id = wk.id AND wsa.deleted_at IS NULL');
    expect(sql).toContain('WHERE wk.id = $2');
    expect(sql).toContain('JOIN patient_addresses pa ON pa.id = jp.patient_address_id');
    expect(sql).toContain('ST_DWithin(ST_SetSRID(ST_MakePoint(pa.lng::float8, pa.lat::float8), 4326)::geography, w.location, $3 * 1000)');
    expect(sql).toContain('ROUND((d.meters / 1000)::numeric, 1) AS distance_km');
  });

  it('T-F2a-33 ordena da mais perto para a mais longe', () => {
    expect(buildJobsByRadiusSql(W, 5).sql).toMatch(/ORDER BY d\.meters ASC, jp\.id ASC$/);
  });

  it('T-F2a-33 nunca o endereço exato: o SQL não lê texto de endereço e não projeta lat/lng', () => {
    const { sql } = buildJobsByRadiusSql(W, 100);
    for (const proibido of ['address_formatted', 'address_raw', 'complement', 'access_notes', 'logistics_corridor', 'address_line']) {
      expect(sql).not.toContain(proibido);
    }
    expect(sql).not.toMatch(/pa\.(lat|lng)\s+AS\b/i);
  });

  it('T-F2a-33 realm (D665, DT-20): mesmo realm pela peça testRealmSql; vaga de teste sem o filtro público, vaga real com ele', () => {
    const { sql } = buildJobsByRadiusSql(W, 10);
    expect(sql).toContain('COALESCE((SELECT w_realm_chk.is_test FROM workers w_realm_chk WHERE w_realm_chk.id = w.id), false)');
    expect(sql).toContain('AND (NOT (COALESCE(jp.is_test, false) = false) OR (jp.status IN');
    expect(sql).toContain("jp.social_short_links ? 'site'");
    expect(sql).toContain('jp.is_draft = false');
    expect(sql).toContain('jp.country = $1');
    expect(sql).toContain('jp.deleted_at IS NULL');
  });

  it('T-F2a-33 campos da vaga pela peça vacancyEffectiveFieldsSql (horário e profissões do serviço contratado)', () => {
    const { sql } = buildJobsByRadiusSql(W, 10);
    expect(sql).toContain('LEFT JOIN patient_contracted_services pcs_eff ON pcs_eff.id = jp.contracted_service_id');
    expect(sql).toContain('horario_do_servico(jp.contracted_service_id, CURRENT_DATE) ELSE jp.schedule END AS schedule');
    expect(sql).toContain("COALESCE(pcs_eff.required_professions, '{}'::text[]) ELSE jp.required_professions END AS worker_type");
  });

  it('T-F2a-33 sem zona viva → null e a lista não é consultada', async () => {
    const client = fakeClient({ zone: false });
    await expect(readJobsByRadius(client, { workerId: W, radiusKm: 10 })).resolves.toBeNull();
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][1]).toEqual([W]);
  });

  it('T-F2a-33 mapeia a linha: distance_km número, worker_type nunca null, chaves fechadas (sem lat/lng nem texto de endereço)', async () => {
    const client = fakeClient({ zone: true, rows: [{ ...ROW, worker_type: null, lat: -37.97, lng: -57.55, address_formatted: 'x' }] });
    const out = await readJobsByRadius(client, { workerId: W, radiusKm: 5 });
    expect(out).toHaveLength(1);
    const item = (out as NonNullable<typeof out>)[0];
    expect(item.distance_km).toBe(3);
    expect(item.worker_type).toEqual([]);
    expect(Object.keys(item).sort()).toEqual(
      ['already_applied', 'case_number', 'city', 'distance_km', 'id', 'neighborhood', 'schedule', 'service', 'state', 'title', 'vacancy_number', 'worker_type'].sort(),
    );
    expect(client.query.mock.calls[1][1]).toEqual(['AR', W, 5]);
  });

  it('T-F2a-34 already_applied derivado em leitura da candidatura DO PRÓPRIO prestador ($2), nunca gravado', () => {
    const { sql } = buildJobsByRadiusSql(W, 10);
    expect(sql).toContain(
      'EXISTS (SELECT 1 FROM worker_job_applications wja WHERE wja.worker_id = $2 AND wja.job_posting_id = jp.id) AS already_applied',
    );
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it('T-F2a-34 mapeia already_applied: true só quando o banco diz true', async () => {
    const client = fakeClient({ zone: true, rows: [{ ...ROW, already_applied: true }, { ...ROW, already_applied: null }] });
    const out = (await readJobsByRadius(client, { workerId: W, radiusKm: 10 })) ?? [];
    expect(out.map((i) => i.already_applied)).toEqual([true, false]);
  });
});
