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
  worker_address: 'Trabalhadores',
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
  patient_contract_value: 'Pacientes',
  // patient_consent_documents (spec 018, PR-4) foi REMOVIDA por completo
  // (fix/018-remover-documentos-consentimento) — documento (prova) e consentimento de imagem
  // saíram; só a foto fica, sob patient_identity:read/write, sem célula própria.
  // Spec 017 (D299.3): o projeto terapêutico e os seus 2 catálogos, na MESMA família admin.patients.
  // `catalog_pathology_types` SAIU (08/09): tipo de patologia deriva do CID-11 — o sync marca a célula deprecada.
  patient_therapeutic_project: 'Pacientes',
  catalog_therapeutic_objectives: 'Pacientes',
  catalog_therapeutic_activities: 'Pacientes',
  // US-17 (spec 018, PR-7, migration 430): catálogo dos segmentos da Ana Care, mesma família.
  catalog_therapeutic_segments: 'Pacientes',
  // Spec `anacare-conferencia-de-horas`, fase 1 (D344/D345): célula PRÓPRIA, fora de qualquer
  // grupo padrão — vizinho de paciente (turnos/horas do Ana Care), não um container da ficha.
  anacare_hours: 'Pacientes',
  recruitment: 'Recrutamento',
  talentum: 'Recrutamento',
  prescreening: 'Recrutamento',
  analytics: 'Analytics',
  dedup: 'Operações',
  dashboard: 'Operações',
  // D286 (06/09): os blocos da Gestión a la Vista, um a um.
  dashboard_numbers: 'Operações',
  dashboard_team: 'Operações',
  dashboard_priorities: 'Operações',
  dashboard_registrations: 'Operações',
  dashboard_funnel: 'Operações',
  dashboard_zones: 'Operações',
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
    'Ver o DOSSIÊ do prestador: documento (DNI), data de nascimento, fotos e os dados sensíveis de '
    + 'raça, religião e orientação sexual. Acesso de auditoria e RH, não de operação.',
  // D286 fase 2 (06/09): o endereço sai do dossiê e vira célula própria, espelho de `patient_address` —
  // a MESMA célula vale no card de endereço da ficha e na aba Prestadores do mapa (coordenada é
  // endereço, `lex` P2; abrir o mapa não pode exigir raça e religião).
  // D286 (06/09) — Gestión a la Vista por bloco. Só contagens e percentuais; a célula existe para
  // o painel dizer o que cada grupo vê da gestão. `dashboard:read` continua sendo abrir a tela.
  'dashboard_numbers:read':
    'Ver o bloco NÚMEROS CLAVE da Gestión a la Vista: pacientes ativos, horas, percentuais de '
    + 'resposta rápida e de capacidade, o que está rodando e o que está chegando.',
  'dashboard_team:read':
    'Ver o bloco EQUIPO ARMADO Y HORAS: classificação dos casos por equipe armada e as horas '
    + 'cobertas por semana.',
  'dashboard_priorities:read':
    'Ver o bloco PRIORIDADES DE CONTACTO: quem a operação precisa contatar primeiro, por urgência.',
  'dashboard_registrations:read':
    'Ver o bloco REGISTROS: cadastros de prestadores e pacientes entrados no período.',
  'dashboard_funnel:read':
    'Ver o bloco TOTALIZACIÓN DEL EMBUDO: candidaturas por etapa e por prestador, com o filtro de '
    + 'período, e os encuadres da semana.',
  'dashboard_zones:read':
    'Ver o bloco ZONAS: pacientes e prestadores por zona e sexo, demanda contra disponibilidade, '
    + 'com filtro por profissão.',
  'worker_address:read':
    'Ver o ENDEREÇO do prestador: linha de endereço, coordenada e raio de atendimento — na ficha e '
    + 'no mapa. Cidade e zona de trabalho não precisam desta célula.',
  'worker:disable':
    'Dar e reverter a baixa do prestador — as transições DE e PARA o estado DISABLED. Exige motivo '
    + 'e não vem em nenhum grupo por padrão.',

  // ── As 5 células da D116, declaradas por rota e nascidas no sync (nunca estiveram no seed 206).
  //    Definição escrita aqui pelo mesmo motivo das outras: o painel mostra o texto ao conceder,
  //    e a fixture de paridade do front (seed ∪ descrições) precisa conhecê-las.
  'patient:delete':
    'Purgar paciente de TESTE (só `is_test`; paciente real responde 409). Ferramenta do monitoramento sintético.',
  'messaging:write':
    'Editar a configuração de mensageria: templates, mensagens por etapa, plantillas, convite à apresentação.',
  'integration:execute':
    'Disparar integrações à mão (espelho Ana Care, sync do ClickUp). Operação, não leitura.',
  'test_fixtures:execute':
    'Criar e apagar dados de teste. Ferramenta do monitoramento sintético (e2e-prod).',
  'api_docs:read':
    'Ver a documentação OpenAPI do backend no painel.',

  // ── Paciente por CONTAINER (D286; `lex` 06/09 CONDICIONADO, C11: definição escrita no mesmo
  //    commit que cria a célula). `patient:read` fica sendo o OPERACIONAL: id, status, funil de
  //    admissão, caso, SLA, país — nada que identifique a pessoa. Nenhuma destas entra em grupo
  //    por padrão (`lex` P5/E).
  'patient_identity:read':
    'Ver QUEM é o paciente: nome, documento, data de nascimento, sexo, telefone e e-mail de contato. '
    + 'Sem ela a lista e a ficha mostram só o operacional (status, caso, funil).',
  'patient_identity:write':
    'Editar a identidade do paciente (nome, documento, nascimento, sexo, telefone, e-mail de contato). '
    + 'Também sobe/troca/apaga a FOTO de perfil (spec 018, PR-4).',
  'patient_clinical:read':
    'Ver o quadro CLÍNICO do paciente: patologías (CID-11) e diagnóstico legado, nível de dependência, '
    + 'especialidade, dispositivos, observações, CUD, proteção judicial, consentimento e os textos '
    + 'restritos (instruções de emergência, nota de espera). Dado sensível de saúde — Ley 25.326 art. 2.',
  'patient_clinical:write':
    'Editar o quadro clínico do paciente, inclusive registrar e dar baixa em patologías CID-11.',
  'patient_care_team:read':
    'Ver a EQUIPE TRATANTE do paciente: nome, papel, telefone e e-mail dos profissionais — dado de terceiro.',
  'patient_care_team:write':
    'Criar, editar e dar baixa em profissionais da equipe tratante do paciente (nome, telefone, '
    + 'e-mail, especialidade) — nunca DELETE (spec 018, PR-5, US-11).',
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
  // 07/09/2026 — era "papel admin"; virou célula de DADO (D286). Não é portão de rota: a
  // rota abre com `patient_services:*`, só o preço depende dela (`contractedServiceHourlyValueAccess`).
  'patient_contract_value:read':
    'Ver e editar o VALOR-HORA dos serviços contratados: o preço do contrato cobrado à família ou '
    + 'obra social. Quem não tem a célula vê o campo redigido e não consegue gravá-lo.',
  // ── Spec 017 (D299; lex 08/09 C7): projeto terapêutico versionado e os seus catálogos ──
  'patient_therapeutic_project:read':
    'Ver o PROJETO TERAPÊUTICO do paciente: versões (major.minor), prazos, autor, serviço contratado '
    + 'escolhido, objetivos e atividades. A síntese clínica, o objetivo geral, o CID-11 e o tipo de patologia '
    + '(capítulo CID-11 derivado dos diagnósticos) só saem com `patient_clinical:read` (célula cumulativa). Dado sensível de saúde.',
  'patient_therapeutic_project:write':
    'Criar uma nova versão do projeto terapêutico ("Novo" = major seguinte, "Editar" = minor seguinte) '
    + 'e anular uma versão. Exige também `patient_clinical:write` — o corpo carrega texto clínico.',
  // `exportGate` fica dentro de closure condicional (`?purpose=export`) em
  // `adminTherapeuticProjectsRoutes.ts` — o scanner de rota não vê essa chamada de
  // `perm.require`, então esta célula só chega ao catálogo por `cellsForaDeRota`.
  'patient_therapeutic_project:export':
    'Exportar o PDF de uma versão do projeto terapêutico (vigente ou antiga). Exige também '
    + '`patient_therapeutic_project:read` — a leitura da versão é pré-requisito do export.',
  'catalog_therapeutic_objectives:read':
    'Ver o catálogo de OBJETIVOS ESPECÍFICOS do projeto terapêutico (lista global, sem dado de paciente).',
  'catalog_therapeutic_objectives:write':
    'Adicionar, renomear e desativar objetivos específicos do catálogo (backoffice).',
  'catalog_therapeutic_activities:read':
    'Ver o catálogo de ROTINA E ATIVIDADES do projeto terapêutico (lista global, sem dado de paciente).',
  'catalog_therapeutic_activities:write':
    'Adicionar, renomear e desativar atividades do catálogo (backoffice).',
  'catalog_therapeutic_segments:read':
    'Ver o catálogo de SEGMENTOS da Ana Care (US-17, lista global, sem dado de paciente).',
  'catalog_therapeutic_segments:write':
    'Adicionar, renomear e desativar segmentos do catálogo (backoffice).',

  // ── spec 018, PR-8b (ADR-2, SUP-30): split `<recurso>:write` → `<recurso>:create` +
  // `<recurso>:update` para os 19 recursos com `write` LITERAL na rota (20 − permission_management)
  // mais os 4 recursos cuja rota declara a célula por VARIÁVEL (projeto terapêutico e os 3
  // catálogos) — 23 no total. `permission_management` NÃO splita (fica `write`, contracts/
  // permissions-split.md linha 11). Nesta rodada (A1) as ROTAS continuam pedindo `write` — as
  // células novas só entram no catálogo (via `cellsForaDeRota`, já que nenhuma rota as declara
  // ainda) e ficam disponíveis para o painel conceder; a rota passa a exigi-las no round 8b.4.
  'patient:create': 'Criar pacientes e vínculos administrativos (papéis do chat, convênios do catálogo).',
  'patient:update': 'Editar status e vínculos administrativos do paciente (papéis do chat, convênios, status do funil).',
  'patient_address:create': 'Cadastrar um endereço novo do paciente.',
  'patient_address:update': 'Editar um endereço existente do paciente.',
  'patient_chat:create': 'Vincular um novo grupo de WhatsApp do caso ao paciente.',
  'patient_chat:update': 'Trocar os IDs dos grupos de WhatsApp já vinculados ao caso.',
  'patient_identity:create':
    'Cadastrar a identidade do paciente (nome, documento, nascimento, sexo, telefone, e-mail de '
    + 'contato) e subir a primeira foto/consentimento de imagem.',
  'patient_identity:update':
    'Editar a identidade do paciente já cadastrada; trocar/apagar a foto e revogar consentimento '
    + 'de imagem (spec 018, PR-4).',
  'patient_clinical:create': 'Registrar um diagnóstico (CID-11) novo do paciente.',
  'patient_clinical:update': 'Editar o quadro clínico do paciente, inclusive dar baixa em diagnósticos.',
  'patient_care_team:create': 'Adicionar um profissional novo à equipe tratante do paciente.',
  'patient_care_team:update': 'Editar ou dar baixa em profissional já cadastrado na equipe tratante.',
  'patient_family:create': 'Cadastrar um familiar, responsável ou contato externo novo do paciente.',
  'patient_family:update': 'Editar ou dar baixa em familiar, responsável ou contato externo já cadastrado; trocar a marca de emergência.',
  'patient_coverage:create': 'Cadastrar a cobertura do paciente ou um contato de emergência da cobertura novo.',
  'patient_coverage:update': 'Editar a cobertura do paciente ou dar baixa em contato de emergência da cobertura já cadastrado.',
  'patient_services:create': 'Contratar um serviço novo para o paciente.',
  'patient_services:update':
    'Editar serviço contratado já existente, ativar recrutamento e associar/editar prestadores do serviço.',
  'patient_therapeutic_project:create':
    'Criar uma nova versão MAJOR do projeto terapêutico ("Novo"). Exige também `patient_clinical:write`.',
  'patient_therapeutic_project:update':
    'Criar uma nova versão MINOR ("Editar") ou anular uma versão do projeto terapêutico. Exige também `patient_clinical:write`.',
  'catalog_therapeutic_objectives:create': 'Adicionar objetivo específico novo ao catálogo (backoffice).',
  'catalog_therapeutic_objectives:update': 'Renomear e desativar objetivo específico do catálogo (backoffice).',
  'catalog_therapeutic_activities:create': 'Adicionar atividade nova ao catálogo (backoffice).',
  'catalog_therapeutic_activities:update': 'Renomear e desativar atividade do catálogo (backoffice).',
  'catalog_therapeutic_segments:create': 'Adicionar segmento novo ao catálogo (backoffice).',
  'catalog_therapeutic_segments:update': 'Renomear e desativar segmento do catálogo (backoffice).',
  'user_management:create': 'Criar conta nova de staff.',
  'user_management:update': 'Resetar a senha de uma conta de staff existente.',
  'vacancy:create': 'Criar vaga nova, gerar link social e conteúdo por IA no momento da criação.',
  'vacancy:update':
    'Editar vaga existente: resolver revisão de endereço, gerar/editar conteúdo por IA e links de reunião.',
  'funnel:create': 'Registrar nota de contato com prestador no funil.',
  'funnel:update': 'Mover/editar etapa do funil, resultado de encuadre e bloqueio de candidatura.',
  'talentum:create': 'Gerar descrição/conteúdo novo do Talentum para a vaga.',
  'talentum:update': 'Publicar, despublicar, editar descrição ou sincronizar vagas/prestadores com o Talentum.',
  'prescreening:create': 'Criar a configuração de pré-seleção de uma vaga.',
  'prescreening:update': 'Editar a configuração de pré-seleção de uma vaga já existente.',
  'interview:create': 'Criar um horário de entrevista novo para a vaga.',
  'interview:update': 'Reservar um horário de entrevista já criado.',
  'messaging:create': 'Criar template, rascunho de mensagem ou validar rascunho novo.',
  'messaging:update':
    'Editar/enviar template ou rascunho de mensagem já existente, configurar mensageria por etapa e '
    + 'o convite à apresentação.',
  'recruitment:create': 'Disparar cálculo novo de reemplazos.',
  'recruitment:update': 'Editar/repetir o cálculo de reemplazos.',
  'worker:create': 'Criar uma tag de prestador nova.',
  'worker:update': 'Editar status, ocupação, área de serviço, perfil e tags de um prestador já cadastrado.',
  'worker_document:create': 'Subir um documento novo do prestador (ou o link de ingestão a partir de URL).',
  'worker_document:update': 'Editar o prazo de validade de um documento já cadastrado do prestador.',

  // ── Spec `anacare-conferencia-de-horas`, fase 1 (D344/D345) — duas células distintas, NASCEM
  //    sem grupo (fora de qualquer grupo padrão), descrição no mesmo commit que as cria.
  'anacare_hours:read':
    'Ver a conferência de horas do Ana Care: turnos, horas, origem do check-in e status de '
    + 'validação — SEM nome de paciente/prestador (esses seguem sob patient_identity:read/'
    + 'worker_contact:read) e sem o texto da nota de contestação (sob patient_clinical:read).',
  'anacare_hours:validate':
    'Validar um turno, validar em lote e contestar (com motivo e nota opcional) na conferência '
    + 'de horas do Ana Care. Exige também anacare_hours:read para ver o que está validando.',
};

/**
 * Recursos cujo `<recurso>:write` é SPLITADO em `<recurso>:create` + `<recurso>:update`
 * (spec 018, PR-8b, ADR-2/SUP-30). `permission_management` fica de fora de propósito —
 * é a ÚNICA rota que continua sob `write` (contracts/permissions-split.md linha 11).
 *
 * Os 19 primeiros são os recursos com `perm.require('<recurso>', 'write', …)` LITERAL
 * (`git grep -n "perm\.require([^)]*'write'" -- worker-functions/src | grep -v test` menos
 * `permission_management`, 93 hits medidos em 15/09 (excluindo por CAMINHO `__tests__`, não por
 * substring da linha — correção do coordenador: o filtro por substring "test" cortava
 * `/workers/:id/test-flag` e `/patients/:id/test-flag`, ambos `update`) contra a 108 rotas do
 * mapa nominal —
 * loops/middleware expandem). Os 4 últimos declaram a célula por VARIÁVEL (o mapa nominal,
 * `pr8b-mapa-rotas.tsv`, linhas 36-43) e por isso o grep literal não os alcança.
 */
export const SPLIT_RESOURCES: ReadonlySet<string> = new Set([
  'patient',
  'patient_address',
  'patient_chat',
  'patient_identity',
  'patient_clinical',
  'patient_care_team',
  'patient_family',
  'patient_coverage',
  'patient_services',
  'user_management',
  'vacancy',
  'funnel',
  'talentum',
  'prescreening',
  'interview',
  'messaging',
  'recruitment',
  'worker',
  'worker_document',
  'patient_therapeutic_project',
  'catalog_therapeutic_objectives',
  'catalog_therapeutic_activities',
  'catalog_therapeutic_segments',
]);

export function isSplitResource(resource: string): boolean {
  return SPLIT_RESOURCES.has(resource);
}

/**
 * Expande `<recurso>:write` de um recurso SPLITADO em `<recurso>:create` +
 * `<recurso>:update`; qualquer outra chave (inclusive `permission_management:write`
 * e qualquer `:write` de recurso não splitado) passa intacta. Dedup por `Set` — não
 * ordena (quem chama decide se ordena; `normalizeSnapshot` já ordena por conta própria).
 *
 * Ponto ÚNICO da expansão (fix-once): usado na gravação de grupo
 * (`SetGroupPermissionsUseCase`, durante a janela de transição, SUP-31), na leitura do
 * contrato de authz (`GetMyAuthzUseCase` — o painel nunca vê `write` de recurso
 * splitado) e no export/import de configuração IAM (`iamConfig/snapshot.ts` —
 * `normalizeSnapshot` roda dos dois lados: export de um banco já migrado nunca mostra
 * `write` residual, e import de um arquivo ANTIGO com `write` expande antes do diff).
 */
export function expandWriteCells(cellKeys: readonly string[]): string[] {
  const out = new Set<string>();
  for (const key of cellKeys) {
    const parsed = parseCellKey(key);
    if (parsed && parsed.action === 'write' && isSplitResource(parsed.resource)) {
      out.add(cellKey(parsed.resource, 'create'));
      out.add(cellKey(parsed.resource, 'update'));
      continue;
    }
    out.add(key);
  }
  return [...out];
}

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
