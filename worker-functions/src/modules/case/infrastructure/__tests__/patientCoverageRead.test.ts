/** patientCoverageRead (§C) — spec 058 T058. `buildCoverage` é pura; os 4 estados de `displaySource` e a regra `display: null`. */
import { buildCoverage, coverageEntriesSql, readCoverageEntries, type CoverageEntry } from '../patientCoverageRead';

const OSDE: CoverageEntry = { code: 'OSDE', name: 'OSDE', mapped: true, source: 'clickup' };
const SWISS: CoverageEntry = { code: 'SWISS_MEDICAL', name: 'Swiss Medical', mapped: true, source: 'panel' };
const CRU: CoverageEntry = { code: null, name: null, mapped: false, source: 'clickup' };

describe('buildCoverage', () => {
  it('INFORMED vence VERIFIED: com cobertura informada e entradas mapeadas, display é a informada', () => {
    expect(buildCoverage({ informed: 'Galeno Plus', entries: [OSDE] })).toEqual({ display: 'Galeno Plus', displaySource: 'INFORMED', entries: [OSDE] });
  });

  it('VERIFIED: sem informada, display = nomes do catálogo (distintos, na ordem das entradas)', () => {
    expect(buildCoverage({ informed: null, entries: [OSDE, CRU, SWISS, { ...OSDE, source: 'panel' }] })).toMatchObject({
      display: 'OSDE, Swiss Medical',
      displaySource: 'VERIFIED',
    });
  });

  it('UNMAPPED_ONLY: só entradas sem mapeamento -> display null com o objeto coverage PRESENTE e as entradas', () => {
    const c = buildCoverage({ informed: '  ', entries: [CRU, CRU] });
    expect(c.displaySource).toBe('UNMAPPED_ONLY');
    expect(c.display).toBeNull();
    expect(c.entries).toHaveLength(2);
  });

  it('NONE: nada informado e nenhuma entrada -> display null, entries [] (o objeto existe; coverage:null é outra coisa, "sem permissão")', () => {
    for (const informed of [null, undefined, '', '   ']) {
      const c = buildCoverage({ informed, entries: [] });
      expect(c).toEqual({ display: null, displaySource: 'NONE', entries: [] });
    }
  });

  it('o back não traduz: entrada sem mapeamento tem code e name nulos e mapped false (quem escreve "sem mapeamento" é o front)', () => {
    expect(buildCoverage({ informed: null, entries: [CRU] }).entries[0]).toEqual({ code: null, name: null, mapped: false, source: 'clickup' });
  });

  it('não muda a lista de entrada (cópia)', () => {
    const entries = [OSDE];
    const c = buildCoverage({ informed: null, entries });
    expect(c.entries).not.toBe(entries);
    expect(c.entries).toEqual(entries);
  });
});

describe('coverageEntriesSql / readCoverageEntries', () => {
  it('a subconsulta ordena pelo catálogo e traz as sem mapeamento, sem o rótulo cru', () => {
    const sql = coverageEntriesSql('p.id');
    expect(sql).toContain('piv.patient_id = p.id');
    expect(sql).toContain('piv.provider_code IS NULL');
    expect(sql).not.toContain('raw_label');
    expect(sql).toContain("'[]'::jsonb");
  });

  it('a leitura fora da ficha usa a MESMA subconsulta e devolve [] quando não há linha', async () => {
    const cli = { query: jest.fn().mockResolvedValue({ rows: [{ entries: [OSDE] }] }) };
    expect(await readCoverageEntries(cli as never, 'pat-1')).toEqual([OSDE]);
    expect(String(cli.query.mock.calls[0][0])).toContain(coverageEntriesSql('$1::uuid'));
    expect(await readCoverageEntries({ query: jest.fn().mockResolvedValue({ rows: [] }) } as never, 'pat-1')).toEqual([]);
  });
});
