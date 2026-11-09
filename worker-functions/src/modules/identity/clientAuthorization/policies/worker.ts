/**
 * Política do prestador (`care`·worker) sobre a PRÓPRIA ficha: `Worker.owner == principal`, ambos a RAIZ da pessoa
 * (D647). O recurso nunca vem de header (D650): é a ficha pedida na rota, ou a do próprio token nas rotas `/me`.
 */
export const WORKER_POLICIES = `
permit(principal is Person, action in [Action::"ReadOwnWorkerProfile", Action::"UpdateOwnWorkerProfile"], resource is Worker)
  when { principal.areas.contains("care:worker") && resource.owner == principal };
`;
