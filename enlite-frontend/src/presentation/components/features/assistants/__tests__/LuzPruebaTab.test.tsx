/**
 * LuzPruebaTab + the gating of the tab in the widget — spec 086 (F3: RF-1..5, CA-7..9 at unit level).
 * The platform service is mocked by module. Real i18n (es + pt-BR). Cell = the real `useHasCell` over the auth store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import i18n from "i18next";
import es from "@infrastructure/i18n/locales/es.json";
import ptBR from "@infrastructure/i18n/locales/pt-BR.json";
import { AdminLuzPruebaApiService } from "@infrastructure/http/AdminLuzPruebaApiService";
import { AdminAssistantsApiService } from "@infrastructure/http/AdminAssistantsApiService";
import { LuzPruebaError, type LuzPruebaTurnResponse } from "@domain/entities/LuzPrueba";
import type { Assistant } from "@domain/entities/Assistant";
import { useAdminAuthStore } from "@presentation/stores/adminAuthStore";
import { useLuzPrueba } from "@presentation/hooks/useLuzPrueba";
import { AssistantsWidget } from "../AssistantsWidget";
import { LuzPruebaTab } from "../LuzPruebaTab";

i18n.addResourceBundle("es", "translation", es, true, true);
i18n.addResourceBundle("pt-BR", "translation", ptBR, true, true);

vi.mock("@infrastructure/http/AdminLuzPruebaApiService", () => ({
  AdminLuzPruebaApiService: { turn: vi.fn() },
}));
vi.mock("@infrastructure/http/AdminAssistantsApiService", () => ({
  AdminAssistantsApiService: { list: vi.fn(), messages: vi.fn(), sendMessage: vi.fn(), markRead: vi.fn() },
}));

const turn = vi.mocked(AdminLuzPruebaApiService.turn);
const assistants = vi.mocked(AdminAssistantsApiService);

const T = es.admin.luzPrueba;

function Harness() {
  const s = useLuzPrueba();
  return <LuzPruebaTab state={s} />;
}

const ok = (over: Partial<LuzPruebaTurnResponse> = {}): LuzPruebaTurnResponse => ({
  tipo: "reply",
  texto: "Hola, soy Luz",
  ferramentas: [],
  validadores: [],
  prestadora: { nome: "Prueba Luz PRUEBA" },
  ...over,
});

async function enviar(texto: string) {
  const box = screen.getByTestId("luz-prueba-input");
  fireEvent.change(box, { target: { value: texto } });
  fireEvent.keyDown(box, { key: "Enter" });
}

function setCells(cells: string[]) {
  useAdminAuthStore.setState({
    authzStatus: "ready",
    authz: {
      uid: "u1", tenantId: "t", status: "ACTIVE", permissions: cells, countries: ["AR"], groups: [], features: {},
    },
  });
}

describe("LuzPruebaTab (spec 086)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    void i18n.changeLanguage("es");
  });

  it("renders the FIXED header (generic before the first answer) and the same composer", () => {
    render(<Harness />);
    expect(screen.getByTestId("luz-prueba-header").textContent).toBe(T.headerGeneric);
    expect(screen.getByTestId("luz-prueba-input")).toBeTruthy();
    expect(screen.getByTestId("luz-prueba-reset")).toBeTruthy();
  });

  it("sends with Enter, shows the answer, the tools line (dry run vs read) and the validators; the header takes the provider's name", async () => {
    turn.mockResolvedValue(
      ok({
        ferramentas: [
          { nome: "get_worker_status", ok: true, prueba: false },
          { nome: "apply_to_vacancy", ok: true, prueba: true },
        ],
        validadores: ["notario:x"],
      }),
    );
    render(<Harness />);
    await enviar("hola");
    await waitFor(() => expect(screen.getAllByTestId("luz-prueba-msg")).toHaveLength(2));
    const msgs = screen.getAllByTestId("luz-prueba-msg");
    expect(msgs.map((m) => m.getAttribute("data-role"))).toEqual(["user", "assistant"]);
    expect(msgs[1].textContent).toBe("Hola, soy Luz");
    const tools = screen.getByTestId("luz-prueba-tools").textContent ?? "";
    expect(tools).toContain("(prueba) apply_to_vacancy — ok simulado");
    expect(tools).toContain("get_worker_status — ok");
    expect(tools).toContain("notario:x");
    expect(screen.getByTestId("luz-prueba-header").textContent).toBe(
      T.header.replace("{{nome}}", "Prueba Luz PRUEBA"),
    );
    const call = turn.mock.calls[0][0];
    expect(call.mensagem).toBe("hola");
    expect(call.historico).toEqual([]);
    expect(call.sessao).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
  });

  it("disables send while waiting; the next turn carries the last turns as history (at most 10, without the current message)", async () => {
    turn.mockResolvedValue(ok());
    render(<Harness />);
    for (let i = 1; i <= 7; i++) {
      await enviar(`m${i}`);
      await waitFor(() => expect(screen.getAllByTestId("luz-prueba-msg")).toHaveLength(i * 2));
    }
    const last = turn.mock.calls[6][0];
    expect(last.mensagem).toBe("m7");
    expect(last.historico).toHaveLength(10);
    expect(last.historico[0]).toEqual({ role: "user", content: "m2" });
    expect(last.historico[9]).toEqual({ role: "assistant", content: "Hola, soy Luz" });
  });

  it("blocks a second send while the first is in flight", async () => {
    let done: (r: LuzPruebaTurnResponse) => void = () => undefined;
    turn.mockReturnValue(new Promise((r) => (done = r)));
    render(<Harness />);
    await enviar("uno");
    await waitFor(() => expect(screen.getByTestId("luz-prueba-typing")).toBeTruthy());
    expect(screen.getByTestId("luz-prueba-send")).toBeDisabled();
    await enviar("dos");
    expect(turn).toHaveBeenCalledTimes(1);
    await act(async () => done(ok()));
  });

  it("simulated handover renders the block with the reason; skip renders a discreet line", async () => {
    turn.mockResolvedValueOnce(ok({ tipo: "handover_simulado", texto: undefined, motivo: "pidió humano" }));
    turn.mockResolvedValueOnce(ok({ tipo: "skip", texto: undefined }));
    render(<Harness />);
    await enviar("quiero hablar con alguien");
    await waitFor(() => expect(screen.getAllByTestId("luz-prueba-msg")).toHaveLength(2));
    expect(screen.getAllByTestId("luz-prueba-msg")[1].textContent).toBe("[handover simulado — pidió humano]");
    await enviar("ok");
    await waitFor(() => expect(screen.getAllByTestId("luz-prueba-msg")).toHaveLength(4));
    expect(screen.getAllByTestId("luz-prueba-msg")[3].textContent).toBe(T.skip);
    // neither handover nor skip go back as history
    expect(turn.mock.calls[1][0].historico).toEqual([{ role: "user", content: "quiero hablar con alguien" }]);
  });

  it("429 shows the daily cap with the limit and gives the text back to the box", async () => {
    turn.mockRejectedValue(new LuzPruebaError("TETO_DIARIO", 429, 60));
    render(<Harness />);
    await enviar("hola");
    const n = await screen.findByTestId("luz-prueba-notice");
    expect(n.textContent).toBe(T.cap.replace("{{limite}}", "60"));
    expect(screen.queryAllByTestId("luz-prueba-msg")).toHaveLength(0);
    expect(screen.getByTestId("luz-prueba-input")).toHaveValue("hola");
  });

  it("502 shows 'Luz unavailable'", async () => {
    turn.mockRejectedValue(new LuzPruebaError("TRIAGE_INDISPONIVEL", 502));
    render(<Harness />);
    await enviar("hola");
    expect((await screen.findByTestId("luz-prueba-notice")).textContent).toBe(T.unavailable);
  });

  it("pt-BR: header and cap come in Portuguese", async () => {
    await i18n.changeLanguage("pt-BR");
    turn.mockRejectedValue(new LuzPruebaError("TETO_DIARIO", 429, 60));
    render(<Harness />);
    expect(screen.getByTestId("luz-prueba-header").textContent).toBe(ptBR.admin.luzPrueba.headerGeneric);
    await enviar("oi");
    expect((await screen.findByTestId("luz-prueba-notice")).textContent).toBe(
      ptBR.admin.luzPrueba.cap.replace("{{limite}}", "60"),
    );
  });

  it("'Reiniciar conversa' clears the list and draws a NEW sessao; the next turn has empty history", async () => {
    turn.mockResolvedValue(ok());
    render(<Harness />);
    await enviar("a");
    await waitFor(() => expect(screen.getAllByTestId("luz-prueba-msg")).toHaveLength(2));
    await enviar("b");
    await waitFor(() => expect(screen.getAllByTestId("luz-prueba-msg")).toHaveLength(4));
    const sessaoAntes = turn.mock.calls[1][0].sessao;
    expect(turn.mock.calls[0][0].sessao).toBe(sessaoAntes);
    fireEvent.click(screen.getByTestId("luz-prueba-reset"));
    expect(screen.queryAllByTestId("luz-prueba-msg")).toHaveLength(0);
    expect(screen.getByTestId("luz-prueba-header").textContent).toBe(T.headerGeneric);
    await enviar("c");
    await waitFor(() => expect(turn).toHaveBeenCalledTimes(3));
    const c = turn.mock.calls[2][0];
    expect(c.historico).toEqual([]);
    expect(c.sessao).not.toBe(sessaoAntes);
  });
});

describe("Gating of the 'Luz (prueba)' tab in the widget (RF-1)", () => {
  const ag = (slug: string, name: string): Assistant => ({
    slug, name, role: "MANAGER", area: "Operaciones", available: true, last_at: null, unread_count: 0,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    void i18n.changeLanguage("es");
    assistants.messages.mockResolvedValue({ conversation_id: null, messages: [] });
    assistants.markRead.mockResolvedValue(undefined);
  });
  afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: "idle" }));

  it("WITHOUT the cell: no tab in the DOM and no request to /luz-prueba (2 assistants, picker open)", async () => {
    setCells(["assistant_maria:chat"]);
    assistants.list.mockResolvedValue([ag("maria", "Maria"), ag("lucero", "Lucero")]);
    render(<AssistantsWidget />);
    fireEvent.click(await screen.findByTestId("assistants-fab"));
    fireEvent.click(await screen.findByTestId("assistants-picker"));
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.queryByTestId("assistants-tab-luz-prueba")).toBeNull();
    expect(screen.queryByTestId("luz-prueba-header")).toBeNull();
    expect(turn).not.toHaveBeenCalled();
  });

  it("WITHOUT the cell and with an empty reach: not even the button", async () => {
    setCells([]);
    assistants.list.mockResolvedValue([]);
    render(<AssistantsWidget />);
    await waitFor(() => expect(assistants.list).toHaveBeenCalled());
    expect(screen.queryByTestId("assistants-fab")).toBeNull();
  });

  it("WITH the cell: the tab is in the list and opens the prueba view (header + composer); Maria keeps working", async () => {
    setCells(["luz_prueba:chat"]);
    assistants.list.mockResolvedValue([ag("maria", "Maria")]);
    render(<AssistantsWidget />);
    fireEvent.click(await screen.findByTestId("assistants-fab"));
    fireEvent.click(await screen.findByTestId("assistants-picker"));
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("assistants-tab-luz-prueba"));
    const panel = screen.getByTestId("assistants-panel");
    expect(within(panel).getByTestId("luz-prueba-header")).toBeTruthy();
    expect(screen.queryByTestId("assistants-composer")).toBeNull();
    fireEvent.click(screen.getByTestId("assistants-picker"));
    fireEvent.click(screen.getByTestId("assistants-tab-maria"));
    expect(screen.getByTestId("assistants-composer")).toBeTruthy();
    expect(screen.queryByTestId("luz-prueba-header")).toBeNull();
  });

  it("WITH the cell and an EMPTY reach: the button exists and the panel opens straight on the prueba view", async () => {
    setCells(["luz_prueba:chat"]);
    assistants.list.mockResolvedValue([]);
    render(<AssistantsWidget />);
    fireEvent.click(await screen.findByTestId("assistants-fab"));
    expect(await screen.findByTestId("luz-prueba-header")).toBeTruthy();
    expect(screen.queryByTestId("assistants-picker")).toBeNull();
  });
});
