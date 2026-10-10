import { readFileSync } from 'fs';
import { join } from 'path';
import { buildInterviewInput, fillPrompt, findUnfilled, normalizeMarkdownEscapes } from '../admissionPromptFiller';

const fx = (n: string): string => readFileSync(join(__dirname, '../../infrastructure/__tests__/fixtures', n), 'utf8');

describe('admissionPromptFiller', () => {
  it('escapes: a fixture com `\\_`, `\\*`, `\\\\\\_` (formato Markdown da leitura do Drive) vira o nome limpo da chave', () => {
    const out = normalizeMarkdownEscapes(fx('gem-prompt-markdown-escapes.fixture.txt'));
    expect(out).toContain('entrevista_id, fecha');
    expect(out).toContain('resp_nombre_completo');
    expect(out).toContain('"informante_inferido": true');
    expect(out).toContain('**clave JSON**');
    expect(out).toContain('{{ESCALA_DEPENDENCIA_ENLITE}}');
    expect(out).not.toMatch(/\\[_*]/);
    expect(JSON.parse(out.split('\n')[6]).entrevistas_procesadas[0].entrevista_id).toBe('');
  });

  it('o export text/plain real do Doc (o que o provider lê) não tem escape e passa intacto', () => {
    const real = fx('gem-prompt-export-txt.fixture.txt');
    expect(normalizeMarkdownEscapes(real)).toBe(real);
  });

  it('o Doc real: exatamente 8 marcadores; `{{...}}` do cabeçalho NÃO é marcador; preenchidos os 8, não sobra nenhum', () => {
    const real = fx('gem-prompt-export-txt.fixture.txt');
    const names = findUnfilled(real).sort();
    expect(names).toEqual([
      'CATALOGO_SEGMENTOS_CLINICOS', 'CATALOGO_TIPOS_PRESTADOR', 'CATALOGO_TIPO_PATOLOGIA', 'ESCALA_DEPENDENCIA_ENLITE',
      'MAX_HORAS_POR_TURNO', 'MAX_HORAS_SEMANALES_POR_PRESTADOR', 'REGLA_COBERTURA_SUPLENTE', 'REGLA_TURNOS_NOCTURNOS_Y_FINES_DE_SEMANA',
    ]);
    const filled = fillPrompt(real, Object.fromEntries(names.map((n) => [n, `V-${n}`])));
    expect(findUnfilled(filled)).toEqual([]);
    expect(filled).toContain('V-MAX_HORAS_POR_TURNO');
  });

  it('marcador sem valor continua no texto e findUnfilled devolve só o NOME', () => {
    const out = fillPrompt('a {{X_UM}} b {{X_DOIS}} segredo clínico', { X_UM: '1' });
    expect(findUnfilled(out)).toEqual(['X_DOIS']);
  });

  it('cabeçalho da entrada: entrevista_id=ADM-… e fecha=…; sem informante_tipo', () => {
    const t = buildInterviewInput({ entrevistaId: 'ADM-0042', fecha: '2026-10-09' }, 'TEXTO');
    expect(t).toContain('entrevista_id=ADM-0042');
    expect(t).toContain('fecha=2026-10-09');
    expect(t).not.toContain('informante_tipo');
    expect(t.endsWith('TEXTO')).toBe(true);
  });

  it('trava reconhece `{{nombre}}` e `{{ X }}` (minúscula e espaços), só pelo nome, e ignora apenas o literal `{{...}}` da prosa', () => {
    expect(findUnfilled('a {{nombre}} b {{ X }} c {{ ... }} d {{...}} e {{texto clinico longo}}').sort()).toEqual(['(invalido)', 'X', 'nombre']);
    expect(findUnfilled('so {{...}} aqui')).toEqual([]);
    // marcador conhecido com espaços é PREENCHIDO
    expect(fillPrompt('x {{ MAX_HORAS_POR_TURNO }} y', { MAX_HORAS_POR_TURNO: '12' })).toBe('x 12 y');
  });
});
