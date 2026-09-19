/**
 * Interface do serviço que registra o DNI de um paciente do Ana Care quando a fonte não mandou
 * documento (migration 446) — consumido pelo modal de documento aberto no clique de "Enviar"
 * quando `axonicoDayEligibility` acusa `missingDocument` (decisão do Gabriel, 19/09: "se o
 * paciente NÃO TIVER DNI, ao clicar em Enviar, perguntar e registrar; depois disso não perguntar
 * mais"). MESMO padrão de `AxonicoComprobanteService.ts` — a rota é de outro domínio (identidade
 * do paciente, não Axonico), mas o desenho de contrato/erro é idêntico.
 *
 * Contrato (fixo, confirmado contra `RegistrarDocumentoPacienteAnaCareController.ts` e
 * `adminIntegrationsRoutes.ts` nesta mesma worktree):
 *  `POST /api/admin/integrations/anacare/patient-document`
 *  corpo: `{ anaCarePatientId, documentNumber, documentType? }`
 *  sucesso 200: `{ success: true, data: { status: 'registrado'|'ja_registrado', record } }`
 *  erro: `{ success: false, error: '<NomeDoErro>', message }` com status 400 (corpo inválido /
 *    `AnaCarePatientIdAusenteError`), 422 (`DocumentoInvalidoError`), 409
 *    (`DocumentoJaRegistradoDivergenteError` — já existe com número DIFERENTE).
 */
export interface RegisterAnaCarePatientDocumentCommand {
  anaCarePatientId: string;
  documentNumber: string;
  documentType?: string;
}

export type RegisterAnaCarePatientDocumentStatus = 'registrado' | 'ja_registrado';

export interface AnaCarePatientDocumentRecord {
  id: string;
  anaCarePatientId: string;
  documentNumber: string;
  documentType?: string;
  registeredBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterAnaCarePatientDocumentResult {
  status: RegisterAnaCarePatientDocumentStatus;
  record: AnaCarePatientDocumentRecord;
}

/** Erro de negócio devolvido pela rota — `code` é o `error` literal do corpo (nome do erro, ex. "DocumentoJaRegistradoDivergenteError"), `message` é o texto pronto do backend (não usado na tela — a tela traduz por `code`, ver `AxonicoDocumentModal`). */
export class AnaCarePatientDocumentServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AnaCarePatientDocumentServiceError';
    this.code = code;
  }
}

export interface AnaCarePatientDocumentService {
  registerDocument(command: RegisterAnaCarePatientDocumentCommand): Promise<RegisterAnaCarePatientDocumentResult>;
}
