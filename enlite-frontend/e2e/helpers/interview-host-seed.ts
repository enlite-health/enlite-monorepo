/**
 * interview-host-seed.ts — ÚNICO jeito de semear `interview_hosts` nos e2e @integration do frontend (spec 055). Espelho do
 * `worker-functions/tests/e2e/helpers/interviewHostFixture.ts` (outro pacote, não dá para importar).
 *
 * Desde a migration 523 a leitura de agendamento faz JOIN em `users` (staff ativo) e `countries` é NOT NULL: toda entrevistadora
 * semeada leva o usuário staff (uid `ihost-<e-mail>`, idempotente por e-mail) e os dois fluxos ligados — o comportamento de antes
 * da spec. Não repetir esse SQL nos specs.
 */
import { scalar, safeSql, ABAC_TENANT } from './abac-stack-helper';

export interface SeedInterviewHost {
  email: string;
  displayName: string;
  /** Padrão `['AR']`. */
  countries?: string[];
  doesEnquadre?: boolean;
  doesAdmission?: boolean;
}

/** Cria o usuário staff e a linha de `interview_hosts`; devolve o id da linha. */
export function seedInterviewHost(h: SeedInterviewHost): string {
  const countries = h.countries ?? ['AR'];
  const uid = scalar(`INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id)
      VALUES ('ihost-${h.email}', '${h.email}', '${h.displayName}', 'admin', 'ACTIVE', true, '${ABAC_TENANT}')
      ON CONFLICT (email) DO UPDATE SET is_active = true RETURNING firebase_uid`);
  return scalar(`INSERT INTO interview_hosts (email, display_name, country, countries, user_uid, does_enquadre, does_admission, active)
      VALUES ('${h.email}', '${h.displayName}', '${countries[0]}', ARRAY[${countries.map((c) => `'${c}'`).join(',')}], '${uid}',
              ${h.doesEnquadre ?? true}, ${h.doesAdmission ?? true}, true) RETURNING id`);
}

/** Apaga as linhas e os usuários `ihost-*` que ninguém mais referencia. Falha de um DELETE não esconde a do seguinte. */
export function cleanupInterviewHosts(emails: string[]): void {
  const list = emails.map((e) => `'${e}'`).join(',');
  safeSql(`DELETE FROM interview_hosts WHERE email = ANY(ARRAY[${list}])`);
  safeSql(`DELETE FROM users u WHERE u.firebase_uid LIKE 'ihost-%' AND NOT EXISTS (SELECT 1 FROM interview_hosts h WHERE h.user_uid = u.firebase_uid)`);
}

