import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

/**
 * Aviso do pedido do Sol (spec 078, M3b-2, decisão 25 / itens 53, 55, 57).
 *
 *  - TODO pedido depositado: UMA notificação in-app por decisor, na MESMA transação do depósito: `PEDIDO_IA_NOVO`, ou `PEDIDO_IA_GRAVE`
 *    quando o pedido é grave (a GRAVE substitui a NOVA).
 *  - Pedido GRAVE (`grave_gatilho <> 'nenhum'`): além da in-app, 1 WhatsApp por destinatário da lista fechada
 *    (`SOL_AVISO_GRAVE_DESTINATARIOS`), pelo número do Sol (`SOL_TWILIO_FROM`), com template fixo aprovado pela Meta
 *    (`SOL_TWILIO_CONTENT_SID_GRAVE`). A ÚNICA variável do template é o link da página. Nenhum assunto/descrição/conteúdo
 *    passa por aqui: a assinatura de `naTransacao`/`whatsappGrave` só recebe o ID do pedido.
 *  - Fail-closed: sem número do Sol, sem template ou sem link, NADA sai; a falha é gravada em `agentes.avisos_enviados`.
 *  - Falha do WhatsApp nunca desfaz o pedido (o WhatsApp sai DEPOIS do commit). Uma linha de auditoria por envio.
 *  - Reenvio único (item 57): pedido grave sem decisão há >= N horas e com exatamente 1 tentativa por destinatário -> tentativa 2.
 *    Com 2 tentativas NÃO reenvia: devolve o pedido em `escalar` (canal humano; nada automático).
 */

export const TEMPLATE_REF_GRAVE = 'sol_aviso_grave_v1';
export const TEMPLATE_REF_NOVO = 'PEDIDO_IA_NOVO';
const SEM_DESTINATARIO_REF = 'sem-destinatarios';
const REENVIO_HORAS_PADRAO = 4;

export interface AvisoConfig {
  /** Número do Sol (remetente do WhatsApp). Ausente = não envia. */
  from: string | null;
  contentSid: string | null;
  destinatarios: ReadonlyArray<{ uid: string; numero: string }>;
  /** Base do front (sem barra final). Ausente = não envia (o aviso sem link não serve a ninguém). */
  linkBase: string | null;
  reenvioHoras: number;
}

/** Lê a configuração do ambiente. NUNCA loga: `SOL_AVISO_GRAVE_DESTINATARIOS` contém números (vêm do Secret Manager em prd). */
export function lerConfigAviso(env: NodeJS.ProcessEnv = process.env): AvisoConfig {
  const destinatarios = (env.SOL_AVISO_GRAVE_DESTINATARIOS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((par) => {
      const i = par.indexOf(':');
      const uid = i > 0 ? par.slice(0, i).trim() : '';
      const numero = i > 0 ? par.slice(i + 1).trim() : '';
      return uid && numero ? [{ uid, numero }] : [];
    });
  const horas = Number(env.SOL_AVISO_GRAVE_REENVIO_HORAS);
  return {
    from: env.SOL_TWILIO_FROM?.trim() || null,
    contentSid: env.SOL_TWILIO_CONTENT_SID_GRAVE?.trim() || null,
    destinatarios,
    linkBase: env.FRONTEND_URL?.trim().replace(/\/+$/, '') || null,
    reenvioHoras: Number.isFinite(horas) && horas > 0 ? horas : REENVIO_HORAS_PADRAO,
  };
}

/** `stub: true` = dublê (nada saiu da máquina). */
export type EnvioWhatsapp = { ok: true; stub: boolean } | { ok: false };

export interface AvisoWhatsappPort {
  enviar(i: { to: string; from: string; contentSid: string; variables: Record<string, string> }): Promise<EnvioWhatsapp>;
}

export interface LinhaAviso {
  pedidoId: string;
  canal: 'inapp' | 'twilio';
  destinatarioRef: string;
  tentativa: 1 | 2;
  templateRef: string;
  resultado: 'ok' | 'falha' | 'stub';
  motivo?: string;
}

export interface AvisosRegistroPort {
  registrar(c: PoolClient, l: LinhaAviso): Promise<void>;
  /** Pedidos graves, sem nenhum evento de decisão, criados há >= `horas` em relação a `agora`. */
  gravesSemDecisao(c: PoolClient, agora: Date, horas: number): Promise<string[]>;
  /** Maior tentativa Twilio já gravada por destinatário (resultado qualquer: a falha também é tentativa). */
  tentativasTwilio(c: PoolClient, pedidoId: string): Promise<Array<{ destinatarioRef: string; maxTentativa: number }>>;
}

export interface AvisoPedidoDeps {
  /** uids de quem decide pedidos (célula `pedidos_ia:decidir` ou Acesso Master). */
  decisores: (c: PoolClient) => Promise<string[]>;
  inapp: { publishPedidoIa(c: PoolClient, i: { typeCode: 'PEDIDO_IA_NOVO' | 'PEDIDO_IA_GRAVE'; recipientUids: readonly string[] }): Promise<string | null> };
  whatsapp: AvisoWhatsappPort;
  registro: AvisosRegistroPort;
  /** Abre a transação (produção: `withActorContext` com o ator `system:mcp:sol-fila`). */
  tx: <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>;
  config: () => AvisoConfig;
  /** Falha engolida de propósito (o pedido não se desfaz): quem monta decide onde reportar. Sem número, sem texto. */
  onErro?: (err: unknown, fonte: string) => void;
}

/** O número nunca vai para o banco: sha256 de `uid:numero` (o uid é o sal; número sozinho seria enumerável por força bruta). */
export const refDoNumero = (uid: string, numero: string): string => createHash('sha256').update(`${uid}:${numero}`).digest('hex');

export class AvisoPedidoService {
  constructor(private readonly d: AvisoPedidoDeps) {}

  /** Dentro da transação do depósito: notificação in-app aos decisores (+ a GRAVE se for o caso) e 1 linha de auditoria por decisor. */
  async naTransacao(c: PoolClient, i: { pedidoId: string; grave: boolean }): Promise<{ inapp: number }> {
    const uids = await this.d.decisores(c);
    if (uids.length === 0) return { inapp: 0 };
    // UMA notificação por decisor: a GRAVE substitui a NOVA (duas entradas do mesmo pedido no sino seriam ruído).
    const typeCode = i.grave ? 'PEDIDO_IA_GRAVE' : 'PEDIDO_IA_NOVO';
    await this.d.inapp.publishPedidoIa(c, { typeCode, recipientUids: uids });
    for (const uid of uids) {
      await this.d.registro.registrar(c, {
        pedidoId: i.pedidoId, canal: 'inapp', destinatarioRef: uid, tentativa: 1, templateRef: typeCode, resultado: 'ok',
      });
    }
    return { inapp: uids.length };
  }

  /** Depois do commit do depósito: a tentativa 1 do WhatsApp. Nunca lança (o pedido já existe). */
  async whatsappGrave(pedidoId: string): Promise<void> {
    try {
      await this.enviarRodada(pedidoId, 1, null);
    } catch (err) {
      this.d.onErro?.(err, 'AvisoPedidoService:whatsappGrave');
    }
  }

  /** Item 57. `agora` injetável (teste); em produção, o relógio. */
  async reenviar(agora: Date = new Date()): Promise<{ reenviados: number; escalar: Array<{ pedido_id: string }> }> {
    const cfg = this.d.config();
    const ids = await this.d.tx((c) => this.d.registro.gravesSemDecisao(c, agora, cfg.reenvioHoras));
    let reenviados = 0;
    const escalar: Array<{ pedido_id: string }> = [];
    for (const pedidoId of ids) {
      const tentativas = await this.d.tx((c) => this.d.registro.tentativasTwilio(c, pedidoId));
      // Nunca houve envio registrado (crash entre o commit e o envio): ninguém foi avisado, o canal humano precisa saber.
      if (tentativas.length === 0) { escalar.push({ pedido_id: pedidoId }); continue; }
      const aReenviar = tentativas.filter((t) => t.maxTentativa === 1).map((t) => t.destinatarioRef);
      if (aReenviar.length > 0) reenviados += await this.enviarRodada(pedidoId, 2, new Set(aReenviar));
      if (tentativas.some((t) => t.maxTentativa >= 2)) escalar.push({ pedido_id: pedidoId });
    }
    return { reenviados, escalar };
  }

  /** Uma rodada de WhatsApp: envia a cada destinatário (ou só aos `apenasRefs`) e grava UMA linha por envio. Devolve quantas linhas. */
  private async enviarRodada(pedidoId: string, tentativa: 1 | 2, apenasRefs: Set<string> | null): Promise<number> {
    const cfg = this.d.config();
    const alvos = cfg.destinatarios.length > 0
      ? cfg.destinatarios.map((x) => ({ ref: refDoNumero(x.uid, x.numero), numero: x.numero as string | null }))
      : [{ ref: SEM_DESTINATARIO_REF, numero: null }];
    // Ref gravado e já ausente da configuração (número removido): a tentativa 2 existe, como falha, e não some em silêncio.
    const conhecidos = new Set(alvos.map((a) => a.ref));
    for (const r of apenasRefs ?? []) if (!conhecidos.has(r)) alvos.push({ ref: r, numero: null });

    const linhas: LinhaAviso[] = [];
    for (const a of alvos) {
      if (apenasRefs && !apenasRefs.has(a.ref)) continue;
      linhas.push(await this.enviarUm(pedidoId, a.ref, a.numero, tentativa, cfg));
    }
    if (linhas.length > 0) {
      await this.d.tx(async (c) => { for (const l of linhas) await this.d.registro.registrar(c, l); });
    }
    return linhas.length;
  }

  private async enviarUm(pedidoId: string, ref: string, numero: string | null, tentativa: 1 | 2, cfg: AvisoConfig): Promise<LinhaAviso> {
    const base = { pedidoId, canal: 'twilio' as const, destinatarioRef: ref, tentativa, templateRef: TEMPLATE_REF_GRAVE };
    const falha = (motivo: string): LinhaAviso => ({ ...base, resultado: 'falha', motivo });
    if (numero === null) return falha(ref === SEM_DESTINATARIO_REF ? 'sem_destinatario' : 'destinatario_fora_da_config');
    if (!cfg.from) return falha('sem_numero_do_sol');
    if (!cfg.contentSid) return falha('sem_template');
    if (!cfg.linkBase) return falha('sem_link');
    try {
      // A ÚNICA variável do template é o link (posicional "1" na Content API). Nenhum campo do pedido entra aqui.
      const r = await this.d.whatsapp.enviar({
        to: numero, from: cfg.from, contentSid: cfg.contentSid,
        variables: { '1': `${cfg.linkBase}/admin/pedidos-ia/${pedidoId}` },
      });
      return r.ok ? { ...base, resultado: r.stub ? 'stub' : 'ok' } : falha('twilio_recusou');
    } catch (err) {
      this.d.onErro?.(err, 'AvisoPedidoService:enviarUm');
      return falha('twilio_recusou');
    }
  }
}
