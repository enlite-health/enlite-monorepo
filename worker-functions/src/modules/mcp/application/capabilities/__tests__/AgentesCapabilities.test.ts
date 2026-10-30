import { AgentesVeredictoRegistrarCapability } from '../AgentesVeredictoRegistrarCapability';
import { AgentesReporteRegistrarCapability } from '../AgentesReporteRegistrarCapability';
import { AgentesReporteLerCapability } from '../AgentesReporteLerCapability';
import { AgentesPlacarLerCapability } from '../AgentesPlacarLerCapability';
import { AgentesPedidoDepositarCapability } from '../AgentesPedidoDepositarCapability';
import { AgentesMedicaoRegistrarCapability } from '../AgentesMedicaoRegistrarCapability';
import type { AgentesRepository } from '../../../infrastructure/AgentesRepository';

const UUID_A = '123e4567-e89b-12d3-a456-426614174000';
const UUID_B = '123e4567-e89b-12d3-a456-426614174001';

function makeRepo() {
  return {
    registrarVeredicto: jest.fn().mockResolvedValue({ id: UUID_A }),
    registrarReporte: jest.fn().mockResolvedValue({ id: UUID_A }),
    lerReportes: jest.fn().mockResolvedValue({ reportes: [] }),
    lerPlacar: jest.fn().mockResolvedValue({}),
    depositarPedido: jest.fn().mockResolvedValue({ pedido_id: UUID_A, atitude_id: UUID_B }),
    registrarMedicao: jest.fn().mockResolvedValue({ id: UUID_A }),
  };
}
const asRepo = (r: ReturnType<typeof makeRepo>) => r as unknown as AgentesRepository;

const veredicto = (over: Record<string, unknown> = {}) => ({
  operador: 'luz',
  sensor: 'juiz',
  inbox: 'ar-1',
  conversa_ref: 'conv-1',
  ultima_msg_ref: 'msg-9',
  nota: 7,
  cruza_areas: false,
  juiz_versao: 'gemini-2.5-flash:10ea503f',
  avaliado_em: '2026-10-29T10:00:00Z',
  achados: [
    { tipo: 'violacao', regra_ref: 'tom#28bd0a83fc2c', gravidade: 'alta' },
    { tipo: 'acerto', regra_ref: 'canal#3bad076e9644' },
  ],
  ...over,
});

const reporte = (over: Record<string, unknown> = {}) => ({
  autor: 'Gestora Teste',
  operador: 'luz',
  area: 'recrutamento',
  observacao: 'prometeu prazo que não existe',
  veredicto_ids: [UUID_A],
  ...over,
});

const pedido = (over: Record<string, unknown> = {}) => ({
  assunto: 'ajustar tom',
  descricao: 'descrição curta tipada',
  autor: 'sol-fila',
  area: 'recrutamento',
  grave_gatilho: 'nenhum',
  registro_versao: 'v1',
  atitude: {
    degrau: 1,
    conteudo: 'memória: nunca prometer prazo',
    caso_teste: 'caso: candidato pergunta prazo',
    metrica_alvo: 'taxa_violacao',
    janela: '7d',
    gatilho_rollback: 'taxa > 2x baseline',
  },
  origens: [{ reporte_id: UUID_A }, { veredicto_id: UUID_B }],
  ...over,
});

describe('agentes.veredicto.registrar — formato', () => {
  it('payload válido chega ao repositório com o principal', async () => {
    const repo = makeRepo();
    const cap = new AgentesVeredictoRegistrarCapability(asRepo(repo));
    await expect(cap.execute(veredicto(), 'sol-supervisor')).resolves.toEqual({ id: UUID_A });
    expect(repo.registrarVeredicto).toHaveBeenCalledWith('sol-supervisor', expect.objectContaining({ conversa_ref: 'conv-1' }));
  });

  it.each([
    ['campo extra (trecho)', { trecho: 'oi, tudo bem?' }],
    ['achado com texto no lugar da referência', { achados: [{ tipo: 'violacao', regra_ref: 'prometeu salário fixo ao candidato', gravidade: 'alta' }] }],
    ['achado com campo extra (resumo)', { achados: [{ tipo: 'acerto', regra_ref: 'tom#abc', resumo: 'texto' }] }],
    ['violação sem gravidade', { achados: [{ tipo: 'violacao', regra_ref: 'tom#abc' }] }],
    ['acerto com gravidade', { achados: [{ tipo: 'acerto', regra_ref: 'tom#abc', gravidade: 'baixa' }] }],
    ['sensor fora da lista', { sensor: 'adivinho' }],
    ['juiz sem nota', { nota: undefined }],
    ['nota de sensor que não é juiz', { sensor: 'silente' }],
    ['nota 11', { nota: 11 }],
    ['operador "Luz" (maiúscula)', { operador: 'Luz' }],
    ['operador de 41 chars', { operador: 'a'.repeat(41) }],
    ['conversa_ref com espaço (frase)', { conversa_ref: 'a conversa do João' }],
    ['conversa_ref de 81 chars', { conversa_ref: 'c'.repeat(81) }],
    ['cruza_areas ausente', { cruza_areas: undefined }],
    ['avaliado_em não é data', { avaliado_em: 'ontem' }],
  ])('recusa antes do banco: %s', async (_nome, over) => {
    const repo = makeRepo();
    const cap = new AgentesVeredictoRegistrarCapability(asRepo(repo));
    await expect(cap.execute(veredicto(over), 'sol-supervisor')).rejects.toThrow();
    expect(repo.registrarVeredicto).not.toHaveBeenCalled();
  });

  it('sem principal: recusa (fail-closed)', async () => {
    const cap = new AgentesVeredictoRegistrarCapability(asRepo(makeRepo()));
    await expect(cap.execute(veredicto())).rejects.toThrow(/principal ausente/);
  });
});

describe('agentes.reporte.registrar — formato', () => {
  it('payload válido (observacao de 500 chars) passa', async () => {
    const repo = makeRepo();
    const cap = new AgentesReporteRegistrarCapability(asRepo(repo));
    await cap.execute(reporte({ observacao: 'x'.repeat(500) }), 'maria');
    expect(repo.registrarReporte).toHaveBeenCalledWith('maria', expect.objectContaining({ operador: 'luz' }));
  });

  it.each([
    ['observacao de 501 chars', { observacao: 'x'.repeat(501) }],
    ['reporte com trecho de conversa (campo extra)', { trecho: 'Luz: seu pagamento sai amanhã' }],
    ['regra_proposta de 301 chars', { regra_proposta: 'r'.repeat(301) }],
    ['veredicto_ids com valor que não é uuid', { veredicto_ids: ['1; DROP TABLE'] }],
    ['observacao vazia', { observacao: '   ' }],
    ['operador "Luz" (maiúscula)', { operador: 'Luz' }],
  ])('recusa antes do banco: %s', async (_nome, over) => {
    const repo = makeRepo();
    const cap = new AgentesReporteRegistrarCapability(asRepo(repo));
    await expect(cap.execute(reporte(over), 'maria')).rejects.toThrow();
    expect(repo.registrarReporte).not.toHaveBeenCalled();
  });
});

describe('agentes.reporte.ler / agentes.placar.ler — formato', () => {
  it('reporte.ler aceita sem filtros e recusa campo extra', async () => {
    const repo = makeRepo();
    const cap = new AgentesReporteLerCapability(asRepo(repo));
    await cap.execute(undefined, 'sol-fila');
    expect(repo.lerReportes).toHaveBeenCalledWith('sol-fila', {});
    await expect(cap.execute({ texto: 'x' }, 'sol-fila')).rejects.toThrow();
    await expect(cap.execute({ operador: 'Luz' }, 'sol-fila')).rejects.toThrow();
    expect(repo.lerReportes).toHaveBeenCalledTimes(1);
  });

  it('placar.ler exige operador, de e ate; de < ate; campo extra recusado', async () => {
    const repo = makeRepo();
    const cap = new AgentesPlacarLerCapability(asRepo(repo));
    const ok = { operador: 'luz', de: '2026-10-01T00:00:00Z', ate: '2026-10-29T00:00:00Z' };
    await cap.execute(ok, 'maria');
    expect(repo.lerPlacar).toHaveBeenCalledWith('maria', ok);
    await expect(cap.execute({ operador: 'luz' }, 'maria')).rejects.toThrow();
    await expect(cap.execute({ ...ok, de: ok.ate, ate: ok.de }, 'maria')).rejects.toThrow();
    await expect(cap.execute({ ...ok, area: 'x' }, 'maria')).rejects.toThrow();
    await expect(cap.execute({ ...ok, operador: 'Luz' }, 'maria')).rejects.toThrow();
    expect(repo.lerPlacar).toHaveBeenCalledTimes(1);
  });
});

describe('agentes.pedido.depositar — formato', () => {
  it('payload válido chega ao repositório', async () => {
    const repo = makeRepo();
    const cap = new AgentesPedidoDepositarCapability(asRepo(repo));
    await expect(cap.execute(pedido(), 'sol-fila')).resolves.toEqual({ pedido_id: UUID_A, atitude_id: UUID_B });
  });

  it.each([
    ['campo extra no pedido', { status: 'aceito' }],
    ['campo extra na atitude', { atitude: { ...pedido().atitude, trecho: 'x' } }],
    ['degrau 5', { atitude: { ...pedido().atitude, degrau: 5 } }],
    ['conteudo de 4001 chars', { atitude: { ...pedido().atitude, conteudo: 'c'.repeat(4001) } }],
    ['grave_gatilho fora da lista', { grave_gatilho: 'talvez' }],
    ['origem com reporte e veredicto juntos', { origens: [{ reporte_id: UUID_A, veredicto_id: UUID_B }] }],
    ['origens vazias', { origens: [] }],
    ['origem com id que não é uuid', { origens: [{ reporte_id: 'abc' }] }],
    ['descricao de 1001 chars', { descricao: 'd'.repeat(1001) }],
  ])('recusa antes do banco: %s', async (_nome, over) => {
    const repo = makeRepo();
    const cap = new AgentesPedidoDepositarCapability(asRepo(repo));
    await expect(cap.execute(pedido(over), 'sol-fila')).rejects.toThrow();
    expect(repo.depositarPedido).not.toHaveBeenCalled();
  });
});

describe('agentes.medicao.registrar — formato', () => {
  const medicao = (over: Record<string, unknown> = {}) => ({
    metrica: 'taxa_violacao',
    escopo: 'luz',
    de: '2026-10-01T00:00:00Z',
    ate: '2026-10-08T00:00:00Z',
    valor: 0.12,
    n: 340,
    medido_em: '2026-10-29T10:00:00Z',
    motivo: 'linha_de_base',
    ...over,
  });

  it('linha de base sem pedido_id passa; antes/depois com pedido_id passam', async () => {
    const repo = makeRepo();
    const cap = new AgentesMedicaoRegistrarCapability(asRepo(repo));
    await expect(cap.execute(medicao(), 'sol-fila')).resolves.toEqual({ id: UUID_A });
    await cap.execute(medicao({ motivo: 'antes', pedido_id: UUID_B }), 'sol-fila');
    await cap.execute(medicao({ motivo: 'depois', pedido_id: UUID_B }), 'sol-fila');
    expect(repo.registrarMedicao).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['linha_de_base com pedido_id', { pedido_id: UUID_B }],
    ['antes sem pedido_id', { motivo: 'antes' }],
    ['motivo fora da lista', { motivo: 'durante' }],
    ['de depois de ate', { de: '2026-10-09T00:00:00Z' }],
    ['n negativo', { n: -1 }],
    ['n fracionário', { n: 1.5 }],
    ['valor NaN/Infinity', { valor: Infinity }],
    ['campo extra (texto)', { texto: 'x' }],
    ['metrica com frase', { metrica: 'taxa de violação' }],
    ['pedido_id que não é uuid', { motivo: 'antes', pedido_id: 'abc' }],
  ])('recusa antes do banco: %s', async (_nome, over) => {
    const repo = makeRepo();
    const cap = new AgentesMedicaoRegistrarCapability(asRepo(repo));
    await expect(cap.execute(medicao(over), 'sol-fila')).rejects.toThrow();
    expect(repo.registrarMedicao).not.toHaveBeenCalled();
  });
});
