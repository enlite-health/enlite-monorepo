/**
 * Interface do serviço de exportação das horas de UM paciente num período (spec 032). Serviço
 * SEPARADO de `AnaCareHoursService` de propósito: acrescentar o método lá forçaria os dezenas de
 * mocks literais dessa interface (mesmo racional de `AxonicoComprobanteService`).
 *
 * Contrato (fixo, F1 do backend): `GET /api/admin/anacare-hours/patients/:patientId/export
 * ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD` (Hasta inclusivo, ≤ 62 dias) → xlsx; o nome do arquivo vem
 * no header `X-Export-Filename` (o ÚNICO exposto pelo CORS). Erros reusam `AnaCareHoursServiceError`.
 */
export interface ExportPatientRangeCommand {
  patientId: string;
  /** `YYYY-MM-DD`. */
  desde: string;
  /** `YYYY-MM-DD`, inclusivo. */
  hasta: string;
}

export interface AnaCareHoursExportService {
  /** Baixa o xlsx pelo navegador. Resolve só com o arquivo entregue; em erro lança e NUNCA baixa nada. */
  exportPatientRange(command: ExportPatientRangeCommand): Promise<void>;
}
