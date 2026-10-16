/**
 * Domínio dos documentos do paciente (spec 031, D463): tipos da lista, regra do nome (rótulo) e
 * os erros que o controller traduz em HTTP.
 *
 * O NOME do documento é decisão da operadora (D463, Q9): nenhuma regra sobre o CONTEÚDO — só
 * forma (trim, 1–255). Nunca em log/erro: as mensagens de erro abaixo não ecoam o valor.
 */
export const DOCUMENT_LABEL_MAX_LENGTH = 255;

export type PatientDocumentOrigin = 'tab' | 'chat' | 'admission';

/** Forma da lista (contrato da rota GET). `label` é `null` só se a decifra falhar para ESTE item. */
export interface PatientDocumentDto {
  id: string;
  origin: PatientDocumentOrigin;
  label: string | null;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  createdByUid: string;
  createdByDisplayName: string | null;
  labelUpdatedAt: string | null;
}

export class InvalidDocumentLabelError extends Error {
  readonly code = 'INVALID_DOCUMENT_LABEL';
  readonly status = 400;

  constructor() {
    super(`label é obrigatório (1 a ${DOCUMENT_LABEL_MAX_LENGTH} caracteres, sem contar espaços nas pontas)`);
    this.name = 'InvalidDocumentLabelError';
  }
}

export class PatientDocumentNotFoundError extends Error {
  readonly code = 'DOCUMENT_NOT_FOUND';
  readonly status = 404;

  constructor() {
    super('Document not found');
    this.name = 'PatientDocumentNotFoundError';
  }
}

/** `trim`, 1–255. Qualquer outra coisa (não-string, vazio, só espaços, longo demais) recusa. */
export function normalizeDocumentLabel(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidDocumentLabelError();
  const label = raw.trim();
  if (label.length < 1 || label.length > DOCUMENT_LABEL_MAX_LENGTH) throw new InvalidDocumentLabelError();
  return label;
}

export class PatientNotFoundError extends Error {
  readonly code = 'PATIENT_NOT_FOUND';
  readonly status = 404;

  constructor() {
    super('Patient not found');
    this.name = 'PatientNotFoundError';
  }
}
