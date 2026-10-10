/**
 * VertexAdmissionSummaryGenerator (spec 049, H4): o prompt vem de um Google Doc. Sem o id ou com o Doc ilegível NÃO há resumo
 * (nada de prompt inventado); `promptVersion` = sha256 curto do texto. Provider e Vertex são dublês — nada toca Google.
 */
import { AdmissionSummaryError } from '../../application/ports/AdmissionImportPorts';
import { readFileSync } from 'fs';
import { GeminiApiError } from '../../../integration/infrastructure/gemini-fetch';
import { join } from 'path';
import { MAX_OUTPUT_TOKENS, THINKING_BUDGET, promptVersionOf, VertexAdmissionSummaryGenerator } from '../VertexAdmissionSummaryGenerator';

const okResponse = (text: string) => ({ json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) }) as unknown as Response;

const CATALOGS = {
  segmentLabels: async () => ['SEG-ALFA', 'SEG-BETA'],
  pathologyTypeLabels: async () => ['PAT-UM', 'PAT-DOIS'],
};

function build(
  env: Record<string, string | undefined>, getPrompt: (id: string) => Promise<string>,
  opts: { catalogs?: Partial<typeof CATALOGS>; reply?: string; finishReason?: string; promptFeedback?: unknown } = {},
) {
  const vertex = jest.fn(async (_model: string, _body: unknown, _label: string) => {
    if (opts.finishReason === undefined && opts.promptFeedback === undefined) return okResponse(opts.reply ?? '  resumo sintético  ');
    return ({ json: async () => ({ candidates: [{ finishReason: opts.finishReason, content: { parts: [{ text: opts.reply ?? 'resumo cortado' }] } }], promptFeedback: opts.promptFeedback }) }) as unknown as Response;
  });
  const gen = new VertexAdmissionSummaryGenerator(
    { NODE_ENV: 'production', ...env } as NodeJS.ProcessEnv,
    { promptProvider: { getPrompt: jest.fn(getPrompt) }, vertex: vertex as never, catalogs: { ...CATALOGS, ...opts.catalogs } },
  );
  return { gen, vertex };
}

describe('VertexAdmissionSummaryGenerator — prompt do Google Doc (H4)', () => {
  it('(a) sem ADMISSION_SUMMARY_PROMPT_DOC_ID → prompt_missing e o Vertex NÃO é chamado', async () => {
    const { gen, vertex } = build({}, async () => 'x');
    await expect(gen.generate({ transcript: 't' })).rejects.toMatchObject({ reason: 'prompt_missing' });
    expect(vertex).not.toHaveBeenCalled();
  });

  it('id só com espaços também é prompt_missing', async () => {
    const { gen, vertex } = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: '   ' }, async () => 'x');
    await expect(gen.generate({ transcript: 't' })).rejects.toBeInstanceOf(AdmissionSummaryError);
    expect(vertex).not.toHaveBeenCalled();
  });

  it('Doc ilegível (erro ou vazio) → prompt_unavailable, sem Vertex e sem repassar a mensagem do Google', async () => {
    const boom = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: 'DOC-SEGREDO' }, async () => { throw new Error('403 doc DOC-SEGREDO'); });
    const err = await boom.gen.generate({ transcript: 't' }).catch((e) => e as AdmissionSummaryError);
    expect(err).toMatchObject({ reason: 'prompt_unavailable' });
    expect((err as Error).message).not.toContain('DOC-SEGREDO');
    const vazio = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' }, async () => '  \n ');
    await expect(vazio.gen.generate({ transcript: 't' })).rejects.toMatchObject({ reason: 'prompt_unavailable' });
    expect(boom.vertex).not.toHaveBeenCalled();
    expect(vazio.vertex).not.toHaveBeenCalled();
  });

  it('com o Doc lido: o texto do Doc é a instrução de sistema e o resumo volta aparado', async () => {
    const { gen, vertex } = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' }, async () => 'INSTRUCOES-DO-DOC');
    const out = await gen.generate({ transcript: 'transcricao' });
    expect(out.summary).toBe('resumo sintético');
    const body = vertex.mock.calls[0][1] as { systemInstruction: { parts: Array<{ text: string }> } };
    expect(body.systemInstruction.parts[0].text).toBe('INSTRUCOES-DO-DOC');
  });

  it('(c) promptVersion é função do texto: igual para o mesmo texto, diferente quando o Doc muda', async () => {
    let texto = 'versao um';
    const { gen } = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' }, async () => texto);
    const v1 = (await gen.generate({ transcript: 't' })).promptVersion;
    const v1b = (await gen.generate({ transcript: 't' })).promptVersion;
    texto = 'versao dois';
    const v2 = (await gen.generate({ transcript: 't' })).promptVersion;
    expect(v1).toBe(v1b);
    expect(v1).toBe(promptVersionOf('versao um'));
    expect(v1).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(v2).not.toBe(v1);
  });
});

const REAL_DOC = readFileSync(join(__dirname, 'fixtures/gem-prompt-export-txt.fixture.txt'), 'utf8');
const sentSystem = (vertex: jest.Mock): string => (vertex.mock.calls[0][1] as { systemInstruction: { parts: Array<{ text: string }> } }).systemInstruction.parts[0].text;
const sentUser = (vertex: jest.Mock): string => (vertex.mock.calls[0][1] as { contents: Array<{ parts: Array<{ text: string }> }> }).contents[0].parts[0].text;

describe('VertexAdmissionSummaryGenerator — marcadores, trava, entrada e saída do Gem', () => {
  it('preenchimento: com o Doc real, os 8 marcadores somem; catálogos vêm das fontes (dublê com 2 segmentos) e as regras do Marcel entram', async () => {
    const { gen, vertex } = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' }, async () => REAL_DOC);
    await gen.generate({ transcript: 't', entrevistaId: 'ADM-1', fecha: '2026-10-09' });
    const sys = sentSystem(vertex);
    expect(sys).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    expect(sys).toContain('SEG-ALFA / SEG-BETA');
    expect(sys).toContain('PAT-UM / PAT-DOIS');
    expect(sys).toContain('Leve / Moderada / Grave / Muy grave');
    expect(sys).toContain('Acompañante Terapéutico / Cuidador/a / Enfermero/a / Kinesiólogo/a / Psicólogo/a');
    expect(sys).toContain('60 horas semanales por prestador');
    expect(sys).toContain('12 horas por turno');
    expect(sys).toContain('Máximo 8 prestadores activos por paciente.');
    expect(sys).toContain('Fin de semana: evitar que el mismo equipo');
  });

  it('trava: marcador desconhecido -> 0 chamadas ao Vertex e prompt_unfilled_placeholder com SÓ o nome', async () => {
    const { gen, vertex } = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' }, async () => 'texto secreto {{MARCADOR_NOVO}} mais texto');
    const err = await gen.generate({ transcript: 't' }).catch((e) => e as AdmissionSummaryError);
    expect(err).toMatchObject({ reason: 'prompt_unfilled_placeholder', placeholders: ['MARCADOR_NOVO'] });
    expect((err as Error).message).not.toContain('secreto');
    expect(vertex).not.toHaveBeenCalled();
  });

  it('catálogo VAZIO (terminologia não carregada ou segmentos sem item) -> prompt_catalog_empty com o nome, 0 chamadas ao Vertex', async () => {
    const semPat = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' }, async () => REAL_DOC, { catalogs: { pathologyTypeLabels: async () => [] } });
    await expect(semPat.gen.generate({ transcript: 't' })).rejects.toMatchObject({ reason: 'prompt_catalog_empty', placeholders: ['CATALOGO_TIPO_PATOLOGIA'] });
    const semSeg = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' }, async () => REAL_DOC, { catalogs: { segmentLabels: async () => [] } });
    await expect(semSeg.gen.generate({ transcript: 't' })).rejects.toMatchObject({ reason: 'prompt_catalog_empty', placeholders: ['CATALOGO_SEGMENTOS_CLINICOS'] });
    expect(semPat.vertex).not.toHaveBeenCalled();
    expect(semSeg.vertex).not.toHaveBeenCalled();
  });

  it('escapes de Markdown no prompt são normalizados antes do Vertex', async () => {
    const { gen, vertex } = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' }, async () => 'chave entrevista\\_id e resp\\\\\\_nombre');
    await gen.generate({ transcript: 't' });
    expect(sentSystem(vertex)).toBe('chave entrevista_id e resp_nombre');
  });

  it('entrada: a mensagem do usuário leva entrevista_id=ADM-… e fecha=… antes da transcrição', async () => {
    const { gen, vertex } = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' }, async () => 'p');
    await gen.generate({ transcript: 'TRANSCRICAO', entrevistaId: 'ADM-0042', fecha: '2026-10-09' });
    const u = sentUser(vertex);
    expect(u).toMatch(/^entrevista_id=ADM-0042\nfecha=2026-10-09\n/);
    expect(u.endsWith('TRANSCRICAO')).toBe(true);
  });

  it('saída: JSON válido + resumo -> structured e resumo separados; JSON inválido -> jsonInvalid e só o resumo', async () => {
    const ok = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' }, async () => 'p', { reply: '{"estado":"BORRADOR_PARA_REVISION_CTM"}\n\nResumen legible' });
    expect(await ok.gen.generate({ transcript: 't' })).toMatchObject({ summary: 'Resumen legible', structured: { estado: 'BORRADOR_PARA_REVISION_CTM' }, jsonInvalid: false });
    const bad = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' }, async () => 'p', { reply: '{"a":,}\n\nResumen legible' });
    expect(await bad.gen.generate({ transcript: 't' })).toMatchObject({ summary: 'Resumen legible', structured: null, jsonInvalid: true });
  });

  it('finishReason: MAX_TOKENS -> output_truncated; SAFETY/RECITATION/promptFeedback -> blocked_by_model; STOP salva. Em todos o texto parcial NÃO sobe', async () => {
    const run = async (o: { finishReason?: string; promptFeedback?: unknown }) => {
      const b = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' }, async () => 'p', { ...o, reply: '{"a":1}\n\nTEXTO-PARCIAL-CLINICO' });
      return b.gen.generate({ transcript: 't' }).catch((e) => e as AdmissionSummaryError);
    };
    const trunc = await run({ finishReason: 'MAX_TOKENS' });
    expect(trunc).toMatchObject({ reason: 'output_truncated' });
    expect((trunc as Error).message).not.toContain('TEXTO-PARCIAL');
    expect(await run({ finishReason: 'SAFETY' })).toMatchObject({ reason: 'blocked_by_model' });
    expect(await run({ finishReason: 'RECITATION' })).toMatchObject({ reason: 'blocked_by_model' });
    expect(await run({ promptFeedback: { blockReason: 'SAFETY' } })).toMatchObject({ reason: 'blocked_by_model' });
    expect(await run({ finishReason: 'STOP' })).toMatchObject({ summary: 'TEXTO-PARCIAL-CLINICO' });
  });

  it('o pedido leva o teto de saída medido e o thinking explícito', async () => {
    const { gen, vertex } = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' }, async () => 'p');
    await gen.generate({ transcript: 't' });
    const cfg = (vertex.mock.calls[0][1] as { generationConfig: Record<string, unknown> }).generationConfig;
    expect(cfg).toMatchObject({ maxOutputTokens: MAX_OUTPUT_TOKENS, thinkingConfig: { thinkingBudget: THINKING_BUDGET } });
    expect(MAX_OUTPUT_TOKENS).toBeLessThan(65537); // teto do gemini-2.5-pro no Vertex (400 acima disso, medido)
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThan(THINKING_BUDGET * 2);
  });

  it('falha de leitura do catálogo (≠ lista vazia) -> catalog_read_failed com o nome do catálogo e a CLASSE do erro, sem a mensagem; 0 chamadas ao Vertex', async () => {
    class PgBoom extends Error {}
    const b = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' }, async () => REAL_DOC, { catalogs: { segmentLabels: async () => { throw new PgBoom('conexao com senha=SEGREDO'); } } });
    const err = await b.gen.generate({ transcript: 't' }).catch((e) => e as AdmissionSummaryError);
    expect(err).toMatchObject({ reason: 'catalog_read_failed', placeholders: ['CATALOGO_SEGMENTOS_CLINICOS'], errorClass: 'PgBoom' });
    expect((err as Error).message).not.toContain('SEGREDO');
    expect(b.vertex).not.toHaveBeenCalled();
    const naoErro = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' }, async () => REAL_DOC, { catalogs: { pathologyTypeLabels: async () => { throw 'texto'; } } });
    await expect(naoErro.gen.generate({ transcript: 't' })).rejects.toMatchObject({ reason: 'catalog_read_failed', errorClass: 'unknown' });
  });

  describe('falha do Vertex: transitória (não conta no teto) × configuração (conta)', () => {
    const failWith = async (err: unknown) => {
      const vertex = jest.fn(async () => { throw err; });
      const gen = new VertexAdmissionSummaryGenerator({ NODE_ENV: 'production', ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' } as NodeJS.ProcessEnv, {
        promptProvider: { getPrompt: async () => 'p' }, vertex: vertex as never, catalogs: CATALOGS,
      });
      return gen.generate({ transcript: 't' }).catch((e) => e as AdmissionSummaryError);
    };
    it.each([429, 500, 503, 599])('HTTP %i -> vertex_transient', async (status) => {
      expect(await failWith(new GeminiApiError(status, 'x'))).toMatchObject({ reason: 'vertex_transient' });
    });
    it.each([400, 401, 403, 404])('HTTP %i -> vertex_failed (configuração/permissão)', async (status) => {
      expect(await failWith(new GeminiApiError(status, 'x'))).toMatchObject({ reason: 'vertex_failed' });
    });
    it('erro de rede/timeout (não-HTTP) -> vertex_transient; corpo ilegível -> empty_response (a chamada foi paga)', async () => {
      expect(await failWith(new Error('ETIMEDOUT'))).toMatchObject({ reason: 'vertex_transient' });
      const b = new VertexAdmissionSummaryGenerator({ NODE_ENV: 'production', ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' } as NodeJS.ProcessEnv, {
        promptProvider: { getPrompt: async () => 'p' }, vertex: (async () => ({ json: async () => { throw new Error('json'); } })) as never, catalogs: CATALOGS,
      });
      await expect(b.generate({ transcript: 't' })).rejects.toMatchObject({ reason: 'empty_response' });
    });
  });
});
