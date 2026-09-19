/**
 * EnliteServiceType — vocabulário canônico dos tipos de prestador que o paciente pode precisar.
 *
 * Não existe no repo antes da change `integracao-axonico` (`grep -rl "EnliteServiceType"
 * worker-functions/src` devolvia zero em 18/09/2026). Mora em `domain/` (não em
 * `domain/IAxonicoApiClient.ts`) porque não é conceito do Axonico — é o vocabulário canônico do
 * NOSSO banco (`patients.service_type`, migration `139_patient_enums_canonical.sql:43`, CHECK
 * `service_type <@ ARRAY['AT','CAREGIVER','NURSE','KINESIOLOGIST','PSYCHOLOGIST']`). Um arquivo
 * próprio, não dentro da porta do Axonico, para que a próxima integração de terceiro que também
 * precise mapear tipo de serviço (ex.: outra obra social) importe o mesmo tipo sem depender do
 * módulo do Axonico — mesmo padrão de `WorkerMirrorRecord.ts`/`WorkerMirrorProvider.ts`, que já
 * vivem soltos em `domain/` por serem conceito compartilhado, não amarrado a um cliente HTTP
 * específico.
 *
 * IMPORTANTE: a chave canônica para esse perfil de prestador é sempre a palavra em inglês do
 * enum (`CAREGIVER`) — a migration 139 normaliza as variações do rótulo em português do
 * ClickUp para essa mesma chave; qualquer outra grafia seria desconhecida tanto para o banco
 * quanto para `resolveServiceMapping` do Axonico.
 */
export type EnliteServiceType = 'AT' | 'CAREGIVER' | 'NURSE' | 'KINESIOLOGIST' | 'PSYCHOLOGIST';
