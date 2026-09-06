import { logger } from '@shared/logging';

/**
 * TwilioContentWriter — o único lugar do sistema que ESCREVE na Twilio.
 *
 * 🔒 REGISTRO: o parecer do `lex` NÃO foi emitido para esta escrita. A regra do
 * CLAUDE.md exige o parecer antes de implementar ação que sai do perímetro; o
 * Gabriel determinou explicitamente construir sem ele em 31/08/2026. Está
 * escrito aqui, e não só no PR, porque o código é o que sobrevive.
 *
 * 🔒 TRÊS TRAVAS, e nenhuma delas é redundante:
 *
 *  1. `TEMPLATE_SUBMISSION_ENABLED` precisa valer exatamente 'true'. Neste repo
 *     **merge = deploy**: sem a flag, mergear este PR ligaria a capacidade de
 *     escrever na Meta sem ninguém decidir isso. A flag existe para que ligar
 *     seja um ato separado do deploy.
 *  2. As credenciais precisam existir. Faltando, o chamador recebe erro
 *     EXPLÍCITO — nunca um no-op silencioso, que faria a tela dizer "enviado"
 *     sem nada ter saído.
 *  3. `configured` é consultado ANTES de qualquer chamada, e o controller
 *     devolve 503 quando é falso. A ausência de configuração é uma resposta,
 *     não um erro de sistema.
 *
 * ⚠️ O que a Twilio faz e a Meta desfaz: criar o Content é reversível (dá para
 * apagar); submeter para aprovação NÃO é — o nome do template fica queimado na
 * WABA mesmo se recusado. Por isso os dois passos são separados aqui, e o
 * segundo só corre depois do primeiro ter dado certo.
 */
const TWILIO_BASE = 'https://content.twilio.com';

export interface ConteudoParaCriar {
  friendlyName: string;
  language: string;
  body: string;
  /** Nomes das variáveis, na ordem: {{1}} vira variables['1']. */
  variaveis: string[];
}

export interface ContentCriado {
  sid: string;
}

export interface ResultadoSubmissao {
  contentSid: string;
  name: string;
  category: string;
}

export class TwilioSubmissionDisabledError extends Error {
  constructor(readonly motivo: 'flag_desligada' | 'sem_credencial') {
    super(`Submissão indisponível: ${motivo}`);
    this.name = 'TwilioSubmissionDisabledError';
  }
}

export class TwilioContentWriter {
  private readonly authHeader: string | null;
  private readonly flagLigada: boolean;

  constructor(
    accountSid: string | undefined = process.env.TWILIO_ACCOUNT_SID,
    authToken: string | undefined = process.env.TWILIO_AUTH_TOKEN,
    flag: string | undefined = process.env.TEMPLATE_SUBMISSION_ENABLED,
  ) {
    this.authHeader = accountSid && authToken
      ? `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`
      : null;
    // Comparação estrita com 'true': 'TRUE', '1' e 'yes' NÃO ligam. Flag que
    // aceita variação vira flag que alguém liga sem querer.
    this.flagLigada = flag === 'true';
  }

  /** Por que não está disponível — ou `null` quando está. */
  get indisponivel(): 'flag_desligada' | 'sem_credencial' | null {
    if (!this.flagLigada) return 'flag_desligada';
    if (!this.authHeader) return 'sem_credencial';
    return null;
  }

  get configured(): boolean {
    return this.indisponivel === null;
  }

  private assertDisponivel(): string {
    const motivo = this.indisponivel;
    if (motivo) throw new TwilioSubmissionDisabledError(motivo);
    return this.authHeader as string;
  }

  /**
   * Cria o Content na Twilio. REVERSÍVEL — ainda não foi para a Meta.
   *
   * As variáveis viram `{"1": "nome"}`: a Twilio numera por posição, e é dessa
   * numeração que sai o `{{1}}` que a cuidadora recebe.
   */
  async criarContent(c: ConteudoParaCriar): Promise<ContentCriado> {
    const auth = this.assertDisponivel();
    const variables: Record<string, string> = {};
    c.variaveis.forEach((nome, i) => { variables[String(i + 1)] = nome; });

    const res = await fetch(`${TWILIO_BASE}/v1/Content`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        friendly_name: c.friendlyName,
        language: c.language,
        variables,
        types: { 'twilio/text': { body: c.body } },
      }),
    });

    if (!res.ok) {
      const texto = await res.text().catch(() => '');
      throw new Error(`Twilio ${res.status} ao criar Content: ${texto}`);
    }
    const json = (await res.json()) as { sid?: string };
    if (!json.sid) {
      // Resposta 200 sem SID é pior que erro: o Content pode ter sido criado e
      // nós ficaríamos sem a chave para achá-lo. Falhar alto é o certo.
      throw new Error('Twilio devolveu 200 sem `sid` ao criar Content');
    }
    logger.info({ msg: 'twilio_content_criado', contentSid: json.sid });
    return { sid: json.sid };
  }

  /**
   * Submete à Meta, via Twilio. ⚠️ IRREVERSÍVEL: o nome fica queimado na WABA.
   */
  async submeterParaAprovacao(contentSid: string, name: string, category: string): Promise<ResultadoSubmissao> {
    const auth = this.assertDisponivel();
    const res = await fetch(`${TWILIO_BASE}/v1/Content/${contentSid}/ApprovalRequests/whatsapp`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, category }),
    });

    if (!res.ok) {
      const texto = await res.text().catch(() => '');
      throw new Error(`Twilio ${res.status} ao submeter à Meta: ${texto}`);
    }
    logger.info({ msg: 'twilio_template_submetido', contentSid, name, category });
    return { contentSid, name, category };
  }
}
