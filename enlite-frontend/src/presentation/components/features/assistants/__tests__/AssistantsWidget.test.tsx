/**
 * AssistantsWidget — spec 080 (T158 copy, T160 adjustments). Service mocked by module (no backend). Real i18n (es).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AdminAssistantsApiService } from "@infrastructure/http/AdminAssistantsApiService";
import { AssistantError, type Assistant } from "@domain/entities/Assistant";
import i18n from "i18next";
import es from "@infrastructure/i18n/locales/es.json";
import { AssistantsWidget } from "../AssistantsWidget";

// jsdom's PointerEvent may drop clientX/clientY; a MouseEvent subclass keeps them (same trick as useDraggableFab.test).
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}
vi.stubGlobal("PointerEvent", TestPointerEvent);

i18n.addResourceBundle("es", "translation", es, true, true);
void i18n.changeLanguage("es");

vi.mock("@infrastructure/http/AdminAssistantsApiService", () => ({
  AdminAssistantsApiService: {
    list: vi.fn(),
    messages: vi.fn(),
    sendMessage: vi.fn(),
    markRead: vi.fn(),
  },
}));

const svc = vi.mocked(AdminAssistantsApiService);

const ag = (
  slug: string,
  name: string,
  available = true,
  unread_count = 0,
): Assistant => ({
  slug,
  name,
  role: "MANAGER",
  area: "Operaciones",
  available,
  last_at: null,
  unread_count,
});
const MARIA = ag("maria", "Maria");
const FOUR = [
  MARIA,
  ag("lucero", "Lucero", false),
  ag("candela", "Candela", false),
  ag("teresa", "Teresa"),
];

const reply = (text: string) => ({
  conversation_id: "c1",
  message: {
    id: "m-resp",
    author: "ASSISTANT" as const,
    text,
    tools: [],
    validator: null,
    created_at: "2026-10-30T10:00:00Z",
  },
  turn: { tokens_in: 1, tokens_out: 1, cost_usd: 0 },
});

async function abrir() {
  fireEvent.click(await screen.findByTestId("assistants-fab"));
  return screen.getByTestId("assistants-panel");
}

describe("AssistantsWidget (spec 080, T158/T160)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    svc.messages.mockResolvedValue({ conversation_id: null, messages: [] });
  });

  it("empty reach: renders nothing (not even the button)", async () => {
    svc.list.mockResolvedValue([]);
    const { container } = render(<AssistantsWidget />);
    await waitFor(() => expect(svc.list).toHaveBeenCalled());
    expect(screen.queryByTestId("assistants-fab")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("list fails: also renders nothing", async () => {
    svc.list.mockRejectedValue(new Error("x"));
    const { container } = render(<AssistantsWidget />);
    await waitFor(() => expect(svc.list).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("1 assistant: opens straight, no picker, no list, only close", async () => {
    svc.list.mockResolvedValue([MARIA]);
    render(<AssistantsWidget />);
    await abrir();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByTestId("assistants-picker")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("assistants-tab-maria"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Maria")).toBeInTheDocument();
  });

  it('>= 2 assistants: list with the N assistants, unavailable ones marked "en breve"', async () => {
    svc.list.mockResolvedValue(FOUR);
    render(<AssistantsWidget />);
    await abrir();
    fireEvent.click(screen.getByTestId("assistants-picker"));
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(screen.getAllByText(/en breve/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("assistants-tab-teresa")).toBeInTheDocument();
  });

  it("remembered tab: saves to localStorage and reopens on the last one", async () => {
    svc.list.mockResolvedValue(FOUR);
    const { unmount } = render(<AssistantsWidget />);
    await abrir();
    fireEvent.click(screen.getByTestId("assistants-picker"));
    fireEvent.click(screen.getByTestId("assistants-tab-teresa"));
    expect(window.localStorage.getItem("assistants.tab")).toBe("teresa");
    unmount();
    render(<AssistantsWidget />);
    await abrir();
    fireEvent.click(screen.getByTestId("assistants-picker"));
    expect(screen.getByTestId("assistants-tab-teresa")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await waitFor(() => expect(svc.messages).toHaveBeenLastCalledWith("teresa"));
  });

  it('optimistic send: shows the person and "escribiendo…", then the reply', async () => {
    svc.list.mockResolvedValue([MARIA]);
    let resolver!: (v: ReturnType<typeof reply>) => void;
    svc.sendMessage.mockReturnValue(new Promise((r) => (resolver = r)));
    render(<AssistantsWidget />);
    await abrir();
    fireEvent.change(screen.getByTestId("assistants-composer"), {
      target: { value: "hola" },
    });
    fireEvent.click(screen.getByTestId("assistants-send"));
    expect(await screen.findByText("hola")).toBeInTheDocument();
    expect(screen.getByTestId("assistants-typing")).toHaveAttribute(
      "aria-label",
      "escribiendo…",
    );
    expect(svc.sendMessage).toHaveBeenCalledWith("maria", "hola");
    resolver(reply("buen día"));
    expect(
      await screen.findByTestId("assistants-msg-m-resp"),
    ).toHaveTextContent("buen día");
    expect(
      screen.queryByTestId("assistants-typing"),
    ).not.toBeInTheDocument();
  });

  it("Enter sends; Shift+Enter does not", async () => {
    svc.list.mockResolvedValue([MARIA]);
    svc.sendMessage.mockResolvedValue(reply("ok"));
    render(<AssistantsWidget />);
    await abrir();
    const c = screen.getByTestId("assistants-composer");
    fireEvent.change(c, { target: { value: "a" } });
    fireEvent.keyDown(c, { key: "Enter", shiftKey: true });
    expect(svc.sendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(c, { key: "Enter" });
    await waitFor(() => expect(svc.sendMessage).toHaveBeenCalledTimes(1));
  });

  it("429: shows the cap notice with the assistant name", async () => {
    svc.list.mockResolvedValue([MARIA]);
    svc.sendMessage.mockRejectedValue(new AssistantError("PERSON_DAILY_CAP", 429));
    render(<AssistantsWidget />);
    await abrir();
    fireEvent.change(screen.getByTestId("assistants-composer"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByTestId("assistants-send"));
    expect(await screen.findByTestId("assistants-notice")).toHaveTextContent(
      "Llegaste al límite de hoy con Maria. Mañana podés seguir.",
    );
  });

  it('403: shows "noAccess"', async () => {
    svc.list.mockResolvedValue([MARIA]);
    svc.sendMessage.mockRejectedValue(new AssistantError("NO_REACH", 403));
    render(<AssistantsWidget />);
    await abrir();
    fireEvent.change(screen.getByTestId("assistants-composer"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByTestId("assistants-send"));
    expect(await screen.findByTestId("assistants-notice")).toHaveTextContent(
      "No puedo ver eso con tu acceso.",
    );
  });

  it('502: shows "modelError"', async () => {
    svc.list.mockResolvedValue([MARIA]);
    svc.sendMessage.mockRejectedValue(new AssistantError("MODEL_ERROR", 502));
    render(<AssistantsWidget />);
    await abrir();
    fireEvent.change(screen.getByTestId("assistants-composer"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByTestId("assistants-send"));
    expect(await screen.findByTestId("assistants-notice")).toHaveTextContent(
      "No pude responder ahora",
    );
  });

  it("unavailable assistant: composer and send disabled, never sends", async () => {
    svc.list.mockResolvedValue([ag("lucero", "Lucero", false)]);
    render(<AssistantsWidget />);
    await abrir();
    expect(screen.getByTestId("assistants-composer")).toBeDisabled();
    expect(screen.getByTestId("assistants-send")).toBeDisabled();
    fireEvent.click(screen.getByTestId("assistants-send"));
    expect(svc.sendMessage).not.toHaveBeenCalled();
  });

  it('focus on the composer on open; Esc and "cerrar" close', async () => {
    svc.list.mockResolvedValue([MARIA]);
    render(<AssistantsWidget />);
    await abrir();
    expect(screen.getByTestId("assistants-composer")).toHaveFocus();
    fireEvent.keyDown(screen.getByTestId("assistants-panel"), {
      key: "Escape",
    });
    expect(screen.queryByTestId("assistants-panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("assistants-fab"));
    fireEvent.click(screen.getByLabelText("Cerrar"));
    expect(screen.queryByTestId("assistants-panel")).not.toBeInTheDocument();
  });

  it("PLATFORM_UNAVAILABLE on list: no button (fail-closed, never 'when in doubt show')", async () => {
    svc.list.mockRejectedValue(new AssistantError("PLATFORM_UNAVAILABLE", 503));
    const { container } = render(<AssistantsWidget />);
    await waitFor(() => expect(svc.list).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it("NO_REACH on list: no button", async () => {
    svc.list.mockRejectedValue(new AssistantError("NO_REACH", 403));
    render(<AssistantsWidget />);
    await waitFor(() => expect(svc.list).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("1 assistant in reach: the button is present", async () => {
    svc.list.mockResolvedValue([MARIA]);
    render(<AssistantsWidget />);
    expect(
      await screen.findByRole("button", { name: "Asistentes" }),
    ).toBeInTheDocument();
  });

  it("unread sum 0: no badge", async () => {
    svc.list.mockResolvedValue([ag("maria", "Maria", true, 0)]);
    render(<AssistantsWidget />);
    await screen.findByTestId("assistants-fab");
    expect(screen.queryByTestId("assistants-badge")).toBeNull();
  });

  it("unread sum 3 (1 + 2 across assistants): a red dot (no number) with the total in its aria-label", async () => {
    svc.list.mockResolvedValue([
      ag("maria", "Maria", true, 1),
      ag("teresa", "Teresa", true, 2),
    ]);
    render(<AssistantsWidget />);
    await screen.findByTestId("assistants-fab");
    const dot = screen.getByTestId("assistants-badge");
    expect(dot).toHaveTextContent("");
    expect(dot).toHaveAttribute("role", "img");
    expect(dot).toHaveAttribute("aria-label", "3 mensajes sin leer");
  });

  it("unread sum above 99: the aria-label carries the real total (no \"99+\" cap)", async () => {
    svc.list.mockResolvedValue([
      ag("maria", "Maria", true, 60),
      ag("teresa", "Teresa", true, 60),
    ]);
    render(<AssistantsWidget />);
    await screen.findByTestId("assistants-fab");
    expect(screen.getByTestId("assistants-badge")).toHaveAttribute(
      "aria-label",
      "120 mensajes sin leer",
    );
  });

  it("badge ignores unread_count of unavailable assistants", async () => {
    svc.list.mockResolvedValue([
      ag("maria", "Maria", true, 2),
      ag("lucero", "Lucero", false, 40),
    ]);
    render(<AssistantsWidget />);
    await screen.findByTestId("assistants-fab");
    expect(screen.getByTestId("assistants-badge")).toHaveAttribute(
      "aria-label",
      "2 mensajes sin leer",
    );
  });

  it("badge accessible label comes from i18n with the count", async () => {
    svc.list.mockResolvedValue([ag("maria", "Maria", true, 3)]);
    render(<AssistantsWidget />);
    await screen.findByTestId("assistants-fab");
    expect(screen.getByTestId("assistants-badge")).toHaveAttribute(
      "aria-label",
      "3 mensajes sin leer",
    );
  });

  it("minimize keeps the draft for the next opening; close discards it", async () => {
    svc.list.mockResolvedValue([MARIA, ag("teresa", "Teresa")]);
    render(<AssistantsWidget />);
    await abrir();
    fireEvent.change(screen.getByTestId("assistants-composer"), {
      target: { value: "borrador" },
    });
    fireEvent.click(screen.getByTestId("assistants-minimize"));
    expect(screen.queryByTestId("assistants-panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("assistants-fab"));
    expect(screen.getByTestId("assistants-composer")).toHaveValue("borrador");
    fireEvent.click(screen.getByTestId("assistants-close"));
    expect(screen.queryByTestId("assistants-panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("assistants-fab"));
    expect(screen.getByTestId("assistants-composer")).toHaveValue("");
  });

  it("the unread dot sits on the button (small, no text) and the button is 48px high via h-12", async () => {
    svc.list.mockResolvedValue([ag("maria", "Maria", true, 1)]);
    render(<AssistantsWidget />);
    const fab = await screen.findByTestId("assistants-fab");
    expect(fab.className).toContain("h-12");
    expect(fab.className).toContain("bottom-4");
    expect(screen.getByTestId("assistants-badge").className).toContain("h-3 w-3");
  });

  it("drag (pointerdown, 50px move, pointerup, click) does not open the panel; a plain click does", async () => {
    svc.list.mockResolvedValue([MARIA]);
    render(<AssistantsWidget />);
    const fab = await screen.findByTestId("assistants-fab");
    const pt = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1 });
    fireEvent.pointerDown(fab, pt(500, 500));
    fireEvent.pointerMove(fab, pt(450, 500));
    fireEvent.pointerUp(fab, pt(450, 500));
    fireEvent.click(fab);
    expect(screen.queryByTestId("assistants-panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("assistants-fab"));
    expect(screen.getByTestId("assistants-panel")).toBeInTheDocument();
  });
});
