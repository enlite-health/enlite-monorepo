import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { AdminWorkersController } from '../controllers/AdminWorkersController';
import { AdminWorkersAuxController } from '../controllers/AdminWorkersAuxController';
import { AdminWorkerTestFlagController } from '../controllers/AdminWorkerTestFlagController';
import { AdminWorkerProfileController } from '../controllers/AdminWorkerProfileController';
import { AdminWorkerServiceAreaController } from '../controllers/AdminWorkerServiceAreaController';
import { AdminTagCatalogController } from '../controllers/AdminTagCatalogController';
import { WorkerTimelineController } from '../controllers/WorkerTimelineController';
import { logResourceAccess } from '@shared/audit/resourceAccessLog';
import { AdminWorkersMapController } from '../controllers/AdminWorkersMapController';

export interface AdminWorkerRouteControllers {
  workers: AdminWorkersController;
  aux: AdminWorkersAuxController;
  testFlag: AdminWorkerTestFlagController;
  profile: AdminWorkerProfileController;
  serviceArea: AdminWorkerServiceAreaController;
  tags: AdminTagCatalogController;
  timeline: WorkerTimelineController;
  /** Opcional só para não quebrar quem monta o router sem mapa (testes antigos). */
  map?: AdminWorkersMapController;
}

/**
 * Admin worker + worker-tag routes — mounted at /api/admin.
 *
 * Route ordering is significant: specific paths (export, filter-options,
 * timeline) MUST precede the `/workers/:id` param route to avoid capture.
 *
 * ── Família `admin.workers` (task 3.5, a 3ª a declarar célula) ───────────────
 * Mapa rota→célula: `openspec/changes/painel-grupos-permissao/route-permission-map.md`.
 * A família é declarada em QUATRO arquivos (este, `adminWorkerDocumentsRoutes`,
 * o trecho admin de `workerDocumentsRoutes` e `workerContextRoutes`) porque as
 * 31 rotas de `/api/admin/workers/*` sempre moraram espalhadas. O que as une é
 * o nome da família — que é o que `PERMISSION_ENFORCED_ROUTES` liga, e por isso
 * `ADMIN_WORKERS_FAMILY` é exportado daqui e importado pelos outros três: a
 * família virar pela metade seria pior que não virar.
 *
 * A ordem dos guards é a mesma fixada por `adminUsersRoutes`/`adminPatientsRoutes`
 * (contrato, não estilo): papel → célula → `logResourceAccess`. Acesso NEGADO
 * não é acesso e não entra na trilha de leitura de ficha (a negativa tem trilha
 * própria, D-P4); e os guards de papel de hoje FICAM, porque enquanto a família
 * está fora de `PERMISSION_ENFORCED_ROUTES` o papel é a única proteção.
 *
 * ⚠️ `GET /workers/by-phone` é `requireStaffOrApiKey`: quem chama é o
 * triage-service (a Luz). Chave de API é serviço, não pessoa, e não tem grupo —
 * o desvio está no `PermissionMiddleware`, não aqui. A célula é declarada
 * assim mesmo, porque quando um STAFF chama esta rota a decisão é dele.
 *
 * ℹ️ As 11 células desta família já existem no seed da migration 206 (medido) —
 * ao contrário de `admin.patients`, ela NÃO depende de
 * `PERMISSION_CATALOG_SYNC_ENABLED` ter ligado para poder ser enforçada.
 */
import { ADMIN_WORKERS_FAMILY } from '@modules/identity/permissions';
import { workerDetailTrailOf } from '../../application/workerContainerAccess';
export { ADMIN_WORKERS_FAMILY };

export function createAdminWorkerRoutes(
  c: AdminWorkerRouteControllers,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const staffOrApiKey = authMiddleware.requireStaffOrApiKey();
  const adminOnly = authMiddleware.requireAdmin();
  const perm = permissions.family(ADMIN_WORKERS_FAMILY);

  // ── Admin Workers ──
  router.get('/workers/stats', staffOnly, perm.require('worker', 'read'), (req: Request, res: Response) => c.aux.getWorkerDateStats(req, res));
  // by-phone aceita API key (consumido pelo triage-service pra resolver worker do contato).
  //
  // ⚠️ `worker_pii:read`, NÃO `worker:read` como o mapa da 0.6 dizia (decisão do
  // Gabriel, 19/08). `getWorkerByPhone` monta a resposta com o MESMO
  // `WORKER_DETAIL_COLS` + `buildWorkerDetailResponse` de `getWorkerById` —
  // nome, DNI, nascimento, raça, religião, orientação sexual e URLs de
  // documento. Com a célula fraca, quem tivesse só `worker:read` seria negado
  // na ficha e pegaria o dossiê idêntico por aqui, e ainda sem trilha (a rota
  // não tem `logResourceAccess` e `worker` não é recurso sensível). O gate
  // achou; o mapa foi corrigido junto.
  // C6: `by-phone` abre o dossiê inteiro e não tinha trilha. O id vem do que o
  // handler resolveu (`req.recursoAcessadoId`), NUNCA do telefone da query — o
  // telefone é o próprio dado pessoal, e gravá-lo como identificador da trilha
  // publicaria em tabela auditada aquilo que a trilha existe para proteger.
  router.get('/workers/by-phone', staffOrApiKey, perm.require('worker_pii', 'read'),
    logResourceAccess('worker', 'read_by_phone', (req) => req.recursoAcessadoId),
    (req: Request, res: Response) => c.workers.getWorkerByPhone(req, res));
  router.get('/workers/case-options', staffOnly, perm.require('worker', 'read'), (req: Request, res: Response) => c.aux.listCaseOptions(req, res));
  // filter-options MUST be before /:id to avoid param capture
  router.get('/workers/filter-options', staffOnly, perm.require('worker', 'read'), (req: Request, res: Response) => c.aux.getFilterOptions(req, res));
  // map MUST be before /:id — pontos do mapa de prestadores (REQ-04, DEC-14). POST com corpo: o centro do raio nunca vai na URL (lex C2).
  // D286 fase 2: coordenada É endereço → a MESMA célula do card de endereço da ficha (`worker_address:read`);
  // o nome de cada pino segue `worker_contact:read` (projetado no controller, antes do KMS). Era `worker:read`
  // e entregava nome + lat/lng de todo mundo (`lex` P1).
  if (c.map) {
    const map = c.map;
    router.post('/workers/map', staffOnly, perm.require('worker_address', 'read'), (req: Request, res: Response) => map.getMapPoints(req, res));
  }
  router.post('/workers/sync-talentum', staffOnly, perm.require('talentum', 'write'), (req: Request, res: Response) => c.aux.syncTalentumWorkers(req, res));
  // export MUST be registered before /:id to avoid param capture
  router.get('/workers/export', adminOnly, perm.require('worker', 'export'), (req: Request, res: Response) => c.workers.exportWorkers(req, res));
  // timeline MUST be registered before /:id to avoid param capture
  router.get('/workers/:id/timeline', staffOnly, perm.require('worker', 'read'), (req: Request, res: Response) => c.timeline.getTimeline(req, res));
  // D286 fase 2: abrir a ficha é o OPERACIONAL; contato, dossiê, documentos e encuadres saem
  // projetados pela célula de cada container (`buildWorkerDetailResponse`). Quem só tem
  // `worker:read` recebe a ficha sem nome, sem DNI, sem documento — não uma negação da tela.
  // A trilha (`resource_access_log`) carrega os containers servidos no `action` — é o que substitui
  // a linha ALLOW de `worker_pii` que esta rota deixou de gerar.
  router.get('/workers/:id', staffOnly, perm.require('worker', 'read'), logResourceAccess('worker', workerDetailTrailOf), (req: Request, res: Response) => c.workers.getWorkerById(req, res));
  // test-flag e profile são admin-only (mais estrito que staff)
  router.patch('/workers/:id/test-flag', adminOnly, perm.require('worker', 'write'), (req: Request, res: Response) => c.testFlag.updateTestFlag(req, res));
  // edição de perfil do worker — apenas role ADMIN
  router.patch('/workers/:id/profile', adminOnly, perm.require('worker', 'write'), (req: Request, res: Response) => c.profile.updateProfile(req, res));
  // edição de endereço/área de serviço — apenas role ADMIN (Google Places + lat/lng)
  router.put('/workers/:id/service-area', adminOnly, perm.require('worker', 'write'), (req: Request, res: Response) => c.serviceArea.updateServiceArea(req, res));
  router.get('/workers', staffOnly, perm.require('worker', 'read'), (req: Request, res: Response) => c.workers.listWorkers(req, res));

  // ── Worker Tags ──
  router.get('/worker-tags', staffOnly, perm.require('worker', 'read'), (req: Request, res: Response) => c.tags.list(req, res));
  router.post('/worker-tags', adminOnly, perm.require('worker', 'write'), (req: Request, res: Response) => c.tags.create(req, res));
  router.patch('/worker-tags/:id', adminOnly, perm.require('worker', 'write'), (req: Request, res: Response) => c.tags.update(req, res));
  router.delete('/worker-tags/:id', adminOnly, perm.require('worker', 'write'), (req: Request, res: Response) => c.tags.delete(req, res));
  router.post('/workers/:id/tags/:tagId', staffOnly, perm.require('worker', 'write'), (req: Request, res: Response) => c.tags.assign(req, res));
  router.delete('/workers/:id/tags/:tagId', staffOnly, perm.require('worker', 'write'), (req: Request, res: Response) => c.tags.remove(req, res));

  return router;
}
