/**
 * AssistentesWidget — spec 080, T041. Serviço mockado por módulo (sem backend). i18n real (es).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AdminAssistentesApiService } from "@infrastructure/http/AdminAssistentesApiService";
import { AssistenteErro, type Assistente } from "@domain/entities/Assistente";
import i18n from "i18next";
import es from "@infrastructure/i18n/locales/es.json";
import { AssistentesWidget } from "../AssistentesWidget";

i18n.addResourceBundle("es", "translation", es, true, true);
void i18n.changeLanguage("es");

vi.mock("@infrastructure/http/AdminAssistentesApiService", () => ({
  AdminAssistentesApiService: {
    listar: vi.fn(),
    mensagens: vi.fn(),
    enviar: vi.fn(),
  },
}));

const svc = vi.mocked(AdminAssistentesApiService);

const ag = (slug: string, nome: string, disponivel = true): Assistente => ({
  slug,
  nome,
  papel: "x",
  area: "Operaciones",
  disponivel,
  nao_lidas: 0,
});
const MARIA = ag("maria", "Maria");
const QUATRO = [
  MARIA,
  ag("lucero", "Lucero", false),
  ag("candela", "Candela", false),
  ag("luz", "Luz"),
];

const resposta = (texto: string) => ({
  conversa_id: "c1",
  mensagem: {
    id: "m-resp",
    autor: "agente" as const,
    texto,
    ferramentas: [],
    validador: null,
    criado_em: "2026-10-30T10:00:00Z",
  },
  turno: { tokens_in: 1, tokens_out: 1, custo_usd: 0 },
});

async function abrir() {
  fireEvent.click(await screen.findByTestId("assistentes-fab"));
  return screen.getByTestId("assistentes-painel");
}

describe("AssistentesWidget (spec 080, T041)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    svc.mensagens.mockResolvedValue({ conversa_id: null, mensagens: [] });
  });

  it("sem agentes: não renderiza nada (nem o botão)", async () => {
    svc.listar.mockResolvedValue([]);
    const { container } = render(<AssistentesWidget />);
    await waitFor(() => expect(svc.listar).toHaveBeenCalled());
    expect(screen.queryByTestId("assistentes-fab")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("listar falha: também não renderiza nada", async () => {
    svc.listar.mockRejectedValue(new Error("x"));
    const { container } = render(<AssistentesWidget />);
    await waitFor(() => expect(svc.listar).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("1 agente: abre direto, sem seletor nem abas", async () => {
    svc.listar.mockResolvedValue([MARIA]);
    render(<AssistentesWidget />);
    await abrir();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByTestId("assistentes-seletor")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("assistentes-aba-maria"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Maria")).toBeInTheDocument();
  });

  it('>= 2 agentes: combobox com os N agentes, indisponíveis marcados "en breve"', async () => {
    svc.listar.mockResolvedValue(QUATRO);
    render(<AssistentesWidget />);
    await abrir();
    fireEvent.click(screen.getByTestId("assistentes-seletor"));
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(screen.getAllByText(/en breve/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("assistentes-aba-luz")).toBeInTheDocument();
  });

  it("aba lembrada: grava em localStorage e reabre na última", async () => {
    svc.listar.mockResolvedValue(QUATRO);
    const { unmount } = render(<AssistentesWidget />);
    await abrir();
    fireEvent.click(screen.getByTestId("assistentes-aba-luz"));
    expect(window.localStorage.getItem("assistentes.aba")).toBe("luz");
    unmount();
    render(<AssistentesWidget />);
    await abrir();
    expect(screen.getByTestId("assistentes-aba-luz")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await waitFor(() => expect(svc.mensagens).toHaveBeenLastCalledWith("luz"));
  });

  it('envio otimista: mostra a pessoa e "escribiendo…", depois a resposta', async () => {
    svc.listar.mockResolvedValue([MARIA]);
    let resolver!: (v: ReturnType<typeof resposta>) => void;
    svc.enviar.mockReturnValue(new Promise((r) => (resolver = r)));
    render(<AssistentesWidget />);
    await abrir();
    fireEvent.change(screen.getByTestId("assistentes-composer"), {
      target: { value: "hola" },
    });
    fireEvent.click(screen.getByTestId("assistentes-enviar"));
    expect(await screen.findByText("hola")).toBeInTheDocument();
    expect(screen.getByTestId("assistentes-escribiendo")).toHaveTextContent(
      "escribiendo…",
    );
    expect(svc.enviar).toHaveBeenCalledWith("maria", "hola");
    resolver(resposta("buen día"));
    expect(
      await screen.findByTestId("assistentes-msg-m-resp"),
    ).toHaveTextContent("buen día");
    expect(
      screen.queryByTestId("assistentes-escribiendo"),
    ).not.toBeInTheDocument();
  });

  it("Enter envia; Shift+Enter não envia", async () => {
    svc.listar.mockResolvedValue([MARIA]);
    svc.enviar.mockResolvedValue(resposta("ok"));
    render(<AssistentesWidget />);
    await abrir();
    const c = screen.getByTestId("assistentes-composer");
    fireEvent.change(c, { target: { value: "a" } });
    fireEvent.keyDown(c, { key: "Enter", shiftKey: true });
    expect(svc.enviar).not.toHaveBeenCalled();
    fireEvent.keyDown(c, { key: "Enter" });
    await waitFor(() => expect(svc.enviar).toHaveBeenCalledTimes(1));
  });

  it("429: mostra o aviso do teto com o nome do agente", async () => {
    svc.listar.mockResolvedValue([MARIA]);
    svc.enviar.mockRejectedValue(new AssistenteErro("TETO_PESSOA_DIA", 429));
    render(<AssistentesWidget />);
    await abrir();
    fireEvent.change(screen.getByTestId("assistentes-composer"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByTestId("assistentes-enviar"));
    expect(await screen.findByTestId("assistentes-aviso")).toHaveTextContent(
      "Llegaste al límite de hoy con Maria. Mañana podés seguir.",
    );
  });

  it('403: mostra "sinAcceso"', async () => {
    svc.listar.mockResolvedValue([MARIA]);
    svc.enviar.mockRejectedValue(new AssistenteErro("SEM_CELULA", 403));
    render(<AssistentesWidget />);
    await abrir();
    fireEvent.change(screen.getByTestId("assistentes-composer"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByTestId("assistentes-enviar"));
    expect(await screen.findByTestId("assistentes-aviso")).toHaveTextContent(
      "No puedo ver eso con tu acceso.",
    );
  });

  it('502: mostra "erroModelo"', async () => {
    svc.listar.mockResolvedValue([MARIA]);
    svc.enviar.mockRejectedValue(new AssistenteErro("ERRO_MODELO", 502));
    render(<AssistentesWidget />);
    await abrir();
    fireEvent.change(screen.getByTestId("assistentes-composer"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByTestId("assistentes-enviar"));
    expect(await screen.findByTestId("assistentes-aviso")).toHaveTextContent(
      "No pude responder ahora",
    );
  });

  it("agente indisponível: composer e enviar desabilitados, não envia", async () => {
    svc.listar.mockResolvedValue([ag("lucero", "Lucero", false)]);
    render(<AssistentesWidget />);
    await abrir();
    expect(screen.getByTestId("assistentes-composer")).toBeDisabled();
    expect(screen.getByTestId("assistentes-enviar")).toBeDisabled();
    fireEvent.click(screen.getByTestId("assistentes-enviar"));
    expect(svc.enviar).not.toHaveBeenCalled();
  });

  it('foco no composer ao abrir; Esc e "cerrar" fecham', async () => {
    svc.listar.mockResolvedValue([MARIA]);
    render(<AssistentesWidget />);
    await abrir();
    expect(screen.getByTestId("assistentes-composer")).toHaveFocus();
    fireEvent.keyDown(screen.getByTestId("assistentes-painel"), {
      key: "Escape",
    });
    expect(screen.queryByTestId("assistentes-painel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("assistentes-fab"));
    fireEvent.click(screen.getByLabelText("Cerrar"));
    expect(screen.queryByTestId("assistentes-painel")).not.toBeInTheDocument();
  });
});
