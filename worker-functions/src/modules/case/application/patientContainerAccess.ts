/**
 * patientContainerAccess — o ÚNICO ponto que decide, container a container, o que da ficha e da
 * lista de paciente um ator recebe (D286, 05/09/2026; `lex` 06/09: CONDICIONADO, P1-P6 + C1-C12).
 *
 * A tela de detalhe do paciente é um conjunto de CONTAINERS (Identidade, Diagnóstico, Familiares,
 * Chat IDs, Cobertura, Localizações, Serviços contratados…), e cada um ganha célula própria de
 * leitura e de escrita. Esconder o card na tela NÃO é permissão: quem abre o console vê a resposta
 * inteira. Por isso a decisão é feita AQUI, antes de a resposta sair — e, para familiares, equipe e
 * e-mail de contato, antes de o KMS descriptografar (`lex` P3; mesmo desenho da C3 de prestador em
 * `projectWorkerFields`).
 *
 * ── Os containers e a CÉLULA de cada um (por DADO, nunca por tela — `lex` A) ─────────────────
 *  · `patient`            id, status, funil de admissão, caso, SLA, país, atenção — nada que
 *                         identifique (o operacional; `patient:read` é a célula da lista/kanban)
 *  · `patient_identity`   nome, documento, nascimento, sexo, telefone, e-mail de contato
 *  · `patient_clinical`   diagnóstico (livre e CID-11), dependência, especialidade, dispositivos,
 *                         observações, CUD, proteção judicial, consentimento, texto restrito
 *                         (`emergency_instructions`/`on_hold_note` — a célula JÁ existia para
 *                         estes dois, `patientClinicalAccess.ts`; é a MESMA chave, `lex` P4)
 *  · `patient_care_team`  equipe tratante (terceiros: nome/telefone/e-mail de profissionais)
 *  · `patient_family`     familiares/responsáveis (terceiros; base legal própria — `lex` C)
 *  · `patient_chat`       ids de grupo de WhatsApp do caso (chave de acesso a conversa clínica)
 *  · `patient_coverage`   obra social / plano, afiliado, verificação de cobertura
 *  · `patient_address`    endereços e localidade — a MESMA célula vale no mapa (`lex` C7)
 *  · `patient_services`   serviços contratados, profissão requerida, início do serviço
 *
 *  · `patient_therapeutic_project` projeto terapêutico versionado (spec 017): a ficha só carrega o
 *                         marcador; as versões saem por rota própria, projetadas em
 *                         `therapeuticProjectAccess.ts` (texto clínico só com `patient_clinical:read`)
 *
 * Cards que ainda são placeholder (supervisão, relatórios) NÃO têm célula: célula sem consumidor é
 * o que a catraca de dívida acusa (`lex` P2; D286 adendo a).
 *
 * ── `cells = null` NÃO é "nenhuma célula" ───────────────────────────────────────────────────
 * É "o engine não decidiu nesta request" (família fora de `PERMISSION_ENFORCED_ROUTES`, principal
 * de serviço, engine desligado). Nesse estado tudo passa, como a rota devolvia antes (D113). `[]`
 * é ator conhecido e sem célula → redige tudo que não for operacional.
 *
 * ── Marcador de redação CONSTANTE (`lex` C3) ────────────────────────────────────────────────
 * `redacted.<container> = true` sai SEMPRE que falta a célula — com ou sem conteúdo no campo. Se
 * o marcador dependesse de haver diagnóstico, "existe diagnóstico" vazaria por inferência
 * (LGPD art. 11 §5).
 */

export const PATIENT_CONTAINERS = [
  'identity',
  'clinical',
  'careTeam',
  'family',
  'chat',
  'coverage',
  'address',
  'services',
  // Spec 017 (D299.3): o projeto terapêutico deixa de ser placeholder. As versões vivem em rota
  // própria (`/patients/:id/therapeutic-projects`, `therapeuticProjectAccess.ts`); aqui o container
  // existe para o marcador constante na ficha (lex C8) e para a trilha de containers servidos.
  'therapeuticProject',
] as const;
export type PatientContainer = (typeof PATIENT_CONTAINERS)[number];

/** Recurso (o `resource` da célula `recurso:ação`) de cada container. */
export const PATIENT_CONTAINER_RESOURCE: Readonly<Record<PatientContainer, string>> = {
  identity: 'patient_identity',
  clinical: 'patient_clinical',
  careTeam: 'patient_care_team',
  family: 'patient_family',
  chat: 'patient_chat',
  coverage: 'patient_coverage',
  address: 'patient_address',
  services: 'patient_services',
  therapeuticProject: 'patient_therapeutic_project',
};

export const patientContainerCell = (container: PatientContainer, action: 'read' | 'write'): string =>
  `${PATIENT_CONTAINER_RESOURCE[container]}:${action}`;

/** O que cada container carrega na FICHA (`PatientDetailRow` + o que o controller anexa). */
const DETAIL_FIELDS: Readonly<Record<PatientContainer, readonly string[]>> = {
  identity: [
    'firstName', 'lastName', 'birthDate', 'documentType', 'documentNumber', 'sex', 'phoneWhatsapp', 'contactEmail',
  ],
  clinical: [
    'diagnosis', 'diagnoses', 'diagnosesUnavailable', 'dependencyLevel', 'clinicalSpecialty', 'clinicalSegments',
    'deviceType', 'deviceTypes', 'additionalComments', 'additionalCommentsUpdatedAt', 'additionalCommentsUpdatedBy',
    'emergencyInstructions', 'emergencyInstructionsUpdatedAt', 'emergencyInstructionsUpdatedBy', 'onHoldNote',
    'hasJudicialProtection', 'hasCud', 'hasConsent',
  ],
  careTeam: ['professionals'],
  family: ['responsibles', 'phoneMatchesResponsible'],
  chat: ['chatIds', 'familyChatId', 'providersChatId'],
  coverage: ['affiliateId', 'insuranceInformed', 'insuranceVerified', 'insuranceVerifiedCodes', 'insuranceVerifiedEntries', 'coverageEmergencyContacts'],
  address: ['addresses', 'cityLocality', 'province', 'zoneNeighborhood'],
  services: ['contractedServices', 'serviceType', 'serviceStartDate'],
  // Nenhum campo na ficha: as versões saem pela rota própria. O marcador `redacted.therapeuticProject`
  // continua constante (lex C8) — "existe projeto" não vaza por ausência de campo.
  therapeuticProject: [],
};

/** O que cada container carrega na LISTA/Kanban (`toAdminPatientListItem`). */
const LIST_FIELDS: Readonly<Partial<Record<PatientContainer, readonly string[]>>> = {
  identity: [
    'firstName', 'lastName', 'documentType', 'documentNumber', 'sex', 'responsibleName', 'leadContactEmailMasked',
    'leadContactIsResponsible',
  ],
  clinical: ['diagnosis', 'dependencyLevel', 'clinicalSpecialty'],
  services: ['serviceType'],
  address: ['addressesCount'],
};

/** Que containers o ator pode LER. `null` (engine não decidiu) → todos. */
export type PatientContainerReads = Readonly<Record<PatientContainer, boolean>>;

export function canReadPatientContainer(cells: readonly string[] | null | undefined, container: PatientContainer): boolean {
  if (cells === null || cells === undefined) return true;
  return cells.includes(patientContainerCell(container, 'read'));
}

export function patientContainerReadsOf(cells: readonly string[] | null | undefined): PatientContainerReads {
  const out = {} as Record<PatientContainer, boolean>;
  for (const c of PATIENT_CONTAINERS) out[c] = canReadPatientContainer(cells, c);
  return out;
}

export const ALL_PATIENT_CONTAINERS_READABLE: PatientContainerReads = patientContainerReadsOf(null);

function redact<T extends Record<string, unknown>>(
  obj: T,
  reads: PatientContainerReads,
  fieldsByContainer: Readonly<Partial<Record<PatientContainer, readonly string[]>>>,
): T & { redacted?: Partial<Record<PatientContainer, true>> } {
  const hidden = PATIENT_CONTAINERS.filter((c) => !reads[c]);
  if (hidden.length === 0) return obj;
  const out: Record<string, unknown> = { ...obj };
  const redacted: Partial<Record<PatientContainer, true>> = {};
  for (const c of hidden) {
    for (const f of fieldsByContainer[c] ?? []) if (f in out) out[f] = null;
    // Constante: o marcador não depende de o campo ter conteúdo (lex C3).
    redacted[c] = true;
  }
  out.redacted = { ...(obj.redacted as object | undefined), ...redacted };
  return out as T & { redacted: Partial<Record<PatientContainer, true>> };
}

/**
 * A ficha projetada pelos containers do ator. Devolve o MESMO objeto quando o ator lê tudo (sem
 * cópia — a ficha é grande). Campos de container sem célula viram `null`; arrays viram `null`
 * também (não `[]`: `[]` diria "não tem familiares", e o ator não pode saber nem isso).
 */
export function projectPatientDetailByContainers<T extends Record<string, unknown>>(
  patient: T,
  cells: readonly string[] | null | undefined,
): T & { redacted?: Partial<Record<PatientContainer, true>> } {
  return redact(patient, patientContainerReadsOf(cells), DETAIL_FIELDS);
}

/** Uma linha da lista/Kanban projetada pelos containers do ator (`lex` P1: a lista É o export). */
export function projectPatientListItemByContainers<T extends Record<string, unknown>>(
  item: T,
  cells: readonly string[] | null | undefined,
): T & { redacted?: Partial<Record<PatientContainer, true>> } {
  return redact(item, patientContainerReadsOf(cells), LIST_FIELDS);
}

/**
 * `completeness` filtrada pelos containers (`lex` C4): o código `RESPONSIBLE` revela se há
 * familiares, `COVERAGE` se há cobertura, etc. Quem não lê o container não recebe o código —
 * nem em `missing`, nem em `blocking`. `ready`/`canActivate` são recalculados sobre o que sobrou,
 * então um ator parcial pode ver "pronto" para uma ficha que, no todo, não está: por isso o gate
 * de `POST /activate` NUNCA lê esta projeção — ele recalcula do banco (`ActivatePatientUseCase`).
 */
const COMPLETENESS_CODE_CONTAINER: Readonly<Record<string, PatientContainer>> = {
  ADDRESS: 'address',
  RESPONSIBLE: 'family',
  COVERAGE: 'coverage',
  CONTRACTED_SERVICE: 'services',
  CONSENT: 'clinical',
  BIRTH_DATE: 'identity',
};

export function projectCompletenessByContainers<
  C extends { missing: readonly string[]; blocking: readonly string[]; ready: boolean; canActivate: boolean },
>(completeness: C, cells: readonly string[] | null | undefined): C {
  const reads = patientContainerReadsOf(cells);
  const visible = (code: string): boolean => {
    const container = COMPLETENESS_CODE_CONTAINER[code];
    return container === undefined ? true : reads[container];
  };
  const missing = completeness.missing.filter(visible);
  const blocking = completeness.blocking.filter(visible);
  if (missing.length === completeness.missing.length && blocking.length === completeness.blocking.length) return completeness;
  return { ...completeness, missing, blocking, ready: missing.length === 0, canActivate: blocking.length === 0 };
}

/** Os containers efetivamente SERVIDOS nesta resposta — o que a trilha registra (`lex` D/C8). */
export function servedPatientContainers(cells: readonly string[] | null | undefined): PatientContainer[] {
  const reads = patientContainerReadsOf(cells);
  return PATIENT_CONTAINERS.filter((c) => reads[c]);
}

/**
 * O `action` da linha em `resource_access_log` para a abertura da ficha: `read_detail` mais o
 * conjunto ENUMERADO de containers servidos. É a trilha da D do `lex` (uma linha por abertura,
 * na infra existente) — em tabela auditada, não no Cloud Logging (`lex` fase 2, P7).
 */
export function patientDetailTrailAction(cells: readonly string[] | null | undefined): string {
  const served = servedPatientContainers(cells);
  return served.length === 0 ? 'read_detail' : `read_detail:${served.join('+')}`;
}

/** A mesma coisa lida da REQUEST — o que a rota passa ao `logResourceAccess` (avaliado no `finish`). */
export function patientDetailTrailOf(req: { permissionCells?: readonly string[] | null }): string {
  return patientDetailTrailAction(req.permissionCells ?? null);
}
