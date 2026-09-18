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
 * Guards, na ordem (ver design.md §F3):
 *   0. `document_number` do paciente é NULL (ou paciente não existe) → `PatienteSemDniError`.
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
import type { IPatientReadPort } from '../domain/IPatientReadPort';
import type { IAxonicoApiClient } from '../domain/IAxonicoApiClient';
import type { IAxonicoLancamentoRepository } from '../domain/IAxonicoLancamentoRepository';
import { resolveServiceMapping } from '../infrastructure/AxonicoServiceMapping';

const TAG = '[LancarPrestacaoAxonicoUseCase]';

// ─────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────

export interface LancarPrestacaoAxonicoInput {
  patientId: string;
  serviceType: EnliteServiceType;
  /** Data da prestação — só a data importa (mesmo contrato de `SubmitComprobanteParams`). */
  serviceDate: Date;
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

/** Guard 0 — paciente inexistente ou `document_number IS NULL`. */
export class PacienteSemDniError extends Error {
  readonly patientId: string;
  readonly reason: 'not_found' | 'no_document';

  constructor(patientId: string, reason: 'not_found' | 'no_document') {
    const detail = reason === 'not_found' ? 'paciente não encontrado' : 'document_number ausente';
    super(`${TAG} guard 0 — patientId='${patientId}': ${detail}`);
    this.name = 'PacienteSemDniError';
    this.patientId = patientId;
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
 * Dedupe remoto (guard 4) — `findPatientByDni` não achou o paciente no Axonico pelo DNI que nosso
 * banco tem cadastrado. Não é guard (já tocou rede) — grava `status='erro'` como qualquer outra
 * falha desta etapa.
 */
export class AxonicoPacienteNaoEncontradoError extends Error {
  readonly patientId: string;

  constructor(patientId: string) {
    super(`${TAG} findPatientByDni não encontrou paciente no Axonico para patientId='${patientId}'`);
    this.name = 'AxonicoPacienteNaoEncontradoError';
    this.patientId = patientId;
  }
}

// ─────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────

export class LancarPrestacaoAxonicoUseCase {
  constructor(
    private readonly patientReadPort: IPatientReadPort,
    private readonly axonicoApiClient: IAxonicoApiClient,
    private readonly lancamentoRepository: IAxonicoLancamentoRepository,
  ) {}

  async execute(input: LancarPrestacaoAxonicoInput): Promise<LancarPrestacaoAxonicoResult> {
    const { patientId, serviceType, serviceDate, hours } = input;
    const serviceDateStr = formatServiceDateYMD(serviceDate);

    // ── Guard 0 — DNI presente ───────────────────────────────────
    const patientRecord = await this.patientReadPort.findDocumentNumber(patientId);
    if (!patientRecord) {
      throw new PacienteSemDniError(patientId, 'not_found');
    }
    if (patientRecord.documentNumber === null) {
      throw new PacienteSemDniError(patientId, 'no_document');
    }
    const documentNumber = patientRecord.documentNumber;

    // ── Guard 1 — hora cheia (D366) ──────────────────────────────
    if (!Number.isInteger(hours) || hours <= 0) {
      throw new HoraQuebradaError(hours);
    }

    // ── Guard 2 — dedupe local (nossa tabela primeiro; roda ANTES do teto) ──────
    const existingLocal = await this.lancamentoRepository.findExisting(patientId, serviceType, serviceDateStr);
    if (existingLocal) {
      logger.info({ msg: `${TAG} dedupe local — já enviado`, patientId, serviceType, serviceDate: serviceDateStr });
      await this.lancamentoRepository.insert({
        patientId,
        serviceType,
        serviceDate: serviceDateStr,
        hours,
        numeroComprobante: null,
        codAutorizacion: null,
        status: 'duplicado',
        errorMessage: null,
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
      throw new AxonicoTetoIndisponivelError(hours, cause);
    }
    if (cantidadMaxPrestacoes === null) {
      throw new AxonicoTetoIndisponivelError(hours, 'cantidad_max_prestaciones ausente na resposta');
    }
    if (hours > cantidadMaxPrestacoes) {
      throw new AxonicoTetoExcedidoError(hours, cantidadMaxPrestacoes);
    }

    // ── Guard 4a — mapeamento de tipo (lança ANTES de tocar rede; CAREGIVER e outros fora do
    //    mapa nunca chegam a `findPatientByDni`) ──────────────────
    const serviceCodes = resolveServiceMapping(serviceType);

    // ── 4a (continuação) — dedupe remoto: findPatientByDni + checkExistingComprobante ──
    let patientMatch: Awaited<ReturnType<IAxonicoApiClient['findPatientByDni']>>;
    let hasExistingRemote: boolean;
    try {
      patientMatch = await this.axonicoApiClient.findPatientByDni(documentNumber);
      if (!patientMatch) {
        throw new AxonicoPacienteNaoEncontradoError(patientId);
      }
      hasExistingRemote = await this.axonicoApiClient.checkExistingComprobante({
        historiaClinica: patientMatch.historiaClinica,
        nroCobertura: patientMatch.nroCobertura,
        serviceCodes,
        serviceDate,
      });
    } catch (err) {
      await this.gravaErro(patientId, serviceType, serviceDateStr, hours, err);
      throw err;
    }

    if (hasExistingRemote) {
      logger.info({ msg: `${TAG} dedupe remoto — comprobante já existe no Axonico`, patientId, serviceType, serviceDate: serviceDateStr });
      const insertedDuplicado = await this.lancamentoRepository.insert({
        patientId,
        serviceType,
        serviceDate: serviceDateStr,
        hours,
        numeroComprobante: null,
        codAutorizacion: null,
        status: 'duplicado',
        errorMessage: null,
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
      await this.gravaErro(patientId, serviceType, serviceDateStr, hours, err);
      throw err;
    }

    try {
      await this.lancamentoRepository.insert({
        patientId,
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
      // cobre a GRAVAÇÃO LOCAL falhando depois disso (pool caído, corrida na UNIQUE parcial
      // uq_axonico_lancamento_dedupe, FK). NÃO gravar 'erro' aqui seria mentira (o lançamento
      // teve sucesso no Axonico) e a escrita provavelmente falharia pelo mesmo motivo. Este log é
      // o ÚNICO rastro que sobra do faturamento — por isso carrega numeroComprobante/
      // codAutorizacion, nunca dado clínico/PII (patientId é UUID, metadado operacional).
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({
        msg: `${TAG} comprovante FOI CRIADO no Axonico mas a gravação local falhou — faturamos e nosso lado não registrou`,
        numeroComprobante: submitResult.numeroComprobante,
        codAutorizacion: submitResult.codAutorizacion,
        patientId,
        serviceType,
        serviceDate: serviceDateStr,
        hours,
        errorMessage,
      });
      throw err;
    }

    return {
      status: 'enviado',
      numeroComprobante: submitResult.numeroComprobante,
      codAutorizacion: submitResult.codAutorizacion,
    };
  }

  /** Grava `status='erro'` com `error_message` preenchido — CHECK `chk_axonico_lancamento_error_message`
   *  exige isso, e proíbe `error_message` nos demais status (nunca chamar isto fora deste caso). */
  private async gravaErro(
    patientId: string,
    serviceType: EnliteServiceType,
    serviceDateStr: string,
    hours: number,
    err: unknown,
  ): Promise<void> {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn({ msg: `${TAG} tentativa falhou — gravando status=erro`, patientId, serviceType, serviceDate: serviceDateStr, errorMessage });
    await this.lancamentoRepository.insert({
      patientId,
      serviceType,
      serviceDate: serviceDateStr,
      hours,
      numeroComprobante: null,
      codAutorizacion: null,
      status: 'erro',
      errorMessage,
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD`, hora local (mesma convenção de `formatDate` em `AxonicoApiClient.ts`, que também
 *  usa componentes locais de `Date` — nunca UTC). Formato exigido por `service_date DATE` (migration
 *  445) via `$N::date`. */
function formatServiceDateYMD(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export default LancarPrestacaoAxonicoUseCase;
