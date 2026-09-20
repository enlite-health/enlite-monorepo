/**
 * LancarPrestacaoAxonicoUseCase — F3 da change `integracao-axonico`.
 *
 * Lança UMA prestação de AT no Axonico (`PUT /api/comprobante`, via `IAxonicoApiClient`),
 * registrando cada TENTATIVA em `axonico_comprobante_lancamento` (`IAxonicoLancamentoRepository`,
 * F2). Injeção por construtor, mesmo padrão de `ProcessTalentumPrescreening` do módulo `matching`
 * (portas de domínio mockáveis, nunca `Pool` direto aqui).
 *
 * Cada `PUT /api/comprobante` real GERA FATURAMENTO em produção do Axonico — não existe sandbox.
 * Por isso os guards abaixo rodam NESTA ORDEM EXATA, cada um antes de qualquer chamada de rede
 * evitável, e o teto de `cantidad` (guard 3) nunca usa um número cravado (D371): sem leitura
 * confirmada do teto, o lançamento é recusado. O dedupe LOCAL (guard 2) roda ANTES do teto de
 * propósito: num reprocessamento de lote com o Axonico instável, um item JÁ FATURADO não pode
 * virar `AxonicoTetoIndisponivelError` — a tabela local existe exatamente para responder isso sem
 * bater na API.
 *
 * CORREÇÃO (19/09/2026, decisão do Gabriel — não relitigar): a tela de conferência de horas do Ana
 * Care ainda não vincula os pacientes dele aos nossos (`patients.ana_care_id` é NULL nos 388
 * pacientes de prd, `patient_identity_links` tem 0 linhas — o vínculo vem depois de ~2 semanas em
 * prod sem erro). Por isso este use case **não recebe mais `patientId`** e **não consulta
 * `patients`** — o lançamento é feito pelo `documentNumber` que já vem pronto do Ana Care no corpo
 * da requisição (F4, `LancamentoBodySchema`). `IPatientReadPort`/`PatientReadRepository` continuam
 * existindo (são genéricos, podem servir outro fluxo) — só saíram DESTE use case.
 *
 * Guards, na ordem (ver design.md §F3):
 *   0. `documentNumber` recebido é ausente ou inválido (não é um DNI de 7/8 dígitos depois de
 *      normalizado — inclui a string literal `'null'`) → `PacienteSemDniError`.
 *   1. `hours` não é inteiro positivo (D366) → `HoraQuebradaError`.
 *   2. Dedupe LOCAL — nossa tabela (`findExisting`) achou `status='enviado'` → `duplicado` com o
 *      comprovante ORIGINAL (`numeroComprobante`/`codAutorizacion`/`lancadoEm` do registro
 *      existente), SEM nenhuma chamada a `getCantidadMaxPrestaciones`/`findPatientByDni`/
 *      `checkExistingComprobante`/`submitComprobante`.
 *   3. Teto de `cantidad_max_prestaciones` (D371) — leitura falhou, campo ausente, ou `hours`
 *      acima do teto → `AxonicoTetoIndisponivelError` / `AxonicoTetoExcedidoError`. Esta é a
 *      ÚNICA chamada de rede permitida antes do dedupe remoto, e é ao endpoint de parâmetros
 *      (`getCantidadMaxPrestaciones`), nunca a `submitComprobante`.
 *   4. `resolveServiceMapping` (lança `AxonicoUnmappedServiceTypeError` para `CAREGIVER` e
 *      qualquer tipo fora do mapa, ainda sem tocar rede) + `findPatientByDni` +
 *      `checkExistingComprobante` (dedupe REMOTO — mas o filtro do `POST /api/comprobante/filter`
 *      inclui `matricula` da sessão E `servicio_origen` fixo, ver `AxonicoApiClient.
 *      checkExistingComprobante`: só cobre lançamento feito POR NÓS, com ESTA credencial. NÃO
 *      cobre lançamento feito à mão no portal do Axonico por OUTRO usuário — esse passa
 *      despercebido e pode ser faturado de novo) — achou → `duplicado`, mas SEM o comprovante
 *      (foi criado fora do nosso registro):
 *      `numeroComprobante`/`codAutorizacion` nulos, `lancadoEm` é o `createdAt` da linha
 *      `duplicado` recém-inserida.
 *   5. Só se nada achou: `submitComprobante`.
 *
 * Guards 0/1/3 e o mapeamento ausente (4) LANÇAM e NÃO gravam linha na tabela — não houve
 * tentativa real contra o Axonico. A partir de `findPatientByDni` (inclusive), cada tentativa vira
 * uma linha nova: `duplicado` (achado remoto), `enviado` (sucesso) ou `erro` (falha, com
 * `error_message`, SEM retry automático — D368, o `submitComprobante` nunca é chamado duas vezes
 * pelo use case).
 */

import { logger } from '@shared/logging';
import type { EnliteServiceType } from '../domain/EnliteServiceType';
import type { IAxonicoApiClient } from '../domain/IAxonicoApiClient';
import type { AxonicoLancamentoRecord, IAxonicoLancamentoRepository } from '../domain/IAxonicoLancamentoRepository';
import { resolveServiceMapping } from '../infrastructure/AxonicoServiceMapping';
import { normalizeAndValidateDocumentNumber } from '../domain/documentNumber';

const TAG = '[LancarPrestacaoAxonicoUseCase]';

// ─────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────

export interface LancarPrestacaoAxonicoInput {
  /**
   * DNI do paciente, como vem do Ana Care — RAW, ainda não normalizado (o guard 0 normaliza e
   * valida via `normalizeAndValidateDocumentNumber`). Não é o `patientId` nosso — este use case não
   * recebe `patientId` e não consulta `patients` (decisão do Gabriel, 19/09/2026).
   */
  documentNumber: string;
  /** Reservado — ainda não usado no mapeamento/validação (o Ana Care só manda DNI hoje). */
  documentType?: string;
  serviceType: EnliteServiceType;
  /**
   * Dia civil da prestação, formato `'YYYY-MM-DD'` (nunca `Date` — um dia civil não tem instante;
   * a conversão morre na borda, mesmo contrato de `SubmitComprobanteParams`/`DedupeParams`).
   */
  serviceDate: string;
  /** Sempre inteiro positivo (D366) — o guard 1 reconfirma, nunca confia no chamador. */
  hours: number;
}

export type LancarPrestacaoAxonicoResult =
  | { status: 'enviado'; numeroComprobante: string; codAutorizacion: string }
  | {
      status: 'duplicado';
      jaFaturado: true;
      numeroComprobante: string | null;
      codAutorizacion: string | null;
      lancadoEm: Date;
    };

// ─────────────────────────────────────────────────────────────────
// Erros nomeados — um por guard, nunca `new Error` genérico (facilita `instanceof` no chamador,
// mesmo padrão de `AxonicoUnmappedServiceTypeError`/`AxonicoValidationError`/`AxonicoBusinessError`).
// ─────────────────────────────────────────────────────────────────

/**
 * Guard 0 — `documentNumber` recebido no corpo é ausente, ou presente mas INVÁLIDO (não é um DNI de
 * 7/8 dígitos depois de normalizado — ver `domain/documentNumber.ts`; medido em produção: 19
 * pacientes com a string literal `'null'`, que passaria por um `IS NOT NULL` mas não é um DNI).
 *
 * CORREÇÃO (19/09/2026): este guard não consulta mais `patients` — não há `patientId` nem reason
 * `'not_found'` (o Ana Care é quem manda o documento; não existe "paciente não encontrado" aqui,
 * só "documento ausente/inválido"). Mensagem NUNCA interpola o valor recebido — `documentNumber` é
 * DNI, PII, mesmo quando inválido/lixo.
 */
export class PacienteSemDniError extends Error {
  readonly reason: 'no_document' | 'invalid_document';

  constructor(reason: 'no_document' | 'invalid_document') {
    const detail = reason === 'no_document' ? 'documentNumber ausente' : 'documentNumber inválido (não é um DNI de 7/8 dígitos)';
    super(`${TAG} guard 0 — ${detail}`);
    this.name = 'PacienteSemDniError';
    this.reason = reason;
  }
}

/** Guard 1 — `hours` não é inteiro positivo (D366). */
export class HoraQuebradaError extends Error {
  readonly hours: number;

  constructor(hours: number) {
    super(`${TAG} guard 1 — hours=${hours} não é um inteiro positivo (D366)`);
    this.name = 'HoraQuebradaError';
    this.hours = hours;
  }
}

/**
 * Guard 3 — leitura de `cantidad_max_prestaciones` indisponível: a chamada a
 * `getCantidadMaxPrestaciones` lançou, ou devolveu `null` (D371 — nunca um número cravado).
 */
export class AxonicoTetoIndisponivelError extends Error {
  readonly hours: number;

  constructor(hours: number, cause: string) {
    super(`${TAG} guard 3 — teto de cantidad_max_prestaciones indisponível (${cause}), hours=${hours} recusado (D371)`);
    this.name = 'AxonicoTetoIndisponivelError';
    this.hours = hours;
  }
}

/** Guard 3 — `hours` acima do teto medido de `cantidad_max_prestaciones`. */
export class AxonicoTetoExcedidoError extends Error {
  readonly hours: number;
  readonly cantidadMaxPrestacoes: number;

  constructor(hours: number, cantidadMaxPrestacoes: number) {
    super(`${TAG} guard 3 — hours=${hours} excede cantidad_max_prestaciones=${cantidadMaxPrestacoes}`);
    this.name = 'AxonicoTetoExcedidoError';
    this.hours = hours;
    this.cantidadMaxPrestacoes = cantidadMaxPrestacoes;
  }
}

/**
 * Dedupe remoto (guard 4) — `findPatientByDni` não achou o paciente no Axonico pelo `documentNumber`
 * recebido no corpo. Não é guard (já tocou rede) — grava `status='erro'` como qualquer outra falha
 * desta etapa. Mensagem NUNCA interpola o DNI (PII) — desde 19/09/2026 não há `patientId` nosso
 * para identificar o caso na mensagem; quem correlaciona é o `serviceType`/`serviceDate` do log em
 * `gravaErro`, não este erro.
 */
export class AxonicoPacienteNaoEncontradoError extends Error {
  constructor() {
    super(`${TAG} findPatientByDni não encontrou paciente no Axonico para o documentNumber recebido`);
    this.name = 'AxonicoPacienteNaoEncontradoError';
  }
}

/**
 * Guard final (pós-`submitComprobante`, no `insert` de `status='enviado'`) — o índice único
 * parcial `uq_axonico_lancamento_dedupe` (migration 445, agora chaveado por `document_number`)
 * ESTOUROU (código pg `23505`) apesar do guard 2 não ter achado nada: outra requisição
 * concorrente para o MESMO `documentNumber`/`serviceType`/`serviceDate` venceu a corrida entre o
 * `SELECT` do guard 2 e este `INSERT` — a mesma janela de corrida que `pgUniqueViolationConflict`
 * (`src/shared/http/pgUniqueViolationConflict.ts`) já resolve para outras rotas de escrita do
 * repo. Os DOIS comprovantes (`existente` — quem venceu a corrida e já está gravado — e
 * `recemFaturado` — o que ACABOU de sair de `submitComprobante` nesta chamada) são FATURAMENTOS
 * REAIS no Axonico: o controller (F4) devolve os dois ao operador, nunca só um.
 *
 * `code = '23505'` replicado aqui (não só a mensagem) para que `pgUniqueViolationConflict`
 * reconheça este erro do MESMO jeito que reconheceria o erro cru do `pg` — o use case só
 * enriquece o erro original com os dois comprovantes, não troca o mecanismo de detecção.
 *
 * FORA DO ESCOPO desta correção: fechar a janela de corrida DE VERDADE (advisory lock ou linha de
 * reserva antes do `PUT`) é mudança de DESENHO, não mapeamento de erro — ver LISTA no relatório da
 * change. Este erro só GARANTE que a corrida, quando acontece, vira 409 com os dois comprovantes
 * em vez de 500 genérico ou de mascarar o segundo faturamento.
 *
 * CORREÇÃO (19/09/2026): não carrega mais `patientId` — não há `patientId` de entrada neste fluxo.
 */
export class AxonicoLancamentoConcorrenteError extends Error {
  readonly code = '23505' as const;
  readonly documentNumber: string;
  readonly existente: AxonicoLancamentoRecord;
  readonly recemFaturado: { numeroComprobante: string; codAutorizacion: string };

  constructor(
    documentNumber: string,
    existente: AxonicoLancamentoRecord,
    recemFaturado: { numeroComprobante: string; codAutorizacion: string },
  ) {
    // Mensagem não interpola o DNI (documentNumber é PII clínica) — só diz que a chave da corrida
    // foi o DNI, sem imprimir o valor; os dois números de comprovante já rastreiam o caso.
    super(
      `${TAG} guard final — uq_axonico_lancamento_dedupe estourou (23505) na chave de DNI do ` +
        `paciente: corrida concorrente faturou DOIS comprovantes (existente=` +
        `'${existente.numeroComprobante}', recém-faturado='${recemFaturado.numeroComprobante}')`,
    );
    this.name = 'AxonicoLancamentoConcorrenteError';
    this.documentNumber = documentNumber;
    this.existente = existente;
    this.recemFaturado = recemFaturado;
  }
}

// ─────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────

export class LancarPrestacaoAxonicoUseCase {
  constructor(
    private readonly axonicoApiClient: IAxonicoApiClient,
    private readonly lancamentoRepository: IAxonicoLancamentoRepository,
  ) {}

  async execute(input: LancarPrestacaoAxonicoInput): Promise<LancarPrestacaoAxonicoResult> {
    const { serviceType, serviceDate, hours } = input;
    const serviceDateStr = serviceDate;

    // ── Guard 0 — DNI recebido presente e VÁLIDO (não só truthy — a string literal 'null' não é
    //    um DNI; ver `domain/documentNumber.ts`). Não consulta `patients` (decisão 19/09/2026):
    //    o documento já vem pronto do Ana Care, no corpo da requisição. ──────────────────
    const dniValidation = normalizeAndValidateDocumentNumber(input.documentNumber);
    if (!dniValidation.valid) {
      // Nunca logar input.documentNumber (PII), nem validado nem lixo — só a razão da recusa.
      logger.warn({
        msg: `${TAG} guard 0 — documentNumber ausente ou inválido, recusado`,
        reason: dniValidation.reason,
        serviceType,
        serviceDate: serviceDateStr,
        hours,
      });
      throw new PacienteSemDniError(dniValidation.reason === 'ausente' ? 'no_document' : 'invalid_document');
    }
    const documentNumber = dniValidation.normalized;
    // Não há `patientId` de entrada neste fluxo (migration 446 tornou a coluna NULLABLE) — toda
    // tentativa grava `patientId: null` até o vínculo paciente↔Ana Care existir de verdade.
    const patientId = null;

    // ── Guard 1 — hora cheia (D366) ──────────────────────────────
    if (!Number.isInteger(hours) || hours <= 0) {
      logger.warn({ msg: `${TAG} guard 1 — hours não é inteiro positivo, recusado`, hours, serviceType, serviceDate: serviceDateStr });
      throw new HoraQuebradaError(hours);
    }

    // ── Guard 2 — dedupe local (nossa tabela primeiro; roda ANTES do teto). Chaveado por
    //    documentNumber — a chave que o Axonico fatura — não por patientId (correção 18/09/2026:
    //    dois patientId com o mesmo DNI passavam este guard cada um por si). ──────────────────
    const existingLocal = await this.lancamentoRepository.findExisting(documentNumber, serviceType, serviceDateStr);
    if (existingLocal) {
      const insertedDuplicadoLocal = await this.lancamentoRepository.insert({
        patientId,
        documentNumber,
        serviceType,
        serviceDate: serviceDateStr,
        hours,
        numeroComprobante: null,
        codAutorizacion: null,
        status: 'duplicado',
        errorMessage: null,
      });
      // Nunca logar documentNumber (DNI) — PII clínica. Sem patientId (19/09/2026) — correlaciona
      // por serviceType/serviceDate e por insertedId (a linha gravada — id interno, nunca o DNI).
      logger.info({
        msg: `${TAG} dedupe local — já enviado`,
        insertedId: insertedDuplicadoLocal.id,
        serviceType,
        serviceDate: serviceDateStr,
      });
      return {
        status: 'duplicado',
        jaFaturado: true,
        numeroComprobante: existingLocal.numeroComprobante,
        codAutorizacion: existingLocal.codAutorizacion,
        lancadoEm: existingLocal.createdAt,
      };
    }

    // ── Guard 3 — teto de cantidad (D371) — única chamada de rede antes do dedupe remoto ──
    let cantidadMaxPrestacoes: number | null;
    try {
      cantidadMaxPrestacoes = await this.axonicoApiClient.getCantidadMaxPrestaciones();
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      logger.warn({
        msg: `${TAG} guard 3 — leitura de cantidad_max_prestaciones falhou, lançamento recusado (D371)`,
        cause,
        hours,
        serviceType,
        serviceDate: serviceDateStr,
      });
      throw new AxonicoTetoIndisponivelError(hours, cause);
    }
    if (cantidadMaxPrestacoes === null) {
      logger.warn({
        msg: `${TAG} guard 3 — cantidad_max_prestaciones ausente na resposta, lançamento recusado (D371)`,
        hours,
        serviceType,
        serviceDate: serviceDateStr,
      });
      throw new AxonicoTetoIndisponivelError(hours, 'cantidad_max_prestaciones ausente na resposta');
    }
    if (hours > cantidadMaxPrestacoes) {
      logger.warn({
        msg: `${TAG} guard 3 — hours excede cantidad_max_prestaciones, lançamento recusado`,
        hours,
        cantidadMaxPrestacoes,
        serviceType,
        serviceDate: serviceDateStr,
      });
      throw new AxonicoTetoExcedidoError(hours, cantidadMaxPrestacoes);
    }

    // ── Guard 4a — mapeamento de tipo (lança ANTES de tocar rede; CAREGIVER e outros fora do
    //    mapa nunca chegam a `findPatientByDni`) ──────────────────
    let serviceCodes: ReturnType<typeof resolveServiceMapping>;
    try {
      serviceCodes = resolveServiceMapping(serviceType);
    } catch (err) {
      logger.warn({
        msg: `${TAG} guard 4a — tipo de serviço sem mapeamento no Axonico, lançamento recusado (D372)`,
        serviceType,
        serviceDate: serviceDateStr,
        hours,
      });
      throw err;
    }

    // ── 4a (continuação) — dedupe remoto: findPatientByDni + checkExistingComprobante ──
    let patientMatch: Awaited<ReturnType<IAxonicoApiClient['findPatientByDni']>>;
    let hasExistingRemote: boolean;
    try {
      patientMatch = await this.axonicoApiClient.findPatientByDni(documentNumber);
      if (!patientMatch) {
        throw new AxonicoPacienteNaoEncontradoError();
      }
      hasExistingRemote = await this.axonicoApiClient.checkExistingComprobante({
        historiaClinica: patientMatch.historiaClinica,
        nroCobertura: patientMatch.nroCobertura,
        serviceCodes,
        serviceDate,
      });
    } catch (err) {
      await this.gravaErro(documentNumber, serviceType, serviceDateStr, hours, err);
      throw err;
    }

    if (hasExistingRemote) {
      const insertedDuplicado = await this.lancamentoRepository.insert({
        patientId,
        documentNumber,
        serviceType,
        serviceDate: serviceDateStr,
        hours,
        numeroComprobante: null,
        codAutorizacion: null,
        status: 'duplicado',
        errorMessage: null,
      });
      // Nunca logar documentNumber (DNI) — PII clínica. Sem patientId (19/09/2026) — correlaciona
      // por serviceType/serviceDate e por insertedId (a linha gravada — id interno, nunca o DNI).
      logger.info({
        msg: `${TAG} dedupe remoto — comprobante já existe no Axonico`,
        insertedId: insertedDuplicado.id,
        serviceType,
        serviceDate: serviceDateStr,
      });
      return {
        status: 'duplicado',
        jaFaturado: true,
        numeroComprobante: null,
        codAutorizacion: null,
        lancadoEm: insertedDuplicado.createdAt,
      };
    }

    // ── 4b — envio (D368: nunca chamado duas vezes; falha grava 'erro' e relança, sem retry) ──
    let submitResult: Awaited<ReturnType<IAxonicoApiClient['submitComprobante']>>;
    try {
      submitResult = await this.axonicoApiClient.submitComprobante({
        historiaClinica: patientMatch.historiaClinica,
        nroCobertura: patientMatch.nroCobertura,
        serviceCodes,
        serviceDate,
        cantidad: hours,
      });
    } catch (err) {
      await this.gravaErro(documentNumber, serviceType, serviceDateStr, hours, err);
      throw err;
    }

    let insertedEnviado: AxonicoLancamentoRecord;
    try {
      insertedEnviado = await this.lancamentoRepository.insert({
        patientId,
        documentNumber,
        serviceType,
        serviceDate: serviceDateStr,
        hours,
        numeroComprobante: submitResult.numeroComprobante,
        codAutorizacion: submitResult.codAutorizacion,
        status: 'enviado',
        errorMessage: null,
      });
    } catch (err) {
      // O comprovante JÁ FOI CRIADO no Axonico (submitComprobante deu certo) — este catch só
      // cobre a GRAVAÇÃO LOCAL falhando depois disso (pool caído, FK, ou a UNIQUE parcial
      // uq_axonico_lancamento_dedupe). O caso `23505` (violação da UNIQUE) é ESPERADO sob corrida:
      // o guard 2 (findExisting) não achou nada, mas outra requisição concorrente para o MESMO
      // documentNumber/serviceType/serviceDate venceu o INSERT entre o SELECT do guard 2 e este
      // INSERT — os dois `submitComprobante` JÁ FATURARAM, e o operador precisa saber dos DOIS
      // comprovantes (item 1.3 da change: 23505 vira 409 com os dois, via mapError no controller
      // F4, nunca 500 genérico nem só o primeiro comprovante silenciado).
      const code = (err as { code?: string } | null)?.code;
      if (code === '23505') {
        const existente = await this.lancamentoRepository.findExisting(documentNumber, serviceType, serviceDateStr);
        if (existente) {
          logger.error({
            msg: `${TAG} corrida concorrente — uq_axonico_lancamento_dedupe estourou no INSERT do 'enviado': DOIS comprovantes foram faturados no Axonico`,
            numeroComprobanteExistente: existente.numeroComprobante,
            numeroComprobanteRecemFaturado: submitResult.numeroComprobante,
            codAutorizacaoRecemFaturado: submitResult.codAutorizacion,
            serviceType,
            serviceDate: serviceDateStr,
            hours,
          });
          throw new AxonicoLancamentoConcorrenteError(documentNumber, existente, {
            numeroComprobante: submitResult.numeroComprobante,
            codAutorizacion: submitResult.codAutorizacion,
          });
        }
        // 23505 sem achar o registro vencedor (corrida com o outro DELETE/rollback, janela rara) —
        // cai no comportamento genérico abaixo, sem mascarar como sucesso.
      }

      // NÃO gravar 'erro' aqui seria mentira (o lançamento teve sucesso no Axonico) e a escrita
      // provavelmente falharia pelo mesmo motivo. Este log é o ÚNICO rastro que sobra do
      // faturamento — por isso carrega numeroComprobante/codAutorizacion, nunca o DNI (PII, regra
      // dura do projeto). Sem patientId (19/09/2026) — não há mais identificador nosso a logar.
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({
        msg: `${TAG} comprovante FOI CRIADO no Axonico mas a gravação local falhou — faturamos e nosso lado não registrou`,
        numeroComprobante: submitResult.numeroComprobante,
        codAutorizacion: submitResult.codAutorizacion,
        serviceType,
        serviceDate: serviceDateStr,
        hours,
        errorMessage,
      });
      throw err;
    }

    // Sucesso também loga (requisito duro: "sempre saber se o fluxo está correndo bem" não só
    // quando dá erro). insertedId é a linha gravada — o id interno que permite achar a linha no
    // banco depois; nunca o DNI. Nível info: caminho feliz.
    logger.info({
      msg: `${TAG} sucesso — comprovante lançado no Axonico`,
      insertedId: insertedEnviado.id,
      numeroComprobante: submitResult.numeroComprobante,
      codAutorizacion: submitResult.codAutorizacion,
      serviceType,
      serviceDate: serviceDateStr,
      hours,
    });

    return {
      status: 'enviado',
      numeroComprobante: submitResult.numeroComprobante,
      codAutorizacion: submitResult.codAutorizacion,
    };
  }

  /** Grava `status='erro'` com `error_message` preenchido — CHECK `chk_axonico_lancamento_error_message`
   *  exige isso, e proíbe `error_message` nos demais status (nunca chamar isto fora deste caso). */
  private async gravaErro(
    documentNumber: string,
    serviceType: EnliteServiceType,
    serviceDateStr: string,
    hours: number,
    err: unknown,
  ): Promise<void> {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const inserted = await this.lancamentoRepository.insert({
      patientId: null,
      documentNumber,
      serviceType,
      serviceDate: serviceDateStr,
      hours,
      numeroComprobante: null,
      codAutorizacion: null,
      status: 'erro',
      errorMessage,
    });
    // Nunca logar documentNumber (DNI) — PII clínica. Não há mais patientId (19/09/2026) — o log
    // correlaciona por serviceType/serviceDate e por insertedId (a linha gravada).
    logger.warn({
      msg: `${TAG} tentativa falhou — gravando status=erro`,
      insertedId: inserted.id,
      serviceType,
      serviceDate: serviceDateStr,
      errorMessage,
    });
  }
}

export default LancarPrestacaoAxonicoUseCase;
