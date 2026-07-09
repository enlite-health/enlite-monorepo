import axios, { AxiosInstance } from 'axios';
import { IMessagingService, MessageSentResult, SendWhatsAppOptions } from '../domain/IMessagingService';
import { Result } from '@shared/utils/Result';
import { MessageTemplate } from '../domain/MessageTemplate';
import { renderNumberedOptions } from '../domain/numberedButtonOptions';
import { MessageTemplateRepository } from './MessageTemplateRepository';

/**
 * Envio de WhatsApp via Periskope (https://docs.periskope.app).
 *
 * Diferenças estruturais em relação ao canal Twilio/WABA:
 *   - Não há templates aprovados nem janela de 24h: todo envio é texto livre.
 *     O body do template (message_templates) é interpolado e enviado como está.
 *   - Não há botões interativos (quick-reply): templates com buttons são
 *     renderizados como opções numeradas no fim do texto, e o worker responde
 *     digitando o número/texto (roteado pelo PeriskopeWebhookController).
 *   - O envio é assíncrono: a API responde `queued` com `unique_id`, que é
 *     usado como externalId. Rate limit documentado: 10 por janela — o spacing
 *     fica a cargo da fila (messaging_outbox) e da queue interna do Periskope.
 *   - Não espelha em lugar nenhum: a inbox do Periskope já é a timeline que a
 *     agente humana vê (o espelho Chatwoot deixa de existir neste provider).
 */
export class PeriskopeMessagingService implements IMessagingService {
  private http: AxiosInstance | null;
  private isConfigured: boolean;
  private templateRepo: MessageTemplateRepository;

  constructor(templateRepo: MessageTemplateRepository) {
    this.templateRepo = templateRepo;

    const apiKey = process.env.PERISKOPE_API_KEY;
    // Número conectado no Periskope: DDI + número, só dígitos (ex: 5491122334455)
    const phone = process.env.PERISKOPE_PHONE;

    this.isConfigured = !!(apiKey && phone);

    if (this.isConfigured) {
      this.http = axios.create({
        baseURL: 'https://api.periskope.app/v1',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'x-phone': phone!,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });
    } else {
      this.http = null;
      console.warn('[Periskope] Service not configured - messaging features will be disabled');
    }
  }

  async sendWhatsApp(options: SendWhatsAppOptions): Promise<Result<MessageSentResult>> {
    if (!this.isConfigured || !this.http) {
      return Result.fail<MessageSentResult>(
        'Periskope service not configured. Please set PERISKOPE_API_KEY and PERISKOPE_PHONE environment variables.',
      );
    }

    const to = this.normalizeNumber(options.to);
    if (!to) {
      return Result.fail<MessageSentResult>(`Invalid phone number: ${options.to}`);
    }

    const guard = this.guardUnresolvedTokens(options.variables);
    if (guard) return Result.fail<MessageSentResult>(guard);

    const template = await this.templateRepo.findBySlug(options.templateSlug);
    if (!template) {
      return Result.fail<MessageSentResult>(`Template '${options.templateSlug}' não encontrado ou inativo`);
    }

    const message = this.renderMessage(template, options.variables ?? {});

    try {
      console.log(`[Periskope] send — slug=${options.templateSlug} to=${to}`);
      const res = await this.http.post<{
        status: string;
        unique_id: string;
        queue_id: string;
      }>('/message/send', {
        chat_id: this.chatIdFor(to),
        message,
      });

      return Result.ok<MessageSentResult>({
        externalId: res.data.unique_id,
        status: res.data.status,
        to,
      });
    } catch (error: any) {
      const detail = error?.response?.data ? ` — ${JSON.stringify(error.response.data)}` : '';
      return Result.fail<MessageSentResult>(`Periskope error: ${error.message}${detail}`);
    }
  }

  /**
   * Content API é um conceito do canal Twilio/WABA — não existe equivalente no
   * Periskope. Callers devem usar sendWhatsApp com templateSlug, que resolve o
   * body no message_templates e envia texto livre.
   */
  async sendWithContentSid(
    _to: string,
    contentSid: string,
    _contentVariables: Record<string, string>,
  ): Promise<Result<MessageSentResult>> {
    return Result.fail<MessageSentResult>(
      `Periskope provider does not support Twilio Content API (contentSid=${contentSid}). Use sendWhatsApp with templateSlug instead.`,
    );
  }

  /**
   * Renderiza o texto final: body interpolado e, se o template tem botões
   * quick-reply, opções numeradas no fim (o WhatsApp Web não tem botões
   * interativos — o worker responde digitando).
   */
  renderMessage(template: MessageTemplate, variables: Record<string, string>): string {
    const body = this.interpolate(template.body, variables);
    const buttons = template.buttons;
    if (!buttons || buttons.length === 0) return body;

    // SSOT: mesma numeração que PeriskopeInboundRouter usa para parsear a
    // resposta do worker (numberedButtonOptions.ts) — nunca renderizar inline.
    return `${body}\n\n${renderNumberedOptions(buttons)}`;
  }

  /** Periskope identifica chats 1-1 como <DDI+numero>@c.us (sem '+'). */
  private chatIdFor(e164: string): string {
    return `${e164.replace(/[^\d]/g, '')}@c.us`;
  }

  /**
   * Guard de segurança: rejeita envios cujas variáveis contenham tokens PII
   * não resolvidos (tk_<hex>). Ver TokenService.resolveVariables — sem o
   * resolve, o worker receberia "Hola tk_1becdd3bd1fea388" no WhatsApp.
   */
  private guardUnresolvedTokens(
    vars: Record<string, string> | undefined,
  ): string | null {
    if (!vars) return null;
    const offenders: string[] = [];
    for (const [key, value] of Object.entries(vars)) {
      if (typeof value === 'string' && value.startsWith('tk_')) {
        offenders.push(`${key}=${value}`);
      }
    }
    if (offenders.length === 0) return null;
    const msg =
      `Unresolved PII tokens in message variables (${offenders.join(', ')}). ` +
      `Caller must call TokenService.resolveVariables() before sendWhatsApp.`;
    console.error(`[Periskope] BLOCKED — ${msg}`);
    return msg;
  }

  /** Substitui {{variavel}} pelo valor correspondente; mantém o placeholder se não fornecido. */
  private interpolate(body: string, vars: Record<string, string>): string {
    return body.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
  }

  /**
   * Garante formato E.164 (+DDI...).
   * Números argentinos sem o '9' de celular são corrigidos automaticamente.
   * (Mesmas regras do canal Twilio — a base de workers é a mesma.)
   */
  private normalizeNumber(raw: string): string | null {
    if (!raw) return null;

    const cleaned = raw.replace(/[^\d+]/g, '');

    if (cleaned.startsWith('+')) return cleaned;

    // Argentina: números de 10 dígitos sem DDI
    if (cleaned.length === 10) return `+54${cleaned}`;

    // Argentina: 11 dígitos com DDI 54 mas sem '+'
    if (cleaned.startsWith('54') && cleaned.length === 13) return `+${cleaned}`;

    // Brasil: 11 dígitos com DDI 55
    if (cleaned.startsWith('55') && cleaned.length === 13) return `+${cleaned}`;

    if (cleaned.length >= 11) return `+${cleaned}`;

    return null;
  }
}
