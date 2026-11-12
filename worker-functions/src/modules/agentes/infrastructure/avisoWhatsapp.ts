import { Result } from '@shared/utils/Result';
import type { MessageSentResult } from '@modules/notification/domain/IMessagingService';
import type { AvisoWhatsappPort, EnvioWhatsapp } from '../application/AvisoPedidoService';

/** O que o `TwilioMessagingService` expõe e este adapter usa (o 4º parâmetro é o remetente: o número do Sol, separado). */
export interface TwilioContentSender {
  sendWithContentSid(to: string, contentSid: string, vars: Record<string, string>, from?: string): Promise<Result<MessageSentResult>>;
}

/** Adapter REAL: só é construído fora de teste (ver `criarWhatsappAviso`). */
export class TwilioAvisoWhatsapp implements AvisoWhatsappPort {
  constructor(private readonly twilio: TwilioContentSender) {}
  async enviar(i: { to: string; from: string; contentSid: string; variables: Record<string, string> }): Promise<EnvioWhatsapp> {
    const r = await this.twilio.sendWithContentSid(i.to, i.contentSid, i.variables, i.from);
    return r.isSuccess ? { ok: true, stub: false } : { ok: false };
  }
}

/** Dublê: nada sai da máquina; guarda as chamadas (com o número, só em memória do teste) e devolve `stub`. */
export class StubAvisoWhatsapp implements AvisoWhatsappPort {
  readonly calls: Array<{ to: string; from: string; contentSid: string; variables: Record<string, string> }> = [];
  failWith: boolean = false;
  async enviar(i: { to: string; from: string; contentSid: string; variables: Record<string, string> }): Promise<EnvioWhatsapp> {
    this.calls.push(i);
    return this.failWith ? { ok: false } : { ok: true, stub: true };
  }
}

/** Sem Twilio disponível (boot sem o serviço): toda tentativa vira falha registrada, nunca exceção. */
class IndisponivelAvisoWhatsapp implements AvisoWhatsappPort {
  async enviar(): Promise<EnvioWhatsapp> { return { ok: false }; }
}

/**
 * Mesma regra de `createAdmissionExternals`: `NODE_ENV=test` OU `ADMISSION_EXTERNALS=fake` -> dublê; `NODE_ENV=test` com `real` LANÇA
 * (teste nunca toca canal real). Em produção com `fake` também lança (dublê em prd seria aviso que nunca sai, sem erro) — exceto na
 * stage (`ENLITE_DEPLOY_ENV=stage`), como lá.
 */
export function criarWhatsappAviso(
  env: { NODE_ENV?: string; ADMISSION_EXTERNALS?: string; ENLITE_DEPLOY_ENV?: string },
  real: () => TwilioContentSender | undefined,
): AvisoWhatsappPort {
  const isTest = env.NODE_ENV === 'test';
  if (isTest && env.ADMISSION_EXTERNALS === 'real') throw new Error('criarWhatsappAviso: real é proibido com NODE_ENV=test');
  if (env.NODE_ENV === 'production' && env.ADMISSION_EXTERNALS === 'fake' && env.ENLITE_DEPLOY_ENV !== 'stage') {
    throw new Error('criarWhatsappAviso: ADMISSION_EXTERNALS=fake é proibido em produção');
  }
  if (isTest || env.ADMISSION_EXTERNALS === 'fake') return new StubAvisoWhatsapp();
  const t = real();
  return t ? new TwilioAvisoWhatsapp(t) : new IndisponivelAvisoWhatsapp();
}
