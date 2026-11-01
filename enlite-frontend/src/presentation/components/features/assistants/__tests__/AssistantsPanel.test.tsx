/**
 * AssistantsPanel — spec 080 (T162). Service mocked by module. Real i18n (es + pt-BR).
 */
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AdminAssistantsApiService } from "@infrastructure/http/AdminAssistantsApiService";
import { AssistantError, type Assistant } from "@domain/entities/Assistant";
import i18n from "i18next";
import es from "@infrastructure/i18n/locales/es.json";
import ptBR from "@infrastructure/i18n/locales/pt-BR.json";
import { AssistantsWidget } from "../AssistantsWidget";

i18n.addResourceBundle("es", "translation", es, true, true);
i18n.addResourceBundle("pt-BR", "translation", ptBR, true, true);
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

const reply = {
  conversation_id: "c1",
  message: {
    id: "m-resp",
    author: "ASSISTANT" as const,
    text: "respuesta",
    tools: [],
    validator: null,
    created_at: "2026-10-30T10:00:00Z",
  },
  turn: { tokens_in: 1, tokens_out: 1, cost_usd: 0 },
};

async function abrir() {
  fireEvent.click(await screen.findByTestId("assistants-fab"));
  return screen.findByTestId("assistants-panel");
}

const tabs = () => screen.getAllByRole("tab");

describe("AssistantsPanel (spec 080, T162)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    void i18n.changeLanguage("es");
    svc.messages.mockResolvedValue({ conversation_id: null, messages: [] });
    svc.markRead.mockResolvedValue(undefined);
  });

  it("0 assistants: no panel (not even the button)", async () => {
    svc.list.mockResolvedValue([]);
    render(<AssistantsWidget />);
    await waitFor(() => expect(svc.list).toHaveBeenCalled());
    expect(screen.queryByTestId("assistants-fab")).toBeNull();
    expect(screen.queryByTestId("assistants-panel")).toBeNull();
  });

  it("1 assistant: a single conversation (no tab strip, no picker), named in the header", async () => {
    svc.list.mockResolvedValue([ag("maria", "Maria")]);
    render(<AssistantsWidget />);
    const panel = await abrir();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByTestId("assistants-picker")).toBeNull();
    expect(panel.textContent).toContain("Maria");
    expect(screen.getAllByTestId("assistants-composer")).toHaveLength(1);
  });

  it("3 assistants, one available:false: 3 tabs, the unavailable one marked 'en breve'", async () => {
    svc.list.mockResolvedValue([
      ag("maria", "Maria"),
      ag("lucero", "Lucero", false),
      ag("teresa", "Teresa"),
    ]);
    render(<AssistantsWidget />);
    await abrir();
    expect(tabs()).toHaveLength(3);
    expect(screen.getByTestId("assistants-tab-soon-lucero").textContent).toBe(
      "en breve",
    );
    expect(screen.queryByTestId("assistants-tab-soon-maria")).toBeNull();
    expect(screen.queryByTestId("assistants-tab-soon-teresa")).toBeNull();
  });

  it("the 'en breve' label comes from i18n (pt-BR too)", async () => {
    await i18n.changeLanguage("pt-BR");
    svc.list.mockResolvedValue([
      ag("maria", "Maria"),
      ag("lucero", "Lucero", false),
    ]);
    render(<AssistantsWidget />);
    await abrir();
    expect(screen.getByTestId("assistants-tab-soon-lucero").textContent).toBe(
      "em breve",
    );
  });

  it("an unavailable tab has no working composer (disabled, no send)", async () => {
    svc.list.mockResolvedValue([
      ag("maria", "Maria"),
      ag("lucero", "Lucero", false),
    ]);
    render(<AssistantsWidget />);
    await abrir();
    fireEvent.click(screen.getByTestId("assistants-tab-lucero"));
    const composer = screen.getByTestId(
      "assistants-composer",
    ) as HTMLTextAreaElement;
    expect(composer.disabled).toBe(true);
    expect(
      (screen.getByTestId("assistants-send") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(svc.sendMessage).not.toHaveBeenCalled();
  });

  it("tabs are exactly the reach's assistants (no extra tab is added)", async () => {
    svc.list.mockResolvedValue([ag("maria", "Maria"), ag("teresa", "Teresa")]);
    render(<AssistantsWidget />);
    await abrir();
    expect(tabs().map((t) => t.textContent)).toEqual(["Maria", "Teresa"]);
  });

  it("tab order = the order of the reach (not sorted by name)", async () => {
    svc.list.mockResolvedValue([
      ag("teresa", "Teresa"),
      ag("candela", "Candela"),
      ag("maria", "Maria"),
    ]);
    render(<AssistantsWidget />);
    await abrir();
    expect(tabs().map((t) => t.textContent)).toEqual([
      "Teresa",
      "Candela",
      "Maria",
    ]);
  });

  it("badge per tab with unread_count > 0 (and none without)", async () => {
    svc.list.mockResolvedValue([
      ag("maria", "Maria"),
      ag("teresa", "Teresa", true, 4),
      ag("candela", "Candela", true, 0),
    ]);
    render(<AssistantsWidget />);
    await abrir();
    expect(screen.getByTestId("assistants-tab-badge-teresa").textContent).toBe(
      "4",
    );
    expect(screen.queryByTestId("assistants-tab-badge-candela")).toBeNull();
    expect(screen.queryByTestId("assistants-tab-badge-maria")).toBeNull();
  });

  it("opening a tab with unread > 0 marks read ONCE and on 204 zeroes only that badge", async () => {
    svc.list.mockResolvedValue([
      ag("maria", "Maria"),
      ag("teresa", "Teresa", true, 4),
      ag("candela", "Candela", true, 2),
    ]);
    render(<AssistantsWidget />);
    await abrir();
    expect(svc.markRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("assistants-tab-teresa"));
    await waitFor(() =>
      expect(screen.queryByTestId("assistants-tab-badge-teresa")).toBeNull(),
    );
    expect(svc.markRead).toHaveBeenCalledTimes(1);
    expect(svc.markRead).toHaveBeenCalledWith("teresa");
    expect(screen.getByTestId("assistants-tab-badge-candela").textContent).toBe(
      "2",
    );
  });

  it("the panel opening on an already-active tab marks only THAT tab (not all on mount)", async () => {
    window.localStorage.setItem("assistants.tab", "teresa");
    svc.list.mockResolvedValue([
      ag("maria", "Maria", true, 1),
      ag("teresa", "Teresa", true, 4),
      ag("candela", "Candela", true, 2),
    ]);
    render(<AssistantsWidget />);
    await abrir();
    await waitFor(() => expect(svc.markRead).toHaveBeenCalledTimes(1));
    expect(svc.markRead).toHaveBeenCalledWith("teresa");
    expect(screen.getByTestId("assistants-tab-badge-maria").textContent).toBe(
      "1",
    );
  });

  it("a reply arriving with the tab open marks read again", async () => {
    svc.list.mockResolvedValue([ag("maria", "Maria", true, 3)]);
    svc.sendMessage.mockResolvedValue(reply);
    render(<AssistantsWidget />);
    await abrir();
    await waitFor(() => expect(svc.markRead).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId("assistants-composer"), {
      target: { value: "hola" },
    });
    fireEvent.click(screen.getByTestId("assistants-send"));
    await screen.findByTestId("assistants-msg-m-resp");
    await waitFor(() => expect(svc.markRead).toHaveBeenCalledTimes(2));
    expect(svc.markRead).toHaveBeenLastCalledWith("maria");
  });

  it("under React.StrictMode (dev server) opening with unread marks read EXACTLY once", async () => {
    svc.list.mockResolvedValue([ag("maria", "Maria", true, 2)]);
    render(
      <StrictMode>
        <AssistantsWidget />
      </StrictMode>,
    );
    await abrir();
    await waitFor(() => expect(svc.markRead).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 200));
    expect(svc.markRead).toHaveBeenCalledTimes(1);
    expect(svc.markRead).toHaveBeenCalledWith("maria");
  });

  it("an 'en breve' tab never calls markRead, even with unread_count > 0", async () => {
    svc.list.mockResolvedValue([
      ag("maria", "Maria"),
      ag("lucero", "Lucero", false, 5),
    ]);
    render(<AssistantsWidget />);
    await abrir();
    fireEvent.click(screen.getByTestId("assistants-tab-lucero"));
    await screen.findByTestId("assistants-tab-soon-lucero");
    expect(svc.markRead).not.toHaveBeenCalled();
  });

  it.each([403, 500])(
    "markRead failing (%i) does not break the screen and the badge stays",
    async (status) => {
      svc.list.mockResolvedValue([
        ag("maria", "Maria"),
        ag("teresa", "Teresa", true, 4),
      ]);
      svc.markRead.mockRejectedValue(
        new AssistantError(
          status === 403 ? "NO_REACH" : "INTERNAL_ERROR",
          status,
        ),
      );
      render(<AssistantsWidget />);
      await abrir();
      fireEvent.click(screen.getByTestId("assistants-tab-teresa"));
      await waitFor(() => expect(svc.markRead).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("assistants-panel")).toBeTruthy();
      expect(
        screen.getByTestId("assistants-tab-badge-teresa").textContent,
      ).toBe("4");
    },
  );

  it("history fails to load: a visible alert (es), not an empty conversation; pt-BR too", async () => {
    svc.list.mockResolvedValue([ag("maria", "Maria")]);
    svc.messages.mockRejectedValue(new Error("boom"));
    render(<AssistantsWidget />);
    await abrir();
    const alert = await screen.findByTestId("assistants-history-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe(es.admin.assistants.historyError);
    expect(screen.queryByTestId("assistants-msg-m1")).toBeNull();
    expect(ptBR.admin.assistants.historyError).toBeTruthy();
  });

  it("history loads fine: no history alert", async () => {
    svc.list.mockResolvedValue([ag("maria", "Maria")]);
    render(<AssistantsWidget />);
    await abrir();
    await waitFor(() => expect(svc.messages).toHaveBeenCalled());
    expect(screen.queryByTestId("assistants-history-error")).toBeNull();
  });
});
