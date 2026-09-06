/**
 * src/modules/identity/permissions/domain/PermissionCell.ts
 *
 * A CÉLULA da matriz — `recurso:ação` — é a unidade de capacidade do sistema
 * (D115, conceito (a)). Ela é GLOBAL: não carrega país (isso é o eixo (b),
 * `group_country_scopes`) nem disponibilidade (eixo (c), `iam.country_features`).
 *
 * O catálogo de células é DERIVADO do código (design 1b): a rota declara a
 * célula que exige e o scanner sincroniza `iam.permissions` no boot. Este
 * arquivo é o vocabulário compartilhado dessa derivação — formato da chave,
 * categoria do recurso — e não conhece banco nem Express.
 */

/** Categoria de tela do painel (agrupa as células na matriz). Seed da mig 206. */
export const PERMISSION_CATEGORIES = [
  'Trabalhadores',
  'Vagas e Funil',
  'Pacientes',
  'Recrutamento',
  'Analytics',
  'Operações',
  'Comunicação',
  'Importação',
  'Administração',
] as const;

export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

/**
 * Recurso sem categoria declarada. Aparece assim na tela DE PROPÓSITO: jogar o
 * desconhecido em "Operações" esconderia a decisão que falta ser tomada.
 */
export const UNCATEGORIZED = 'Não categorizado';

/**
 * Recurso → categoria. Espelha o seed da migration 206 (41 células / 9
 * categorias) mais as 4 células novas da D116 (`patient:delete`,
 * `integration:execute`, `test_fixtures:execute`, `api_docs:read`).
 *
 * É um mapa por RECURSO (não por célula) porque a categoria é propriedade do
 * recurso: `worker:read` e `worker:delete` moram na mesma linha da matriz.
 */
export const RESOURCE_CATEGORY: Readonly<Record<string, PermissionCategory>> = {
  worker: 'Trabalhadores',
  worker_pii: 'Trabalhadores',
  worker_contact: 'Trabalhadores',
  worker_document: 'Trabalhadores',
  vacancy: 'Vagas e Funil',
  funnel: 'Vagas e Funil',
  interview: 'Vagas e Funil',
  match: 'Vagas e Funil',
  patient: 'Pacientes',
  // D286 (05/09/2026): um recurso por CONTAINER da ficha do paciente — célula por DADO, tela é
  // só agrupamento no painel. Ver `case/application/patientContainerAccess.ts`.
  patient_identity: 'Pacientes',
  patient_clinical: 'Pacientes',
  patient_care_team: 'Pacientes',
  patient_family: 'Pacientes',
  patient_chat: 'Pacientes',
  patient_coverage: 'Pacientes',
  patient_address: 'Pacientes',
  patient_services: 'Pacientes',
  recruitment: 'Recrutamento',
  talentum: 'Recrutamento',
  prescreening: 'Recrutamento',
  analytics: 'Analytics',
  dedup: 'Operações',
  dashboard: 'Operações',
  integration: 'Operações',
  test_fixtures: 'Operações',
  api_docs: 'Operações',
  messaging: 'Comunicação',
  upload: 'Importação',
  user_management: 'Administração',
  permission_management: 'Administração',
};

/**
 * DEFINIÇÃO das células — o que cada uma protege, em uma frase que uma pessoa do
 * time entende ao marcar a caixa na tela.
 *
 * Existe porque a célula sem definição escrita é promessa que ninguém consegue
 * conferir: `worker_pii:read` estava no seed da 206 desde o início com o texto
 * "Visualizar PII sensível de workers (CPF, endereço)" — errado no país onde a
 * empresa opera (é DNI, não CPF) e CALADO justamente sobre o que torna a célula
 * sensível: raça, religião e orientação sexual (Ley 25.326 art. 2 e 7.3;
 * LGPD art. 6 III). Ninguém podia decidir quem recebe uma célula assim.
 *
 * O catálogo é DERIVADO do código (D115): o `sync_permission_cell` faz
 * `COALESCE(EXCLUDED.description, iam.permissions.description)`, então o texto
 * daqui SOBRESCREVE o do seed quando existe, e o seed permanece quando não.
 * Por isso a definição mora aqui e não numa migration: migration é história,
 * definição é vocabulário vivo.
 *
 * ⚠️ Os TRÊS níveis de prestador não são graus do mesmo acesso — são coisas
 * diferentes, e é por isso que telefone e raça não podem compartilhar chave.
 * Dar `worker_pii:read` a toda recrutadora para que ela veja um telefone
 * esvazia a célula: quem abre o Kanban passa a ver o dossiê de brinde.
 */
export const CELL_DESCRIPTION: Readonly<Record<string, string>> = {
  'worker:read':
    'Ver o prestador em operação: identificador, status, ocupação, zona de trabalho e etapa do '
    + 'funil. NÃO inclui nome, telefone nem documento.',
  'worker_contact:read':
    'Ver e usar o CONTATO do prestador: nome, telefone, WhatsApp e e-mail. É o instrumento diário '
    + 'de quem recruta — a operação liga para a pessoa.',
  'worker_pii:read':
    'Ver o DOSSIÊ do prestador: documento (DNI), data de nascimento, endereço, fotos e os dados '
    + 'sensíveis de raça, religião e orientação sexual. Acesso de auditoria e RH, não de operação.',
  'worker:disable':
    'Dar e reverter a baixa do prestador — as transições DE e PARA o estado DISABLED. Exige motivo '
    + 'e não vem em nenhum grupo por padrão.',

  // ── Paciente por CONTAINER (D286; `lex` 06/09 CONDICIONADO, C11: definição escrita no mesmo
  //    commit que cria a célula). `patient:read` fica sendo o OPERACIONAL: id, status, funil de
  //    admissão, caso, SLA, país — nada que identifique a pessoa. Nenhuma destas entra em grupo
  //    por padrão (`lex` P5/E).
  'patient_identity:read':
    'Ver QUEM é o paciente: nome, documento, data de nascimento, sexo, telefone e e-mail de contato. '
    + 'Sem ela a lista e a ficha mostram só o operacional (status, caso, funil).',
  'patient_identity:write':
    'Editar a identidade do paciente (nome, documento, nascimento, sexo, telefone, e-mail de contato).',
  'patient_clinical:read':
    'Ver o quadro CLÍNICO do paciente: patologías (CID-11) e diagnóstico legado, nível de dependência, '
    + 'especialidade, dispositivos, observações, CUD, proteção judicial, consentimento e os textos '
    + 'restritos (instruções de emergência, nota de espera). Dado sensível de saúde — Ley 25.326 art. 2.',
  'patient_clinical:write':
    'Editar o quadro clínico do paciente, inclusive registrar e dar baixa em patologías CID-11.',
  'patient_care_team:read':
    'Ver a EQUIPE TRATANTE do paciente: nome, papel, telefone e e-mail dos profissionais — dado de terceiro.',
  'patient_family:read':
    'Ver FAMILIARES e responsáveis do paciente: nome, vínculo, telefone, e-mail e documento — dado de '
    + 'terceiro, com base legal própria; revela por inferência que há paciente de home care na família.',
  'patient_family:write':
    'Editar familiares e responsáveis do paciente (rede de apoio).',
  'patient_chat:read':
    'Ver os IDs dos grupos de WhatsApp do caso (família, prestadores). O id é a CHAVE de acesso a uma '
    + 'conversa com contexto clínico — não é dado técnico.',
  'patient_chat:write':
    'Vincular e desvincular os grupos de WhatsApp do caso ao paciente.',
  'patient_coverage:read':
    'Ver a COBERTURA médica do paciente: obra social ou plano informado, número de afiliado e a '
    + 'verificação de cobertura.',
  'patient_coverage:write':
    'Editar a cobertura médica do paciente.',
  'patient_address:read':
    'Ver os ENDEREÇOS e a localidade do paciente — inclusive no mapa (a mesma célula vale nos dois '
    + 'lugares: coordenada de domicílio + home care é dado de saúde).',
  'patient_address:write':
    'Cadastrar e editar endereços e a logística de acesso do paciente.',
  'patient_services:read':
    'Ver os SERVIÇOS CONTRATADOS do paciente: serviço, profissão requerida, prestadores associados, '
    + 'início. O valor-hora tem portão próprio e NÃO vem com esta célula.',
  'patient_services:write':
    'Criar, editar e dar baixa em serviços contratados e associar prestadores a eles.',
};

/** Célula do catálogo — o que `iam.permissions` guarda de uma linha. */
export interface PermissionCell {
  resource: string;
  action: string;
  category: string;
  description?: string | null;
  /** Serviço dono da declaração (D115 §7: catálogo distribuído). */
  ownerService: string;
  /** Preenchido quando a célula sumiu do código — nunca apagamos linha. */
  deprecatedAt?: Date | null;
}

/** `recurso` e `ação` aceitos: minúsculas, dígitos e `_` (o formato do seed 206). */
const SEGMENT = /^[a-z][a-z0-9_]*$/;

export function isValidResource(value: string): boolean {
  return SEGMENT.test(value);
}

export function isValidAction(value: string): boolean {
  return SEGMENT.test(value);
}

/** Chave canônica da célula, o formato que `iam.effective_permissions` devolve. */
export function cellKey(resource: string, action: string): string {
  return `${resource}:${action}`;
}

/** Inverso de `cellKey`. Chave malformada → `null` (nunca lança na borda). */
export function parseCellKey(key: string): { resource: string; action: string } | null {
  const parts = key.split(':');
  if (parts.length !== 2) return null;
  const [resource, action] = parts;
  if (!isValidResource(resource) || !isValidAction(action)) return null;
  return { resource, action };
}

export function isValidCellKey(key: string): boolean {
  return parseCellKey(key) !== null;
}

/**
 * Categoria do recurso. Desconhecido → `UNCATEGORIZED` (a tela mostra que falta
 * decidir), nunca uma categoria "quase certa".
 */
export function categoryFor(resource: string): string {
  return RESOURCE_CATEGORY[resource] ?? UNCATEGORIZED;
}
