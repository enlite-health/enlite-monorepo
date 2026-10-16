/**
 * O gerador de resumo tem UMA classe e dois perfis (spec 052, Fase 3, T-36a/b): a instância da ADMISSÃO (Doc + 8 marcadores + esquema da
 * admissão) e a do ENQUADRE (texto em arquivo + sem catálogo + convocados na entrada + gate próprio). Vertex e Doc são dublês.
 */
import { AdmissionSummaryError } from '../../application/ports/AdmissionImportPorts';
import { assertSummaryShape } from '../../application/admissionSummaryGate';
import { assertEnquadreSummaryShape } from '../../application/enquadreSummaryGate';
import { ENQUADRE_SUMMARY_PROMPT } from '../../domain/prompts/enquadreSummaryPrompt';
import { validSummaryJson } from '../doubles/admissionSummaryFixtures';
import { validEnquadreSummaryJson } from '../doubles/enquadreSummaryFixtures';
import { ENQUADRE_SUMMARY_PROFILE } from '../enquadreSummaryProfile';
import { ADMISSION_SUMMARY_PROFILE, promptVersionOf, VertexAdmissionSummaryGenerator } from '../VertexAdmissionSummaryGenerator';

const CATALOGS = { segmentLabels: async () => ['SEG-ALFA'], pathologyTypeLabels: async () => ['PAT-UM'] };
const reply = (text: string) => ({ json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }) }) as unknown as Response;
const sent = (vertex: jest.Mock) => vertex.mock.calls[0][1] as { systemInstruction: { parts: Array<{ text: string }> }; contents: Array<{ parts: Array<{ text: string }> }> };

function build(env: Record<string, string | undefined>, deps: { profile?: typeof ENQUADRE_SUMMARY_PROFILE; doc?: string; out?: string } = {}) {
  const vertex = jest.fn(async () => reply(deps.out ?? '{"a":1}\n\nResumen'));
  const getPrompt = jest.fn(async (_id: string) => deps.doc ?? 'TEXTO-DO-DOC');
  const gen = new VertexAdmissionSummaryGenerator({ NODE_ENV: 'production', ...env } as NodeJS.ProcessEnv, {
    promptProvider: { getPrompt }, vertex: vertex as never, catalogs: CATALOGS, ...(deps.profile ? { profile: deps.profile } : {}),
  });
  return { gen, vertex, getPrompt };
}

describe('instância da ADMISSÃO = Doc + esquema de hoje (o que já roda em produção)', () => {
  it('sem `profile` a instância usa o perfil da admissão: Doc de ADMISSION_SUMMARY_PROMPT_DOC_ID, marcadores de catálogo e o gate da admissão', async () => {
    const { gen, vertex, getPrompt } = build({ ADMISSION_SUMMARY_PROMPT_DOC_ID: 'DOC-1' }, { doc: 'Catálogo: {{CATALOGO_SEGMENTOS_CLINICOS}}' });
    const out = await gen.generate({ transcript: 'T', entrevistaId: 'ADM-0001', fecha: '2026-10-09' });
    expect(getPrompt).toHaveBeenCalledWith('DOC-1');
    expect(sent(vertex).systemInstruction.parts[0].text).toBe('Catálogo: SEG-ALFA'); // marcador do catálogo preenchido
    expect(sent(vertex).contents[0].parts[0].text).toMatch(/^entrevista_id=ADM-0001\nfecha=2026-10-09\n\ntranscripcion:\nT$/);
    expect(out.promptVersion).toBe(promptVersionOf('Catálogo: {{CATALOGO_SEGMENTOS_CLINICOS}}'));
    expect(gen.assertShape).toBe(ADMISSION_SUMMARY_PROFILE.assertShape);
    // o gate da admissão aceita o JSON da admissão e RECUSA o do enquadre
    expect(() => gen.assertShape({ summary: 's', promptVersion: 'v', structured: validSummaryJson() }, { transcript: 't' })).not.toThrow();
    expect(() => gen.assertShape({ summary: 's', promptVersion: 'v', structured: validEnquadreSummaryJson() }, { transcript: 't' })).toThrow(AdmissionSummaryError);
    expect(ADMISSION_SUMMARY_PROFILE.prompt).toEqual({ kind: 'doc', docIdEnv: 'ADMISSION_SUMMARY_PROMPT_DOC_ID' });
    expect(ADMISSION_SUMMARY_PROFILE.assertShape({ summary: 's', promptVersion: 'v', structured: validSummaryJson() }, { transcript: 't' })).toBeDefined();
    expect(() => assertSummaryShape({ summary: 's', promptVersion: 'v', structured: validEnquadreSummaryJson() })).toThrow();
  });

  it('sem o id do Doc a admissão continua sem resumo (prompt_missing), e o Vertex não é chamado', async () => {
    const { gen, vertex } = build({});
    await expect(gen.generate({ transcript: 'T' })).rejects.toMatchObject({ reason: 'prompt_missing' });
    expect(vertex).not.toHaveBeenCalled();
  });
});

describe('instância do ENQUADRE = texto do arquivo + gate próprio (T-36b)', () => {
  const convocados = [{ ref: 'REF-1', nombre: 'Prestadora Sintetica Um' }, { ref: 'REF-2', nombre: 'Prestador Sintetico Dois' }];

  it('o prompt é o texto do arquivo (NÃO lê o Doc, nem precisa da env) e a versão gravada é o hash desse texto', async () => {
    const { gen, vertex, getPrompt } = build({}, { profile: ENQUADRE_SUMMARY_PROFILE });
    const out = await gen.generate({ transcript: 'TRANSCRICAO', entrevistaId: 'ENC-AB12CD', fecha: '2026-10-14', convocados });
    expect(getPrompt).not.toHaveBeenCalled();
    expect(sent(vertex).systemInstruction.parts[0].text).toBe(ENQUADRE_SUMMARY_PROMPT);
    expect(out.promptVersion).toBe(promptVersionOf(ENQUADRE_SUMMARY_PROMPT));
    expect(out.promptVersion).toMatch(/^sha256:[0-9a-f]{12}$/);
    // mudou uma letra do texto → outra versão (a versão É o hash do texto)
    expect(promptVersionOf(`${ENQUADRE_SUMMARY_PROMPT} `)).not.toBe(out.promptVersion);
  });

  it('a mensagem do usuário leva o código ENC-, a data, os convocados (só ref + nome) e a transcrição; sem catálogo', async () => {
    const { gen, vertex } = build({}, { profile: ENQUADRE_SUMMARY_PROFILE });
    await gen.generate({ transcript: 'TRANSCRICAO', entrevistaId: 'ENC-AB12CD', fecha: '2026-10-14', convocados });
    const user = sent(vertex).contents[0].parts[0].text;
    expect(user).toBe(
      `entrevista_id=ENC-AB12CD\nfecha=2026-10-14\n\nconvocados:\n${JSON.stringify(convocados)}\n\ntranscripcion:\nTRANSCRICAO`,
    );
    expect(ENQUADRE_SUMMARY_PROMPT).not.toMatch(/\{\{/); // o prompt não tem marcador sobrando
  });

  it('o gate do enquadre: aceita a forma válida e REJEITA saída com bloco faltando (só nomes de campo no erro)', () => {
    const input = { transcript: 't', convocados };
    const ok = { summary: 's', promptVersion: 'v', structured: validEnquadreSummaryJson('ENC-AB12CD', ['REF-1', null]) };
    expect(assertEnquadreSummaryShape(ok, input)).toBe(ok);
    const semBloco = (mut: (j: Record<string, any>) => void) => {
      const j = validEnquadreSummaryJson('ENC-AB12CD', ['REF-1']);
      mut(j);
      return assertEnquadreSummaryShape({ summary: 's', promptVersion: 'v', structured: j }, input);
    };
    const falha = (fn: () => unknown) => { try { fn(); } catch (e) { return e as AdmissionSummaryError; } throw new Error('não rejeitou'); };
    expect(falha(() => semBloco((j) => delete j.sin_atribuir))).toMatchObject({ reason: 'schema_invalid', placeholders: ['sin_atribuir'] });
    expect(falha(() => semBloco((j) => delete j.prestadores[0].alertas))).toMatchObject({ reason: 'schema_invalid', placeholders: ['prestadores[0].alertas'] });
    expect(falha(() => semBloco((j) => delete j.encuentro.temas_cubiertos.zona))).toMatchObject({ placeholders: ['encuentro.temas_cubiertos.zona'] });
    expect(falha(() => semBloco((j) => { j.estado = 'BORRADOR_PARA_REVISION_CTM'; }))).toMatchObject({ placeholders: ['estado'] }); // o estado da admissão não vale
    expect(falha(() => semBloco((j) => { j.prestadores = []; }))).toMatchObject({ placeholders: ['prestadores'] });
    expect(falha(() => semBloco((j) => { j.prestadores[0].interes.valor = 'seleccionado'; }))).toMatchObject({ placeholders: ['prestadores[0].interes'] });
    expect(falha(() => semBloco((j) => { j.prestadores[0].convocado_ref = 'REF-INVENTADA'; }))).toMatchObject({ placeholders: ['prestadores[0].convocado_ref'] });
    expect(falha(() => assertEnquadreSummaryShape({ summary: 's', promptVersion: 'v', structured: null, jsonInvalid: true }, input))).toMatchObject({ reason: 'json_invalid' });
    expect(falha(() => assertEnquadreSummaryShape({ summary: 's', promptVersion: 'v', structured: validSummaryJson() }, input))).toMatchObject({ reason: 'schema_invalid' });
  });
});
