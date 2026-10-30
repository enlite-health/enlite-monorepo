/**
 * LinkExistingVacancyUseCase — spec 079 T019. Dublês dos repositórios; `lockRecruitmentContext` mockado;
 * o runner de transação executa a fn com um client fake. A prova com SQL real é do e2e.
 */
jest.mock("firebase-functions", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
const mockLock = jest.fn();
jest.mock("../recruitmentReadinessContext", () => ({
  ...jest.requireActual("../recruitmentReadinessContext"),
  lockRecruitmentContext: (...a: unknown[]) => mockLock(...a),
}));
const mockMovePatientStatus = jest.fn();
jest.mock("../PatientStatusWriter", () => ({
  ...jest.requireActual("../PatientStatusWriter"),
  movePatientStatus: (...a: unknown[]) => mockMovePatientStatus(...a),
}));

import {
  LinkExistingVacancyUseCase,
  VacancyNotLinkableError,
  LinkBlockedError,
  AddressNotOfPatientError,
  ServiceAlreadyRecruitingError,
} from "../LinkExistingVacancyUseCase";
import type { VacancyForLinkRow } from "../../infrastructure/LinkExistingVacancyRepository";

const P = "patient-1";
const S = "service-1";
const V = "vacancy-1";
const client = { marker: "client" };
const actor = { actorUserId: "uid-1", actorType: "HUMAN" as const, actorLabel: "admin_panel", traceId: "t1" };

const okCtx = (over: Record<string, unknown> = {}) => ({
  patient: {
    id: P, status: "ACTIVE", case_number: 1, insurance_informed: "OSDE",
    has_verified_active_coverage: true, active_dx_count: "1",
  },
  service: {
    id: S, providers_needed: 1, has_schedule: true, live_address_id: "addr-1",
    required_professions: ["AT"], required_sex: "BOTH", required_experience: "1",
    work_schedule: "full-time", payment_day: "5", ...over,
  },
});

const vac = (over: Partial<VacancyForLinkRow> = {}): VacancyForLinkRow => ({
  id: V, patientId: P, contractedServiceId: null, deletedAt: null, status: "SEARCHING",
  required_professions: null, required_experience: null, work_schedule: null, payment_day: null,
  required_sex: null, providers_needed: null, age_range_min: null, age_range_max: null,
  schedule: null, patient_address_id: null, ...over,
});

function build(opts: { accepts?: (f: string, v: unknown) => boolean } = {}) {
  const calls: string[] = [];
  const repo = {
    listPatientVacanciesForLink: jest.fn(async () => [
      { id: "v-ok", caseNumber: 1, caseOrdinal: 1, vacancyNumber: 1, title: "t", status: "SEARCHING", isDraft: false, contractedServiceId: null, createdAt: new Date() },
      { id: "v-linked", caseNumber: 1, caseOrdinal: 2, vacancyNumber: 2, title: "t", status: "SEARCHING", isDraft: false, contractedServiceId: "other", createdAt: new Date() },
      { id: "v-baja", caseNumber: 1, caseOrdinal: 3, vacancyNumber: 3, title: "t", status: "DE_BAJA", isDraft: false, contractedServiceId: null, createdAt: new Date() },
    ]),
    readVacancyForLink: jest.fn(async (): Promise<VacancyForLinkRow | null> => vac()),
    readServiceLinkTarget: jest.fn(async () => ({ provider_age_band: null })),
    feedService: jest.fn(async () => { calls.push("feed"); }),
    linkVacancyAndClear: jest.fn(async () => { calls.push("link"); return 1; }),
  };
  const audit = { logFieldChangesSafe: jest.fn(async () => { calls.push("audit"); }) };
  const runner = jest.fn(async (fn: (c: unknown) => unknown) => fn(client)) as never;
  const accepts = jest.fn(opts.accepts ?? (() => true));
  const uc = new LinkExistingVacancyUseCase(repo as never, audit as never, accepts as never, runner);
  return { uc, repo, audit, accepts, calls };
}
const noWrites = (t: ReturnType<typeof build>) => {
  expect(t.repo.feedService).not.toHaveBeenCalled();
  expect(t.repo.linkVacancyAndClear).not.toHaveBeenCalled();
  expect(t.audit.logFieldChangesSafe).not.toHaveBeenCalled();
};

beforeEach(() => {
  jest.clearAllMocks();
  mockLock.mockResolvedValue(okCtx());
});

describe("elegibilidade (confirmação)", () => {
  it.each([
    ["OTHER_PATIENT", { patientId: "outro" }],
    ["ALREADY_LINKED", { contractedServiceId: "x" }],
    ["DELETED", { deletedAt: new Date() }],
    ["DE_BAJA", { status: "DE_BAJA" }],
  ])("%s -> VacancyNotLinkableError sem gravar", async (reason, over) => {
    const t = build();
    t.repo.readVacancyForLink.mockResolvedValue(vac(over as Partial<VacancyForLinkRow>));
    await expect(t.uc.confirm(P, S, V, actor)).rejects.toMatchObject({ name: "VacancyNotLinkableError", reason });
    noWrites(t);
  });

  it("vaga inexistente -> NOT_FOUND", async () => {
    const t = build();
    t.repo.readVacancyForLink.mockResolvedValue(null);
    await expect(t.uc.confirm(P, S, V, actor)).rejects.toBeInstanceOf(VacancyNotLinkableError);
    await expect(t.uc.confirm(P, S, V, actor)).rejects.toMatchObject({ reason: "NOT_FOUND" });
    noWrites(t);
  });
});

describe("serviço com vaga viva", () => {
  it("lock lança ServiceAlreadyRecruitingError na prévia e na confirmação", async () => {
    mockLock.mockRejectedValue(new ServiceAlreadyRecruitingError("live"));
    const t = build();
    await expect(t.uc.preview(P, S, V)).rejects.toBeInstanceOf(ServiceAlreadyRecruitingError);
    await expect(t.uc.confirm(P, S, V, actor)).rejects.toBeInstanceOf(ServiceAlreadyRecruitingError);
    noWrites(t);
  });
});

describe("bloqueios", () => {
  it("endereço diferente -> LinkBlockedError [ADDRESS_MISMATCH], nenhuma escrita", async () => {
    const t = build();
    t.repo.readVacancyForLink.mockResolvedValue(vac({ patient_address_id: "addr-2" }));
    await expect(t.uc.confirm(P, S, V, actor)).rejects.toMatchObject({ name: "LinkBlockedError", blockers: ["ADDRESS_MISMATCH"] });
    noWrites(t);
  });

  it("portão falhando -> LinkBlockedError(missing), nenhuma escrita", async () => {
    mockLock.mockResolvedValue(okCtx({ has_schedule: false }));
    const t = build();
    const err = await t.uc.confirm(P, S, V, actor).catch((e) => e);
    expect(err).toBeInstanceOf(LinkBlockedError);
    expect(err.blockers).toEqual(["SERVICE_SCHEDULE"]);
    noWrites(t);
  });

  it("prévia devolve blockers e canConfirm=false em vez de lançar", async () => {
    mockLock.mockResolvedValue(okCtx({ has_schedule: false }));
    const t = build();
    const r = await t.uc.preview(P, S, V);
    expect(r.preview?.blockers).toEqual(["SERVICE_SCHEDULE"]);
    expect(r.preview?.canConfirm).toBe(false);
  });
});

describe("re-validação na confirmação", () => {
  it("prévia OK; depois a vaga aparece vinculada -> confirm lança e não grava", async () => {
    const t = build();
    const pv = await t.uc.preview(P, S, V);
    expect(pv.preview?.canConfirm).toBe(true);
    t.repo.readVacancyForLink.mockResolvedValue(vac({ contractedServiceId: "outro" }));
    await expect(t.uc.confirm(P, S, V, actor)).rejects.toMatchObject({ reason: "ALREADY_LINKED" });
    noWrites(t);
  });

  it("UPDATE com rowCount 0 -> ALREADY_LINKED e sem auditoria", async () => {
    const t = build();
    t.repo.linkVacancyAndClear.mockResolvedValue(0);
    await expect(t.uc.confirm(P, S, V, actor)).rejects.toMatchObject({ reason: "ALREADY_LINKED" });
    expect(t.audit.logFieldChangesSafe).not.toHaveBeenCalled();
  });
});

describe("erros do banco", () => {
  it("23505 no UPDATE -> ServiceAlreadyRecruitingError", async () => {
    const t = build();
    t.repo.linkVacancyAndClear.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
    await expect(t.uc.confirm(P, S, V, actor)).rejects.toBeInstanceOf(ServiceAlreadyRecruitingError);
    expect(t.audit.logFieldChangesSafe).not.toHaveBeenCalled();
  });

  it("23503 (FK composta) -> AddressNotOfPatientError", async () => {
    const t = build();
    t.repo.feedService.mockRejectedValue(Object.assign(new Error("fk"), { code: "23503" }));
    await expect(t.uc.confirm(P, S, V, actor)).rejects.toBeInstanceOf(AddressNotOfPatientError);
    expect(t.repo.linkVacancyAndClear).not.toHaveBeenCalled();
  });

  it("erro desconhecido é relançado", async () => {
    const t = build();
    t.repo.linkVacancyAndClear.mockRejectedValue(new Error("boom"));
    await expect(t.uc.confirm(P, S, V, actor)).rejects.toThrow("boom");
  });
});

describe("caminho feliz", () => {
  it("ordem, auditoria com 3 classes de linha e fedFields mapeados", async () => {
    mockLock.mockResolvedValue(okCtx({ required_sex: null, live_address_id: null }));
    const t = build();
    t.repo.readVacancyForLink.mockResolvedValue(
      vac({ required_sex: "F", patient_address_id: "addr-9", age_range_min: 18, age_range_max: 30, providers_needed: "2" }),
    );
    // ctx.providers_needed = 1 => serviço vale; faixa: força a vaga alimentar via band achada
    const res = await t.uc.confirm(P, S, V, actor);
    expect(t.calls).toEqual(["feed", "link", "audit"]);
    expect(t.repo.feedService).toHaveBeenCalledWith(client, S, expect.objectContaining({ required_sex: "F", address_id: "addr-9" }), "uid-1");
    expect(res.fedFields).toEqual(expect.arrayContaining(["required_sex", "address"]));
    expect(res.vacancyId).toBe(V);
    expect(res.serviceId).toBe(S);

    expect(t.audit.logFieldChangesSafe).toHaveBeenCalledTimes(1);
    const params = (t.audit.logFieldChangesSafe.mock.calls[0] as unknown[])[1] as {
      jobPostingId: string; actorType: string; actorUserId: string; traceId: string;
      fields: Array<{ field: string; before: unknown; after: unknown }>;
    };
    expect(params).toMatchObject({ jobPostingId: V, actorType: "HUMAN", actorUserId: "uid-1", traceId: "t1" });
    expect(params.fields).toEqual(
      expect.arrayContaining([
        { field: "contracted_service_id", before: null, after: S },
        { field: "required_sex", before: "F", after: null },
        { field: "age_range_min", before: 18, after: null },
        { field: "providers_needed", before: "2", after: null },
        { field: "contracted_service.required_sex", before: null, after: "F" },
        { field: "contracted_service.address_id", before: null, after: "addr-9" },
      ]),
    );
    expect(mockMovePatientStatus).not.toHaveBeenCalled();
  });

  it("faixa exata da vaga alimenta provider_age_band e sai como age_range em fedFields", async () => {
    const t = build();
    t.repo.readVacancyForLink.mockResolvedValue(vac({ age_range_min: 30, age_range_max: 44 }));
    const res = await t.uc.confirm(P, S, V, actor);
    expect(t.repo.feedService).toHaveBeenCalledWith(client, S, expect.objectContaining({ provider_age_band: "AGE_30_45" }), "uid-1");
    expect(res.fedFields).toEqual(["age_range"]);
    const fields = ((t.audit.logFieldChangesSafe.mock.calls[0] as unknown[])[1] as { fields: Array<{ field: string }> }).fields.map((f) => f.field);
    expect(fields).toContain("contracted_service.provider_age_band");
  });
});

describe("prévia", () => {
  it("nunca grava; lista só as elegíveis; sem vacancyId -> preview null", async () => {
    const t = build();
    const r = await t.uc.preview(P, S);
    expect(r.preview).toBeNull();
    expect(r.candidates.map((c) => c.id)).toEqual(["v-ok"]);
    await t.uc.preview(P, S, V);
    noWrites(t);
    expect(t.repo.readVacancyForLink).toHaveBeenCalledWith(client, V, { forUpdate: false });
    expect(mockMovePatientStatus).not.toHaveBeenCalled();
  });

  it("vaga inexistente / inelegível na prévia lançam VacancyNotLinkableError", async () => {
    const t = build();
    t.repo.readVacancyForLink.mockResolvedValue(null);
    await expect(t.uc.preview(P, S, V)).rejects.toMatchObject({ reason: "NOT_FOUND" });
    t.repo.readVacancyForLink.mockResolvedValue(vac({ status: "DE_BAJA" }));
    await expect(t.uc.preview(P, S, V)).rejects.toMatchObject({ reason: "DE_BAJA" });
  });
});

describe("accepts injetado", () => {
  it("stub false -> warning e o campo não alimenta", async () => {
    mockLock.mockResolvedValue(okCtx({ required_sex: null }));
    const t = build({ accepts: () => false });
    t.repo.readVacancyForLink.mockResolvedValue(vac({ required_sex: "F" }));
    const pv = await t.uc.preview(P, S, V);
    expect(t.accepts).toHaveBeenCalledWith("required_sex", "F");
    expect(pv.preview?.warnings).toEqual([{ field: "required_sex", code: "VALUE_OUTSIDE_SERVICE_DOMAIN" }]);
    // serviço segue sem sexo -> portão bloqueia
    expect(pv.preview?.blockers).toContain("SERVICE_REQUIRED_SEX" as never);
  });
});
