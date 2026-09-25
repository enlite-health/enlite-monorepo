/**
 * LancarPrestacaoAxonicoController — F4 da change `integracao-axonico`.
 *
 * POST /integrations/axonico/comprobante      — lança UMA prestação
 * POST /integrations/axonico/comprobante/lote — lança um LOTE (laço sobre o caminho unitário)
 *
 * Zero lógica de negócio aqui (regra dura da F4): valida com Zod e delega ao
 * `LancarPrestacaoAxonicoUseCase`. O laço do lote é só orquestração — cada item chama o MESMO
 * `execute()` do caminho unitário, com try/catch por item (falha de um item nunca aborta os
 * seguintes), mesmo padrão de `BackfillWorkerMirrorUseCase.execute` (linhas 107-124: contadores +
 * `errors: Array<{ id, message }>` em vez de abortar o laço inteiro).
 *
 * `serviceDate` é validado como `'YYYY-MM-DD'` aqui, na BORDA — o miolo (use case, client) assume
 * a string já validada e nunca converte para `Date`. `hours` é validado como inteiro positivo
 * aqui, ANTES de qualquer chamada ao use case — hora quebrada nunca toca rede (D366).
 *
 * CORREÇÃO (19/09/2026, decisão do Gabriel): o corpo não recebe mais `patientId` — a tela de
 * conferência de horas do Ana Care ainda não vincula os pacientes dele aos nossos, então o
 * lançamento é feito pelo `documentNumber` que já vem pronto do Ana Care. `documentNumber` é
 * obrigatório; `documentType` é aceito e reservado (ainda não usado). Um corpo com `patientId` e
 * sem `documentNumber` é recusado pelo Zod (campo obrigatório ausente) — `patientId` extra é apenas
 * ignorado (schema não-`strict`), nunca usado.
 *
 * CORREÇÃO (24/09/2026, change `axonico-envio-rastreavel`): quem disparou a tentativa nunca vinha
 * do payload (não é confiável) — vem da sessão autenticada, mesmo padrão de
 * `AnaCareHoursController.actorUid` (`AuthMiddleware.getAuthContext(req)?.principal.id`). Ao
 * contrário daquele método (que cai em `'unknown'` quando ausente), aqui a ausência de uid é 401 —
 * o registro de quem lançou uma prestação que FATURA de verdade não pode ser "desconhecido".
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { LancarPrestacaoAxonicoUseCase } from '../../application/LancarPrestacaoAxonicoUseCase';
import {
  PacienteSemDniError,
  HoraQuebradaError,
  AxonicoTetoIndisponivelError,
  AxonicoTetoExcedidoError,
  AxonicoPacienteNaoEncontradoError,
  AxonicoLancamentoConcorrenteError,
} from '../../application/LancarPrestacaoAxonicoUseCase';
import type { LancarPrestacaoAxonicoResult } from '../../application/LancarPrestacaoAxonicoUseCase';
import { AxonicoUnmappedServiceTypeError } from '../../infrastructure/AxonicoServiceMapping';
import {
  AxonicoValidationError,
  AxonicoBusinessError,
  AxonicoAuthError,
  AxonicoIndeterminateWriteError,
} from '../../infrastructure/AxonicoErrors';
import { pgUniqueViolationConflict } from '@shared/http/pgUniqueViolationConflict';

// `serviceDate` — string 'YYYY-MM-DD' de ponta a ponta (nunca Date). `hours` — inteiro positivo
// (D366): fracionário é rejeitado AQUI pelo Zod, antes de qualquer chamada de rede.
//
// `documentNumber` — obrigatório (19/09/2026): substitui `patientId`, que SAIU do corpo — o
// lançamento é feito pelo documento que o Ana Care já manda pronto, sem consultar `patients`. A
// validação de FORMATO do DNI (7/8 dígitos, rejeita a string 'null') é do use case (guard 0, via
// `normalizeAndValidateDocumentNumber`) — aqui só garante que a string chegou e não é vazia.
// `documentType` é aceito e reservado, ainda sem uso.
const LancamentoBodySchema = z.object({
  documentNumber: z.string().min(1, 'documentNumber é obrigatório'),
  documentType: z.string().optional(),
  serviceType: z.enum(['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST']),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "serviceDate deve ser 'YYYY-MM-DD'"),
  hours: z.number().int('hours deve ser um inteiro (D366) — hora quebrada é recusada').positive('hours deve ser positivo'),
});

const LoteBodySchema = z.object({
  itens: z.array(LancamentoBodySchema).min(1).max(500),
});

type LancamentoBody = z.infer<typeof LancamentoBodySchema>;

const TAG = '[LancarPrestacaoAxonicoController]';

/** Um item do relatório do lote — expõe SEMPRE o que o operador precisa saber se já faturou
 *  (D contrato F4 item 3): `duplicado` tem que carregar `numeroComprobante`/`codAutorizacion`
 *  (nulos quando o dedupe foi remoto), nunca só um booleano genérico. */
type LoteItemResultado =
  | ({ index: number; status: 'ok' } & Omit<Extract<LancarPrestacaoAxonicoResult, { status: 'enviado' }>, 'status'>)
  | ({ index: number; status: 'duplicado' } & Omit<Extract<LancarPrestacaoAxonicoResult, { status: 'duplicado' }>, 'status'>)
  | { index: number; status: 'erro'; errorType: string; message: string; data?: unknown };

export class LancarPrestacaoAxonicoController {
  /**
   * `useCaseFactory` — lazy, mesmo padrão de `AnaCareBackfillController` (o client HTTP externo
   * só é construído quando a rota é de fato chamada, nunca no boot do processo). Memoização de
   * sessão/token é responsabilidade de quem passa a factory (routes), não deste controller.
   */
  constructor(private readonly useCaseFactory: () => Promise<LancarPrestacaoAxonicoUseCase>) {}

  /** POST /integrations/axonico/comprobante — um lançamento. */
  async handle(req: Request, res: Response): Promise<void> {
    // uid de quem está disparando — resolvido da sessão, nunca do corpo (mesmo padrão de
    // `AnaCareHoursController.actorUid`). Sem uid: 401 ANTES de validar o corpo — um lançamento que
    // fatura de verdade não pode ficar sem autor conhecido (diferente de `actorUid`, que aceita
    // `'unknown'` para leituras/escritas que não faturam).
    const sentBy = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!sentBy) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const parsed = LancamentoBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      // Nunca logar req.body (pode carregar documentNumber = DNI) — só os NOMES dos campos que
      // falharam a validação Zod, nunca o valor recebido.
      logger.warn({
        msg: `${TAG} corpo inválido — recusado antes de qualquer chamada ao use case`,
        invalidFields: Object.keys(parsed.error.flatten().fieldErrors),
      });
      res.status(400).json({ success: false, error: 'Invalid request body', details: parsed.error.flatten() });
      return;
    }

    logger.info({
      msg: `${TAG} requisição recebida`,
      serviceType: parsed.data.serviceType,
      serviceDate: parsed.data.serviceDate,
      hours: parsed.data.hours,
    });

    const outcome = await this.executarUm(parsed.data, sentBy);
    if (outcome.status === 'erro') {
      // errorType/httpStatus/message já são seguros (testes da suíte do use case garantem que a
      // mensagem nunca interpola o DNI) — o boundary HTTP loga o VEREDITO da requisição, não
      // repete o detalhe de guard (já logado no use case/client).
      const logFields = {
        msg: `${TAG} requisição recusada`,
        errorType: outcome.errorType,
        httpStatus: outcome.httpStatus,
        serviceType: parsed.data.serviceType,
        serviceDate: parsed.data.serviceDate,
      };
      // >=500 é falha do terceiro/nossa (ver AxonicoApiClient); os dois nomeados abaixo são 4xx que
      // MESMO ASSIM exigem ação humana (faturamento em estado concorrente/indeterminado) — nunca
      // "esperado-mas-atípico" como uma validação comum.
      const exigeAcaoMesmoSendo4xx = new Set(['AxonicoLancamentoConcorrenteError', 'AxonicoIndeterminateWriteError']);
      if (outcome.httpStatus >= 500 || exigeAcaoMesmoSendo4xx.has(outcome.errorType)) {
        logger.error(logFields);
      } else {
        logger.warn(logFields);
      }
      res.status(outcome.httpStatus).json({
        success: false,
        error: outcome.errorType,
        message: outcome.message,
        ...(outcome.data !== undefined ? { data: outcome.data } : {}),
      });
      return;
    }

    res.status(200).json({ success: true, data: outcome.result });
  }

  /** POST /integrations/axonico/comprobante/lote — laço sobre o caminho unitário, item a item. */
  async handleLote(req: Request, res: Response): Promise<void> {
    // Mesmo guard de `handle` — uma uid só, válida para o lote inteiro (quem disparou o lote é
    // quem disparou cada item dele).
    const sentBy = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!sentBy) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const parsed = LoteBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      logger.warn({
        msg: `${TAG} lote — corpo inválido, recusado antes de qualquer chamada ao use case`,
        invalidFields: Object.keys(parsed.error.flatten().fieldErrors),
      });
      res.status(400).json({ success: false, error: 'Invalid request body', details: parsed.error.flatten() });
      return;
    }

    logger.info({ msg: `${TAG} lote recebido`, totalItens: parsed.data.itens.length });

    const resultados: LoteItemResultado[] = [];
    // Laço com try/catch POR ITEM (copiado o DESENHO de BackfillWorkerMirrorUseCase.execute,
    // linhas 107-124): falha de um item NUNCA aborta os seguintes.
    for (let index = 0; index < parsed.data.itens.length; index++) {
      const item = parsed.data.itens[index];
      const outcome = await this.executarUm(item, sentBy);
      if (outcome.status === 'erro') {
        resultados.push({
          index,
          status: 'erro',
          errorType: outcome.errorType,
          message: outcome.message,
          ...(outcome.data !== undefined ? { data: outcome.data } : {}),
        });
        continue;
      }
      if (outcome.result.status === 'enviado') {
        resultados.push({ ...outcome.result, index, status: 'ok' });
      } else {
        resultados.push({ ...outcome.result, index, status: 'duplicado' });
      }
    }

    const summary = {
      total: resultados.length,
      ok: resultados.filter((r) => r.status === 'ok').length,
      duplicado: resultados.filter((r) => r.status === 'duplicado').length,
      erro: resultados.filter((r) => r.status === 'erro').length,
    };

    // Sucesso também loga (item do lote com 0 erro é sucesso, não "nada aconteceu") — nível
    // depende do resultado: lote com pelo menos 1 erro é warn (operador precisa olhar quais
    // índices falharam, já reportados em `resultados`, na resposta HTTP), zero erros é info.
    const loteConcluidoFields = { msg: `${TAG} lote concluído`, ...summary };
    if (summary.erro > 0) {
      logger.warn(loteConcluidoFields);
    } else {
      logger.info(loteConcluidoFields);
    }

    res.status(200).json({ success: true, data: { summary, resultados } });
  }

  /** Chama o use case e traduz cada erro nomeado (guard) num par (errorType, httpStatus). Nunca
   *  lógica de negócio aqui — só tradução de exceção já lançada pelo miolo. */
  private async executarUm(
    input: LancamentoBody,
    sentBy: string,
  ): Promise<
    | { status: 'ok'; result: LancarPrestacaoAxonicoResult }
    | { status: 'erro'; errorType: string; message: string; httpStatus: number; data?: unknown }
  > {
    try {
      const useCase = await this.useCaseFactory();
      const result = await useCase.execute({ ...input, sentBy });
      return { status: 'ok', result };
    } catch (err) {
      return { status: 'erro', ...mapError(err) };
    }
  }
}

function mapError(err: unknown): { errorType: string; message: string; httpStatus: number; data?: unknown } {
  if (err instanceof HoraQuebradaError) {
    return { errorType: err.name, message: err.message, httpStatus: 400 };
  }
  if (err instanceof PacienteSemDniError) {
    return { errorType: err.name, message: err.message, httpStatus: 422 };
  }
  if (err instanceof AxonicoUnmappedServiceTypeError) {
    return { errorType: err.name, message: err.message, httpStatus: 422 };
  }
  if (err instanceof AxonicoTetoExcedidoError) {
    return { errorType: err.name, message: err.message, httpStatus: 422 };
  }
  if (err instanceof AxonicoTetoIndisponivelError) {
    return { errorType: err.name, message: err.message, httpStatus: 502 };
  }
  if (err instanceof AxonicoPacienteNaoEncontradoError) {
    return { errorType: err.name, message: err.message, httpStatus: 404 };
  }
  if (err instanceof AxonicoLancamentoConcorrenteError) {
    // Item 1.3: o índice único (uq_axonico_lancamento_dedupe, migration 445) estourou (23505) no
    // INSERT final — corrida entre o guard 2 (SELECT) e este INSERT. Usa o MESMO helper que as
    // outras rotas de escrita do repo usam para 23505→409 (`pgUniqueViolationConflict`); a
    // mensagem formatada por ele vira `message`, e os DOIS comprovantes (o que já estava gravado
    // e o que ACABOU de ser faturado nesta chamada) vão em `data` — nunca só um dos dois.
    const conflict = pgUniqueViolationConflict(
      err,
      'Comprovante já lançado por outra requisição concorrente para o mesmo documentNumber/serviceType/serviceDate — dois comprovantes foram faturados no Axonico',
    );
    return {
      errorType: err.name,
      message: conflict?.error ?? err.message,
      httpStatus: 409,
      data: {
        comprovanteExistente: {
          numeroComprobante: err.existente.numeroComprobante,
          codAutorizacion: err.existente.codAutorizacion,
          lancadoEm: err.existente.createdAt,
        },
        comprovanteRecemFaturado: err.recemFaturado,
      },
    };
  }
  if (err instanceof AxonicoIndeterminateWriteError) {
    // Estado INDETERMINADO — pode ter faturado no Axonico sem confirmação do nosso lado. Nunca
    // 5xx genérico: o operador precisa saber que isto exige checagem humana, não retry automático.
    return { errorType: err.name, message: err.message, httpStatus: 409 };
  }
  if (err instanceof AxonicoValidationError) {
    return { errorType: err.name, message: err.message, httpStatus: 422 };
  }
  if (err instanceof AxonicoAuthError) {
    return { errorType: err.name, message: err.message, httpStatus: 502 };
  }
  if (err instanceof AxonicoBusinessError) {
    return { errorType: err.name, message: err.message, httpStatus: 502 };
  }
  const e = err instanceof Error ? err : new Error(String(err));
  return { errorType: 'UnknownError', message: e.message, httpStatus: 500 };
}
