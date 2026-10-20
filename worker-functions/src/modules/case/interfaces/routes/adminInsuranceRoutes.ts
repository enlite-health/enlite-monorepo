import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import type { AdminInsuranceProvidersController } from '../controllers/AdminInsuranceProvidersController';
import type { AdminInsuranceProviderContactsController } from '../controllers/AdminInsuranceProviderContactsController';
import type { AdminInsuranceContractsController } from '../controllers/AdminInsuranceContractsController';
import type { AdminContractedServiceContractLinkController } from '../controllers/AdminContractedServiceContractLinkController';

/**
 * Rotas do cadastro de obra social, contratos/termos e do vínculo serviço -> contrato (spec 058 §3.2; plan §1.4) — montadas em /api/admin.
 *
 * Família `admin.patients` (a mesma de `adminPatientsRoutes`): as 11 células novas vêm no sync do catálogo e entram em `PERMISSION_ENFORCED_ROUTES`
 * junto com a família; ANTES disso valem como `untilEnforced: 'admin'` (a 058 nasce só-admin até alguém conceder — spec §3.5).
 * Ordem dos guards = a de `adminPatientsRoutes`: staffOnly → `perm.require` → handler. Literais ANTES das rotas com `:code`
 * (`/insurance-providers/for-service` não pode ser capturada como `:code`).
 *
 * O GET `/catalogs/insurance-providers` (o select do drawer de cobertura) e o POST ficam em `adminPatientsRoutes` (C4 ⚑: o GET segue
 * `patient_coverage:read`; o POST virou `catalog_insurance_providers:create`).
 */
export function createAdminInsuranceRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  providers: AdminInsuranceProvidersController,
  contacts: AdminInsuranceProviderContactsController,
  contracts: AdminInsuranceContractsController,
  contractLink: AdminContractedServiceContractLinkController,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);
  const onlyAdminUntilEnforced = { untilEnforced: 'admin' } as const;

  // ── Obras sociais (Dados gerais) ───────────────────────────────────────────
  router.get('/insurance-providers', staffOnly, perm.require('catalog_insurance_providers', 'read', onlyAdminUntilEnforced), (req: Request, res: Response) =>
    providers.search(req, res),
  );
  // Cascata do serviço contratado: {code, name} das ativas com contrato oferecido no país + o `selected`. Sem `payerKind`.
  router.get('/insurance-providers/for-service', staffOnly, perm.require('insurance_contracts', 'read', onlyAdminUntilEnforced), (req: Request, res: Response) =>
    providers.listForService(req, res),
  );
  router.get('/insurance-providers/:code', staffOnly, perm.require('catalog_insurance_providers', 'read', onlyAdminUntilEnforced), (req: Request, res: Response) =>
    providers.get(req, res),
  );
  router.patch('/insurance-providers/:code', staffOnly, perm.require('catalog_insurance_providers', 'update', onlyAdminUntilEnforced), (req: Request, res: Response) =>
    providers.patch(req, res),
  );

  // ── Empregados (contatos) ──────────────────────────────────────────────────
  router.get('/insurance-providers/:code/contacts', staffOnly, perm.require('insurance_provider_contacts', 'read', onlyAdminUntilEnforced), (req: Request, res: Response) =>
    contacts.list(req, res),
  );
  router.post('/insurance-providers/:code/contacts', staffOnly, perm.require('insurance_provider_contacts', 'create', onlyAdminUntilEnforced), (req: Request, res: Response) =>
    contacts.create(req, res),
  );
  router.patch('/insurance-providers/:code/contacts/:contactId', staffOnly, perm.require('insurance_provider_contacts', 'update', onlyAdminUntilEnforced), (req: Request, res: Response) =>
    contacts.patch(req, res),
  );
  router.post('/insurance-providers/:code/contacts/:contactId/retire', staffOnly, perm.require('insurance_provider_contacts', 'update', onlyAdminUntilEnforced), (req: Request, res: Response) =>
    contacts.retire(req, res),
  );

  // ── Contratos e termos ─────────────────────────────────────────────────────
  router.get('/insurance-providers/:code/contracts', staffOnly, perm.require('insurance_contracts', 'read', onlyAdminUntilEnforced), (req: Request, res: Response) =>
    contracts.list(req, res),
  );
  // Grava preço (NC-12): as DUAS células.
  router.post(
    '/insurance-providers/:code/contracts',
    staffOnly,
    perm.require('insurance_contracts', 'create', onlyAdminUntilEnforced),
    perm.require('patient_contract_value', 'create', onlyAdminUntilEnforced),
    (req: Request, res: Response) => contracts.create(req, res),
  );
  router.patch('/insurance-contracts/:id', staffOnly, perm.require('insurance_contracts', 'update', onlyAdminUntilEnforced), (req: Request, res: Response) =>
    contracts.patch(req, res),
  );
  router.post('/insurance-contracts/:id/terms', staffOnly, perm.require('patient_contract_value', 'create', onlyAdminUntilEnforced), (req: Request, res: Response) =>
    contracts.addTerm(req, res),
  );
  router.post('/insurance-contracts/:id/terms/:termId/supersede', staffOnly, perm.require('patient_contract_value', 'create', onlyAdminUntilEnforced), (req: Request, res: Response) =>
    contracts.supersedeTerm(req, res),
  );

  // ── Pacientes da obra social (§L) ──────────────────────────────────────────
  // Portão PRÓPRIO: lista identificadora ("quem tem cobertura aqui"). Não pega carona em `patient_services:read` nem em `patient_coverage:read`.
  router.get('/insurance-providers/:code/patients', staffOnly, perm.require('insurance_provider_patients', 'read', onlyAdminUntilEnforced), (req: Request, res: Response) =>
    providers.listPatients(req, res),
  );

  // ── Vínculo serviço contratado -> contrato (§E) ────────────────────────────
  const base = '/patients/:id/contracted-services/:sid/contract-link';
  router.post(base, staffOnly, perm.require('patient_services', 'update'), (req: Request, res: Response) => contractLink.create(req, res));
  router.post(`${base}/end`, staffOnly, perm.require('patient_services', 'update'), (req: Request, res: Response) => contractLink.end(req, res));
  router.post(`${base}/supersede`, staffOnly, perm.require('patient_services', 'update'), (req: Request, res: Response) => contractLink.supersede(req, res));

  return router;
}
