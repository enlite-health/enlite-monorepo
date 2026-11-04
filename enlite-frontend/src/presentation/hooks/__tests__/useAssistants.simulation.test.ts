/**
 * useAssistants × simulação de grupo (spec 026). O sinal é `authz.simulation` do adminAuthStore:
 * começar/trocar/encerrar a simulação refaz `list()`; lista vazia = sem assistentes (widget some).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { AdminAssistantsApiService } from "@infrastructure/http/AdminAssistantsApiService";
import { useAdminAuthStore } from "@presentation/stores/adminAuthStore";
import type { Assistant } from "@domain/entities/Assistant";
import type { AuthzContract } from "@domain/entities/Authz";
import { useAssistants } from "../useAssistants";

vi.mock("@infrastructure/http/AdminAssistantsApiService", () => ({
  AdminAssistantsApiService: {
    list: vi.fn(),
    messages: vi.fn(),
    sendMessage: vi.fn(),
    markRead: vi.fn(),
  },
}));

const svc = vi.mocked(AdminAssistantsApiService);

const maria: Assistant = {
  slug: "maria",
  name: "Maria",
  role: "MANAGER",
  area: "Operaciones",
  available: true,
  last_at: null,
  unread_count: 0,
};

const authzWith = (groupId: string | null) =>
  ({
    simulation: groupId
      ? { groupId, groupName: "G", startedAt: "2026-11-02T14:00:00Z", expiresAt: "2026-11-02T18:00:00Z" }
      : null,
  }) as unknown as AuthzContract;

const setSim = (groupId: string | null) =>
  act(() => {
    useAdminAuthStore.setState({ authz: authzWith(groupId) });
  });

describe("useAssistants — simulação de grupo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAdminAuthStore.setState({ authz: authzWith(null) });
  });

  it("começar a simulação refaz list(); lista vazia esconde; encerrar traz de volta", async () => {
    svc.list.mockResolvedValueOnce([maria]);
    const { result } = renderHook(() => useAssistants());
    await waitFor(() => expect(result.current.assistants).toHaveLength(1));
    expect(svc.list).toHaveBeenCalledTimes(1);

    svc.list.mockResolvedValueOnce([]);
    setSim("g1");
    await waitFor(() => expect(svc.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.assistants).toHaveLength(0));
    expect(result.current.active).toBeNull();

    svc.list.mockResolvedValueOnce([maria]);
    setSim(null);
    await waitFor(() => expect(svc.list).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.assistants).toHaveLength(1));
  });

  it("trocar de grupo simulado também refaz list(), sem manter a lista anterior", async () => {
    svc.list.mockResolvedValueOnce([maria]);
    setSim("g1");
    const { result } = renderHook(() => useAssistants());
    await waitFor(() => expect(result.current.assistants).toHaveLength(1));

    let resolver: (l: Assistant[]) => void = () => {};
    svc.list.mockReturnValueOnce(new Promise<Assistant[]>((r) => (resolver = r)));
    setSim("g2");
    await waitFor(() => expect(svc.list).toHaveBeenCalledTimes(2));
    expect(result.current.assistants).toHaveLength(0); // nada clicável enquanto a nova lista não chega
    await act(async () => resolver([]));
    expect(result.current.assistants).toHaveLength(0);
  });
});
