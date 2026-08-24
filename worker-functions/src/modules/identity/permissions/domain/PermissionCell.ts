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
