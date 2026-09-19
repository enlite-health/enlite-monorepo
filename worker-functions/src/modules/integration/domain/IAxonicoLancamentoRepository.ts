/**
 * IAxonicoLancamentoRepository — porta de domínio para `axonico_comprobante_lancamento`
 * (migration 445, change `integracao-axonico` F2). Mesmo padrão de nomeação dos irmãos do módulo
 * (`IAxonicoApiClient`, `ITalentumApiClient`, `IAnaCareApiClient`): porta separada da
 * implementação (`infrastructure/AxonicoLancamentoRepository.ts`).
 *
 * Desenho (F2, decisão do coordenador): CADA TENTATIVA de envio é uma linha nova — não existe
 * `update(status)`. O que impede duas tentativas `enviado` para a mesma tripla
 * `(document_number, service_type, service_date)` é o índice único parcial no banco (migration
 * 445), não uma checagem no código: `insert` PODE lançar por violação de constraint, e é o
 * CHAMADOR (F3) quem decide o que fazer com isso.
 *
 * CORREÇÃO (18/09/2026, antes do merge): a tripla de dedupe era `(patient_id, service_type,
 * service_date)`. Errado — o Axonico fatura pelo DNI (via `historia_clinica`, que é derivada
 * dele), não pelo nosso `patient_id`, e dois cadastros nossos podem compartilhar o mesmo DNI (sem
 * UNIQUE em `patients.document_number`). `findExisting` e `insert` agora chaveiam por
 * `documentNumber` (já normalizado pelo chamador — ver `domain/documentNumber.ts`), não por
 * `patientId`. `patientId` continua em `InsertAxonicoLancamentoParams`/`AxonicoLancamentoRecord`
 * — rastreabilidade de qual cadastro gerou a tentativa —, só sai da chave de dedupe.
 */
import type { EnliteServiceType } from './EnliteServiceType';

/** Status de uma tentativa de lançamento — mesmo vocabulário do CHECK da migration 445. */
export type AxonicoLancamentoStatus = 'enviado' | 'duplicado' | 'erro';

/** Uma linha de `axonico_comprobante_lancamento`, já lida do banco. */
export interface AxonicoLancamentoRecord {
  id: string;
  patientId: string;
  /** DNI normalizado — chave do dedupe (índice `uq_axonico_lancamento_dedupe`). */
  documentNumber: string;
  serviceType: EnliteServiceType;
  /** `service_date` da tabela — data (`YYYY-MM-DD`), nunca timestamp. */
  serviceDate: string;
  hours: number;
  numeroComprobante: string | null;
  codAutorizacion: string | null;
  status: AxonicoLancamentoStatus;
  errorMessage: string | null;
  createdAt: Date;
}

/** Parâmetros de `insert` — uma tentativa nova. */
export interface InsertAxonicoLancamentoParams {
  patientId: string;
  /** DNI normalizado (ver `domain/documentNumber.ts`) — chave do dedupe. */
  documentNumber: string;
  serviceType: EnliteServiceType;
  serviceDate: string;
  hours: number;
  numeroComprobante: string | null;
  codAutorizacion: string | null;
  status: AxonicoLancamentoStatus;
  errorMessage: string | null;
}

export interface IAxonicoLancamentoRepository {
  /**
   * Busca a tentativa `status='enviado'` já gravada para a tripla `(documentNumber, serviceType,
   * serviceDate)` — a mesma tripla que o índice único parcial da migration 445 protege.
   * `documentNumber` é o DNI JÁ NORMALIZADO (ver `domain/documentNumber.ts`) — o repositório não
   * normaliza, o chamador garante. `null` = nenhum lançamento bem-sucedido ainda para esta tripla.
   */
  findExisting(
    documentNumber: string,
    serviceType: EnliteServiceType,
    serviceDate: string,
  ): Promise<AxonicoLancamentoRecord | null>;

  /**
   * Grava UMA tentativa nova. Nunca faz `ON CONFLICT DO UPDATE` — uma segunda tentativa
   * `status='enviado'` para a mesma tripla de `documentNumber` de uma tentativa `enviado` já
   * existente ESTOURA por violação do índice único parcial (`uq_axonico_lancamento_dedupe`),
   * propositalmente: é essa violação que prova, em teste, que o dedupe local é real.
   */
  insert(params: InsertAxonicoLancamentoParams): Promise<AxonicoLancamentoRecord>;
}
