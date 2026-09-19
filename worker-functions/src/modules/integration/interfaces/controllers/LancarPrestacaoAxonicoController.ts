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
 */

import { Request, Response } from 'express';
import { z } from 'zod';
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
const LancamentoBodySchema = z.object({
  patientId: z.string().uuid(),
  serviceType: z.enum(['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST']),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "serviceDate deve ser 'YYYY-MM-DD'"),
  hours: z.number().int('hours deve ser um inteiro (D366) — hora quebrada é recusada').positive('hours deve ser positivo'),
});

const LoteBodySchema = z.object({
  itens: z.array(LancamentoBodySchema).min(1).max(500),
});

type LancamentoBody = z.infer<typeof LancamentoBodySchema>;

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
    const parsed = LancamentoBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid request body', details: parsed.error.flatten() });
      return;
    }

    const outcome = await this.executarUm(parsed.data);
    if (outcome.status === 'erro') {
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
    const parsed = LoteBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid request body', details: parsed.error.flatten() });
      return;
    }

    const resultados: LoteItemResultado[] = [];
    // Laço com try/catch POR ITEM (copiado o DESENHO de BackfillWorkerMirrorUseCase.execute,
    // linhas 107-124): falha de um item NUNCA aborta os seguintes.
    for (let index = 0; index < parsed.data.itens.length; index++) {
      const item = parsed.data.itens[index];
      const outcome = await this.executarUm(item);
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

    res.status(200).json({ success: true, data: { summary, resultados } });
  }

  /** Chama o use case e traduz cada erro nomeado (guard) num par (errorType, httpStatus). Nunca
   *  lógica de negócio aqui — só tradução de exceção já lançada pelo miolo. */
  private async executarUm(
    input: LancamentoBody,
  ): Promise<
    | { status: 'ok'; result: LancarPrestacaoAxonicoResult }
    | { status: 'erro'; errorType: string; message: string; httpStatus: number; data?: unknown }
  > {
    try {
      const useCase = await this.useCaseFactory();
      const result = await useCase.execute(input);
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
