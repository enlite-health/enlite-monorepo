import * as admin from 'firebase-admin';
import { mergeCustomClaims } from '@modules/identity/infrastructure/mergeCustomClaims';
import type { CountryClaimWrite, ICountryClaimPort } from '../ports/ICountryClaimPort';

async function claimedCountry(uid: string): Promise<unknown> {
  return ((await admin.auth().getUser(uid)).customClaims ?? {}).country;
}

/**
 * Adapter do Identity Platform. Claim já posto (as contas `qa.*`, ou um staff) nunca é trocado.
 * O Firebase não tem escrita condicional: entre o `getUser` e o `setCustomUserClaims` do `mergeCustomClaims`,
 * outro escritor (o `/v1/me/areas`, que regrava `pid`/`areas`) pode regravar o objeto sem o `country`.
 * Por isso relê e, se o `country` sumiu, grava de novo uma vez.
 */
export class FirebaseCountryClaim implements ICountryClaimPort {
  async ensureCountry(uid: string, country: string): Promise<CountryClaimWrite> {
    if (await claimedCountry(uid)) return 'already_set';
    await mergeCustomClaims(uid, { country });
    if ((await claimedCountry(uid)) !== country) await mergeCustomClaims(uid, { country });
    return 'provisioned';
  }
}
