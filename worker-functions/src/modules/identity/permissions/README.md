# Módulo `identity/permissions`

## Efeitos colaterais

- **Troca de simulação de grupo reflete na request seguinte, em qualquer instância.** A chave de
  cache de `PermissionService` (`application/PermissionService.ts`) carrega a versão da simulação
  ativa do ator (`EffectiveAuthzRepository.simulationVersion`, implementada em
  `infrastructure/PgEffectiveAuthzRepository.ts` sobre `iam.group_simulations`); start/end de
  simulação mudam essa versão, então o próximo `resolve()` já é miss — sem depender do
  `DomainEventProcessor` ter drenado o outbox (`permission.changed`), que é o caminho normal de
  invalidação entre instâncias e não roda na mesma request nem antes do outbox ser processado
  (spec 026, troca de grupo com feedback).
