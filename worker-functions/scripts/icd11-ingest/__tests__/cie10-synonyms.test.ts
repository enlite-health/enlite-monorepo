import {
  CIE10_CODE_SOURCE,
  CIE10_TITLE_SOURCE,
  buildCie10Seeds,
  parseCie10Map,
  parseOpsTitles,
  renderCie10Migration,
} from '../cie10-synonyms';

const HEADER = '10ClassKind\t10DepthInKind\ticd10Code\ticd10Chapter\ticd10Title\t11ClassKind\t11DepthInKind\tFoundation\tLin\ticd11Code\ticd11Chapter\ticd11Title';
const row = (kind: string, code10: string, code11: string) =>
  [kind, '1', code10, 'V', 'titulo', 'category', '1', 'f', 'l', code11, '06', 't'].join('\t');

describe('parseCie10Map', () => {
  it('lê só categorias F00-F99, ignora bloco/capítulo/outras letras, e fica com o tronco da pós-coordenação', () => {
    const text = [
      HEADER,
      row('chapter', 'V', '6A00'),
      row('block', 'F70-F79', '6A00'),
      row('category', 'F70', '6A00.0'),
      row('category', 'F84.5', '6A02.0'),
      row('category', 'F10.2', '6C40.2&XS2B'),
      row('category', 'A00', '1A00'),
      row('category', 'F70', '9999'), // repetido: a 1ª linha vence
    ].join('\n');
    expect(parseCie10Map(text)).toEqual([
      { code10: 'F70', code11: '6A00.0' },
      { code10: 'F84.5', code11: '6A02.0' },
      { code10: 'F10.2', code11: '6C40.2' },
    ]);
  });

  it('recusa arquivo que não é o mapeamento da OMS', () => {
    expect(() => parseCie10Map('a\tb\nc\td')).toThrow(/10To11MapToOneCategory/);
  });
});

describe('parseOpsTitles', () => {
  const resumo = [
    'F00*      Demencia en la enfermedad de Alzheimer',
    'F04       Síndrome amnésico orgánico, no inducido por alcohol o por otras',
    '          sustancias psicoactivas',
    'F70       Retraso mental leve',
    'G00       Meningitis bacteriana',
  ];
  const tabular = [
    'F00*      Demencia en la enfermedad de Alzheimer',
    '      Descripción que NÃO é título.',
    'F00.0*    Demencia en la enfermedad de Alzheimer, de comienzo',
    '          temprano (G30.0†)',
    'F84.4   Trastorno hiperactivo asociado con retraso mental y',
    '        movimientos estereotipados',
    '        Es un trastorno mal definido, de validez nosológica dudosa.',
    'F84.5    Síndrome de Asperger',
    'F10.0   Intoxica-',
    '        ción aguda',
    'G00      Meningitis',
    'F99      Depois do G00 não entra',
  ];
  const texto = [...resumo, '', ...tabular].join('\n');

  it('lê o índice resumido e a lista tabular; une título quebrado e hifenização; não confunde descrição com título', () => {
    const t = parseOpsTitles(texto);
    expect(t.get('F04')).toBe('Síndrome amnésico orgánico, no inducido por alcohol o por otras sustancias psicoactivas');
    expect(t.get('F70')).toBe('Retraso mental leve');
    expect(t.get('F00.0')).toBe('Demencia en la enfermedad de Alzheimer, de comienzo temprano (G30.0†)');
    expect(t.get('F84.4')).toBe('Trastorno hiperactivo asociado con retraso mental y movimientos estereotipados');
    expect(t.get('F84.5')).toBe('Síndrome de Asperger');
    expect(t.get('F10.0')).toBe('Intoxicación aguda');
    expect(t.has('F99')).toBe(false);
  });

  it('recusa texto sem o capítulo V duas vezes', () => {
    expect(() => parseOpsTitles('nada')).toThrow(/capítulo V/);
  });
});

describe('buildCie10Seeds / renderCie10Migration', () => {
  const titles = new Map([['F70', "Retraso mental leve"], ['F51.0', "Insomnio no orgánico d'exemplo"]]);
  const seeds = buildCie10Seeds(
    [
      { code10: 'F70', code11: '6A00.0' },
      { code10: 'F70.0', code11: '6A00.0' }, // sem título OPS: só o código
      { code10: 'F51.0', code11: '7A0Z' },
    ],
    titles,
  );

  it('uma linha para o código e uma para o título, quando a OPS tem', () => {
    expect(seeds).toEqual([
      { term: 'F70', source: CIE10_CODE_SOURCE, code11: '6A00.0' },
      { term: 'Retraso mental leve', source: CIE10_TITLE_SOURCE, code11: '6A00.0' },
      { term: 'F70.0', source: CIE10_CODE_SOURCE, code11: '6A00.0' },
      { term: 'F51.0', source: CIE10_CODE_SOURCE, code11: '7A0Z' },
      { term: "Insomnio no orgánico d'exemplo", source: CIE10_TITLE_SOURCE, code11: '7A0Z' },
    ]);
  });

  it('a migration carrega todas as linhas, escapa aspas, junta ao release corrente e emite o NOTICE com as contagens', () => {
    const sql = renderCie10Migration(seeds);
    expect(sql).toContain("('F70', 'who-icd10to11map:code', '6A00.0')");
    expect(sql).toContain("('Insomnio no orgánico d''exemplo', 'ops-cie10-es:title', '7A0Z')");
    expect(sql).toMatch(/JOIN terminology\.icd_releases r ON r\.is_current/);
    expect(sql).toMatch(/ON CONFLICT \(icd_uri, release, lower\(term\), lang\) DO NOTHING/);
    expect(sql).toMatch(/RAISE NOTICE '560 CID-10 F00-F99: esperadas=%, com entidade no release corrente=%, inseridas=%'/);
    expect(sql).not.toMatch(/indexTerm\[\]\s+da\s+OMS\s+como/); // nunca importa o índice da OMS
  });
});
