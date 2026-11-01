/**
 * AdminAssistantsApiService — spec 080 phase A (contract `rotas-gestoras-service.md`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AdminAssistantsApiServiceClass,
  resolveAssistantsBaseUrl,
} from "../AdminAssistantsApiService";
import { AssistantError } from "@domain/entities/Assistant";

const getIdToken = vi.hoisted(() => vi.fn());

vi.mock("@infrastructure/services/FirebaseAuthService", () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken })),
}));

// The base is injected (vitest 1.4 cannot change import.meta.env); no base = no request.
const AdminAssistantsApiService = new AdminAssistantsApiServiceClass(
  "http://localhost:8080",
);

type Reply = { status?: number; payload?: unknown };

function mockFetch(...replies: Reply[]) {
  const fn = vi.fn();
  replies.forEach(({ status = 200, payload = {} }, i) => {
    const res = {
      ok: status < 400,
      status,
      json:
        status === 204
          ? () => Promise.reject(new Error("no body"))
          : () => Promise.resolve(payload),
    };
    if (i === replies.length - 1) fn.mockResolvedValue(res);
    else fn.mockResolvedValueOnce(res);
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const MSG = {
  id: "m1",
  author: "ASSISTANT",
  text: "hola",
  tools: [],
  validator: "OK",
  created_at: "2026-10-30T10:00:00Z",
};

const EXPIRED = {
  status: 401,
  payload: { success: false, code: "TOKEN_EXPIRED", message: "x" },
};

async function errorOf(p: Promise<unknown>): Promise<AssistantError> {
  try {
    await p;
  } catch (e) {
    return e as AssistantError;
  }
  throw new Error("did not throw");
}

describe("AdminAssistantsApiService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIdToken.mockReset();
    getIdToken.mockResolvedValue("mock-token");
  });

  it("list: GET /assistants with Bearer, returns the assistants array (no envelope)", async () => {
    const assistants = [
      {
        slug: "maria",
        name: "Maria",
        role: "MANAGER",
        area: "recrutamento",
        available: true,
        last_at: null,
        unread_count: 0,
      },
    ];
    const f = mockFetch({ payload: { assistants } });
    expect(await AdminAssistantsApiService.list()).toEqual(assistants);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8080/assistants");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer mock-token",
    );
  });

  // vitest 1.4 does not let a test change the module's import.meta.env (same gap as the sibling
  // AdminTherapeuticProjectsApiService.test.ts), so the choice of variable is tested on the pure resolver.
  it("the base is the service's VITE_ASSISTANTS_SERVICE_URL, never the platform's", () => {
    expect(
      resolveAssistantsBaseUrl({
        VITE_ASSISTANTS_SERVICE_URL: "http://assistants.test",
        VITE_API_WORKER_FUNCTIONS_URL: "http://platform.test",
      }),
    ).toBe("http://assistants.test");
  });

  it("the platform's variable alone does NOT set the base (stays empty: no localhost fallback)", () => {
    expect(
      resolveAssistantsBaseUrl({
        VITE_API_WORKER_FUNCTIONS_URL: "http://platform.test",
      }),
    ).toBe("");
    expect(resolveAssistantsBaseUrl(undefined)).toBe("");
  });

  it("empty base = fail-closed: list() never calls fetch and returns []", async () => {
    const f = mockFetch({ payload: { assistants: [{ slug: "x" }] } });
    const svc = new AdminAssistantsApiServiceClass("");
    expect(await svc.list()).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("empty base: messages/sendMessage/markRead do not fetch either (PLATFORM_UNAVAILABLE)", async () => {
    const f = mockFetch({ payload: {} });
    const svc = new AdminAssistantsApiServiceClass("");
    for (const call of [
      () => svc.messages("maria"),
      () => svc.sendMessage("maria", "hi"),
      () => svc.markRead("maria"),
    ]) {
      expect((await errorOf(call())).code).toBe("PLATFORM_UNAVAILABLE");
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("list: also accepts the {success,data} envelope; empty list stays []", async () => {
    mockFetch({ payload: { success: true, data: { assistants: [] } } });
    expect(await AdminAssistantsApiService.list()).toEqual([]);
  });

  it("messages: GET with limit and before in the query", async () => {
    const f = mockFetch({ payload: { conversation_id: null, messages: [] } });
    const out = await AdminAssistantsApiService.messages("maria", {
      limit: 50,
      before: "2026-10-30T10:00:00Z",
    });
    expect(out).toEqual({ conversation_id: null, messages: [] });
    const [url] = f.mock.calls[0] as [string];
    expect(url).toContain("/assistants/maria/messages?");
    expect(url).toContain("limit=50");
    expect(url).toContain("before=2026-10-30T10%3A00%3A00Z");
  });

  it("messages: without params sends no query", async () => {
    const f = mockFetch({
      payload: { conversation_id: "c1", messages: [MSG] },
    });
    await AdminAssistantsApiService.messages("maria");
    expect((f.mock.calls[0] as [string])[0]).toMatch(
      /\/assistants\/maria\/messages$/,
    );
  });

  it("sendMessage: POST with {text}, returns conversation, message and turn", async () => {
    const resp = {
      conversation_id: "c1",
      message: MSG,
      turn: { tokens_in: 10, tokens_out: 5, cost_usd: 0.0001 },
    };
    const f = mockFetch({ payload: resp });
    expect(
      await AdminAssistantsApiService.sendMessage("maria", "hola"),
    ).toEqual(resp);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8080/assistants/maria/messages");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ text: "hola" });
  });

  it("getIdToken is called before EACH send and the token is not reused", async () => {
    const f = mockFetch({ payload: { assistants: [] } });
    getIdToken.mockResolvedValueOnce("t1").mockResolvedValueOnce("t2");
    await AdminAssistantsApiService.list();
    await AdminAssistantsApiService.list();
    expect(getIdToken).toHaveBeenCalledTimes(2);
    const auth = (i: number) =>
      ((f.mock.calls[i] as [string, RequestInit])[1].headers as Record<
        string,
        string
      >).Authorization;
    expect(auth(0)).toBe("Bearer t1");
    expect(auth(1)).toBe("Bearer t2");
  });

  it("401 TOKEN_EXPIRED: repeats ONCE with a fresh token and succeeds", async () => {
    const f = mockFetch(EXPIRED, { payload: { assistants: [] } });
    getIdToken.mockResolvedValueOnce("old").mockResolvedValueOnce("fresh");
    expect(await AdminAssistantsApiService.list()).toEqual([]);
    expect(f).toHaveBeenCalledTimes(2);
    expect(getIdToken).toHaveBeenCalledTimes(2);
    const h = (f.mock.calls[1] as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer fresh");
  });

  it("401 TOKEN_EXPIRED twice: only 1 repetition, then throws the error", async () => {
    const f = mockFetch(EXPIRED);
    const e = await errorOf(AdminAssistantsApiService.list());
    expect(f).toHaveBeenCalledTimes(2);
    expect(e.code).toBe("TOKEN_EXPIRED");
    expect(e.status).toBe(401);
  });

  it("401 TOKEN_INVALID is not repeated", async () => {
    const f = mockFetch({
      status: 401,
      payload: { success: false, code: "TOKEN_INVALID", message: "x" },
    });
    const e = await errorOf(AdminAssistantsApiService.list());
    expect(f).toHaveBeenCalledTimes(1);
    expect(e.code).toBe("TOKEN_INVALID");
  });

  it("403 NO_REACH becomes AssistantError{code,status}", async () => {
    mockFetch({
      status: 403,
      payload: { success: false, code: "NO_REACH", message: "sin acceso" },
    });
    const e = await errorOf(
      AdminAssistantsApiService.sendMessage("maria", "x"),
    );
    expect(e).toBeInstanceOf(AssistantError);
    expect(e.code).toBe("NO_REACH");
    expect(e.status).toBe(403);
  });

  it.each([
    [429, "PERSON_DAILY_CAP"],
    [429, "ASSISTANT_MONTHLY_CAP"],
    [502, "MODEL_ERROR"],
    [503, "PLATFORM_UNAVAILABLE"],
    [403, "NOT_STAFF"],
    [409, "ASSISTANT_UNAVAILABLE"],
    [400, "INVALID_FORMAT"],
    [422, "INPUT_CLINICAL"],
    [422, "INPUT_PERSONAL_DATA"],
  ])("%i %s keeps the server's code", async (status, code) => {
    mockFetch({ status, payload: { success: false, code, message: "m" } });
    const e = await errorOf(
      AdminAssistantsApiService.sendMessage("maria", "x"),
    );
    expect(e.code).toBe(code);
    expect(e.status).toBe(status);
  });

  it("no code in the body: falls back to the contract's code for that status", async () => {
    mockFetch({ status: 429 });
    expect(
      (await errorOf(AdminAssistantsApiService.sendMessage("maria", "x"))).code,
    ).toBe("PERSON_DAILY_CAP");
    mockFetch({ status: 502 });
    expect(
      (await errorOf(AdminAssistantsApiService.sendMessage("maria", "x"))).code,
    ).toBe("MODEL_ERROR");
    mockFetch({ status: 403 });
    expect((await errorOf(AdminAssistantsApiService.list())).code).toBe(
      "NO_REACH",
    );
  });

  it("status/code outside the contract becomes UNKNOWN", async () => {
    mockFetch({ status: 500, payload: { success: false, code: "XYZ" } });
    expect((await errorOf(AdminAssistantsApiService.list())).code).toBe(
      "UNKNOWN",
    );
  });

  it("markRead is a POST /assistants/<slug>/read WITHOUT body; 204 is success", async () => {
    const f = mockFetch({ status: 204 });
    await expect(
      AdminAssistantsApiService.markRead("maria"),
    ).resolves.toBeUndefined();
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8080/assistants/maria/read");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer mock-token",
    );
  });

  it("markRead: fresh getIdToken() before each call", async () => {
    mockFetch({ status: 204 });
    await AdminAssistantsApiService.markRead("maria");
    await AdminAssistantsApiService.markRead("maria");
    expect(getIdToken).toHaveBeenCalledTimes(2);
  });

  it("markRead: 401 TOKEN_EXPIRED repeats ONCE with a new token", async () => {
    const f = mockFetch(EXPIRED, { status: 204 });
    getIdToken.mockResolvedValueOnce("old").mockResolvedValueOnce("fresh");
    await AdminAssistantsApiService.markRead("maria");
    expect(f).toHaveBeenCalledTimes(2);
    const h = (f.mock.calls[1] as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer fresh");
  });

  it("markRead: 403 NO_REACH throws and is not repeated", async () => {
    const f = mockFetch({
      status: 403,
      payload: { success: false, code: "NO_REACH", message: "x" },
    });
    const e = await errorOf(AdminAssistantsApiService.markRead("maria"));
    expect(f).toHaveBeenCalledTimes(1);
    expect(e.code).toBe("NO_REACH");
  });
});
