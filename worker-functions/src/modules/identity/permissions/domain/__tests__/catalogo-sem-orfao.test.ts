/**
 * src/modules/identity/permissions/domain/__tests__/catalogo-sem-orfao.test.ts
 *
 * Fase 2 da change `catalogo-de-permissoes-derivado-do-codigo` (D115): o catálogo de células é
 * DERIVADO do código — nenhuma chave em `CELL_DESCRIPTION` pode ficar sem CONSUMIDOR real, porque
 * é exatamente essa lacuna que fez a Fase 1 achar 12 células `:write` órfãs (removidas no commit
 * `84b1ecb2`). Este teste é a RÉGUA que impede a próxima órfã de voltar sem ninguém notar.
 *
 * Por que ESTÁTICO (grep + resolução de identificador) e não e2e de boot: o CI do
 * `backend-e2e.yml` sobe sem os overlays do sync de permissões — não há app de pé exercitando
 * `cellsForaDeRota`/o sync nesse pipeline. Rodar como unit (`npx jest`) é o único jeito de ter
 * régua na suíte que o CI de fato roda.
 *
 * ── O que conta como CONSUMIDOR (fatos-medidos F8, fase-2.md) ──────────────────────────────────
 *  1. Rota: `<qualquer variável>.require('<recurso>', '<ação>')` — literal OU com recurso/ação
 *     vindo de VARIÁVEL (const, membro de Record indexado por loop, elemento de tupla de loop).
 *  2. Checagem literal: `<algo com "cell" no nome>.includes(<expressão>)` cuja expressão resolve
 *     para `'<recurso>:<ação>'` — direto (`cells.includes('x:y')`), via constante
 *     (`cells.includes(CELL_X)`, `CELL_X = 'x:y'` ou `CELL_X = cellKey('x','y')`), ou via helper
 *     (`cells.includes(patientContainerCell(container, 'read'))`).
 *
 * ── Por que um RESOLVEDOR de expressão, não só grep de string ────────────────────────────────
 * Medido (Passo 0 do fase-2.md): grep de substring simples cai em dois lados —
 *  (a) FALSO POSITIVO: comentário/JSDoc menciona a chave removida (`messaging:write` aparece em
 *      3 comentários de `TemplateDraftsController.ts`/`messagingRoutes.ts` mesmo já REMOVIDA do
 *      dicionário) — por isso todo arquivo passa por `stripComments` antes de qualquer regex.
 *  (b) FALSO NEGATIVO: 13 chaves (`patient_therapeutic_project:*`, `catalog_therapeutic_*:*`) só
 *      têm consumidor via `perm.require(CONST, 'ação')`/`perm.require(RECORD[kind], 'ação')`, e
 *      outras (`dashboard_numbers:read` etc., `worker_contact:read`, `worker_pii:read`,
 *      `patient_identity:read` via `canReadPatientContainer`) só via helper cujo parâmetro é
 *      preenchido em OUTRO ponto do arquivo (loop) ou EM OUTRO ARQUIVO (call site) — nenhuma das
 *      duas aparece como string literal em lugar nenhum. Confirmado por medição: sem o
 *      resolvedor, a varredura acusava 18 chaves como órfãs no estado LIMPO (falso vermelho de
 *      largada, que o fase-2.md proíbe).
 *
 * O resolvedor (`evaluate`) cobre, por construção — nada além disso, e quando não alcança marca
 * a chamada como NÃO RESOLVIDA (nunca assume consumo):
 *   - literal `'x'` / crase `` `${...}` ``;
 *   - identificador → const no mesmo arquivo, ou importado (inclusive via barrel
 *     `export { x } from '...'`, múltiplos saltos até `MAX_DEPTH`);
 *   - `RECORD[chave]` → valor(es) do objeto (uma chave literal, ou todas as chaves de um loop
 *     `for (const k of ARRAY)` sobre a mesma variável);
 *   - `fn(args)` → definição de `fn` (arrow com corpo direto, ou `function`/arrow com
 *     `return ...;`), parâmetros substituídos pelos argumentos e o corpo reavaliado;
 *   - identificador que é PARÂMETRO da função que contém a chamada (`canReadPatientContainer`,
 *     `canReadWorkerContainer`, `canReadDashboardSection`, `pode`) e não resolve por nenhuma via
 *     acima → CALL-SITE FLOW: acha toda chamada `fn(...)` em `src` (exceto a própria definição),
 *     pega o argumento na MESMA posição do parâmetro, resolve ESSE argumento (literal, ou loop no
 *     arquivo do call site) e usa a união dos resultados.
 *
 * Limite deliberado: o call-site flow olha só a expressão do argumento no escopo de MÓDULO do
 * arquivo do call site (não atravessa um segundo nível de "parâmetro de função que é parâmetro de
 * outra função"). Não apareceu esse caso em `src/` na medição de 20/09 — se aparecer no futuro e
 * a chave ficar como NÃO RESOLVIDA na lista abaixo, é sinal de que precisa de mais um nível, não
 * de allow-list.
 *
 * ── Estado medido em 20/09 (só backend): este teste NASCEU VERMELHO por erro de ESPECIFICAÇÃO,
 *    não por bug do resolvedor — a varredura olhava só `worker-functions/src` ──────────────────
 * Com o resolvedor completo do backend (não por falta de alcance), sobravam 4 chaves SEM
 * consumidor nenhum NESSA CAMADA — nem rota, nem `cells.includes`, nem helper:
 *   - `api_docs:read` — a rota real de `/api/docs` (`src/index.ts`) usa só
 *     `authMiddleware.requireStaff()`, sem `perm.require`/checagem de célula nenhuma.
 *   - `patient_chat:read` / `patient_chat:create` — só existe rota para `patient_chat:update`
 *     (`PUT /patients/:id/chat-ids`); leitura de chat usa `patient:read`/`messaging:read`, e
 *     `canReadPatientContainer` nunca é chamado com o container `'chat'`.
 *   - `prescreening:create` — só existem rotas para `prescreening:read`/`update`
 *     (`adminVacanciesRoutes.ts`); não há `create` em lugar nenhum.
 * Célula pode ter consumidor no FRONTEND sem `perm.require` nenhum no backend (a rota já projeta
 * a resposta; quem decide o que MOSTRAR é a tela) — e é exatamente o caso de 3 das 4: `scanFrontend`
 * (abaixo) achou `patient_chat:read`/`patient_chat:create` no `c('chat', 'patient_chat', [...])`
 * de `SCREEN_REGISTRY` (`patients.detail`, container `chat`) + `ContainerGate resource="patient_chat"`
 * (`PatientDetailPage.tsx`), e `prescreening:create` no `c('prescreening', 'prescreening', [...])`
 * de `SCREEN_REGISTRY` (`vacancies.detail`) e no `cells: [...]` literal de `vacancies.talentum`.
 * `api_docs:read` seguia SEM consumidor em nenhuma das duas camadas — PRÉ-EXISTENTE (não
 * introduzida por esta Fase, não fazia parte das 12 da Fase 1), e a feature `api_docs` está em
 * remoção (branches `chore/remover-api-docs`; já não existe no catálogo de prd). Decisão tomada
 * (commit `8991d670`, fatos-medidos F-catalogo-sem-orfao 20/09): removida de `CELL_DESCRIPTION` —
 * a régua fecha VERDE.
 */

/**
 * Fase 3 (D115): o resolvedor de expressão (`evaluate`/`scan`/`scanFrontend` e toda a cadeia de
 * resolução de import/call-site/loop) foi extraído para `permissionCatalogScan.ts`, vizinho deste
 * arquivo — é o MESMO scanner que a régua inversa (`catalogo-cobre-consumidor.test.ts`) reusa para
 * não duplicar a lógica. Nada da resolução mudou; só o arquivo onde ela mora.
 */

import { CELL_DESCRIPTION } from '../PermissionCell';
import { ALL_FILES, FRONTEND_FILES, scan, scanFrontend } from './permissionCatalogScan';

describe('CELL_DESCRIPTION — nenhuma chave fica sem consumidor real (Fase 2, D115)', () => {
  it('a varredura do backend realmente percorre arquivos (contagem > 500) — contagem zero é falha, não sucesso', () => {
    expect(ALL_FILES.length).toBeGreaterThan(500);
  });

  it('a varredura do frontend realmente percorre arquivos (contagem > 300) — contagem zero é falha, não sucesso', () => {
    expect(FRONTEND_FILES.length).toBeGreaterThan(300);
  });

  it('toda chave de CELL_DESCRIPTION tem consumidor real — backend (perm.require/cells.includes) OU frontend (SCREEN_REGISTRY/gate/hook/literal)', () => {
    const { consumed: backendConsumed } = scan();
    const frontendConsumed = scanFrontend();
    const consumed = new Set([...backendConsumed, ...frontendConsumed]);
    const orfas = Object.keys(CELL_DESCRIPTION).filter((k) => !consumed.has(k));
    const mensagens = orfas.map(
      (k) => `${k} — SEM consumidor: nenhum perm.require('${k.split(':')[0]}', '${k.split(':')[1]}') `
        + `nem cells.includes(...) resolvível em worker-functions/src, nem SCREEN_REGISTRY/`
        + `ContainerGate/ActionButton/useActionGate/useContainerAccess/useCellAccess/literal em `
        + `enlite-frontend/src. `
        + `Ação: remover de CELL_DESCRIPTION (change catalogo-de-permissoes-derivado-do-codigo, D115) `
        + `se for órfã de verdade, OU se há consumidor que este teste não alcança, registrar por que `
        + `(célula abaixo da rota/tela com padrão novo) e ajustar o resolvedor — nunca criar allow-list muda.`,
    );
    expect(mensagens).toEqual([]);
  });
});
