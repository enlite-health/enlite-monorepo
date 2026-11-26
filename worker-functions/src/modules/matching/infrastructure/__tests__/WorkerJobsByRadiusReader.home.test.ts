/**
 * WorkerJobsByRadiusReader — spec 096 (CA-1, CA-3, CA-6): `view=home` é aditivo. Sem perfil, o SQL é IDÊNTICO ao de origin/main
 * (fixture colada de `buildJobsByRadiusSql('W-ID', 15)`; regerada na F4 do semaforo-da-vaga porque o filtro de "publicável" passou a ser o do dono). Ids sintéticos.
 */
import fixture from './fixtures/jobsByRadiusSql.origin-main.json';
import {
  buildJobsByRadiusSql,
  HOME_PROFILE_SQL,
  readJobsByRadiusForHome,
  readWorkerHomeProfile,
} from '../WorkerJobsByRadiusReader';

const W = '11111111-1111-4111-8111-111111111111';

describe('WorkerJobsByRadiusReader — view=home', () => {
  it('CA-1 sem perfil: texto do SQL e params idênticos aos da fixture (regerada na F4 do semaforo-da-vaga: o feed lê `vagaPublicavelSql`)', () => {
    const { sql, params } = buildJobsByRadiusSql('W-ID', 15);
    expect(sql).toBe(fixture.sql);
    expect(params).toEqual(fixture.params);
  });

  it('com perfil: acrescenta required_sex (interno) e os predicados; params ganham occupation no fim', () => {
    const { sql, params } = buildJobsByRadiusSql(W, 10, { hasAvailability: true, occupation: 'AT' });
    expect(sql).toContain('AS already_applied,\n              CASE WHEN jp.contracted_service_id IS NOT NULL THEN pcs_eff.required_sex ELSE jp.required_sex END AS required_sex');
    expect(sql).toContain('worker_availability wa');
    expect(sql).toContain('ANY(');
    expect(params).toEqual(['AR', W, 10, 'AT']);
    expect(sql.lastIndexOf('ANY(')).toBeLessThan(sql.lastIndexOf('ORDER BY'));
  });

  it('096 sem teto de raio (null): MESMOS filtros e perfil, só sai o ST_DWithin e o param do raio; com raio o SQL segue igual à fixture', () => {
    const profile = { hasAvailability: true, occupation: 'AT' };
    const capped = buildJobsByRadiusSql(W, 100, profile);
    const open = buildJobsByRadiusSql(W, null, profile);
    expect(capped.sql).toContain('ST_DWithin');
    expect(open.sql).not.toContain('ST_DWithin');
    expect(open.sql.replace(/\n\s*AND ST_DWithin\([^\n]*\* 1000\)/, '')).toBe(
      capped.sql.replace(/\n\s*AND ST_DWithin\([^\n]*\* 1000\)/, '').replace(/\$4/g, '$3'),
    );
    expect(open.sql).toContain('ORDER BY d.meters ASC');
    expect(capped.params).toEqual(['AR', W, 100, 'AT']);
    expect(open.params).toEqual(['AR', W, 'AT']);
    // o filtro público e o realm de teste continuam no SQL sem teto
    expect(open.sql).toContain('jp.deleted_at IS NULL');
  });

  it('com perfil sem profissão: params não ganham occupation', () => {
    expect(buildJobsByRadiusSql(W, 5, { hasAvailability: false, occupation: null }).params).toEqual(['AR', W, 5]);
  });

  it('CA-6 o SQL do perfil não lê sexo cifrado nem texto de endereço; o sexo da vaga é só o exigido', () => {
    const { sql } = buildJobsByRadiusSql(W, 10, { hasAvailability: true, occupation: 'AT' });
    expect(sql).not.toContain('sex_encrypted');
    for (const proibido of ['address_formatted', 'address_line', 'complement']) expect(sql).not.toContain(proibido);
  });

  it('readWorkerHomeProfile: center arredondado a 3 casas, profissão vazia vira null, sexo cifrado repassado', async () => {
    const query = jest.fn(async () => ({
      rows: [{ lat: '-37.97654321', lng: -57.55123456, sex_encrypted: 'cifra', occupation: '  ', has_availability: true }],
    }));
    const out = await readWorkerHomeProfile({ query } as never, W);
    expect(query).toHaveBeenCalledWith(HOME_PROFILE_SQL, [W]);
    expect(out).toEqual({ center: { lat: -37.977, lng: -57.551 }, sexEncrypted: 'cifra', occupation: null, hasAvailability: true });
  });

  it('readWorkerHomeProfile: SEM zona viva ainda devolve o perfil (center null) para a home dizer o que falta', async () => {
    const query = jest.fn(async () => ({ rows: [{ lat: null, lng: null, sex_encrypted: '', occupation: 'AT', has_availability: false }] }));
    await expect(readWorkerHomeProfile({ query } as never, W)).resolves.toEqual({
      center: null, sexEncrypted: null, occupation: 'AT', hasAvailability: false,
    });
    expect(HOME_PROFILE_SQL).toContain('LEFT JOIN LATERAL');
  });

  it('readWorkerHomeProfile: prestador inexistente → null', async () => {
    await expect(readWorkerHomeProfile({ query: jest.fn(async () => ({ rows: [] })) } as never, W)).resolves.toBeNull();
  });

  it('readJobsByRadiusForHome devolve o item com required_sex interno e distance_km número', async () => {
    const row = { id: 'j', case_number: 1, vacancy_number: 2, title: 'T', service: null, neighborhood: null, city: null, state: null,
      schedule: null, worker_type: null, distance_km: '2.5', already_applied: false, required_sex: 'F' };
    const query = jest.fn(async () => ({ rows: [row] }));
    const out = await readJobsByRadiusForHome({ query } as never, { workerId: W, radiusKm: 5, profile: { hasAvailability: false, occupation: null } });
    expect(out[0]).toMatchObject({ distance_km: 2.5, worker_type: [], required_sex: 'F' });
  });
});
