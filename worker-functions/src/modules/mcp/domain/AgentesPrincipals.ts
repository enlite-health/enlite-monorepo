/**
 * Principais de máquina do schema `agentes` (spec 078, M3a-2, Q1 do plano-M3).
 *
 * SÓ A FORMA do JSON do secret `mcp-principal-<name>` (o mesmo que `ServicePrincipalSecretManagerRepo` lê:
 * `name`, `allowedCapabilities`, `tokens`). Os segredos reais e a entrada em `MCP_PRINCIPAL_NAMES`
 * (env do serviço; sem ela `findByToken` só conhece `triage-service`) são ato de PRODUÇÃO — não vivem aqui.
 *
 * Um principal por agente, cada um só com o que a sua função precisa. Até a M2, "a Maria não lê aviso de
 * outro gestor" é esta lista, não RLS.
 */
export const AGENTES_PRINCIPAL_CAPABILITIES = {
  'sol-supervisor': ['agentes.veredicto.registrar'],
  'sol-fila': [
    'agentes.reporte.ler',
    'agentes.placar.ler',
    'agentes.pedido.depositar',
    'agentes.medicao.registrar',
  ],
  maria: ['agentes.placar.ler', 'agentes.reporte.registrar'],
} as const;

export type AgentesPrincipalName = keyof typeof AGENTES_PRINCIPAL_CAPABILITIES;

/** Capabilities do schema `agentes` que escrevem (entram em WRITE_CAPABILITY_NAMES). */
export const AGENTES_WRITE_CAPABILITIES = [
  'agentes.veredicto.registrar',
  'agentes.reporte.registrar',
  'agentes.pedido.depositar',
  'agentes.medicao.registrar',
] as const;
