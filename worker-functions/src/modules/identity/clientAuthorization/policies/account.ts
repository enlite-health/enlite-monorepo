/**
 * Política da PRÓPRIA conta: a `Account` é montada do token (uid e dono), então `resource.uid == context.tokenUid`
 * só fecha quando o recurso é o login que chamou (D650: sem comparar header).
 */
export const ACCOUNT_POLICIES = `
permit(principal is Person, action == Action::"DeleteOwnAccount", resource is Account)
  when { resource.owner == principal && resource.uid == context.tokenUid };
`;
