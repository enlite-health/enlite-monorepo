/**
 * AvisoPedidoService — spec 078 M3b-2 (itens 53, 55, 57). Twilio SEMPRE dublê (`StubAvisoWhatsapp`); o registro é em memória.
 * O e2e `agentes-aviso-078` prova o mesmo contra o banco (UNIQUE/CHECK reais).
 */
import type { PoolClient } from 'pg';
import { StubAvisoWhatsapp } from '../../infrastructure/avisoWhatsapp';
import {
  AvisoPedidoService,
  lerConfigAviso,
  refDoNumero,
  type AvisoConfig,
  type AvisosRegistroPort,
  type LinhaAviso,
} from '../AvisoPedidoService';

const PEDIDO = '123e4567-e89b-12d3-a456-426614174000';
const NUM_A = '+5491100000001';
const NUM_B = '+5491100000002';
const CFG: AvisoConfig = {
  from: '+5491199990000',
  contentSid: 'HXsol_grave',
  destinatarios: [{ uid: 'marcel', numero: NUM_A }, { uid: 'gabriel', numero: NUM_B }],
  linkBase: 'https://app.enlite.test',
  reenvioHoras: 4,
};

class RegistroMemoria implements AvisosRegistroPort {
  linhas: LinhaAviso[] = [];
  graves: string[] = [PEDIDO];
  async registrar(_c: PoolClient, l: LinhaAviso) { this.linhas.push(l); }
  async gravesSemDecisao() { return this.graves; }
  async tentativasTwilio(_c: PoolClient, pedidoId: string) {
    const por = new Map<string, number>();
    for (const l of this.linhas.filter((x) => x.pedidoId === pedidoId && x.canal === 'twilio')) {
      por.set(l.destinatarioRef, Math.max(por.get(l.destinatarioRef) ?? 0, l.tentativa));
    }
    return [...por].map(([destinatarioRef, maxTentativa]) => ({ destinatarioRef, maxTentativa }));
  }
}

function montar(cfg: AvisoConfig = CFG) {
  const whatsapp = new StubAvisoWhatsapp();
  const registro = new RegistroMemoria();
  const inapp = { publishPedidoIa: jest.fn(async () => 'evt') };
  const svc = new AvisoPedidoService({
    decisores: async () => ['marcel', 'gabriel'],
    inapp, whatsapp, registro,
    tx: (fn) => fn({} as PoolClient),
    config: () => cfg,
  });
  return { svc, whatsapp, registro, inapp };
}

const chavesProfundas = (v: unknown): string[] =>
  v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...chavesProfundas(x)]) : [];

describe('AvisoPedidoService — pedido GRAVE (decisão 25)', () => {
  it('grave: 2 in-app (1 GRAVE por decisor, no lugar da NOVO) e 2 WhatsApp (1 por destinatário) — cada envio com 1 linha de auditoria', async () => {
    const { svc, whatsapp, registro, inapp } = montar();
    await svc.naTransacao({} as PoolClient, { pedidoId: PEDIDO, grave: true });
    await svc.whatsappGrave(PEDIDO);

    expect(inapp.publishPedidoIa.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      { typeCode: 'PEDIDO_IA_GRAVE', recipientUids: ['marcel', 'gabriel'] },
    ]);
    expect(whatsapp.calls).toHaveLength(2);
    expect(whatsapp.calls.map((c) => c.to)).toEqual([NUM_A, NUM_B]);
    const twilio = registro.linhas.filter((l) => l.canal === 'twilio');
    expect(twilio).toHaveLength(2);
    expect(twilio.every((l) => l.resultado === 'stub' && l.tentativa === 1 && l.templateRef === 'sol_aviso_grave_v1')).toBe(true);
    expect(registro.linhas.filter((l) => l.canal === 'inapp')).toHaveLength(2); // 1 por decisor
  });

  it('item 53: o dublê recebe SÓ o link — nenhum assunto/descricao/conteudo, nem o número do Sol/destinatário em variável', async () => {
    const { svc, whatsapp } = montar();
    await svc.whatsappGrave(PEDIDO);
    for (const c of whatsapp.calls) {
      expect(Object.keys(c.variables)).toEqual(['1']);
      expect(c.variables['1']).toBe(`https://app.enlite.test/admin/pedidos-ia/${PEDIDO}`);
      expect(c.contentSid).toBe('HXsol_grave');
      expect(c.from).toBe(CFG.from);
      const chaves = chavesProfundas(c);
      for (const proibida of ['assunto', 'descricao', 'conteudo']) expect(chaves).not.toContain(proibida);
    }
  });

  it('a auditoria NUNCA guarda o número: destinatario_ref é o sha256 salgado pelo uid', async () => {
    const { svc, registro } = montar();
    await svc.whatsappGrave(PEDIDO);
    const refs = registro.linhas.map((l) => l.destinatarioRef);
    expect(refs).toEqual([refDoNumero('marcel', NUM_A), refDoNumero('gabriel', NUM_B)]);
    expect(JSON.stringify(registro.linhas)).not.toContain('5491100000');
    expect(refs[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('controle: pedido NÃO grave -> só a notificação NOVO, nenhuma GRAVE (e o WhatsApp nem é pedido)', async () => {
    const { svc, whatsapp, registro, inapp } = montar();
    await svc.naTransacao({} as PoolClient, { pedidoId: PEDIDO, grave: false });
    expect(inapp.publishPedidoIa.mock.calls.map((c: unknown[]) => (c[1] as { typeCode: string }).typeCode)).toEqual(['PEDIDO_IA_NOVO']);
    expect(whatsapp.calls).toHaveLength(0);
    expect(registro.linhas.every((l) => l.canal === 'inapp')).toBe(true);
  });

  it.each([
    ['sem SOL_TWILIO_FROM', { from: null }, 'sem_numero_do_sol'],
    ['sem template', { contentSid: null }, 'sem_template'],
    ['sem link do front', { linkBase: null }, 'sem_link'],
  ] as const)('fail-closed %s: 0 chamadas ao dublê e 2 linhas falha com o motivo', async (_n, over, motivo) => {
    const { svc, whatsapp, registro } = montar({ ...CFG, ...over });
    await svc.whatsappGrave(PEDIDO);
    expect(whatsapp.calls).toHaveLength(0);
    expect(registro.linhas).toHaveLength(2);
    expect(registro.linhas.every((l) => l.resultado === 'falha' && l.motivo === motivo)).toBe(true);
  });

  it('sem destinatário configurado: nada sai e fica 1 linha falha (a trilha existe para o reenvio escalar)', async () => {
    const { svc, whatsapp, registro } = montar({ ...CFG, destinatarios: [] });
    await svc.whatsappGrave(PEDIDO);
    expect(whatsapp.calls).toHaveLength(0);
    expect(registro.linhas).toEqual([expect.objectContaining({ destinatarioRef: 'sem-destinatarios', resultado: 'falha', motivo: 'sem_destinatario' })]);
  });

  it('Twilio recusa: o pedido não se desfaz (não lança), a linha é falha com motivo-slug e o erro não vaza', async () => {
    const { svc, whatsapp, registro } = montar();
    whatsapp.failWith = true;
    await expect(svc.whatsappGrave(PEDIDO)).resolves.toBeUndefined();
    expect(registro.linhas.map((l) => [l.resultado, l.motivo])).toEqual([['falha', 'twilio_recusou'], ['falha', 'twilio_recusou']]);
  });

  it('sem decisores: nada in-app (nunca evento sem destinatário)', async () => {
    const inapp = { publishPedidoIa: jest.fn() };
    const svc = new AvisoPedidoService({ decisores: async () => [], inapp, whatsapp: new StubAvisoWhatsapp(), registro: new RegistroMemoria(), tx: (f) => f({} as PoolClient), config: () => CFG });
    expect(await svc.naTransacao({} as PoolClient, { pedidoId: PEDIDO, grave: true })).toEqual({ inapp: 0 });
    expect(inapp.publishPedidoIa).not.toHaveBeenCalled();
  });
});

describe('AvisoPedidoService — reenvio único (item 57)', () => {
  it('1 tentativa por destinatário -> tentativa 2 (2 envios); chamado de novo -> 0 reenvios e o pedido vai para `escalar` (NUNCA 3ª tentativa)', async () => {
    const { svc, whatsapp, registro } = montar();
    await svc.whatsappGrave(PEDIDO);
    expect(whatsapp.calls).toHaveLength(2);

    const r1 = await svc.reenviar(new Date('2026-10-30T12:00:00Z'));
    expect(r1).toEqual({ reenviados: 2, escalar: [] });
    expect(whatsapp.calls).toHaveLength(4);
    expect(registro.linhas.filter((l) => l.canal === 'twilio' && l.tentativa === 2)).toHaveLength(2);

    const r2 = await svc.reenviar(new Date('2026-10-30T13:00:00Z'));
    expect(r2).toEqual({ reenviados: 0, escalar: [{ pedido_id: PEDIDO }] });
    const r3 = await svc.reenviar(new Date('2026-10-31T13:00:00Z'));
    expect(r3.reenviados).toBe(0);
    expect(whatsapp.calls).toHaveLength(4); // nunca 2 reenvios
    expect(Math.max(...registro.linhas.map((l) => l.tentativa))).toBe(2);
  });

  it('o relógio injetado e o N configurado chegam à consulta de pedidos sem decisão', async () => {
    const { svc, registro } = montar({ ...CFG, reenvioHoras: 7 });
    const spy = jest.spyOn(registro, 'gravesSemDecisao');
    const agora = new Date('2026-10-30T12:00:00Z');
    await svc.reenviar(agora);
    expect(spy).toHaveBeenCalledWith(expect.anything(), agora, 7);
  });

  it('pedido grave sem NENHUMA tentativa registrada (queda entre o commit e o envio) vai para `escalar`, sem envio', async () => {
    const { svc, whatsapp } = montar();
    expect(await svc.reenviar()).toEqual({ reenviados: 0, escalar: [{ pedido_id: PEDIDO }] });
    expect(whatsapp.calls).toHaveLength(0);
  });

  it('destinatário que saiu da configuração: a tentativa 2 existe como falha (não some, não envia)', async () => {
    const { svc, whatsapp, registro } = montar();
    await svc.whatsappGrave(PEDIDO);
    const sem = montar({ ...CFG, destinatarios: [CFG.destinatarios[0]] });
    sem.registro.linhas = [...registro.linhas];
    const r = await sem.svc.reenviar();
    expect(r.reenviados).toBe(2);
    expect(sem.whatsapp.calls).toHaveLength(1);
    expect(sem.registro.linhas.filter((l) => l.tentativa === 2 && l.motivo === 'destinatario_fora_da_config')).toHaveLength(1);
    expect(whatsapp.calls).toHaveLength(2);
  });
});

describe('lerConfigAviso', () => {
  it('lista uid:numero, N padrão 4, barra final do link removida; lixo é ignorado', () => {
    const c = lerConfigAviso({
      SOL_AVISO_GRAVE_DESTINATARIOS: ' marcel:+5491100000001 , gabriel:+5491100000002,sem-dois-pontos,:vazio ',
      FRONTEND_URL: 'https://app.enlite.test/', SOL_TWILIO_FROM: '+5491199990000',
    } as never);
    expect(c.destinatarios).toEqual([{ uid: 'marcel', numero: '+5491100000001' }, { uid: 'gabriel', numero: '+5491100000002' }]);
    expect(c.linkBase).toBe('https://app.enlite.test');
    expect(c.reenvioHoras).toBe(4);
    expect(c.contentSid).toBeNull();
  });
  it('SOL_AVISO_GRAVE_REENVIO_HORAS válido vale; inválido volta ao padrão', () => {
    expect(lerConfigAviso({ SOL_AVISO_GRAVE_REENVIO_HORAS: '6' } as never).reenvioHoras).toBe(6);
    expect(lerConfigAviso({ SOL_AVISO_GRAVE_REENVIO_HORAS: 'x' } as never).reenvioHoras).toBe(4);
    expect(lerConfigAviso({ SOL_AVISO_GRAVE_REENVIO_HORAS: '0' } as never).reenvioHoras).toBe(4);
  });
});
