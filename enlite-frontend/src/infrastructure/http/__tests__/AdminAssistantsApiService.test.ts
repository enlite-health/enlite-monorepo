/**
 * AdminAssistentesApiService — spec 080 fase A (contrato `rota-mensagens.md`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AdminAssistentesApiService } from "../AdminAssistentesApiService";
import { AssistenteErro } from "@domain/entities/Assistente";

vi.mock("@infrastructure/services/FirebaseAuthService", () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: () => Promise.resolve("mock-token"),
  })),
}));

function mockFetch(payload: unknown, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: () => Promise.resolve(payload),
  }) as unknown as typeof fetch;
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

const MSG = {
  id: "m1",
  autor: "agente",
  texto: "hola",
  ferramentas: [],
  validador: "ok",
  criado_em: "2026-10-30T10:00:00Z",
};

async function erroDe(p: Promise<unknown>): Promise<AssistenteErro> {
  try {
    await p;
  } catch (e) {
    return e as AssistenteErro;
  }
  throw new Error("não lançou");
}

describe("AdminAssistentesApiService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listar: GET /assistentes com Bearer, devolve o array agentes (corpo sem envelope)", async () => {
    const agentes = [
      {
        slug: "maria",
        nome: "Maria",
        papel: "gestora",
        area: "recrutamento",
        disponivel: true,
        nao_lidas: 0,
      },
    ];
    const f = mockFetch({ agentes });
    expect(await AdminAssistentesApiService.listar()).toEqual(agentes);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/admin/assistentes");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer mock-token",
    );
  });

  it("listar: aceita também o envelope {success,data}; lista vazia vira []", async () => {
    mockFetch({ success: true, data: { agentes: [] } });
    expect(await AdminAssistentesApiService.listar()).toEqual([]);
  });

  it("mensagens: GET com limite e antes na query", async () => {
    const f = mockFetch({ conversa_id: null, mensagens: [] });
    const out = await AdminAssistentesApiService.mensagens("maria", {
      limite: 50,
      antes: "2026-10-30T10:00:00Z",
    });
    expect(out).toEqual({ conversa_id: null, mensagens: [] });
    const [url] = f.mock.calls[0] as [string];
    expect(url).toContain("/api/admin/assistentes/maria/mensagens?");
    expect(url).toContain("limite=50");
    expect(url).toContain("antes=2026-10-30T10%3A00%3A00Z");
  });

  it("mensagens: sem params não manda query", async () => {
    const f = mockFetch({ conversa_id: "c1", mensagens: [MSG] });
    await AdminAssistentesApiService.mensagens("maria");
    expect((f.mock.calls[0] as [string])[0]).toMatch(
      /\/assistentes\/maria\/mensagens$/,
    );
  });

  it("enviar: POST com {texto}, devolve conversa, mensagem e turno", async () => {
    const resp = {
      conversa_id: "c1",
      mensagem: MSG,
      turno: { tokens_in: 10, tokens_out: 5, custo_usd: 0.0001 },
    };
    const f = mockFetch(resp);
    expect(await AdminAssistentesApiService.enviar("maria", "hola")).toEqual(
      resp,
    );
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/admin/assistentes/maria/mensagens");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ texto: "hola" });
  });

  it("403 SEM_CELULA vira AssistenteErro{code,status}", async () => {
    mockFetch(
      { success: false, code: "SEM_CELULA", message: "sin acceso" },
      403,
    );
    const e = await erroDe(AdminAssistentesApiService.enviar("maria", "x"));
    expect(e).toBeInstanceOf(AssistenteErro);
    expect(e.code).toBe("SEM_CELULA");
    expect(e.status).toBe(403);
  });

  it.each([
    [429, "TETO_PESSOA_DIA"],
    [429, "TETO_AGENTE_MES"],
    [502, "ERRO_MODELO"],
    [404, "AGENTE_DESCONHECIDO"],
    [409, "AGENTE_INDISPONIVEL"],
    [400, "FORMATO_INVALIDO"],
  ])("%i %s preserva o código do servidor", async (status, code) => {
    mockFetch({ success: false, code, message: "m" }, status);
    const e = await erroDe(AdminAssistentesApiService.enviar("maria", "x"));
    expect(e.code).toBe(code);
    expect(e.status).toBe(status);
  });

  it("sem code no corpo: cai no código do contrato daquele status (429, 502, 403)", async () => {
    mockFetch({}, 429);
    expect(
      (await erroDe(AdminAssistentesApiService.enviar("maria", "x"))).code,
    ).toBe("TETO_PESSOA_DIA");
    mockFetch({}, 502);
    expect(
      (await erroDe(AdminAssistentesApiService.enviar("maria", "x"))).code,
    ).toBe("ERRO_MODELO");
    mockFetch({}, 403);
    expect((await erroDe(AdminAssistentesApiService.listar())).code).toBe(
      "SEM_CELULA",
    );
  });

  it("status/código fora do contrato vira DESCONHECIDO", async () => {
    mockFetch({ success: false, code: "XYZ" }, 500);
    expect((await erroDe(AdminAssistentesApiService.listar())).code).toBe(
      "DESCONHECIDO",
    );
  });
});
