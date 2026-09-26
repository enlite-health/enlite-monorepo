/**
 * candidateDistanceSql.test.ts
 *
 * DX-3.10: a fórmula de distância num lugar só. `distanceKmSql` é o fragmento
 * inline que já existia no match; `candidateDistanceKmSql` é a subconsulta
 * escalar (MIN) usada pelo Kanban (P8) e pelo modo lista (P9) — sem duplicar
 * linha para worker com mais de uma área viva.
 */

import { distanceKmSql, candidateDistanceKmSql } from '../candidateDistanceSql';

describe('distanceKmSql', () => {
  it('contém ST_Distance e os três identificadores passados', () => {
    const sql = distanceKmSql('wsa.location', 'pa.lat', 'pa.lng');
    expect(sql).toContain('ST_Distance');
    expect(sql).toContain('wsa.location');
    expect(sql).toContain('pa.lat');
    expect(sql).toContain('pa.lng');
  });
});

describe('candidateDistanceKmSql', () => {
  it('contém MIN(, deleted_at IS NULL e os dois parâmetros', () => {
    const sql = candidateDistanceKmSql('wja.worker_id', 'wja.job_posting_id');
    expect(sql).toContain('MIN(');
    expect(sql).toContain('deleted_at IS NULL');
    expect(sql).toContain('wja.worker_id');
    expect(sql).toContain('wja.job_posting_id');
  });
});
