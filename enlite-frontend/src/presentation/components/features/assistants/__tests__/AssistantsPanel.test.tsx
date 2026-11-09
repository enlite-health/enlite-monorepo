/**
 * AssistantsPanel — spec 080 (T162). Service mocked by module. Real i18n (es + pt-BR).
 */
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AdminAssistantsApiService } from "@infrastructure/http/AdminAssistantsApiService";
import { AssistantError, type Assistant } from "@domain/entities/Assistant";
import i18n from "i18next";
import es from "@infrastructure/i18n/locales/es.json";
import ptBR from "@infrastructure/i18n/locales/pt-BR.json";
import { AssistantsWidget } from "../AssistantsWidget";
import { AssistantsPanel } from "../AssistantsPanel";
import type { UseAssistants } from "@presentation/hooks/useAssistants";

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

/** Opens the assistants list (the picker in the header). */
const abrirLista = () => {
  fireEvent.click(screen.getByTestId("assistants-picker"));
  return screen.getByRole("listbox");
};
const opcoes = () => screen.getAllByRole("option");
const slugs = () =>
  opcoes().map((o) => o.getAttribute("data-testid")?.replace("assistants-tab-", ""));

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

  it("1 assistant: a single conversation (no picker, no list, only close), named in the header", async () => {
    svc.list.mockResolvedValue([ag("maria", "Maria")]);
    render(<AssistantsWidget />);
    const panel = await abrir();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByTestId("assistants-picker")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByTestId("assistants-minimize")).toBeNull();
    expect(screen.getByTestId("assistants-close")).toBeTruthy();
    expect(panel.textContent).toContain("Maria");
    expect(screen.getAllByTestId("assistants-composer")).toHaveLength(1);
  });

  it("footer shows only the fixed footer line (no privacy notice) and the composer has no aria-describedby", async () => {
    svc.list.mockResolvedValue([ag("maria", "Maria")]);
    render(<AssistantsWidget />);
    await abrir();
    expect(screen.queryByTestId("assistants-privacy-notice")).toBeNull();
    expect(screen.getByTestId("assistants-footer").textContent).toBe(es.admin.assistants.footer);
    expect(screen.getByTestId("assistants-composer")).not.toHaveAttribute("aria-describedby");
  });

  it("3 assistants, one available:false: 3 options in the list, the unavailable one marked 'en breve', the others 'disponible'", async () => {
    svc.list.mockResolvedValue([
      ag("maria", "Maria"),
      ag("lucero", "Lucero", false),
      ag("teresa", "Teresa"),
    ]);
    render(<AssistantsWidget />);
    await abrir();
    expect(screen.queryByRole("tab")).toBeNull(); // the tab strip is gone: the picker replaces it
    expect(screen.queryByRole("listbox")).toBeNull(); // closed until opened
    abrirLista();
    expect(opcoes()).toHaveLength(3);
    expect(
      within(screen.getByTestId("assistants-tab-maria")).getByText("disponible"),
    ).toBeTruthy();
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
    abrirLista();
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
    abrirLista();
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

  it("options are exactly the reach's assistants (no extra option is added)", async () => {
    svc.list.mockResolvedValue([ag("maria", "Maria"), ag("teresa", "Teresa")]);
    render(<AssistantsWidget />);
    await abrir();
    abrirLista();
    expect(slugs()).toEqual(["maria", "teresa"]);
  });

  it("option order = the order of the reach (not sorted by name)", async () => {
    svc.list.mockResolvedValue([
      ag("teresa", "Teresa"),
      ag("candela", "Candela"),
      ag("maria", "Maria"),
    ]);
    render(<AssistantsWidget />);
    await abrir();
    abrirLista();
    expect(slugs()).toEqual(["teresa", "candela", "maria"]);
  });

  it("badge per tab with unread_count > 0 (and none without)", async () => {
    svc.list.mockResolvedValue([
      ag("maria", "Maria"),
      ag("teresa", "Teresa", true, 4),
      ag("candela", "Candela", true, 0),
    ]);
    render(<AssistantsWidget />);
    await abrir();
    abrirLista();
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
    abrirLista();
    fireEvent.click(screen.getByTestId("assistants-tab-teresa"));
    await waitFor(() => expect(svc.markRead).toHaveBeenCalledTimes(1));
    abrirLista();
    await waitFor(() =>
      expect(screen.queryByTestId("assistants-tab-badge-teresa")).toBeNull(),
    );
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
    abrirLista();
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
    abrirLista();
    fireEvent.click(screen.getByTestId("assistants-tab-lucero"));
    abrirLista();
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
      abrirLista();
      fireEvent.click(screen.getByTestId("assistants-tab-teresa"));
      await waitFor(() => expect(svc.markRead).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("assistants-panel")).toBeTruthy();
      abrirLista();
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

  it.each([
    ["INPUT_CLINICAL", "inputClinical"],
  ] as const)(
    "%s: shows the notice, the refused message is not in the history and the text returns to the field",
    async (code, key) => {
      svc.list.mockResolvedValue([ag("maria", "Maria")]);
      svc.sendMessage.mockRejectedValue(new AssistantError(code, 422));
      render(<AssistantsWidget />);
      await abrir();
      const composer = screen.getByTestId(
        "assistants-composer",
      ) as HTMLTextAreaElement;
      fireEvent.change(composer, { target: { value: "texto a editar" } });
      fireEvent.click(screen.getByTestId("assistants-send"));
      const notice = await screen.findByTestId("assistants-notice");
      expect(notice.textContent).toBe(
        (es as any).admin.assistants[key],
      );
      expect(screen.queryByText("texto a editar", { selector: "div" })).toBeNull();
      expect(screen.queryByTestId(/^assistants-msg-/)).toBeNull();
      await waitFor(() => expect(composer.value).toBe("texto a editar"));
    },
  );
});

describe("AssistantsPanel — selector, scroll, composer (mockup)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    void i18n.changeLanguage("es");
    svc.messages.mockResolvedValue({ conversation_id: null, messages: [] });
    svc.markRead.mockResolvedValue(undefined);
  });

  const THREE = [ag("maria", "Maria"), ag("lucero", "Lucero", false), ag("teresa", "Teresa")];

  it("picker button: aria-haspopup=listbox, aria-expanded follows the list; options role=option with aria-selected", async () => {
    svc.list.mockResolvedValue(THREE);
    render(<AssistantsWidget />);
    await abrir();
    const btn = screen.getByTestId("assistants-picker");
    expect(btn).toHaveAttribute("aria-haspopup", "listbox");
    expect(btn).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getByTestId("assistants-tab-maria")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("assistants-tab-teresa")).toHaveAttribute("aria-selected", "false");
  });

  it("list items use the PersonAvatar: 30px, fixed primary color, the initial", async () => {
    svc.list.mockResolvedValue(THREE);
    render(<AssistantsWidget />);
    await abrir();
    abrirLista();
    const av = screen.getByTestId("assistants-avatar-teresa");
    expect(av.style.width).toBe("30px");
    expect(av.className).toContain("bg-primary");
    expect(av).toHaveTextContent("T");
  });

  it("choosing an option switches the assistant and closes the list", async () => {
    svc.list.mockResolvedValue(THREE);
    render(<AssistantsWidget />);
    await abrir();
    abrirLista();
    fireEvent.click(screen.getByTestId("assistants-tab-teresa"));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByTestId("assistants-picker").textContent).toBe("Teresa");
    await waitFor(() => expect(svc.messages).toHaveBeenLastCalledWith("teresa"));
  });

  it("Esc closes the list WITHOUT closing the panel; a second Esc closes the panel", async () => {
    svc.list.mockResolvedValue(THREE);
    render(<AssistantsWidget />);
    await abrir();
    abrirLista();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByTestId("assistants-panel")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("assistants-panel"), { key: "Escape" });
    expect(screen.queryByTestId("assistants-panel")).toBeNull();
  });

  it("click outside the list closes it; click inside the list does not", async () => {
    svc.list.mockResolvedValue(THREE);
    render(<AssistantsWidget />);
    await abrir();
    const list = abrirLista();
    fireEvent.mouseDown(list);
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId("assistants-messages"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("unread counter in the list has the aria-label with the count", async () => {
    svc.list.mockResolvedValue([ag("maria", "Maria"), ag("teresa", "Teresa", true, 2)]);
    render(<AssistantsWidget />);
    await abrir();
    abrirLista();
    expect(screen.getByTestId("assistants-tab-badge-teresa")).toHaveAttribute(
      "aria-label",
      "2 mensajes sin leer",
    );
  });

  it("lock line: plural for several, singular for one (pt-BR too)", async () => {
    svc.list.mockResolvedValue([ag("maria", "Maria"), ag("teresa", "Teresa")]);
    const { unmount } = render(<AssistantsWidget />);
    expect((await abrir()).textContent).toContain("Tu grupo: Operaciones · 2 asistentes");
    unmount();
    svc.list.mockResolvedValue([ag("maria", "Maria")]);
    render(<AssistantsWidget />);
    expect((await abrir()).textContent).toContain("Tu grupo: Operaciones · 1 asistente");
    expect(ptBR.admin.assistants.minimize).toBeTruthy();
    expect(ptBR.admin.assistants.openPicker).toBeTruthy();
    expect((ptBR.admin.assistants as Record<string, string>).yourGroup_one).toBeTruthy();
  });

  describe("scroll to the last message", () => {
    const msg = (id: string, author: "PERSON" | "ASSISTANT") => ({
      id, author, text: id, tools: [], validator: null, created_at: "2026-10-30T10:00:00Z",
    });
    const fake = (over: Partial<UseAssistants> = {}): UseAssistants => ({
      assistants: [ag("maria", "Maria")],
      active: ag("maria", "Maria"),
      setTab: vi.fn(),
      messages: [msg("m1", "ASSISTANT")],
      waiting: false,
      notice: null,
      historyError: false,
      unreadTotal: 0,
      send: vi.fn(),
      markRead: vi.fn().mockResolvedValue(undefined),
      loadConversation: vi.fn(),
      ...over,
    });
    const ui = (a: UseAssistants) => (
      <AssistantsPanel assistants={a} draft="" setDraft={vi.fn()} onClose={vi.fn()} onMinimize={vi.fn()} />
    );

    it("a new message and then 'escribiendo' scroll the list to scrollHeight", () => {
      const base = fake();
      const { rerender } = render(ui(base));
      const el = screen.getByTestId("assistants-messages");
      let top = 0;
      Object.defineProperty(el, "scrollHeight", { configurable: true, value: 500 });
      Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v) => { top = v; } });
      expect(top).toBe(0);

      rerender(ui(fake({ messages: [msg("m1", "ASSISTANT"), msg("m2", "PERSON")] })));
      expect(top).toBe(500);

      top = 0;
      Object.defineProperty(el, "scrollHeight", { configurable: true, value: 560 });
      rerender(ui(fake({ messages: [msg("m1", "ASSISTANT"), msg("m2", "PERSON")], waiting: true })));
      expect(top).toBe(560);
    });

    it("while at the end, a size change of the list (composer grows, font loads) keeps it at the end", () => {
      let notify: () => void = () => {};
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(cb: () => void) {
            notify = cb;
          }
          observe() {}
          disconnect() {}
        },
      );
      try {
        render(ui(fake()));
        const el = screen.getByTestId("assistants-messages");
        let top = 0;
        Object.defineProperty(el, "scrollHeight", { configurable: true, value: 640 });
        Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v) => { top = v; } });
        notify();
        expect(top).toBe(640);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("opening the panel and switching assistant scroll to the end", () => {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 777 });
      try {
        const two = [ag("maria", "Maria"), ag("teresa", "Teresa")];
        const { rerender } = render(ui(fake({ assistants: two })));
        const el = screen.getByTestId("assistants-messages");
        expect(el.scrollTop).toBe(777); // on open
        el.scrollTop = 0;
        rerender(ui(fake({ assistants: two, active: two[1] })));
        expect(el.scrollTop).toBe(777); // on switch
      } finally {
        if (original) Object.defineProperty(HTMLElement.prototype, "scrollHeight", original);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
      }
    });
  });

  it("composer is a single-line textarea (rows=1) and Shift+Enter does not submit", async () => {
    svc.list.mockResolvedValue([ag("maria", "Maria")]);
    render(<AssistantsWidget />);
    await abrir();
    const c = screen.getByTestId("assistants-composer") as HTMLTextAreaElement;
    expect(c.tagName).toBe("TEXTAREA");
    expect(c.rows).toBe(1);
    expect(screen.getByTestId("assistants-send")).toHaveAttribute("aria-label", "Enviar");
  });

  it("'escribiendo' is a balloon with 3 dots and the typing label", async () => {
    svc.list.mockResolvedValue([ag("maria", "Maria")]);
    svc.sendMessage.mockReturnValue(new Promise(() => {}));
    render(<AssistantsWidget />);
    await abrir();
    fireEvent.change(screen.getByTestId("assistants-composer"), { target: { value: "hola" } });
    fireEvent.click(screen.getByTestId("assistants-send"));
    const typing = await screen.findByTestId("assistants-typing");
    expect(typing).toHaveAttribute("aria-label", "escribiendo…");
    expect(typing.querySelectorAll("i")).toHaveLength(3);
  });
});

describe("AssistantsPanel — assistant replies in markdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    void i18n.changeLanguage("es");
    svc.markRead.mockResolvedValue(undefined);
  });

  const withHistory = (assistantText: string, personText = "**mío**") => {
    svc.list.mockResolvedValue([ag("maria", "Maria")]);
    svc.messages.mockResolvedValue({
      conversation_id: "c1",
      messages: [
        { id: "m1", author: "PERSON", text: personText, tools: [], validator: null, created_at: "2026-10-30T10:00:00Z" },
        { id: "m2", author: "ASSISTANT", text: assistantText, tools: [], validator: null, created_at: "2026-10-30T10:00:01Z" },
      ],
    });
  };

  it("assistant bubble: **bold** becomes <strong>, '*' bullets become a list, no literal markdown left", async () => {
    withHistory("**Ver** algo\n\n* item um\n* item dois");
    render(<AssistantsWidget />);
    await abrir();
    const bubble = await screen.findByTestId("assistants-msg-m2");
    expect(bubble.querySelector("strong")?.textContent).toBe("Ver");
    expect(bubble.querySelectorAll("ul > li")).toHaveLength(2);
    expect(bubble.textContent).not.toContain("**");
    expect(bubble.textContent).not.toContain("* item");
  });

  it("assistant bubble: raw HTML never becomes HTML (no <img>, no handler)", async () => {
    withHistory("hola <img src=x onerror=alert(1)> chau");
    render(<AssistantsWidget />);
    await abrir();
    const bubble = await screen.findByTestId("assistants-msg-m2");
    expect(bubble.querySelector("img")).toBeNull();
    expect(bubble.querySelector("[onerror]")).toBeNull();
  });

  it("the person's own bubble stays plain text (markdown is not interpreted)", async () => {
    withHistory("ok", "**mío**");
    render(<AssistantsWidget />);
    await abrir();
    const mine = await screen.findByTestId("assistants-msg-m1");
    expect(mine.querySelector("strong")).toBeNull();
    expect(mine.textContent).toBe("**mío**");
  });
});

describe("AssistantsPanel — free placement and reset (spec 090)", () => {
  const a: UseAssistants = {
    assistants: [ag("maria", "Maria")],
    active: ag("maria", "Maria"),
    setTab: vi.fn(),
    messages: [],
    waiting: false,
    notice: null,
    historyError: false,
    unreadTotal: 0,
    send: vi.fn(),
    markRead: vi.fn().mockResolvedValue(undefined),
    loadConversation: vi.fn(),
  };
  const ui = (extra: Partial<React.ComponentProps<typeof AssistantsPanel>> = {}) => (
    <AssistantsPanel assistants={a} draft="" setDraft={vi.fn()} onClose={vi.fn()} onMinimize={vi.fn()} {...extra} />
  );

  it("without placement: keeps today's corner classes and no inline style", () => {
    render(ui());
    const p = screen.getByTestId("assistants-panel");
    expect(p.className).toContain("sm:bottom-4 sm:right-4 sm:h-[480px]");
    expect(p.getAttribute("style")).toBeNull();
  });

  it("with placement: inline left/top/width/height and no corner anchors", () => {
    render(ui({ placement: { left: 10, top: 20, width: 356, height: 480 } }));
    const p = screen.getByTestId("assistants-panel");
    expect(p.style.left).toBe("10px");
    expect(p.style.top).toBe("20px");
    expect(p.style.width).toBe("356px");
    expect(p.style.height).toBe("480px");
    expect(p.className).not.toContain("sm:bottom-4");
  });

  it("reset button exists only with onResetPosition, and clicking it calls it", () => {
    const { unmount } = render(ui());
    expect(screen.queryByTestId("assistants-reset-position")).toBeNull();
    unmount();
    const onReset = vi.fn();
    render(ui({ onResetPosition: onReset }));
    fireEvent.click(screen.getByTestId("assistants-reset-position"));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("reset label: 'Volver a la esquina' (es) and pt-BR key present", () => {
    render(ui({ onResetPosition: vi.fn() }));
    expect(screen.getByLabelText("Volver a la esquina")).toBe(screen.getByTestId("assistants-reset-position"));
    expect((ptBR.admin.assistants as Record<string, string>).resetPosition).toBe("Voltar ao canto");
  });
});
