/**
 * src/modules/identity/permissions/domain/__tests__/catalogo-cobre-consumidor.test.ts
 *
 * Fase 3 da change `catalogo-de-permissoes-derivado-do-codigo` (D115) — a RÉGUA INVERSA da Fase 2
 * (`catalogo-sem-orfao.test.ts`). A Fase 2 acusa chave de `CELL_DESCRIPTION` SEM consumidor
 * (órfã); esta acusa o oposto: consumidor que só o SYNC via `CELL_DESCRIPTION` protege, sem
 * entrada nela.
 *
 * ── Por que o escopo é "cells.includes SEM perm.require", não "todo consumidor" ─────────────
 * Medido ao escrever esta régua (Passo 0 do fase-3.md — rodar a extração inversa ANTES de fechar
 * o teste, para não nascer vermelha por engano de especificação): comparar CELL_DESCRIPTION contra
 * TODO consumidor literal (`perm.require` + `cells.includes`, backend + frontend, como a Fase 2
 * faz na direção órfã) acusa ~30+ chaves de rota comum (`vacancy:read`, `patient:read`,
 * `worker:export`...) que NUNCA estiveram em CELL_DESCRIPTION e não têm problema nenhum — porque
 * o mecanismo real de sync (`src/bootstrap/wirePermissionsModule.ts:183`,
 * `scanExpressRouter.ts:declaredCells`) sincroniza toda célula vista numa rota (`perm.require`)
 * DIRETAMENTE da varredura de rotas, com ou sem CELL_DESCRIPTION — que só supre a DESCRIÇÃO,
 * com fallback `null` (`scanExpressRouter.ts:196`, provado por
 * `PermissionCell.test.ts`/`scanExpressRouter.test.ts`: "célula sem definição em lugar nenhum sai
 * null, nunca undefined"). CELL_DESCRIPTION só é a ÚNICA fonte de sync para a célula que NENHUMA
 * rota declara (`cellsForaDeRota`, `scanExpressRouter.ts:245` — a "2ª fonte do catálogo", B1 do
 * gate `revisao-pr`): ela lê `Object.entries(CELL_DESCRIPTION)` e projeta cada chave que a
 * varredura de rota não viu. É exatamente o caso de `patient_clinical:write`
 * (fatos-medidos F10): checada só via `cells.includes(...)` dentro de `canWriteTherapeuticClinical`
 * (`therapeuticProjectAccess.ts:25,53`), NUNCA numa rota (`perm.require('patient_clinical', ...)`
 * só existe para `read`/`create`/`update` — `adminPatientsRoutes.ts:272-284`). Remover essa chave
 * de CELL_DESCRIPTION some com ela do `cellsForaDeRota`, o sync a deprecia no boot seguinte, e o
 * Projeto Terapêutico cai com 403.
 *
 * Por isso o escopo desta régua é PRECISO: toda chave vista via `cells.includes(...)` (backend,
 * mesmo resolvedor da Fase 2) que NÃO aparece TAMBÉM via `<var>.require(...)` em nenhuma rota —
 * essa é a única categoria que depende de CELL_DESCRIPTION para chegar ao sync. Frontend fica de
 * fora deste teste (não alimenta `cellsForaDeRota`/o sync do backend; célula só-frontend sem
 * entrada aqui é um problema DIFERENTE — UI que nunca acende — já coberto pela Fase 2 na direção
 * órfã, não pela trava de sync desta fase).
 *
 * Reuso: os dois scanners (`scan`/`scanFrontend`) vêm de `permissionCatalogScan.ts`, extraído
 * nesta Fase do `catalogo-sem-orfao.test.ts` original — mesmo resolvedor de expressão, nenhuma
 * lógica duplicada. `scan()` agora expõe `consumedViaRequire`/`consumedViaIncludes` separados
 * (além do `consumed` unificado que a Fase 2 continua usando) exatamente para esta comparação.
 *
 * Chamada NÃO RESOLVIDA (`unresolvedIncludes`) nunca vira falha aqui — o resolvedor prefere
 * marcar "não alcancei" a assumir consumo (mesmo princípio da Fase 2: nunca inventar). Se aparecer
 * uma chamada `cells.includes` nova não resolvida, é achado para o resolvedor, não para o
 * catálogo.
 */

import { CELL_DESCRIPTION } from '../PermissionCell';
import { ALL_FILES, scan } from './permissionCatalogScan';

describe('CELL_DESCRIPTION cobre todo consumidor "abaixo da rota" (Fase 3, D115) — a trava de patient_clinical:write', () => {
  it('a varredura do backend realmente percorre arquivos (contagem > 500) — contagem zero é falha, não sucesso', () => {
    expect(ALL_FILES.length).toBeGreaterThan(500);
  });

  it('toda chave vista SÓ via cells.includes (nunca numa rota perm.require) está declarada em CELL_DESCRIPTION', () => {
    const { consumedViaRequire, consumedViaIncludes } = scan();
    const declaradas = new Set(Object.keys(CELL_DESCRIPTION));
    // Só a categoria que DEPENDE de CELL_DESCRIPTION para chegar ao sync (cellsForaDeRota): vista
    // via cells.includes e NUNCA também via perm.require em rota nenhuma.
    const soAbaixoDaRota = [...consumedViaIncludes].filter((k) => !consumedViaRequire.has(k));
    const semEntrada = soAbaixoDaRota.filter((k) => !declaradas.has(k)).sort();
    const mensagens = semEntrada.map(
      (k) => `${k} — checada via cells.includes(...) em worker-functions/src (nunca numa rota `
        + `perm.require), e SEM entrada em CELL_DESCRIPTION. Risco: essa é a ÚNICA célula que `
        + `chega ao sync por CELL_DESCRIPTION (cellsForaDeRota, scanExpressRouter.ts) — sem a `
        + `entrada, o sync nunca a declara em iam.permissions, e se ela JÁ estava lá (removida `
        + `agora do dicionário), o boot seguinte a deprecia e quem depende dela cai com 403 `
        + `(fatos-medidos F10, caso patient_clinical:write). `
        + `Ação: adicionar a entrada em CELL_DESCRIPTION (change catalogo-de-permissoes-derivado-do-codigo, `
        + `D115) — nunca remover o consumidor para "consertar" a régua.`,
    );
    expect(mensagens).toEqual([]);
  });
});
