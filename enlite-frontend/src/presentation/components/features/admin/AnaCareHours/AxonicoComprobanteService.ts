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
 *
 * ⚠️ `numeroComprobante`/`codAutorizacion` são `string | null` — confirmado contra
 * `LancarPrestacaoAxonicoResult` (`worker-functions/src/modules/integration/application/
 * LancarPrestacaoAxonicoUseCase.ts`): no caso `duplicado` achado pelo DEDUPE REMOTO (guard 4), o
 * comprovante foi criado FORA do nosso registro e os dois campos vêm `null` — a tela não pode
 * tipar como `string` não-nulo, isso mentia sobre o contrato real.
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
  numeroComprobante: string | null;
  codAutorizacion: string | null;
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
