/**
 * vacancyListHelpers.test.ts
 *
 * Unit tests for buildListVacanciesQuery.
 * Covers: each new filter (workerType, state, city, requiredSex, days, time),
 * existing filters (search, status, priority), and absence of each filter.
 */

import { buildListVacanciesQuery, ListVacanciesFilters, loadStageCounts, loadVacancyActivity } from '../vacancyListHelpers';

// Minimal filters that satisfy the required fields
function base(overrides: Partial<ListVacanciesFilters> = {}): ListVacanciesFilters {
  return { limit: '20', offset: '0', ...overrides };
}

describe('buildListVacanciesQuery — base query', () => {
  it('base query includes LEFT JOIN patient_addresses', () => {
    const { baseQuery } = buildListVacanciesQuery(base());
    expect(baseQuery).toContain('LEFT JOIN patient_addresses pa ON jp.patient_address_id = pa.id');
  });

  it('returns paramIndex=1 and empty params when no filters', () => {
    const { params, paramIndex } = buildListVacanciesQuery(base());
    expect(params).toEqual([]);
    expect(paramIndex).toBe(1);
  });
});

// ── existing filters ───────────────────────────────────────────────────────────

describe('buildListVacanciesQuery — search filter', () => {
  it('appends ILIKE search clause for valid search string', () => {
    const { baseQuery, params, paramIndex } = buildListVacanciesQuery(base({ search: 'João' }));
    expect(baseQuery).toContain('ILIKE $1');
    expect(params[0]).toBe('%João%');
    expect(paramIndex).toBe(2);
  });

  it('ignores falsy search value', () => {
    const { params } = buildListVacanciesQuery(base({ search: '' }));
    expect(params).toEqual([]);
  });
});

describe('buildListVacanciesQuery — status filter', () => {
  it('appends status clause for valid status', () => {
    const { baseQuery, params } = buildListVacanciesQuery(base({ status: 'SEARCHING' }));
    expect(baseQuery).toContain('jp.status = $1');
    expect(params[0]).toBe('SEARCHING');
  });

  it('ignores invalid status value', () => {
    const { params } = buildListVacanciesQuery(base({ status: 'INVALID_STATUS' }));
    expect(params).toEqual([]);
  });
});

describe('buildListVacanciesQuery — priority filter', () => {
  it('appends priority clause for valid priority', () => {
    const { baseQuery, params } = buildListVacanciesQuery(base({ priority: 'URGENT' }));
    expect(baseQuery).toContain('jp.priority = $1');
    expect(params[0]).toBe('URGENT');
  });

  it('ignores invalid priority value', () => {
    const { params } = buildListVacanciesQuery(base({ priority: 'EXTREME' }));
    expect(params).toEqual([]);
  });
});

// ── new filters ────────────────────────────────────────────────────────────────

describe('buildListVacanciesQuery — workerType filter', () => {
  it('appends ANY(required_professions) clause for "AT"', () => {
    const { baseQuery, params } = buildListVacanciesQuery(base({ workerType: 'AT' }));
    expect(baseQuery).toContain('= ANY(jp.required_professions)');
    expect(params[0]).toBe('AT');
  });

  it('appends clause for "CAREGIVER"', () => {
    const { baseQuery, params } = buildListVacanciesQuery(base({ workerType: 'CAREGIVER' }));
    expect(baseQuery).toContain('= ANY(jp.required_professions)');
    expect(params[0]).toBe('CAREGIVER');
  });

  it('ignores invalid workerType (e.g. "PSYCHOLOGIST")', () => {
    const { params } = buildListVacanciesQuery(base({ workerType: 'PSYCHOLOGIST' }));
    expect(params).toEqual([]);
  });

  it('ignores non-string workerType', () => {
    const { params } = buildListVacanciesQuery(base({ workerType: 42 }));
    expect(params).toEqual([]);
  });
});

describe('buildListVacanciesQuery — state filter', () => {
  it('appends pa.state ILIKE clause for non-empty state', () => {
    const { baseQuery, params } = buildListVacanciesQuery(base({ state: 'Buenos Aires' }));
    expect(baseQuery).toContain('pa.state ILIKE $1');
    expect(params[0]).toBe('Buenos Aires');
  });

  it('trims state value', () => {
    const { params } = buildListVacanciesQuery(base({ state: '  Córdoba  ' }));
    expect(params[0]).toBe('Córdoba');
  });

  it('ignores empty string state', () => {
    const { params } = buildListVacanciesQuery(base({ state: '' }));
    expect(params).toEqual([]);
  });

  it('ignores whitespace-only state', () => {
    const { params } = buildListVacanciesQuery(base({ state: '   ' }));
    expect(params).toEqual([]);
  });
});

describe('buildListVacanciesQuery — city filter', () => {
  it('appends pa.city ILIKE clause for non-empty city', () => {
    const { baseQuery, params } = buildListVacanciesQuery(base({ city: 'Rosario' }));
    expect(baseQuery).toContain('pa.city ILIKE $1');
    expect(params[0]).toBe('Rosario');
  });

  it('ignores empty city', () => {
    const { params } = buildListVacanciesQuery(base({ city: '' }));
    expect(params).toEqual([]);
  });
});

describe('buildListVacanciesQuery — requiredSex filter', () => {
  it('appends jp.required_sex = clause for "F"', () => {
    const { baseQuery, params } = buildListVacanciesQuery(base({ requiredSex: 'F' }));
    expect(baseQuery).toContain('jp.required_sex = $1');
    expect(params[0]).toBe('F');
  });

  it('appends clause for "M"', () => {
    const { params } = buildListVacanciesQuery(base({ requiredSex: 'M' }));
    expect(params[0]).toBe('M');
  });

  it('appends clause for "BOTH"', () => {
    const { params } = buildListVacanciesQuery(base({ requiredSex: 'BOTH' }));
    expect(params[0]).toBe('BOTH');
  });

  it('ignores invalid requiredSex value', () => {
    const { params } = buildListVacanciesQuery(base({ requiredSex: 'OTHER' }));
    expect(params).toEqual([]);
  });
});

describe('buildListVacanciesQuery — days filter', () => {
  it('appends schedule filter SQL for valid days CSV', () => {
    const { baseQuery, params } = buildListVacanciesQuery(base({ days: '1,2,3' }));
    expect(baseQuery).toContain('bool_and');
    expect(params).toContainEqual([1, 2, 3]);
  });

  it('discards invalid tokens and ignores empty result', () => {
    const { params } = buildListVacanciesQuery(base({ days: 'abc,xyz' }));
    expect(params).toEqual([]);
  });

  it('ignores empty days string', () => {
    const { params } = buildListVacanciesQuery(base({ days: '' }));
    expect(params).toEqual([]);
  });
});

describe('buildListVacanciesQuery — time filter (time-only, no days)', () => {
  it('appends EXISTS time-overlap SQL when days absent and both times valid', () => {
    const { baseQuery, params } = buildListVacanciesQuery(
      base({ timeFrom: '08:00', timeTo: '12:00' }),
    );
    expect(baseQuery).toContain('EXISTS');
    expect(baseQuery).toContain('startTime');
    expect(params).toContain('08:00');
    expect(params).toContain('12:00');
  });

  it('ignores partial time (only timeFrom)', () => {
    const { params } = buildListVacanciesQuery(base({ timeFrom: '08:00' }));
    expect(params).toEqual([]);
  });

  it('ignores invalid time format', () => {
    const { params } = buildListVacanciesQuery(base({ timeFrom: '8:00', timeTo: '18:00' }));
    expect(params).toEqual([]);
  });
});

describe('buildListVacanciesQuery — days + time combined', () => {
  it('appends bool_and + time-overlap SQL for days=[1] + valid times', () => {
    const { baseQuery, params } = buildListVacanciesQuery(
      base({ days: '1', timeFrom: '09:00', timeTo: '17:00' }),
    );
    expect(baseQuery).toContain('bool_and');
    expect(baseQuery).toContain('startTime');
    expect(params).toContainEqual([1]);
    expect(params).toContain('09:00');
    expect(params).toContain('17:00');
  });
});

describe('buildListVacanciesQuery — paramIndex sequencing', () => {
  it('paramIndex advances correctly for multiple filters combined', () => {
    const { params, paramIndex } = buildListVacanciesQuery(
      base({ status: 'SEARCHING', workerType: 'AT', state: 'BA', city: 'CABA' }),
    );
    // status=$1, workerType=$2, state=$3, city=$4
    expect(params).toHaveLength(4);
    expect(paramIndex).toBe(5);
  });

  it('LIMIT/OFFSET params appended correctly after all filters', () => {
    const { params: baseParams, paramIndex } = buildListVacanciesQuery(
      base({ status: 'SEARCHING' }),
    );
    // Simulate what the controller does: push LIMIT + OFFSET
    const allParams = [...baseParams, 20, 0];
    expect(allParams[0]).toBe('SEARCHING'); // $1
    expect(allParams[1]).toBe(20);           // $paramIndex (LIMIT)
    expect(allParams[2]).toBe(0);            // $paramIndex+1 (OFFSET)
    expect(paramIndex).toBe(2);
  });
});

// ── loadStageCounts — uma consulta por página (não por vaga, critério 10) ───────

describe('loadStageCounts', () => {
  function makePool(rows: unknown[]) {
    return { query: jest.fn().mockResolvedValue({ rows }) } as unknown as import('pg').Pool;
  }

  it('não chama query quando a lista de ids está vazia', async () => {
    const pool = makePool([]);
    const out = await loadStageCounts(pool, []);
    expect(out.size).toBe(0);
    expect((pool.query as jest.Mock)).not.toHaveBeenCalled();
  });

  it('chama query UMA vez, com [ids] e SQL contendo GROUP BY e UNION ALL', async () => {
    const pool = makePool([]);
    await loadStageCounts(pool, ['jp-a', 'jp-b']);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = (pool.query as jest.Mock).mock.calls[0];
    expect(params).toEqual([['jp-a', 'jp-b']]);
    expect(sql).toContain('GROUP BY');
    expect(sql).toContain('UNION ALL');
  });

  it('agrupa INVITED/manual + IN_PROGRESS + 1 blocked em INICIADO:1, IN_PROGRESS:1, REJECTED:1', async () => {
    const pool = makePool([
      { id: 'jp-a', kind: 'wja', stage: 'INVITED', source: 'manual', messaged: false, n: 1 },
      { id: 'jp-a', kind: 'wja', stage: 'IN_PROGRESS', source: 'talentum', messaged: true, n: 1 },
      { id: 'jp-a', kind: 'blocked', stage: null, source: null, messaged: false, n: 1 },
    ]);
    const out = await loadStageCounts(pool, ['jp-a']);
    const counts = out.get('jp-a')!;
    expect(counts.INICIADO).toBe(1);
    expect(counts.IN_PROGRESS).toBe(1);
    expect(counts.REJECTED).toBe(1);
  });

  it('um id sem linha nenhuma devolve as 8 colunas zeradas', async () => {
    const pool = makePool([{ id: 'jp-a', kind: 'wja', stage: 'INVITED', source: 'manual', messaged: false, n: 1 }]);
    const out = await loadStageCounts(pool, ['jp-a', 'jp-sem-linha']);
    const counts = out.get('jp-sem-linha')!;
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    expect(Object.keys(counts)).toHaveLength(8);
  });
});

// ── loadVacancyActivity — última ação e dias sem divulgação (DX-3.4/3.5/3.6) ────

describe('loadVacancyActivity', () => {
  function makePool(rows: unknown[]) {
    return { query: jest.fn().mockResolvedValue({ rows }) } as unknown as import('pg').Pool;
  }

  it('não chama query quando a lista de ids está vazia', async () => {
    const pool = makePool([]);
    const out = await loadVacancyActivity(pool, []);
    expect(out.size).toBe(0);
    expect((pool.query as jest.Mock)).not.toHaveBeenCalled();
  });

  it('chama query UMA vez, com [ids], e o SQL nunca usa updated_at (DX-3.5)', async () => {
    const pool = makePool([]);
    await loadVacancyActivity(pool, ['jp-a', 'jp-b']);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = (pool.query as jest.Mock).mock.calls[0];
    expect(params).toEqual([['jp-a', 'jp-b']]);
    expect(sql).toContain('= ANY($1::uuid[])');
    expect(sql).toContain('job_posting_notes');
    expect(sql).toContain('worker_job_application_stage_history');
    expect(sql).toContain('talentum_published_at');
    expect(sql).toContain("'DIVULGACAO'");
    expect(sql).not.toMatch(/updated_at/);
  });

  it('mapeia Date → ISO e days_without_divulgation numérico; sem nenhuma fonte → null', async () => {
    const pool = makePool([
      { id: 'jp-a', last_action_at: new Date('2026-09-20T12:00:00Z'), days_without_divulgation: 5 },
      { id: 'jp-b', last_action_at: null, days_without_divulgation: null },
    ]);
    const out = await loadVacancyActivity(pool, ['jp-a', 'jp-b']);
    expect(out.get('jp-a')).toEqual({ lastActionAt: '2026-09-20T12:00:00.000Z', daysWithoutDivulgation: 5 });
    expect(out.get('jp-b')).toEqual({ lastActionAt: null, daysWithoutDivulgation: null });
  });

  it('id sem linha nenhuma devolve os dois campos null', async () => {
    const pool = makePool([{ id: 'jp-a', last_action_at: new Date('2026-09-20T12:00:00Z'), days_without_divulgation: 5 }]);
    const out = await loadVacancyActivity(pool, ['jp-a', 'jp-sem-linha']);
    expect(out.get('jp-sem-linha')).toEqual({ lastActionAt: null, daysWithoutDivulgation: null });
  });
});
