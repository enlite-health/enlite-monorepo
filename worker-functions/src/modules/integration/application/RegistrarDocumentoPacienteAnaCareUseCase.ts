/**
 * RegistrarDocumentoPacienteAnaCareUseCase — guarda o DNI de um paciente do Ana Care que não tem
 * documento na fonte, para não perguntar de novo (pendência da conferência de horas, decisão do
 * Gabriel 19/09/2026, migration 446).
 *
 * Mesmo padrão de `LancarPrestacaoAxonicoUseCase`: erros NOMEADOS como classes (facilita
 * `instanceof` no controller), injeção por construtor (porta de domínio mockável, nunca `Pool`
 * direto aqui). Validação do documento reusa `normalizeAndValidateDocumentNumber`
 * (`domain/documentNumber.ts`) — proibido regex novo.
 *
 * Ação é HONESTAMENTE `create` (célula `patient_identity:create`, nunca `write` — recurso
 * splitado): nunca sobrescreve um documento já registrado com um número DIFERENTE — isso seria
 * uma atualização silenciosa disfarçada de criação. Com o MESMO número (já normalizado) devolve
 * sucesso idempotente (200), sem tentar `insert` de novo.
 */

import type { IAnaCarePatientDocumentRepository, AnaCarePatientDocumentRecord } from '../domain/IAnaCarePatientDocumentRepository';
import { normalizeAndValidateDocumentNumber } from '../domain/documentNumber';

const TAG = '[RegistrarDocumentoPacienteAnaCareUseCase]';

export interface RegistrarDocumentoPacienteAnaCareInput {
  anaCarePatientId: string;
  /** DNI RAW, ainda não normalizado — o guard 0 normaliza e valida. */
  documentNumber: string;
  documentType?: string;
  /** uid do staff autor (ator da requisição) — grava em `registered_by`. */
  registeredBy: string;
}

export type RegistrarDocumentoPacienteAnaCareResult =
  | { status: 'registrado'; record: AnaCarePatientDocumentRecord }
  | { status: 'ja_registrado'; record: AnaCarePatientDocumentRecord };

/** Guard 0 — `anaCarePatientId` ausente/vazio. */
export class AnaCarePatientIdAusenteError extends Error {
  constructor() {
    super(`${TAG} guard 0 — anaCarePatientId ausente`);
    this.name = 'AnaCarePatientIdAusenteError';
  }
}

/** Guard 1 — `documentNumber` ausente ou inválido (não é um DNI de 7/8 dígitos normalizado). */
export class DocumentoInvalidoError extends Error {
  readonly reason: 'ausente' | 'invalido';

  constructor(reason: 'ausente' | 'invalido') {
    const detail = reason === 'ausente' ? 'documentNumber ausente' : 'documentNumber inválido (não é um DNI de 7/8 dígitos)';
    super(`${TAG} guard 1 — ${detail}`);
    this.name = 'DocumentoInvalidoError';
    this.reason = reason;
  }
}

/**
 * Guard 2 — já existe documento registrado para este paciente com número DIFERENTE do recebido.
 * Nunca sobrescreve — a ação é `create`, não `update`; mudar um documento já registrado exige
 * fluxo/decisão própria, fora deste use case.
 */
export class DocumentoJaRegistradoDivergenteError extends Error {
  readonly anaCarePatientId: string;
  readonly existente: AnaCarePatientDocumentRecord;

  constructor(anaCarePatientId: string, existente: AnaCarePatientDocumentRecord) {
    super(`${TAG} guard 2 — já existe documento registrado para este paciente com número diferente do recebido`);
    this.name = 'DocumentoJaRegistradoDivergenteError';
    this.anaCarePatientId = anaCarePatientId;
    this.existente = existente;
  }
}

export class RegistrarDocumentoPacienteAnaCareUseCase {
  constructor(private readonly repository: IAnaCarePatientDocumentRepository) {}

  async execute(input: RegistrarDocumentoPacienteAnaCareInput): Promise<RegistrarDocumentoPacienteAnaCareResult> {
    const anaCarePatientId = input.anaCarePatientId?.trim();
    if (!anaCarePatientId) {
      throw new AnaCarePatientIdAusenteError();
    }

    const dniValidation = normalizeAndValidateDocumentNumber(input.documentNumber);
    if (!dniValidation.valid) {
      throw new DocumentoInvalidoError(dniValidation.reason === 'ausente' ? 'ausente' : 'invalido');
    }
    const documentNumber = dniValidation.normalized;
    const documentType = input.documentType?.trim() || null;

    // ── Guard 2 — nunca sobrescreve. Mesmo número já normalizado = idempotente (200); número
    //    diferente = 409 (guard, não corrida — decidido ANTES de qualquer INSERT). ──────────────
    const existing = await this.repository.findByPatientId(anaCarePatientId);
    if (existing) {
      if (existing.documentNumber === documentNumber) {
        return { status: 'ja_registrado', record: existing };
      }
      throw new DocumentoJaRegistradoDivergenteError(anaCarePatientId, existing);
    }

    try {
      const record = await this.repository.insert({
        anaCarePatientId,
        documentNumber,
        documentType,
        registeredBy: input.registeredBy,
      });
      return { status: 'registrado', record };
    } catch (err) {
      // Corrida: outra requisição concorrente para o MESMO anaCarePatientId venceu o INSERT entre
      // o `findByPatientId` do guard 2 e este `insert` — mesma janela que
      // `AxonicoLancamentoConcorrenteError` fecha para o módulo irmão. `23505` é o índice único
      // `uq_ana_care_patient_document_patient` (migration 446) estourando; reconsulta e decide o
      // MESMO par idempotente/divergente do guard 2, nunca deixa o 23505 cru virar 500.
      const code = (err as { code?: string } | null)?.code;
      if (code === '23505') {
        const winner = await this.repository.findByPatientId(anaCarePatientId);
        if (winner) {
          if (winner.documentNumber === documentNumber) {
            return { status: 'ja_registrado', record: winner };
          }
          throw new DocumentoJaRegistradoDivergenteError(anaCarePatientId, winner);
        }
      }
      throw err;
    }
  }
}

export default RegistrarDocumentoPacienteAnaCareUseCase;
