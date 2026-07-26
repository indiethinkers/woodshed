import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshInbox: vi.fn(),
  triage: vi.fn(),
  refine: vi.fn(),
  plan: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
}));

vi.mock("@/components/layout/list-panel", () => ({
  ListPanel: ({ children }: { children: ReactNode }) => (
    <aside data-testid="mail-sidebar">{children}</aside>
  ),
}));

vi.mock("@/components/layout/content-panel", () => ({
  ContentPanel: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
}));

vi.mock("@/components/mail/email-detail", () => ({
  EmailDetail: () => null,
}));

vi.mock("@/components/mail/sweep/command-bar", () => ({
  CommandBar: () => null,
}));

vi.mock("@/components/mail/sweep/sweep-card", () => ({
  SweepCardView: () => null,
}));

vi.mock("@/lib/hooks/use-mail", () => ({
  useArchiveOne: () => vi.fn(),
  useEmail: () => ({ data: null }),
  useAllMail: () => ({ data: [] }),
  useMail: () => ({ data: [] }),
  useReplyMail: () => vi.fn(),
  useSendMail: () => vi.fn(),
}));

vi.mock("@/lib/hooks/use-people", () => ({
  useAllPeople: () => ({ data: [] }),
  usePeopleMutations: () => ({
    create: { mutateAsync: vi.fn() },
    update: { mutateAsync: vi.fn() },
  }),
}));

vi.mock("@/lib/hooks/use-mail-refresh-job", () => ({
  useMailRefreshJob: () => ({
    refreshing: false,
    triagingIds: new Set<string>(),
    progress: {
      phase: "idle",
      limit: 20,
      loaded: 0,
      alreadyTriaged: 0,
      pending: 0,
      triaged: 0,
      failed: 0,
      startedAt: null,
      completedAt: null,
      error: null,
    },
    logs: [],
    refreshInbox: mocks.refreshInbox,
    dismissLog: vi.fn(),
  }),
}));

vi.mock("@/lib/hooks/use-sweep", () => ({
  usePlanCardActions: () => ({ mutateAsync: mocks.plan }),
  useRefineCard: () => ({ mutateAsync: mocks.refine }),
  useSaveCard: () => ({ mutateAsync: vi.fn() }),
  useSweepCards: () => ({ data: [] }),
  useTriageEmail: () => ({ mutateAsync: mocks.triage }),
}));

vi.mock("@/lib/hooks/use-resources", () => ({
  useResourceMutations: () => ({ capture: { mutateAsync: vi.fn() } }),
}));

vi.mock("@/lib/hooks/use-tasks", () => ({
  useTaskMutations: () => ({ create: { mutateAsync: vi.fn() } }),
}));

import { MailSurface } from "./mail-surface";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MailSurface", () => {
  it("renders the mode switch in the sidebar and does not run AI on entry", () => {
    render(<MailSurface />);

    const sidebar = within(screen.getByTestId("mail-sidebar"));
    expect(sidebar.getByRole("group", { name: "Mail view" })).toBeInTheDocument();
    expect(sidebar.getByRole("link", { name: "Inbox" })).toBeInTheDocument();
    expect(sidebar.getByRole("link", { name: "AI Sweep" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("main")).queryByRole("group", {
        name: "Mail view",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh & triage" }),
    ).toBeInTheDocument();
    expect(mocks.refreshInbox).not.toHaveBeenCalled();
    expect(mocks.triage).not.toHaveBeenCalled();
    expect(mocks.refine).not.toHaveBeenCalled();
    expect(mocks.plan).not.toHaveBeenCalled();
  });
});
