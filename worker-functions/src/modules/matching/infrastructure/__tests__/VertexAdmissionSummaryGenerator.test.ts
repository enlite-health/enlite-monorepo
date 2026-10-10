/**
 * VertexAdmissionSummaryGenerator (spec 049, H4): o prompt vem de um Google Doc. Sem o id ou com o Doc ilegível NÃO há resumo
 * (nada de prompt inventado); `promptVersion` = sha256 curto do texto. Provider e Vertex são dublês — nada toca Google.
 */
import { AdmissionSummaryError } from '../../application/ports/AdmissionImportPorts';
import { promptVersionOf, VertexAdmissionSummaryGenerator } from '../VertexAdmissionSummaryGenerator';

const okResponse = (text: string) => ({ json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) }) as unknown as Response;

function build(env: Record<string, string | undefined>, getPrompt: (id: string) => Promise<string>) {
  const vertex = jest.fn(async (_model: string, _body: unknown, _label: string) => okResponse('  resumo sintético  '));
  const gen = new VertexAdmissionSummaryGenerator(
    { NODE_ENV: 'production', ...env } as NodeJS.ProcessEnv,
    { promptProvider: { getPrompt: jest.fn(getPrompt) }, vertex: vertex as never },
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
