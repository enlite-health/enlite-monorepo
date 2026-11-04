/**
 * servicePayerSql (spec 087) — a forma do fragmento ÚNICO do pagador vigente: o leitor da ficha, o portão, o checklist e a lista
 * leem dele. A equivalência com o Postgres real é medida nos e2e de API (`activation`, `c1b-patient-list-attention-agreement`).
 */
import { linkVigenteSql, operationDateSql, servicePayerLinkedSql } from '../servicePayerSql';
import { COUNTRY_TIMEZONE_MAP } from '../../locale/CountryTimezone';
import { payerAtMany } from '../../../modules/case/infrastructure/contractedServicePayerRead';

describe('servicePayerSql', () => {
  it('linkVigenteSql: vínculo VIVO (não superado) e vigente em `asOf` — nunca CURRENT_DATE', () => {
    const sql = linkVigenteSql('csc', '$2::date');
    expect(sql).toBe('csc.superseded_at IS NULL AND csc.valid @> $2::date');
    expect(sql).not.toContain('CURRENT_DATE');
  });

  it('servicePayerLinkedSql: EXISTS correlacionado ao serviço, com o mesmo critério de vigência', () => {
    const sql = servicePayerLinkedSql('pcs', '$3::date');
    expect(sql).toMatch(/^EXISTS \(SELECT 1 FROM contracted_service_contract csc_pl\s+WHERE csc_pl\.contracted_service_id = pcs\.id AND csc_pl\.superseded_at IS NULL AND csc_pl\.valid @> \$3::date\)$/);
  });

  it('operationDateSql: o dia LOCAL do país vem do mesmo COUNTRY_TIMEZONE_MAP de `operationDateOf`; país fora do mapa → NULL (sem vínculo), nunca UTC', () => {
    const sql = operationDateSql('p.country');
    for (const [country, tz] of Object.entries(COUNTRY_TIMEZONE_MAP)) expect(sql).toContain(`WHEN '${country}' THEN '${tz}'`);
    expect(sql).toContain('CASE p.country');
    expect(sql).not.toMatch(/ELSE|'UTC'|CURRENT_DATE/);
  });

  it('payerAtMany lê a vigência por ESTE fragmento (um dono): o SQL enviado ao banco contém linkVigenteSql', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await payerAtMany({ query } as never, ['svc-1'], '2026-11-04');
    expect(query.mock.calls[0][0]).toContain(linkVigenteSql('csc', '$2::date'));
    expect(query.mock.calls[0][1]).toEqual([['svc-1'], '2026-11-04']);
  });
});
