/**
 * Schema Cedar do plano do cliente (design.md §4). Principal = pessoa (D647).
 * Constante de string, não arquivo `.cedarschema`: o `tsc` não copia esse tipo de arquivo para `dist/` (T203).
 */
export const CLIENT_SCHEMA = `
entity Person { areas: Set<String> };
entity Worker { owner: Person };
entity Account { owner: Person, uid: String };

action ReadOwnWorkerProfile appliesTo { principal: Person, resource: Worker, context: {} };
action UpdateOwnWorkerProfile appliesTo { principal: Person, resource: Worker, context: {} };
action DeleteOwnAccount appliesTo { principal: Person, resource: Account, context: { tokenUid: String } };
`;
