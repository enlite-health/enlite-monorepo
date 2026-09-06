import twilio from 'twilio';
import { extractPlaceholders } from '../application/StageTemplateEligibility';
import { IMessagingService, MessageSentResult, SendWhatsAppOptions } from '../domain/IMessagingService';
import { Result } from '@shared/utils/Result';
import { MessageTemplate, TemplateButton } from '../domain/MessageTemplate';
import { MessageTemplateRepository } from './MessageTemplateRepository';
import { ChatwootClient } from './ChatwootClient';

// Único arquivo que importa 'twilio'. Para migrar para Cloud Function,
// apenas este arquivo é substituído — nada mais muda.
export class TwilioMessagingService implements IMessagingService {
  private client: twilio.Twilio | null;
  private fromNumber: string;
  private isConfigured: boolean;
  private templateRepo: MessageTemplateRepository;
  private chatwootClient: ChatwootClient | null;
  private chatwootTestNumbers: Set<string>;

  constructor(
    templateRepo: MessageTemplateRepository,
    chatwootClient: ChatwootClient | null = null,
  ) {
    this.templateRepo = templateRepo;
    this.chatwootClient = chatwootClient;

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    this.fromNumber = process.env.TWILIO_WHATSAPP_NUMBER || '';

    this.isConfigured = !!(accountSid && authToken && this.fromNumber);

    if (this.isConfigured) {
      this.client = twilio(accountSid!, authToken!);
    } else {
      this.client = null;
      console.warn('[Twilio] Service not configured - messaging features will be disabled');
    }

    // Whitelist opcional de números pra rollout gradual do espelho no Chatwoot.
    // CSV de E.164. Quando vazia, espelha pra todos (desde que client esteja injetado).
    const raw = process.env.CHATWOOT_MIRROR_TEST_NUMBERS || '';
    this.chatwootTestNumbers = new Set(
      raw.split(',').map(s => s.trim()).filter(Boolean),
    );
  }

  async sendWhatsApp(options: SendWhatsAppOptions): Promise<Result<MessageSentResult>> {
    if (!this.isConfigured || !this.client) {
      return Result.fail<MessageSentResult>('Twilio service not configured. Please set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_WHATSAPP_NUMBER environment variables.');
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

    try {
      // statusCallback: URL para receber atualizações de status de entrega do Twilio.
      // Se TWILIO_STATUS_CALLBACK_URL não estiver definido, o campo é omitido.
      const statusCallback = process.env.TWILIO_STATUS_CALLBACK_URL || undefined;

      // Template com Content SID → usa Twilio Content API (template aprovado WhatsApp Business)
      //   contentVariables: mapeia variáveis nomeadas ({{name}}) para posicionais ("1", "2", ...)
      //   seguindo a ordem de aparição no body do template.
      // Template sem Content SID → envia body como texto livre (sandbox / free-form)
      let message;
      if (template.contentSid) {
        const mappedVars = this.mapToContentVariables(template.body, options.variables ?? {});
        console.log(
          `[Twilio] Content API — slug=${options.templateSlug} contentSid=${template.contentSid} contentVariables=${JSON.stringify(mappedVars)}`,
        );
        message = await this.client.messages.create({
          from: `whatsapp:${this.fromNumber}`,
          to: `whatsapp:${to}`,
          contentSid: template.contentSid,
          contentVariables: JSON.stringify(mappedVars),
          ...(statusCallback ? { statusCallback } : {}),
        });
      } else {
        message = await this.client.messages.create({
          from: `whatsapp:${this.fromNumber}`,
          to: `whatsapp:${to}`,
          body: this.interpolate(template.body, options.variables ?? {}),
          ...(statusCallback ? { statusCallback } : {}),
        });
      }

      const result: MessageSentResult = {
        externalId: message.sid,
        status: message.status,
        to,
      };

      // Espelho no Chatwoot — não bloqueia o envio. Erro só loga.
      await this.mirrorToChatwoot({
        phone: to,
        template,
        variables: options.variables ?? {},
        twilioSid: message.sid,
        contactName: options.contactName,
        contactEmail: options.contactEmail,
      });

      return Result.ok<MessageSentResult>(result);
    } catch (error: any) {
      return Result.fail<MessageSentResult>(`Twilio error: ${error.message}`);
    }
  }

  /**
   * Envia mensagem usando Twilio Content API diretamente (sem template lookup).
   * Para callers que já possuem o contentSid e as variáveis em formato posicional.
   *
   * Nota: este método NÃO espelha no Chatwoot porque não há body de template
   * disponível pra renderizar texto humano. Se for usado em produção, deve ser
   * estendido pra aceitar um body já interpolado.
   */
  async sendWithContentSid(
    to: string,
    contentSid: string,
    contentVariables: Record<string, string>,
  ): Promise<Result<MessageSentResult>> {
    if (!this.isConfigured || !this.client) {
      return Result.fail<MessageSentResult>('Twilio service not configured.');
    }

    const normalizedTo = this.normalizeNumber(to);
    if (!normalizedTo) {
      return Result.fail<MessageSentResult>(`Invalid phone number: ${to}`);
    }

    const guard = this.guardUnresolvedTokens(contentVariables);
    if (guard) return Result.fail<MessageSentResult>(guard);

    try {
      const statusCallback = process.env.TWILIO_STATUS_CALLBACK_URL || undefined;

      const message = await this.client.messages.create({
        from: `whatsapp:${this.fromNumber}`,
        to: `whatsapp:${normalizedTo}`,
        contentSid,
        contentVariables: JSON.stringify(contentVariables),
        ...(statusCallback ? { statusCallback } : {}),
      });

      return Result.ok<MessageSentResult>({
        externalId: message.sid,
        status: message.status,
        to: normalizedTo,
      });
    } catch (error: any) {
      return Result.fail<MessageSentResult>(`Twilio error: ${error.message}`);
    }
  }

  /**
   * Posta uma cópia da mensagem outgoing no Chatwoot. Idempotente via
   * source_id=twilio_sid. Erros são logados mas não falham o envio Twilio.
   */
  private async mirrorToChatwoot(params: {
    phone: string;
    template: MessageTemplate;
    variables: Record<string, string>;
    twilioSid: string;
    contactName?: string;
    contactEmail?: string;
  }): Promise<void> {
    if (!this.chatwootClient) return;

    if (this.chatwootTestNumbers.size > 0 && !this.chatwootTestNumbers.has(params.phone)) {
      return; // fora do allowlist durante rollout gradual
    }

    try {
      const content = this.renderForChatwoot(params.template, params.variables);
      await this.chatwootClient.mirrorOutgoingMessage({
        phone: params.phone,
        name: params.contactName,
        email: params.contactEmail,
        content,
        twilioSid: params.twilioSid,
      });
    } catch (err: any) {
      console.warn(
        `[Chatwoot mirror] failed to mirror sid=${params.twilioSid} phone=${params.phone}: ${err?.message || err}`,
      );
    }
  }

  /**
   * Renderiza a string que vai aparecer pra agente humana no Chatwoot:
   * - body interpolado (sem placeholders {{x}})
   * - se o template tem buttons, anexa "[Opciones: A | B]" no fim, pra que a
   *   agente entenda a qual pergunta o worker respondeu.
   */
  private renderForChatwoot(
    template: MessageTemplate,
    variables: Record<string, string>,
  ): string {
    const body = this.interpolate(template.body, variables);
    const buttons = template.buttons;
    if (!buttons || buttons.length === 0) return body;

    const labels = buttons.map((b: TemplateButton) => b.label).join(' | ');
    return `${body}\n\n_Opciones: ${labels}_`;
  }

  /**
   * Guard de segurança: rejeita envios cujas variáveis contenham tokens PII
   * não resolvidos (tk_<hex>). Tokens são gerados pelo TokenService pra
   * referenciar PII criptografado no outbox; resolveVariables() troca cada
   * token pelo plaintext via KMS antes do envio. Se um caller esquecer o
   * resolve, o worker receberia algo como "Hola tk_1becdd3bd1fea388" no
   * WhatsApp — bug histórico (167 envios afetados em 2026-05-21).
   * Retorna mensagem de erro pra Result.fail, ou null se tudo ok.
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
    console.error(`[Twilio] BLOCKED — ${msg}`);
    return msg;
  }

  /** Substitui {{variavel}} pelo valor correspondente; mantém o placeholder se não fornecido. */
  private interpolate(body: string, vars: Record<string, string>): string {
    return body.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
  }

  /**
   * Mapeia variáveis nomeadas para formato posicional da Twilio Content API.
   * Extrai {{placeholders}} do body do template na ordem de aparição e
   * atribui chaves "1", "2", "3", etc. Variáveis duplicadas são ignoradas.
   */
  mapToContentVariables(
    body: string,
    variables: Record<string, string>,
  ): Record<string, string> {
    // O parser é o mesmo da elegibilidade por etapa (ordem de aparição, sem duplicatas).
    const result: Record<string, string> = {};
    extractPlaceholders(body).forEach((key, i) => {
      result[String(i + 1)] = variables[key] ?? '';
    });
    return result;
  }

  /**
   * Garante formato E.164 (+DDI...).
   * Números argentinos sem o '9' de celular são corrigidos automaticamente.
   */
  private normalizeNumber(raw: string): string | null {
    if (!raw) return null;

    // Remove tudo que não for dígito ou '+'
    const cleaned = raw.replace(/[^\d+]/g, '');

    // Já está em E.164
    if (cleaned.startsWith('+')) return cleaned;

    // Argentina: números de 10 dígitos sem DDI
    if (cleaned.length === 10) return `+54${cleaned}`;

    // Argentina: 11 dígitos com DDI 54 mas sem '+'
    if (cleaned.startsWith('54') && cleaned.length === 13) return `+${cleaned}`;

    // Brasil: 11 dígitos com DDI 55
    if (cleaned.startsWith('55') && cleaned.length === 13) return `+${cleaned}`;

    // Retorna com '+' prefixado se já tiver DDI
    if (cleaned.length >= 11) return `+${cleaned}`;

    return null;
  }
}
