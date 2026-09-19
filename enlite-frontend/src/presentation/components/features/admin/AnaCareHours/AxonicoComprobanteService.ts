/**
 * Interface do serviço que fia o botão "Enviar" de cada dia (`DayGroup`) à NOSSA rota de
 * integração com o Axonico — o front NUNCA fala com o Axonico direto (regra dura do brief).
 * `AxonicoComprobanteHttpService` é a implementação real, contra o contrato fixo abaixo (rota
 * ainda sendo escrita por outra sessão nesta mesma branch, em `worker-functions/` — este arquivo
 * não depende de nada de lá além do contrato documentado aqui).
 *
 * Contrato (fixo, não inventado aqui):
 *  `POST /api/admin/integrations/axonico/comprobante`
 *  corpo: `{ documentNumber, documentType?, serviceType: 'AT', serviceDate: 'YYYY-MM-DD', hours }`
 *  sucesso 200: `{ success: true, data: { status: 'enviado'|'duplicado', numeroComprobante,
 *    codAutorizacion, jaFaturado?, lancadoEm? } }`
 *  erro: `{ success: false, error: '<NomeDoErro>', message }` com status 400/404/409/422/502
 */
export interface EnviarComprobanteAxonicoCommand {
  documentNumber: string;
  documentType?: string;
  serviceDate: string;
  hours: number;
}

export type AxonicoComprobanteStatus = 'enviado' | 'duplicado';

export interface EnviarComprobanteAxonicoResult {
  status: AxonicoComprobanteStatus;
  numeroComprobante: string;
  codAutorizacion: string;
  jaFaturado?: boolean;
  lancadoEm?: string;
}

/** Erro de negócio devolvido pela rota — `code` é o `error` literal do corpo (nome do erro, ex. "DocumentoAusente"), `message` é o texto pronto pra tela. */
export class AxonicoComprobanteServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AxonicoComprobanteServiceError';
    this.code = code;
  }
}

export interface AxonicoComprobanteService {
  enviarComprobante(command: EnviarComprobanteAxonicoCommand): Promise<EnviarComprobanteAxonicoResult>;
}
