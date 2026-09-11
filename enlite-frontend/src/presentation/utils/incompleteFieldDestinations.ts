/**
 * incompleteFieldDestinations.ts
 *
 * Fonte única do mapa token → destino no perfil do worker.
 * Usado pelo IncompleteRegistrationModal para gerar links diretos ao campo pendente.
 *
 * Contrato de URL: /worker/profile?tab=<TabId>[&focus=<alvo>]
 * - focus para documentos = docType sem prefixo "doc_"
 *   ex: doc_resume_cv → resume_cv → data-testid="doc-slot-resume_cv"
 * - focus para campos gerais = id do input no DOM
 *   ex: first_name → fullName → id="fullName"
 * - sem focus: address e availability (sem alvo específico de scroll)
 */

export type TabId = 'general' | 'address' | 'availability' | 'documents';

export interface FieldDestination {
  tab: TabId;
  focus?: string;
}

/**
 * Mapa canônico: token (snake_case da API) → destino no perfil.
 * Os valores de `focus` para aba "general" são os ids REAIS do DOM
 * confirmados em GeneralInfoFormFields.tsx:
 *   fullName (id="fullName"), lastName (id="lastName"), sex (id="sex"),
 *   gender (id="gender"), cpf (id="cpf"), birthDate (id="birthDate"),
 *   phone (data-focus-id="phone" via wrapper), languages (data-focus-id="languages"),
 *   profession (id="profession"), knowledgeLevel (id="knowledgeLevel"),
 *   professionalLicense (id="professionalLicense"), yearsExperience (id="yearsExperience"),
 *   experienceTypes (data-focus-id="experienceTypes"),
 *   preferredTypes (data-focus-id="preferredTypes"),
 *   preferredAgeRange (data-focus-id="preferredAgeRange")
 */
const FIELD_DESTINATION_MAP: Record<string, FieldDestination> = {
  // Campos gerais — focus = id real do input/wrapper no DOM
  first_name: { tab: 'general', focus: 'fullName' },
  last_name: { tab: 'general', focus: 'lastName' },
  sex: { tab: 'general', focus: 'sex' },
  gender: { tab: 'general', focus: 'gender' },
  birth_date: { tab: 'general', focus: 'birthDate' },
  document_number: { tab: 'general', focus: 'cpf' },
  phone: { tab: 'general', focus: 'phone' },
  languages: { tab: 'general', focus: 'languages' },
  profession: { tab: 'general', focus: 'profession' },
  knowledge_level: { tab: 'general', focus: 'knowledgeLevel' },
  title_certificate: { tab: 'general', focus: 'professionalLicense' },
  years_experience: { tab: 'general', focus: 'yearsExperience' },
  experience_types: { tab: 'general', focus: 'experienceTypes' },
  preferred_types: { tab: 'general', focus: 'preferredTypes' },
  preferred_age_range: { tab: 'general', focus: 'preferredAgeRange' },

  // Áreas de atendimento — aba address, sem focus específico
  worker_service_areas: { tab: 'address' },

  // Disponibilidade — aba availability, sem focus específico
  worker_availability: { tab: 'availability' },

  /**
   * Token GROSSO de documentos, como `fn_worker_missing_fields` o devolve.
   *
   * O 403 da postulação expande `worker_documents` nos `doc_*` específicos
   * (`BlockedApplicationRepository.expandDocumentToken`), mas o `GET /progress`
   * entrega o token cru. Os dois vocabulários existem; ambos têm de cair na
   * MESMA aba, senão o token não mapeado cairia no fallback 'general' e
   * marcaria a etapa 1 como pendente sem motivo.
   */
  worker_documents: { tab: 'documents' },

  // Documentos — focus = docType sem prefixo "doc_"
  doc_resume_cv: { tab: 'documents', focus: 'resume_cv' },
  doc_identity_document: { tab: 'documents', focus: 'identity_document' },
  doc_criminal_record: { tab: 'documents', focus: 'criminal_record' },
  doc_at_certificate: { tab: 'documents', focus: 'at_certificate' },
};

/**
 * Tokens que este mapa conhece — a lista de campos do portão de REGISTERED,
 * do ponto de vista do frontend.
 *
 * NÃO é uma segunda definição de completude: é a tradução token→aba. Quem
 * decide o que falta é `fn_worker_missing_fields` no banco, e o teste de
 * contrato (`workerProgressValidation.contract.test.ts`) reprova se o backend
 * passar a devolver um token que não esteja aqui.
 */
export const KNOWN_TOKENS: string[] = Object.keys(FIELD_DESTINATION_MAP);

/** Fallback seguro para tokens desconhecidos */
const FALLBACK_DESTINATION: FieldDestination = { tab: 'general' };

/**
 * Retorna o destino para o token informado.
 * Tokens desconhecidos retornam { tab: 'general' } sem focus.
 */
export function destinationFor(token: string): FieldDestination {
  return FIELD_DESTINATION_MAP[token] ?? FALLBACK_DESTINATION;
}

/**
 * Ordem de prioridade das abas para determinar a "primeira aba pendente" —
 * e, geral/address/availability (sem 'documents'), a ordem de registro que
 * `PendingTasksCard` usa pra agrupar linhas (DD2). Exportado pra não nascer
 * uma segunda lista da mesma ordem em outro arquivo.
 */
export const TAB_ORDER: readonly TabId[] = ['general', 'address', 'availability', 'documents'];

/**
 * Retorna a TabId da primeira aba que contém algum campo pendente.
 * Respeita a ordem: general → address → availability → documents.
 * Se nenhum token mapear para uma aba conhecida, retorna 'general'.
 */
export function firstPendingTab(missingFields: string[]): TabId {
  for (const tab of TAB_ORDER) {
    const hasFieldInTab = missingFields.some((token) => {
      const dest = FIELD_DESTINATION_MAP[token];
      return dest?.tab === tab;
    });
    if (hasFieldInTab) return tab;
  }
  return 'general';
}

/**
 * Gera a URL para /worker/profile com os query params corretos.
 * Se `focus` estiver presente, inclui `?tab=<tab>&focus=<focus>`.
 * Caso contrário, só `?tab=<tab>`.
 */
export function buildProfileUrl(dest: FieldDestination): string {
  const params = new URLSearchParams({ tab: dest.tab });
  if (dest.focus) params.set('focus', dest.focus);
  return `/worker/profile?${params.toString()}`;
}
