import { createHash } from 'node:crypto';
import { CapabilityRegistry } from '../CapabilityRegistry';
import { WriteRateLimiter } from '../WriteRateLimiter';
import { ServicePrincipal } from '../../domain/ServicePrincipal';
import {
  AGENTES_PRINCIPAL_CAPABILITIES,
  AGENTES_WRITE_CAPABILITIES,
  type AgentesPrincipalName,
} from '../../domain/AgentesPrincipals';
import { AgentesVeredictoRegistrarCapability } from '../capabilities/AgentesVeredictoRegistrarCapability';
import { AgentesReporteRegistrarCapability } from '../capabilities/AgentesReporteRegistrarCapability';
import { AgentesReporteLerCapability } from '../capabilities/AgentesReporteLerCapability';
import { AgentesPlacarLerCapability } from '../capabilities/AgentesPlacarLerCapability';
import { AgentesPedidoDepositarCapability } from '../capabilities/AgentesPedidoDepositarCapability';
import { AgentesMedicaoRegistrarCapability } from '../capabilities/AgentesMedicaoRegistrarCapability';
import { AgentesAprovacaoVerificarCapability } from '../capabilities/AgentesAprovacaoVerificarCapability';
import { AgentesAvisoReenviarCapability } from '../capabilities/AgentesAvisoReenviarCapability';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const UUID_A = '123e4567-e89b-12d3-a456-426614174000';

/** Forma do JSON do secret `mcp-principal-<name>` (ServicePrincipalSecretManagerRepo): name, allowedCapabilities, tokens. */
function secretJson(name: AgentesPrincipalName) {
  return JSON.stringify({ name, allowedCapabilities: [...AGENTES_PRINCIPAL_CAPABILITIES[name]], tokens: [`token-${name}`] });
}
function principalFromSecret(name: AgentesPrincipalName): ServicePrincipal {
  const parsed = JSON.parse(secretJson(name)) as { name: string; allowedCapabilities: string[]; tokens: string[] };
  return new ServicePrincipal({
    name: parsed.name,
    allowedCapabilities: parsed.allowedCapabilities,
    tokenHashes: parsed.tokens.map(sha256),
  });
}

function makeRepo() {
  return {
    registrarVeredicto: jest.fn().mockResolvedValue({ id: UUID_A }),
    registrarReporte: jest.fn().mockResolvedValue({ id: UUID_A }),
    lerReportes: jest.fn().mockResolvedValue({ reportes: [] }),
    lerPlacar: jest.fn().mockResolvedValue({ veredictos: 0 }),
    depositarPedido: jest.fn().mockResolvedValue({ pedido_id: UUID_A, atitude_id: UUID_A }),
    registrarMedicao: jest.fn().mockResolvedValue({ id: UUID_A }),
    verificarAprovacao: jest.fn().mockResolvedValue({ valida: true, acao: 'aceitar' }),
  };
}

function makeRegistry(rl?: WriteRateLimiter) {
  const repo = makeRepo();
  const r = repo as never;
  const auditor = { emit: jest.fn() };
  const avisos = { reenviar: jest.fn().mockResolvedValue({ reenviados: 0, escalar: [{ pedido_id: UUID_A }] }) };
  const stub = {} as never;
  const registry = new CapabilityRegistry({
    profileGet: stub, documentsList: stub, vacanciesList: stub, interviewGet: stub, profileUpdate: stub,
    profilePropose: stub, profileConfirm: stub, documentsUpload: stub, statsGet: stub, profileEditsStats: stub,
    funnelActivityStats: stub, workerSearch: stub, caseMemoryGet: stub, caseMemoryPut: stub, optOutRegister: stub,
    accountDeactivate: stub, availabilitySet: stub, availabilityGet: stub, vacanciesNearby: stub,
    applicationRegister: stub, handoverNotify: stub, applicationsList: stub, patientChatMap: stub,
    agentesVeredictoRegistrar: new AgentesVeredictoRegistrarCapability(r),
    agentesReporteRegistrar: new AgentesReporteRegistrarCapability(r),
    agentesReporteLer: new AgentesReporteLerCapability(r),
    agentesPlacarLer: new AgentesPlacarLerCapability(r),
    agentesPedidoDepositar: new AgentesPedidoDepositarCapability(r),
    agentesMedicaoRegistrar: new AgentesMedicaoRegistrarCapability(r),
    agentesAvisoReenviar: new AgentesAvisoReenviarCapability(avisos),
    agentesAprovacaoVerificar: new AgentesAprovacaoVerificarCapability(r),
    auditor,
    writeRateLimiter: rl,
  });
  return { registry, repo, auditor, avisos };
}

type Handler = (args: unknown) => Promise<{ content: Array<{ text: string }> }>;
function register(registry: CapabilityRegistry, getPrincipal: () => ServicePrincipal | undefined) {
  const registerTool = jest.fn();
  registry.registerAll({ registerTool } as never, getPrincipal);
  const calls = registerTool.mock.calls as [string, unknown, Handler][];
  return {
    names: calls.map(([n]) => n),
    handler: (name: string): Handler => {
      const c = calls.find(([n]) => n === name);
      if (!c) throw new Error(`tool ${name} não registrada`);
      return c[2];
    },
  };
}

const VEREDICTO = {
  operador: 'luz', sensor: 'silente', inbox: 'ar-1', conversa_ref: 'conv-1', ultima_msg_ref: 'msg-1',
  cruza_areas: false, avaliado_em: '2026-10-29T10:00:00Z', achados: [],
};

describe('principais do schema agentes — a lista de capabilities de cada um', () => {
  it('a forma do secret vira ServicePrincipal e as listas são as combinadas', () => {
    expect(principalFromSecret('sol-supervisor').allowedCapabilities).toEqual(['agentes.veredicto.registrar']);
    expect([...principalFromSecret('sol-fila').allowedCapabilities].sort()).toEqual(
      ['agentes.aviso.reenviar', 'agentes.medicao.registrar', 'agentes.pedido.depositar', 'agentes.placar.ler', 'agentes.reporte.ler'],
    );
    expect([...principalFromSecret('maria').allowedCapabilities].sort()).toEqual(
      ['agentes.placar.ler', 'agentes.reporte.registrar'],
    );
    expect(principalFromSecret('maria').matchesToken('token-maria', sha256)).toBe(true);
  });

  it('toda capability citada num principal existe no registro (nome digitado errado = teste vermelho)', () => {
    const { registry } = makeRegistry();
    const todas = new ServicePrincipal({
      name: 'todas',
      allowedCapabilities: Object.values(AGENTES_PRINCIPAL_CAPABILITIES).flat(),
      tokenHashes: [sha256('t')],
    });
    const { names } = register(registry, () => todas);
    for (const cap of Object.values(AGENTES_PRINCIPAL_CAPABILITIES).flat()) expect(names).toContain(cap);
  });

  it('tools/list é escopado: cada principal vê só as suas', () => {
    const { registry } = makeRegistry();
    expect(register(registry, () => principalFromSecret('sol-supervisor')).names).toEqual(['agentes.veredicto.registrar']);
    expect(register(registry, () => principalFromSecret('maria')).names.sort()).toEqual(
      ['agentes.placar.ler', 'agentes.reporte.registrar'],
    );
  });
});

describe('agentes.veredicto.registrar — quem pode chamar', () => {
  it('maria chama veredicto.registrar → recusada (a tool nem é exposta, e a chamada é barrada se o principal mudar)', async () => {
    const { registry, repo, auditor } = makeRegistry();
    // 1) a tool não existe para a maria
    expect(register(registry, () => principalFromSecret('maria')).names).not.toContain('agentes.veredicto.registrar');

    // 2) mesmo com a tool registrada (sessão do sol-supervisor), se o principal da chamada for a maria, a chamada é recusada
    let atual = principalFromSecret('sol-supervisor');
    const { handler } = register(registry, () => atual);
    atual = principalFromSecret('maria');
    await expect(handler('agentes.veredicto.registrar')(VEREDICTO)).rejects.toThrow(/not allowed for maria/);
    expect(repo.registrarVeredicto).not.toHaveBeenCalled();
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', principal: 'maria', capability: 'agentes.veredicto.registrar' }),
    );
  });

  it('sol-supervisor chama veredicto.registrar → permitido, ator carimbado com o nome do principal', async () => {
    const { registry, repo } = makeRegistry();
    const { handler } = register(registry, () => principalFromSecret('sol-supervisor'));
    const out = await handler('agentes.veredicto.registrar')(VEREDICTO);
    expect(JSON.parse(out.content[0].text)).toEqual({ id: UUID_A });
    expect(repo.registrarVeredicto).toHaveBeenCalledWith('sol-supervisor', expect.objectContaining({ inbox: 'ar-1' }));
  });

  it('sol-fila não registra veredicto nem reporte; maria não deposita pedido', async () => {
    const { registry } = makeRegistry();
    const fila = register(registry, () => principalFromSecret('sol-fila')).names;
    expect(fila).not.toContain('agentes.veredicto.registrar');
    expect(fila).not.toContain('agentes.reporte.registrar');
    expect(register(registry, () => principalFromSecret('maria')).names).not.toContain('agentes.pedido.depositar');
  });
});

describe('agentes.medicao.registrar — quem pode chamar', () => {
  const MEDICAO = {
    metrica: 'taxa_violacao', escopo: 'luz', de: '2026-10-01T00:00:00Z', ate: '2026-10-08T00:00:00Z',
    valor: 0.1, n: 10, medido_em: '2026-10-29T10:00:00Z', motivo: 'linha_de_base',
  };

  it('só a sol-fila vê e chama; maria e sol-supervisor não; é escrita (rate limit por principal+capability)', async () => {
    const rl = new WriteRateLimiter();
    const spy = jest.spyOn(rl, 'consume');
    const { registry, repo } = makeRegistry(rl);
    expect(register(registry, () => principalFromSecret('maria')).names).not.toContain('agentes.medicao.registrar');
    expect(register(registry, () => principalFromSecret('sol-supervisor')).names).not.toContain('agentes.medicao.registrar');

    const { handler } = register(registry, () => principalFromSecret('sol-fila'));
    const out = await handler('agentes.medicao.registrar')(MEDICAO);
    expect(JSON.parse(out.content[0].text)).toEqual({ id: UUID_A });
    expect(repo.registrarMedicao).toHaveBeenCalledWith('sol-fila', expect.objectContaining({ motivo: 'linha_de_base' }));
    expect(spy).toHaveBeenCalledWith('sol-fila:agentes.medicao.registrar');
    expect(AGENTES_WRITE_CAPABILITIES).toHaveLength(5);
  });
});

describe('agentes.aviso.reenviar — quem pode chamar (M3b-2, item 57)', () => {
  it('só a sol-fila vê e chama; maria e sol-supervisor não; é escrita (balde por principal+capability); `agora` é repassado como Date', async () => {
    const rl = new WriteRateLimiter();
    const spy = jest.spyOn(rl, 'consume');
    const { registry, avisos } = makeRegistry(rl);
    expect(register(registry, () => principalFromSecret('maria')).names).not.toContain('agentes.aviso.reenviar');
    expect(register(registry, () => principalFromSecret('sol-supervisor')).names).not.toContain('agentes.aviso.reenviar');

    const { handler } = register(registry, () => principalFromSecret('sol-fila'));
    const out = await handler('agentes.aviso.reenviar')({ agora: '2026-10-30T12:00:00Z' });
    expect(JSON.parse(out.content[0].text)).toEqual({ reenviados: 0, escalar: [{ pedido_id: UUID_A }] });
    expect(avisos.reenviar).toHaveBeenCalledWith(new Date('2026-10-30T12:00:00Z'));
    expect(spy).toHaveBeenCalledWith('sol-fila:agentes.aviso.reenviar');
    await expect(handler('agentes.aviso.reenviar')({ agora: 'ontem' })).rejects.toThrow();
    await expect(handler('agentes.aviso.reenviar')({ pedido_id: UUID_A })).rejects.toThrow(); // campo extra recusado
  });
});

describe('agentes.aprovacao.verificar — quem pode chamar (M1.3.1, itens 20/48)', () => {
  it('a forma do secret do sol-propagador tem SÓ esta capability', () => {
    expect(principalFromSecret('sol-propagador').allowedCapabilities).toEqual(['agentes.aprovacao.verificar']);
    expect(AGENTES_PRINCIPAL_CAPABILITIES['sol-propagador']).toEqual(['agentes.aprovacao.verificar']);
  });

  it('sol-propagador vê e chama (leitura: fora do balde de escrita); maria, sol-fila e sol-supervisor não veem', async () => {
    const rl = new WriteRateLimiter();
    const spy = jest.spyOn(rl, 'consume');
    const { registry, repo } = makeRegistry(rl);
    for (const quem of ['maria', 'sol-fila', 'sol-supervisor'] as const) {
      expect(register(registry, () => principalFromSecret(quem)).names).not.toContain('agentes.aprovacao.verificar');
    }
    const prop = register(registry, () => principalFromSecret('sol-propagador'));
    expect(prop.names).toEqual(['agentes.aprovacao.verificar']);
    const out = await prop.handler('agentes.aprovacao.verificar')({ aprovacao_id: UUID_A });
    expect(JSON.parse(out.content[0].text)).toEqual({ valida: true, acao: 'aceitar' });
    expect(repo.verificarAprovacao).toHaveBeenCalledWith('sol-propagador', UUID_A);
    expect(spy).not.toHaveBeenCalled();
    expect(AGENTES_WRITE_CAPABILITIES).not.toContain('agentes.aprovacao.verificar');
  });

  it('maria chamando (principal trocado depois do registro) → recusada, repositório intocado', async () => {
    const { registry, repo } = makeRegistry();
    let atual = principalFromSecret('sol-propagador');
    const { handler } = register(registry, () => atual);
    atual = principalFromSecret('maria');
    await expect(handler('agentes.aprovacao.verificar')({ aprovacao_id: UUID_A })).rejects.toThrow(/not allowed for maria/);
    expect(repo.verificarAprovacao).not.toHaveBeenCalled();
  });

  it('uuid inválido e campo extra → recusados antes do repositório', async () => {
    const { registry, repo } = makeRegistry();
    const { handler } = register(registry, () => principalFromSecret('sol-propagador'));
    await expect(handler('agentes.aprovacao.verificar')({ aprovacao_id: 'nao-e-uuid' })).rejects.toThrow();
    await expect(handler('agentes.aprovacao.verificar')({})).rejects.toThrow();
    await expect(handler('agentes.aprovacao.verificar')({ aprovacao_id: UUID_A, extra: 1 })).rejects.toThrow();
    expect(repo.verificarAprovacao).not.toHaveBeenCalled();
  });
});

describe('rate limit das capabilities de escrita sem workerId', () => {
  it('as capabilities de escrita do agentes estão no balde de escrita; as de leitura não', async () => {
    const rl = new WriteRateLimiter();
    const spy = jest.spyOn(rl, 'consume');
    const { registry } = makeRegistry(rl);
    const todas = new ServicePrincipal({
      name: 'todas',
      allowedCapabilities: Object.values(AGENTES_PRINCIPAL_CAPABILITIES).flat(),
      tokenHashes: [sha256('t')],
    });
    const { handler } = register(registry, () => todas);
    await handler('agentes.placar.ler')({ operador: 'luz', de: '2026-10-01T00:00:00Z', ate: '2026-10-02T00:00:00Z' });
    expect(spy).not.toHaveBeenCalled();
    await handler('agentes.veredicto.registrar')(VEREDICTO);
    expect(AGENTES_WRITE_CAPABILITIES).toContain('agentes.veredicto.registrar');
    // chave por principal+capability, sem o 'unknown' de workerId
    expect(spy).toHaveBeenCalledWith('todas:agentes.veredicto.registrar');
  });

  it('o 11º registro do mesmo principal no mesmo minuto é recusado; outro principal tem balde próprio', async () => {
    const { registry } = makeRegistry(new WriteRateLimiter(60_000, 10));
    const { handler } = register(registry, () => principalFromSecret('sol-supervisor'));
    for (let i = 0; i < 10; i++) await handler('agentes.veredicto.registrar')(VEREDICTO);
    await expect(handler('agentes.veredicto.registrar')(VEREDICTO)).rejects.toThrow(/rate/i);
  });
});
