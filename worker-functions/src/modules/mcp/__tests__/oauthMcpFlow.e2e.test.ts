/**
 * Integração end-to-end do conector claude.ai (in-process, servidor HTTP real):
 * descoberta RFC 8414/9728 → DCR → /authorize (consent page) → /oauth/consent
 * → /token com PKCE validado pelo SDK → client MCP oficial faz tools/list.
 * Firebase é o único stub (verifyIdToken injetado); todo o resto é real.
 */
import express from 'express';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mountOAuthRoutes } from '../bootstrap/mountOAuthRoutes';
import { createMcpRoutes } from '../interfaces/routes/mcpRoutes';
import { CapabilityRegistry } from '../application/CapabilityRegistry';
import { WorkerProfileGetCapability } from '../application/capabilities/WorkerProfileGetCapability';
import { WorkerDocumentsListCapability } from '../application/capabilities/WorkerDocumentsListCapability';
import { WorkerVacanciesListCapability } from '../application/capabilities/WorkerVacanciesListCapability';
import { WorkerInterviewGetCapability } from '../application/capabilities/WorkerInterviewGetCapability';
import { WorkerProfileUpdateCapability } from '../application/capabilities/WorkerProfileUpdateCapability';
import { WorkerProfileProposeUpdateCapability } from '../application/capabilities/WorkerProfileProposeUpdateCapability';
import { WorkerProfileConfirmUpdateCapability } from '../application/capabilities/WorkerProfileConfirmUpdateCapability';
import { WorkerDocumentsUploadCapability } from '../application/capabilities/WorkerDocumentsUploadCapability';
import { WorkerStatsGetCapability } from '../application/capabilities/WorkerStatsGetCapability';
import { WorkerSearchCapability } from '../application/capabilities/WorkerSearchCapability';
import { WorkerCaseMemoryGetCapability } from '../application/capabilities/WorkerCaseMemoryGetCapability';
import { WorkerCaseMemoryPutCapability } from '../application/capabilities/WorkerCaseMemoryPutCapability';
import { WorkerOptOutRegisterCapability } from '../application/capabilities/WorkerOptOutRegisterCapability';
import { WorkerAccountDeactivateCapability } from '../application/capabilities/WorkerAccountDeactivateCapability';
import { WorkerAvailabilitySetCapability } from '../application/capabilities/WorkerAvailabilitySetCapability';
import { WorkerVacanciesNearbyCapability } from '../application/capabilities/WorkerVacanciesNearbyCapability';
import { WorkerAvailabilityGetCapability } from '../application/capabilities/WorkerAvailabilityGetCapability';
import { WorkerApplicationRegisterCapability } from '../application/capabilities/WorkerApplicationRegisterCapability';
import { WorkerInterviewSlotsListCapability } from '../application/capabilities/WorkerInterviewSlotsListCapability';
import { WorkerInterviewBookCapability } from '../application/capabilities/WorkerInterviewBookCapability';
import { HandoverNotifyCapability } from '../application/capabilities/HandoverNotifyCapability';
import { WorkerApplicationsListCapability } from '../application/capabilities/WorkerApplicationsListCapability';
import { PatientChatMapCapability } from '../application/capabilities/PatientChatMapCapability';
import { WorkerProfileEditsStatsCapability } from '../application/capabilities/WorkerProfileEditsStatsCapability';
import { FunnelActivityStatsCapability } from '../application/capabilities/FunnelActivityStatsCapability';

const SIGNING_KEY = 's'.repeat(64);
const STAFF = { email: 'ana@enlite.health', role: 'recruiter' };

function makeRegistry(): CapabilityRegistry {
  const stub = { execute: jest.fn().mockResolvedValue({}) } as never;
  return new CapabilityRegistry({
    profileGet: new WorkerProfileGetCapability(stub),
    documentsList: new WorkerDocumentsListCapability({
      findByWorkerId: jest.fn().mockResolvedValue(null),
    } as never),
    vacanciesList: new WorkerVacanciesListCapability(stub),
    interviewGet: new WorkerInterviewGetCapability(stub),
    profileUpdate: new WorkerProfileUpdateCapability(stub),
    profilePropose: new WorkerProfileProposeUpdateCapability(stub),
    profileConfirm: new WorkerProfileConfirmUpdateCapability(stub),
    documentsUpload: new WorkerDocumentsUploadCapability(stub),
    statsGet: new WorkerStatsGetCapability(stub),
    profileEditsStats: new WorkerProfileEditsStatsCapability(stub),
    funnelActivityStats: new FunnelActivityStatsCapability(stub),
    workerSearch: new WorkerSearchCapability(stub),
    caseMemoryGet: new WorkerCaseMemoryGetCapability(stub),
    caseMemoryPut: new WorkerCaseMemoryPutCapability(stub),
    optOutRegister: new WorkerOptOutRegisterCapability(stub),
    accountDeactivate: new WorkerAccountDeactivateCapability(stub),
    availabilitySet: new WorkerAvailabilitySetCapability(stub),
    availabilityGet: new WorkerAvailabilityGetCapability(stub),
    vacanciesNearby: new WorkerVacanciesNearbyCapability(stub),
    applicationRegister: new WorkerApplicationRegisterCapability(stub, {} as never, stub),
    interviewSlotsList: new WorkerInterviewSlotsListCapability(stub),
    interviewBook: new WorkerInterviewBookCapability(stub, stub),
    handoverNotify: new HandoverNotifyCapability(stub),
    applicationsList: new WorkerApplicationsListCapability(stub),
    patientChatMap: new PatientChatMapCapability(stub),
    auditor: { emit: jest.fn() },
  });
}

describe('OAuth 2.1 + MCP — fluxo conector claude.ai (e2e in-process)', () => {
  let server: Server;
  let baseUrl: string;
  const auditor = { emit: jest.fn() };

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Porta primeiro: o issuer precisa constar no token (validação de issuer do JWT)
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;

    const oauth = mountOAuthRoutes(
      app,
      {
        issuerUrl: baseUrl,
        signingKey: SIGNING_KEY,
        firebaseApiKey: 'fake-api-key',
        firebaseAuthDomain: 'fake.firebaseapp.com',
      },
      {
        staffLookup: { findByEmail: jest.fn().mockResolvedValue(STAFF) },
        auditor,
        verifyIdToken: jest.fn().mockResolvedValue({
          uid: 'uid-1',
          email: STAFF.email,
          email_verified: true,
        } as never),
      },
    );

    app.use(
      '/mcp',
      createMcpRoutes({
        principalRepo: { findByToken: jest.fn().mockResolvedValue(null) } as never,
        auditor: auditor as never,
        registry: makeRegistry(),
        serverName: 'enlite-worker-mcp-test',
        serverVersion: '0.0.1',
        oauthVerifier: oauth.verifier,
        resourceMetadataUrl: oauth.resourceMetadataUrl,
      }),
    );
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function runFullFlow(): Promise<string> {
    // 1. Descoberta
    const asMeta = await request(server).get('/.well-known/oauth-authorization-server');
    expect(asMeta.status).toBe(200);
    expect(asMeta.body.registration_endpoint).toContain('/register');
    expect(asMeta.body.code_challenge_methods_supported).toContain('S256');

    const rsMeta = await request(server).get('/.well-known/oauth-protected-resource/mcp/v1');
    expect(rsMeta.status).toBe(200);
    expect(rsMeta.body.authorization_servers).toContain(`${baseUrl}/`);

    // 2. DCR
    const registered = await request(server)
      .post('/register')
      .send({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' });
    expect(registered.status).toBe(201);
    const clientId = registered.body.client_id as string;
    expect(registered.body.client_secret).toBeUndefined();

    // 3. /authorize com PKCE → consent page com requestContext embutido
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = await request(server).get('/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'state-123',
    });
    expect(authorize.status).toBe(200);
    const match = /var requestContext = "([^"]+)"/.exec(authorize.text);
    expect(match).not.toBeNull();

    // 4. Consent (Firebase stubado, staff real via lookup)
    const consent = await request(server)
      .post('/oauth/consent')
      .send({ idToken: 'stub-firebase-token', requestContext: (match as RegExpExecArray)[1] });
    expect(consent.status).toBe(200);
    const redirectUrl = new URL(consent.body.redirectUrl as string);
    expect(redirectUrl.searchParams.get('state')).toBe('state-123');
    const code = redirectUrl.searchParams.get('code') as string;

    // 5. /token — PKCE validado pelo SDK (S256 real)
    const token = await request(server).post('/token').type('form').send({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    });
    expect(token.status).toBe(200);
    expect(token.body.token_type).toBe('bearer');
    expect(token.body.refresh_token).toBeTruthy();
    return token.body.access_token as string;
  }

  it('fluxo completo: descoberta → DCR → authorize → consent → token → tools/list read-only', async () => {
    const accessToken = await runFullFlow();

    // 6. Client MCP oficial com o access token
    const client = new Client({ name: 'e2e-test-client', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/v1`), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    await client.close();

    const names = tools.tools.map((t) => t.name).sort();
    // Principal OAuth vê nomes claude-safe (claude.ai rejeita "." em tool name)
    expect(names).toEqual([
      'worker_documents_list',
      'worker_interview_get',
      'worker_profile_get',
      'worker_search',
      'worker_stats_get',
      'worker_vacancies_list',
    ]);
    for (const name of names) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  }, 20_000);

  it('code_verifier errado → /token recusa (PKCE do SDK)', async () => {
    // Reaproveita o fluxo até o code, mas troca o verifier
    const registered = await request(server)
      .post('/register')
      .send({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'C2' });
    const clientId = registered.body.client_id as string;

    const challenge = createHash('sha256')
      .update(randomBytes(32).toString('base64url'))
      .digest('base64url');
    const authorize = await request(server).get('/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const ctx = (/var requestContext = "([^"]+)"/.exec(authorize.text) as RegExpExecArray)[1];
    const consent = await request(server)
      .post('/oauth/consent')
      .send({ idToken: 'stub', requestContext: ctx });
    const code = new URL(consent.body.redirectUrl as string).searchParams.get('code') as string;

    const token = await request(server).post('/token').type('form').send({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    });
    expect(token.status).toBe(400);
    expect(token.body.error).toBe('invalid_grant');
  });

  it('POST /mcp/v1 sem token → 401 com WWW-Authenticate apontando o resource metadata', async () => {
    const res = await request(server)
      .post('/mcp/v1')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain(
      '/.well-known/oauth-protected-resource/mcp/v1',
    );
  });
});
