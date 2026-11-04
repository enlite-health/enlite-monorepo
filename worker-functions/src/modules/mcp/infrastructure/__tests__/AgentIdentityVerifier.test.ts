import { logger } from '@shared/logging';
import { AGENT_AUDIENCE } from '../../domain/AgentCapabilityCells';
import {
  GoogleAgentIdentityVerifier,
  MockAgentIdentityVerifier,
  createAgentIdentityVerifier,
  verifyAgentToken,
  type IdTokenClient,
} from '../AgentIdentityVerifier';

const ENV = { GCP_PROJECT_ID: 'enlite-teste' } as NodeJS.ProcessEnv;
const SA = 'luz-sa@enlite-teste.iam.gserviceaccount.com';
const ASSISTANTS_AUD = 'https://api.enlite.health/assistentes';

const mock = (p: { email?: string; email_verified?: boolean; aud?: string }): string =>
  `mock_${Buffer.from(JSON.stringify({ email: SA, email_verified: true, aud: AGENT_AUDIENCE, ...p })).toString('base64')}`;

/** Dublê do `OAuth2Client`: faz o que o Google faz com a audiência (compara com a do token) e exige 3 segmentos. */
const fakeGoogle = (payload: { aud: string; email?: string; email_verified?: boolean }): IdTokenClient => ({
  async verifyIdToken({ idToken, audience }) {
    if (idToken.split('.').length !== 3) throw new Error('Wrong number of segments in token');
    if (audience !== undefined && audience !== payload.aud) throw new Error('Wrong recipient');
    return { getPayload: () => ({ email: payload.email ?? SA, email_verified: payload.email_verified ?? true }) };
  },
});

describe('AgentIdentityVerifier (porta MCP do agente)', () => {
  it('audiência fixa: token da audiência do agente passa pelo verificador do Google e devolve o e-mail', async () => {
    const v = new GoogleAgentIdentityVerifier(fakeGoogle({ aud: AGENT_AUDIENCE }));
    await expect(verifyAgentToken(v, 'a.b.c', ENV)).resolves.toBe(SA);
    expect(AGENT_AUDIENCE).toBe('https://api.enlite.health/mcp-agente');
  });

  it('o header aceita `Bearer <token>` e o token puro (os dois dão o mesmo e-mail); `Bearer ` vazio é recusado', async () => {
    const v = new GoogleAgentIdentityVerifier(fakeGoogle({ aud: AGENT_AUDIENCE }));
    await expect(verifyAgentToken(v, 'Bearer a.b.c', ENV)).resolves.toBe(SA);
    await expect(verifyAgentToken(v, 'a.b.c', ENV)).resolves.toBe(SA);
    await expect(verifyAgentToken(v, 'Bearer ', ENV)).resolves.toBeNull();
  });

  it('audiência da porta das assistentes (…/assistentes) é recusada', async () => {
    const v = new GoogleAgentIdentityVerifier(fakeGoogle({ aud: ASSISTANTS_AUD }));
    await expect(verifyAgentToken(v, 'a.b.c', ENV)).resolves.toBeNull();
    await expect(verifyAgentToken(new MockAgentIdentityVerifier(), mock({ aud: ASSISTANTS_AUD }), { ...ENV, USE_MOCK_AUTH: 'true' })).resolves.toBeNull();
  });

  it('email_verified=false é recusado (controle: true passa)', async () => {
    const ruim = new GoogleAgentIdentityVerifier(fakeGoogle({ aud: AGENT_AUDIENCE, email_verified: false }));
    await expect(verifyAgentToken(ruim, 'a.b.c', ENV)).resolves.toBeNull();
    const bom = new GoogleAgentIdentityVerifier(fakeGoogle({ aud: AGENT_AUDIENCE, email_verified: true }));
    await expect(verifyAgentToken(bom, 'a.b.c', ENV)).resolves.toBe(SA);
  });

  it('e-mail fora do sufixo @<GCP_PROJECT_ID>.iam.gserviceaccount.com é recusado; sem GCP_PROJECT_ID, tudo recusado (fail-closed)', async () => {
    const outro = new GoogleAgentIdentityVerifier(fakeGoogle({ aud: AGENT_AUDIENCE, email: 'luz@outro-projeto.iam.gserviceaccount.com' }));
    await expect(verifyAgentToken(outro, 'a.b.c', ENV)).resolves.toBeNull();
    const humano = new GoogleAgentIdentityVerifier(fakeGoogle({ aud: AGENT_AUDIENCE, email: 'alguem@enlite.health' }));
    await expect(verifyAgentToken(humano, 'a.b.c', ENV)).resolves.toBeNull();
    const ok = new GoogleAgentIdentityVerifier(fakeGoogle({ aud: AGENT_AUDIENCE }));
    await expect(verifyAgentToken(ok, 'a.b.c', {} as NodeJS.ProcessEnv)).resolves.toBeNull();
  });

  it('token longo (não-JWT, hex opaco do MCP_TOKEN legado) é recusado', async () => {
    const v = new GoogleAgentIdentityVerifier(fakeGoogle({ aud: AGENT_AUDIENCE }));
    await expect(verifyAgentToken(v, 'f'.repeat(64), ENV)).resolves.toBeNull();
  });

  it('o mock só funciona com USE_MOCK_AUTH=true; em prd (flag ausente) é recusado (controle: com a flag, o MESMO mock passa)', async () => {
    const token = mock({});
    const comFlag = createAgentIdentityVerifier(undefined, { ...ENV, USE_MOCK_AUTH: 'true' });
    await expect(verifyAgentToken(comFlag, token, ENV)).resolves.toBe(SA);
    // sem a flag, o fábrica ignora o dublê e devolve o do Google: o mock não é JWT, então não passa
    const semFlag = createAgentIdentityVerifier(new MockAgentIdentityVerifier(), ENV);
    expect(semFlag).toBeInstanceOf(GoogleAgentIdentityVerifier);
    await expect(verifyAgentToken(semFlag, token, ENV)).resolves.toBeNull();
  });

  it('só o NOME do erro vai ao log: nem o token nem o e-mail aparecem', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const segredo = `mock_${'Z'.repeat(40)}`;
    const v = { verify: async () => { throw new Error(`falhou com ${segredo} e ${SA}`); } };
    await expect(verifyAgentToken(v, segredo, ENV)).resolves.toBeNull();
    const logado = JSON.stringify(warn.mock.calls);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logado).toContain('Error');
    expect(logado).not.toContain(segredo);
    expect(logado).not.toContain(SA);
    warn.mockRestore();
  });
});
