/**
 * Spec 086 (DF-7): `auth_uid` FIXO da prestadora sintética da Luz (prueba), a mesma que a migration 566 insere (o SQL da migration segue literal).
 * Não é uid do Firebase: ninguém loga como ela. O cleanup de fixtures (`is_test = true`) a PRESERVA por esta constante.
 */
export const LUZ_PRUEBA_SINTETICA_AUTH_UID = 'prueba-luz-086-sin-firebase';
