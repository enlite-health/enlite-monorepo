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
 *
 * CORREÇÃO (19/09/2026, decisão do Gabriel): o lançamento passou a ser feito pelo `documentNumber`
 * que vem do Ana Care, sem `patientId` de entrada e sem consultar `patients` (ver
 * `LancarPrestacaoAxonicoUseCase` — o `patientReadPort` saiu deste fluxo). `patientId` vira
 * `string | null` — migration 446 tornou a coluna NULLABLE — e hoje toda tentativa grava `null`
 * até o vínculo paciente↔Ana Care existir de verdade.
 *
 * CORREÇÃO (24/09/2026, change `axonico-envio-rastreavel`): `sent_by` (migration 473) — depois de
 * "Enviar" com sucesso, a tela só sabia "está enviado" por ESTADO LOCAL do hook
 * (`useSendComprobanteToAxonico.ts`); ao recarregar, nada persistido dizia "enviado" nem "por
 * quem". `insert` agora grava `sentBy` em TODA tentativa (enviado/duplicado/erro), mesmo molde de
 * `ShiftHoursValidationRepository.validate` (`validatedBy`). `findSentByDocumentAndMonth` é a
 * leitura nova que `AnaCareHoursService.getPatientMonth` usa para anexar `axonico` a cada dia —
 * junta com `users` (JOIN, mesmo padrão de `ShiftHoursValidationRepository.getByShiftIds`) para
 * devolver o `display_name` de quem enviou, não só o uid cru.
 */
import type { EnliteServiceType } from './EnliteServiceType';

/** Status de uma tentativa de lançamento — mesmo vocabulário do CHECK da migration 445. */
export type AxonicoLancamentoStatus = 'enviado' | 'duplicado' | 'erro';

/** Uma linha de `axonico_comprobante_lancamento`, já lida do banco. */
export interface AxonicoLancamentoRecord {
  id: string;
  /** `null` desde 19/09/2026 (migration 446) — não há mais `patientId` de entrada neste fluxo. */
  patientId: string | null;
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
  /** uid (`users.firebase_uid`) de quem disparou esta tentativa (migration 473). `null` = linha gravada antes desta migration. */
  sentBy: string | null;
  createdAt: Date;
}

/** Parâmetros de `insert` — uma tentativa nova. */
export interface InsertAxonicoLancamentoParams {
  /** `null` desde 19/09/2026 — não há mais `patientId` de entrada neste fluxo. */
  patientId: string | null;
  /** DNI normalizado (ver `domain/documentNumber.ts`) — chave do dedupe. */
  documentNumber: string;
  serviceType: EnliteServiceType;
  serviceDate: string;
  hours: number;
  numeroComprobante: string | null;
  codAutorizacion: string | null;
  status: AxonicoLancamentoStatus;
  errorMessage: string | null;
  /** uid (`users.firebase_uid`) de quem disparou esta tentativa — SEMPRE presente (guard de 401 no controller garante isso antes do use case rodar). */
  sentBy: string;
}

/** Uma tentativa `status='enviado'` já gravada, com o `display_name` de quem enviou resolvido via JOIN — usada por `findSentByDocumentAndMonth` (`AnaCareHoursService.getPatientMonth`, item "Por: <nome> · <data>"). */
export interface AxonicoLancamentoSentRecord {
  /** `service_date` da tabela — data (`YYYY-MM-DD`) — chave de casamento com `AnaCareShift.date`. */
  serviceDate: string;
  numeroComprobante: string;
  codAutorizacion: string;
  createdAt: Date;
  /** uid de quem enviou — `null` só é possível para linhas gravadas antes da migration 473. */
  sentBy: string | null;
  /** `users.display_name` resolvido via JOIN — `null` quando `sentBy` é `null`, ou quando o `users` correspondente não tem `display_name`. */
  sentByName: string | null;
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

  /**
   * Tentativas `status='enviado'` para `(documentNumber, serviceType)` dentro do mês de
   * `monthStart` (`'YYYY-MM-01'`) — usada por `AnaCareHoursService.getPatientMonth` para anexar
   * `axonico` a cada dia (casamento por `serviceDate`). JOIN com `users` para trazer o
   * `display_name` de quem enviou (`sentByName`), mesmo padrão de
   * `ShiftHoursValidationRepository.getByShiftIds`. Vazio = nenhum lançamento `enviado` no mês
   * (nunca lançado, ou paciente sem `documentNumber` — o chamador não invoca este método nesse caso).
   */
  findSentByDocumentAndMonth(
    documentNumber: string,
    serviceType: EnliteServiceType,
    monthStart: string,
  ): Promise<AxonicoLancamentoSentRecord[]>;
}
