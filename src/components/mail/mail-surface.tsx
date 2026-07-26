"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Mail, MailCheck, MailOpen, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { ContentPanel } from "@/components/layout/content-panel";
import { ListPanel } from "@/components/layout/list-panel";
import { Button } from "@/components/ui/button";
import { EmailDetail } from "@/components/mail/email-detail";
import {
  useArchiveOne,
  useEmail,
  useAllMail,
  useReplyMail,
  useSendMail,
} from "@/lib/hooks/use-mail";
import {
  useAllPeople,
  usePeopleMutations,
  type PersonDto,
} from "@/lib/hooks/use-people";
import {
  useMailRefreshJob,
  type MailRefreshLogEntry,
  type MailRefreshProgress,
} from "@/lib/hooks/use-mail-refresh-job";
import {
  usePlanCardActions,
  useRefineCard,
  useSaveCard,
  useSweepCards,
  useTriageEmail,
} from "@/lib/hooks/use-sweep";
import { useResourceMutations } from "@/lib/hooks/use-resources";
import { useTaskMutations } from "@/lib/hooks/use-tasks";
import { cardsByEmail, laneForEmail, rowsByLane } from "@/lib/sweep";
import {
  extractEmailRecipients,
  forwardSubject,
  parseSweepPersonCommand,
} from "@/lib/sweep/action-command";
import {
  parseSweepTaskCommand,
  type SweepTaskCommand,
} from "@/lib/sweep/task-command";
import type { EmailSummary } from "@/lib/mail-lib/types";
import type {
  SweepCard,
  SweepPlannedAction,
  SweepStatus,
} from "@/lib/sweep/types";
import { CommandBar } from "./sweep/command-bar";
import { SweepCardView } from "./sweep/sweep-card";
import { SweepList } from "./sweep/sweep-list";

type MailDetailMode = "triage" | "email";

// Apple-Mail layout: the inbox lives in the inner list panel; the selected
// email's sweep card fills the content panel. Triage is NOT run on load — it's
// tied to the Refresh button (sync mail, then triage anything without a card).
export function MailSurface() {
  const queryClient = useQueryClient();
  const { data: emails = [] } = useAllMail();
  const { data: cards = [] } = useSweepCards();
  const refreshJob = useMailRefreshJob();
  const triage = useTriageEmail();
  const save = useSaveCard();
  const commandSave = useSaveCard();
  const commandRefine = useRefineCard();
  const commandPlan = usePlanCardActions();
  const resourceMutations = useResourceMutations();
  const taskMutations = useTaskMutations();
  const peopleMutations = usePeopleMutations();
  const { data: people = [] } = useAllPeople();
  const send = useSendMail();
  const reply = useReplyMail();
  const archiveOne = useArchiveOne();
  const archivingEmailIdsRef = useRef<Set<string>>(new Set());

  const [lane, setLane] = useState<SweepStatus>("to_review");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualTriagingIds, setManualTriagingIds] = useState<Set<string>>(
    new Set(),
  );
  const [detailMode, setDetailMode] = useState<MailDetailMode>("triage");

  const byEmail = useMemo(() => cardsByEmail(cards), [cards]);
  const laneRows = useMemo(
    () => rowsByLane(emails, cards)[lane],
    [emails, cards, lane],
  );
  const laneIds = useMemo(() => laneRows.map((row) => row.id), [laneRows]);
  const processingIds = useMemo(
    () => new Set([...refreshJob.triagingIds, ...manualTriagingIds]),
    [manualTriagingIds, refreshJob.triagingIds],
  );
  const selectedInboxEmail = useMemo(() => {
    if (!selectedId) return null;
    return emails.find((e) => e.id === selectedId) ?? null;
  }, [selectedId, emails]);
  const { data: selectedLocalEmail = null } = useEmail(
    selectedInboxEmail ? null : selectedId,
  );

  // The index route intentionally starts with no selected email. The user
  // chooses when to enter the sweep instead of being dropped into a message.
  const selectedEmail: EmailSummary | null =
    selectedInboxEmail ?? selectedLocalEmail ?? null;

  const selectedCard = selectedId ? byEmail.get(selectedId) ?? null : null;
  const hasSelection = !!selectedId && (!!selectedEmail || !!selectedCard);

  useEffect(() => {
    if (!selectedId) return;

    function onKeyDown(event: KeyboardEvent) {
      const isArchiveShortcut =
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "e";

      if (isArchiveShortcut) {
        if (event.defaultPrevented || event.isComposing || event.repeat) {
          return;
        }
        if (busy || selectedCard || selectedEmail) {
          event.preventDefault();
        }
        if (!busy) {
          archiveCurrentSelection();
        }
        return;
      }

      if (event.key !== "Escape") return;
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing
      ) {
        return;
      }

      event.preventDefault();
      setSelectedId(null);
      setDetailMode("triage");
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, selectedCard, selectedEmail, selectedId]);

  function nextInLane(emailId: string): string | null {
    const idx = laneIds.findIndex((id) => id === emailId);
    if (idx < 0) return laneIds[0] ?? null;
    return laneIds[idx + 1] ?? laneIds[idx - 1] ?? null;
  }

  function selectReviewEmail(emailId: string | null) {
    setSelectedId(emailId);
    setDetailMode("triage");
  }

  function advanceFrom(emailId: string): string | null {
    const next = nextInLane(emailId);
    selectReviewEmail(next);
    return next;
  }

  function setSweepCardInCache(card: SweepCard) {
    queryClient.setQueryData<SweepCard[]>(["sweep"], (old) =>
      old?.map((existing) => (existing.id === card.id ? card : existing)),
    );
  }

  // Refresh = sync mail, then triage every email that lacks a card.
  async function onRefresh() {
    await refreshJob.refreshInbox({ limit: 20 });
  }

  async function onTriageOne(emailId: string) {
    setManualTriagingIds((prev) => new Set(prev).add(emailId));
    try {
      await triage.mutateAsync(emailId);
    } finally {
      setManualTriagingIds((prev) => {
        const next = new Set(prev);
        next.delete(emailId);
        return next;
      });
    }
  }

  async function complete(
    card: SweepCard,
    action: string,
    detail?: string,
    options: { advance?: boolean } = {},
  ) {
    if (options.advance !== false) advanceFrom(card.emailId);
    await save.mutateAsync({
      ...card,
      status: "done",
      timeline: [
        ...card.timeline,
        {
          at: new Date().toISOString(),
          actor: "you",
          action,
          detail: detail ?? null,
        },
      ],
    });
  }

  async function onSend(card: SweepCard, visibleDraft: string) {
    const body = visibleDraft;
    setBusy(true);
    try {
      if (card.actionKind === "forward") {
        const to = extractEmailRecipients(card.actionTarget);
        if (to.length === 0) {
          throw new Error("Forward target is missing or not an email address.");
        }
        await send({
          fromInbox: card.inbox ?? undefined,
          to,
          subject: forwardSubject(card.subject),
          body,
        });
        await complete({ ...card, draft: body }, "forwarded", to.join(", "));
      } else {
        await reply({
          inReplyToMessageId: card.emailId,
          threadId: card.threadId ?? "",
          fromInbox: card.inbox ?? undefined,
          body,
        });
        await complete({ ...card, draft: body }, "sent");
      }
    } catch (error) {
      toast.error("Send failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  function onArchive(card: SweepCard) {
    if (!beginArchive(card.emailId)) return;
    const doneCard = cardWithTimelineEvents(card, "done", [
      { actor: "you", action: "archived" },
    ]);
    advanceFrom(card.emailId);
    setSweepCardInCache(doneCard);
    void archiveCardInBackground(doneCard, card, "Archive failed").finally(() =>
      finishArchive(card.emailId),
    );
  }

  function archiveCurrentSelection() {
    if (selectedCard) {
      onArchive(selectedCard);
      return;
    }
    if (!selectedEmail) return;
    if (!beginArchive(selectedEmail.id)) return;

    advanceFrom(selectedEmail.id);
    archiveOne(selectedEmail.id)
      .catch((error) => {
        toast.error("Archive failed", {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        finishArchive(selectedEmail.id);
      });
  }

  function beginArchive(emailId: string): boolean {
    if (archivingEmailIdsRef.current.has(emailId)) return false;
    archivingEmailIdsRef.current.add(emailId);
    return true;
  }

  function finishArchive(emailId: string) {
    archivingEmailIdsRef.current.delete(emailId);
  }

  async function onTask(card: SweepCard) {
    setBusy(true);
    try {
      const task = await createTaskFromCard(card, taskCommandFromCard(card));
      await complete(card, "tasked", task.content);
    } finally {
      setBusy(false);
    }
  }

  async function onPerson(card: SweepCard) {
    setBusy(true);
    try {
      const person = await upsertPersonFromCard(card);
      await complete(card, "person-updated", personDetail(person));
    } catch (error) {
      toast.error("Person update failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  async function onSnooze(card: SweepCard, days = 1) {
    const until = new Date(Date.now() + days * 86_400_000).toISOString();
    advanceFrom(card.emailId);
    await save.mutateAsync({
      ...card,
      snoozeUntil: until,
      timeline: [
        ...card.timeline,
        {
          at: new Date().toISOString(),
          actor: "you",
          action: "snoozed",
          detail: until,
        },
      ],
    });
  }

  async function onDraftChange(card: SweepCard, draft: string) {
    if (draft === card.draft) return;
    await save.mutateAsync({ ...card, draft });
  }

  function onCommand(card: SweepCard, instruction: string) {
    if (shouldPlanSweepActions(instruction)) {
      const workingCard = cardWithTimelineEvents(card, "working", [
        { actor: "you", action: "asked", detail: instruction },
        { actor: "app", action: "status", detail: "planning actions" },
      ]);
      advanceFrom(card.emailId);
      setSweepCardInCache(workingCard);
      void runActionPlanInBackground(workingCard, card, instruction);
      return;
    }

    const taskCommand = parseSweepTaskCommand(instruction);
    if (taskCommand) {
      const workingCard = cardWithTimelineEvents(card, "working", [
        { actor: "you", action: "asked", detail: instruction },
        { actor: "app", action: "status", detail: "creating task" },
      ]);
      advanceFrom(card.emailId);
      setSweepCardInCache(workingCard);
      void createTaskCommandInBackground(workingCard, card, taskCommand);
      return;
    }

    if (isArchiveInstruction(instruction)) {
      if (!beginArchive(card.emailId)) return;
      const doneCard = cardWithTimelineEvents(card, "done", [
        { actor: "you", action: "asked", detail: instruction },
        { actor: "app", action: "archived", detail: instruction },
      ]);
      advanceFrom(card.emailId);
      setSweepCardInCache(doneCard);
      void archiveCardInBackground(
        doneCard,
        card,
        "Archive command failed",
      ).finally(() => finishArchive(card.emailId));
      return;
    }

    if (parseSweepPersonCommand(instruction)) {
      const workingCard = cardWithTimelineEvents(card, "working", [
        { actor: "you", action: "asked", detail: instruction },
        { actor: "app", action: "status", detail: "updating person" },
      ]);
      advanceFrom(card.emailId);
      setSweepCardInCache(workingCard);
      void updatePersonCommandInBackground(workingCard, card);
      return;
    }

    const workingCard = cardWithTimelineEvents(card, "working", [
      { actor: "you", action: "asked", detail: instruction },
      { actor: "app", action: "status", detail: "working" },
    ]);
    advanceFrom(card.emailId);
    setSweepCardInCache(workingCard);
    void runCommandInBackground(workingCard, card, instruction);
  }

  async function createTaskFromCard(
    card: SweepCard,
    command: SweepTaskCommand = {},
  ) {
    return taskMutations.create.mutateAsync({
      content: command.content?.trim() || card.headline || card.subject,
      area: "",
      scheduled: command.scheduled,
    });
  }

  function taskCommandFromCard(card: SweepCard): SweepTaskCommand {
    if (!card.actionTarget) return {};
    return parseSweepTaskCommand(`create task ${card.actionTarget}`) ?? {};
  }

  async function upsertPersonFromCard(card: SweepCard): Promise<PersonDto> {
    const target = personTargetFromCard(card);
    const existing = findExistingPerson(people, target);
    const note = personMailNote(card);

    if (existing) {
      return peopleMutations.update.mutateAsync({
        id: existing.id,
        update: {
          email: existing.email || target.email || undefined,
          body: appendPersonNote(existing.body, note),
        },
      });
    }

    return peopleMutations.create.mutateAsync({
      name: target.name,
      role: "",
      company: "",
      email: target.email,
      body: note,
    });
  }

  async function createTaskCommandInBackground(
    workingCard: SweepCard,
    restoreCard: SweepCard,
    command: SweepTaskCommand,
  ) {
    let wroteWorking = false;
    try {
      await commandSave.mutateAsync(workingCard);
      wroteWorking = true;
      const task = await createTaskFromCard(workingCard, command);
      const detail = taskDetail(task.content, command);
      const doneCard = cardWithTimelineEvents(workingCard, "done", [
        { actor: "app", action: "tasked", detail },
      ]);
      setSweepCardInCache(doneCard);
      await commandSave.mutateAsync(doneCard);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error("Task command failed", { description: message });
      const failedCard = cardWithTimelineEvents(restoreCard, "to_review", [
        { actor: "app", action: "failed", detail: message },
      ]);
      setSweepCardInCache(failedCard);
      if (wroteWorking) {
        try {
          await commandSave.mutateAsync(failedCard);
        } catch {
          // The visible toast should report the original task failure.
        }
      }
    }
  }

  async function updatePersonCommandInBackground(
    workingCard: SweepCard,
    restoreCard: SweepCard,
  ) {
    let wroteWorking = false;
    try {
      await commandSave.mutateAsync(workingCard);
      wroteWorking = true;
      const person = await upsertPersonFromCard(workingCard);
      const doneCard = cardWithTimelineEvents(workingCard, "done", [
        { actor: "app", action: "person-updated", detail: personDetail(person) },
      ]);
      setSweepCardInCache(doneCard);
      await commandSave.mutateAsync(doneCard);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error("Person command failed", { description: message });
      const failedCard = cardWithTimelineEvents(restoreCard, "to_review", [
        { actor: "app", action: "failed", detail: message },
      ]);
      setSweepCardInCache(failedCard);
      if (wroteWorking) {
        try {
          await commandSave.mutateAsync(failedCard);
        } catch {
          // The visible toast should report the original person failure.
        }
      }
    }
  }

  async function archiveCardInBackground(
    doneCard: SweepCard,
    restoreCard: SweepCard,
    failureTitle: string,
  ) {
    let wroteDone = false;
    try {
      await commandSave.mutateAsync(doneCard);
      wroteDone = true;
      await archiveOne(doneCard.emailId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(failureTitle, { description: message });
      const failedCard = cardWithTimelineEvents(restoreCard, "to_review", [
        { actor: "app", action: "failed", detail: message },
      ]);
      setSweepCardInCache(failedCard);
      if (wroteDone) {
        try {
          await commandSave.mutateAsync(failedCard);
        } catch {
          // The visible toast should report the original archive failure.
        }
      }
    }
  }

  async function runActionPlanInBackground(
    workingCard: SweepCard,
    restoreCard: SweepCard,
    instruction: string,
  ) {
    let wroteWorking = false;
    let archiveStarted = false;
    try {
      await commandSave.mutateAsync(workingCard);
      wroteWorking = true;

      const plan = await commandPlan.mutateAsync({
        cardId: workingCard.id,
        instruction,
      });
      const actions = plan?.actions ?? [];
      if (actions.length === 0) {
        await commandRefine.mutateAsync({
          cardId: workingCard.id,
          instruction,
        });
        return;
      }

      const confirmationLines = actions.map((action) => {
        const kind = normalizePlannedActionKind(action.kind);
        if (kind === "create_resource") {
          const title = confirmationText(action.title) ?? "(no title)";
          const url = confirmationText(action.url) ?? "(missing URL)";
          const tags = cleanPlannedTags(action.tags);
          return `• Save resource\n  Title: ${title}\n  URL: ${url}\n  Tags: ${tags.length > 0 ? tags.join(", ") : "none"}`;
        }
        if (kind === "create_task") {
          const content = confirmationText(action.content) ?? "(untitled task)";
          const scheduled = cleanScheduledDate(action.scheduled) ?? "unscheduled";
          return `• Create task\n  Content: ${content}\n  Scheduled: ${scheduled}`;
        }
        if (kind === "archive_email") {
          return `• Archive email\n  Subject: ${confirmationText(workingCard.subject) ?? "(no subject)"}\n  From: ${confirmationText(workingCard.from) ?? "(unknown sender)"}`;
        }
        return `• Unknown action: ${confirmationText(action.kind) ?? "(blank)"}`;
      });
      if (
        !window.confirm(
          `Motif proposes these actions:\n\n${confirmationLines.join("\n")}\n\nRun them now?`,
        )
      ) {
        setSweepCardInCache(restoreCard);
        if (wroteWorking) await commandSave.mutateAsync(restoreCard);
        return;
      }

      const events: Array<{
        actor: string;
        action: string;
        detail?: string | null;
      }> = [];

      for (const action of actions) {
        const kind = normalizePlannedActionKind(action.kind);
        if (kind === "create_resource") {
          const url = cleanPlannedText(action.url);
          if (!url) continue;
          const resource = await resourceMutations.capture.mutateAsync({
            url,
            title: cleanPlannedText(action.title),
            tags: cleanPlannedTags(action.tags),
          });
          events.push({
            actor: "app",
            action: "resource-created",
            detail: resourceDetail(resource.title, resource.url),
          });
          continue;
        }

        if (kind === "create_task") {
          const command = taskCommandFromPlannedAction(action);
          const task = await createTaskFromCard(workingCard, command);
          events.push({
            actor: "app",
            action: "tasked",
            detail: taskDetail(task.content, command),
          });
          continue;
        }

        if (kind === "archive_email") {
          if (archiveStarted || !beginArchive(workingCard.emailId)) continue;
          archiveStarted = true;
          await archiveOne(workingCard.emailId);
          events.push({
            actor: "app",
            action: "archived",
            detail: cleanPlannedText(action.reason) ?? instruction,
          });
        }
      }

      if (events.length === 0) {
        throw new Error(plan?.note || "Motif did not find an executable action.");
      }

      const doneCard = cardWithTimelineEvents(workingCard, "done", events);
      setSweepCardInCache(doneCard);
      await commandSave.mutateAsync(doneCard);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error("Motif command failed", { description: message });
      const failedCard = cardWithTimelineEvents(restoreCard, "to_review", [
        { actor: "app", action: "failed", detail: message },
      ]);
      setSweepCardInCache(failedCard);
      if (wroteWorking) {
        try {
          await commandSave.mutateAsync(failedCard);
        } catch {
          // The visible toast should report the original Motif failure.
        }
      }
    } finally {
      if (archiveStarted) finishArchive(workingCard.emailId);
    }
  }

  async function runCommandInBackground(
    workingCard: SweepCard,
    restoreCard: SweepCard,
    instruction: string,
  ) {
    let wroteWorking = false;
    try {
      await commandSave.mutateAsync(workingCard);
      wroteWorking = true;
      await commandRefine.mutateAsync({
        cardId: workingCard.id,
        instruction,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error("Motif command failed", { description: message });
      const failedCard = cardWithTimelineEvents(restoreCard, "to_review", [
        { actor: "app", action: "failed", detail: message },
      ]);
      setSweepCardInCache(failedCard);
      if (wroteWorking) {
        try {
          await commandSave.mutateAsync(failedCard);
        } catch {
          // The visible toast should report the original Motif failure.
        }
      }
    }
  }

  const beginReview = laneIds[0]
    ? () => {
        selectReviewEmail(laneIds[0]);
      }
    : undefined;
  const showRefreshLog =
    refreshJob.progress.phase !== "idle" && refreshJob.logs.length > 0;

  return (
    <>
      <ListPanel>
        <SweepList
          emails={emails}
          cards={cards}
          lane={lane}
          onLaneChange={(l) => {
            setLane(l);
            setSelectedId(null);
            setDetailMode("triage");
          }}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setDetailMode("triage");
          }}
          onRefresh={onRefresh}
          refreshing={refreshJob.refreshing}
          progress={refreshJob.progress}
          processingIds={processingIds}
          triagingCount={refreshJob.triagingIds.size + manualTriagingIds.size}
        />
      </ListPanel>
      <ContentPanel
        showTopbar={false}
        wide={!hasSelection}
        flush={!hasSelection}
        filePath={detailMode === "triage" ? selectedCard?.path : undefined}
        footer={
          selectedCard && detailMode === "triage" ? (
            <CommandBar
              card={selectedCard}
              busy={busy}
              onSubmit={(instruction) => onCommand(selectedCard, instruction)}
            />
          ) : undefined
        }
      >
        {hasSelection && (
          <div className="mb-4 flex justify-end">
            <MailDetailModeToggle
              mode={detailMode}
              canShowEmail={!!selectedEmail}
              onChange={setDetailMode}
            />
          </div>
        )}
        {hasSelection ? (
          <>
            {detailMode === "email" && selectedEmail ? (
              <EmailDetail
                key={selectedEmail.id}
                email={selectedEmail}
                onBack={() => setDetailMode("triage")}
                onOpenEmail={(nextId) => {
                  if (nextId) {
                    const nextLane = laneForEmail(nextId, byEmail);
                    if (nextLane) setLane(nextLane);
                  }
                  setSelectedId(nextId);
                  setDetailMode("triage");
                }}
              />
            ) : detailMode === "email" ? (
              <OriginalUnavailableState />
            ) : selectedCard ? (
              <SweepCardView
                key={selectedCard.id}
                card={selectedCard}
                busy={busy}
                onSend={(draft) => onSend(selectedCard, draft)}
                onArchive={() => onArchive(selectedCard)}
                onTask={() => onTask(selectedCard)}
                onPerson={() => onPerson(selectedCard)}
                onSnooze={() => onSnooze(selectedCard)}
                onSkip={() => advanceFrom(selectedCard.emailId)}
                onDraftChange={(d) => onDraftChange(selectedCard, d)}
              />
            ) : selectedEmail ? (
              <UntriagedState
                triaging={
                  refreshJob.triagingIds.has(selectedEmail.id) ||
                  manualTriagingIds.has(selectedEmail.id)
                }
                onTriage={() => onTriageOne(selectedEmail.id)}
              />
            ) : (
              <OriginalUnavailableState />
            )}
          </>
        ) : showRefreshLog ? (
          <MailRefreshLogState
            progress={refreshJob.progress}
            logs={refreshJob.logs}
            refreshing={refreshJob.refreshing}
            onRefresh={onRefresh}
            onBegin={beginReview}
            onDismiss={refreshJob.dismissLog}
          />
        ) : (
          <MailEmptyState
            lane={lane}
            laneCount={laneRows.length}
            totalCount={emails.length}
            refreshing={refreshJob.refreshing}
            onRefresh={onRefresh}
            onBegin={beginReview}
          />
        )}
      </ContentPanel>
    </>
  );
}

function personTargetFromCard(card: SweepCard): { name: string; email: string } {
  const target = card.actionTarget?.trim() ?? "";
  const targetEmail = extractEmailRecipients(target)[0] ?? "";
  const senderEmail = extractEmailRecipients(card.from)[0] ?? "";
  const email = targetEmail || senderEmail;
  const targetName = stripEmailAddress(target);
  const senderName = stripEmailAddress(card.from);
  const name =
    preferSenderName(targetName) || senderName || email || card.from || "Unknown sender";

  return { name, email };
}

function findExistingPerson(
  people: PersonDto[],
  target: { name: string; email: string },
): PersonDto | undefined {
  const email = target.email.toLowerCase();
  if (email) {
    const byEmail = people.find((person) => person.email.toLowerCase() === email);
    if (byEmail) return byEmail;
  }
  const name = normalizePersonName(target.name);
  if (!name) return undefined;
  return people.find((person) => normalizePersonName(person.name) === name);
}

function personMailNote(card: SweepCard): string {
  const day = new Date().toISOString().slice(0, 10);
  const title = card.headline || card.subject || "Mail follow-up";
  const lines = [`## Mail`, `- ${day}: ${title}`];
  if (card.summary) lines.push(`  - ${card.summary}`);
  if (card.whatHappened) lines.push(`  - ${card.whatHappened}`);
  return lines.join("\n");
}

function appendPersonNote(body: string, note: string): string {
  const trimmed = body.trim();
  return trimmed ? `${trimmed}\n\n${note}` : note;
}

function personDetail(person: PersonDto): string {
  return person.email ? `${person.name} <${person.email}>` : person.name;
}

function stripEmailAddress(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "")
    .replace(/\b(?:person|contact|people|crm|record|sender|from)\b/gi, "")
    .replace(/[()[\]{}"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function preferSenderName(name: string): string {
  if (!name) return "";
  if (/^(?:this|the|that|them|their|email)$/i.test(name)) return "";
  return name;
}

function normalizePersonName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

function MailDetailModeToggle({
  mode,
  canShowEmail,
  onChange,
}: {
  mode: MailDetailMode;
  canShowEmail: boolean;
  onChange: (mode: MailDetailMode) => void;
}) {
  const optionClass = (active: boolean) =>
    active
      ? "bg-[#25231e] text-white shadow-[0_6px_16px_rgba(32,24,10,0.16)] dark:bg-primary dark:text-primary-foreground"
      : "text-muted-foreground hover:bg-[#f1eadf] hover:text-foreground dark:hover:bg-muted";

  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-[#d8d0c1] bg-[#fffdf8] p-1 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] dark:border-border dark:bg-background">
      <button
        type="button"
        onClick={() => onChange("triage")}
        className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${optionClass(mode === "triage")}`}
      >
        <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
        Triage
      </button>
      <button
        type="button"
        onClick={() => onChange("email")}
        disabled={!canShowEmail}
        className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${optionClass(mode === "email")}`}
      >
        <MailOpen className="h-3.5 w-3.5" strokeWidth={1.75} />
        Original
      </button>
    </div>
  );
}

function OriginalUnavailableState() {
  return (
    <div className="py-16 text-center">
      <p className="text-sm text-muted-foreground">
        The original email is no longer in the local inbox.
      </p>
    </div>
  );
}

function MailRefreshLogState({
  progress,
  logs,
  refreshing,
  onRefresh,
  onBegin,
  onDismiss,
}: {
  progress: MailRefreshProgress;
  logs: MailRefreshLogEntry[];
  refreshing: boolean;
  onRefresh: () => void;
  onBegin?: () => void;
  onDismiss: () => void;
}) {
  const panelMinHeight = "calc(100vh - 52px)";
  const done = progress.triaged + progress.failed;
  const remaining =
    progress.pending > 0
      ? Math.max(progress.pending - done, 0)
      : progress.phase === "complete"
        ? 0
        : null;
  const progressPct =
    progress.pending > 0
      ? Math.min(
          100,
          Math.max(Math.round((done / progress.pending) * 100), 10),
        )
      : progress.phase === "complete"
        ? 100
        : progress.phase === "error"
          ? Math.max(progress.loaded > 0 ? 18 : 10, 10)
          : 0;
  const noNewMail =
    progress.phase === "complete" &&
    progress.loaded > 0 &&
    progress.pending === 0 &&
    progress.triaged === 0 &&
    progress.failed === 0;
  const headline =
    noNewMail
      ? "Ready for review."
      : progress.phase === "complete"
      ? "Inbox refresh complete."
      : progress.phase === "error"
        ? "Inbox refresh stopped."
        : "Refreshing inbox.";
  const body =
    progress.phase === "syncing"
      ? "Loading the newest messages before Motif starts triage."
      : progress.phase === "triaging"
        ? "Motif is turning new mail into sweep cards."
        : progress.phase === "error"
          ? (progress.error ?? "Something interrupted the refresh.")
          : noNewMail
            ? `${formatEmailCount(progress.loaded)} checked; ${formatEmailCount(progress.alreadyTriaged)} were already in the sweep.`
          : "The sweep is ready when you are.";

  return (
    <div className="relative overflow-hidden" style={{ minHeight: panelMinHeight }}>
      <div
        className="relative flex items-center justify-center px-10 py-16"
        style={{ minHeight: panelMinHeight }}
      >
        <div className="w-full max-w-3xl">
          <div className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Refresh log
          </div>
          <h1 className="max-w-2xl text-5xl leading-[1.05] text-foreground">
            {headline}
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            {body}
          </p>

          <div className="mt-8 max-w-2xl">
            <RefreshProgressBar
              phase={progress.phase}
              percent={progressPct}
            />
          </div>

          <div className="mt-7 grid max-w-2xl grid-cols-4 gap-2 text-sm">
            <RefreshMetric label="Checked" value={progress.loaded} />
            <RefreshMetric
              label="New"
              value={
                progress.phase === "syncing" ? "..." : progress.pending
              }
            />
            <RefreshMetric label="Triaged" value={progress.triaged} />
            <RefreshMetric
              label="Remaining"
              value={remaining === null ? "..." : remaining}
            />
          </div>

          <div className="mt-8 max-w-2xl rounded-lg border border-border bg-background">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Log
              </div>
              <div className="text-xs tabular-nums text-muted-foreground">
                {progress.phase}
              </div>
            </div>
            <ol className="max-h-56 overflow-auto px-3 py-2">
              {logs.map((entry) => (
                <li
                  key={entry.id}
                  className="grid grid-cols-[4.25rem_0.75rem_1fr] gap-2 py-1.5 text-sm"
                >
                  <time className="pt-0.5 text-xs tabular-nums text-muted-foreground">
                    {formatLogTime(entry.at)}
                  </time>
                  <span
                    className={`mt-2 size-1.5 rounded-full ${logDotClass(
                      entry.tone,
                    )}`}
                  />
                  <span>
                    <span className="text-foreground">{entry.message}</span>
                    {entry.detail && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {entry.detail}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </div>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            {!refreshing && onBegin && (
              <Button
                onClick={onBegin}
                className="h-10 rounded-lg px-4 text-[15px]"
              >
                <MailCheck className="h-4 w-4" strokeWidth={1.75} />
                Begin review
              </Button>
            )}
            <Button
              variant="outline"
              onClick={onRefresh}
              disabled={refreshing}
              title="Sync Gmail, then triage new mail with your configured Hermes agent"
              className="h-10 rounded-lg px-4 text-[15px]"
            >
              <RefreshCw
                className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
                strokeWidth={1.75}
              />
              {refreshing ? "Refreshing & triaging" : "Refresh & triage again"}
            </Button>
            {!refreshing && (
              <Button
                variant="ghost"
                onClick={onDismiss}
                className="h-10 rounded-lg px-4 text-[15px]"
              >
                Clear log
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RefreshProgressBar({
  phase,
  percent,
}: {
  phase: MailRefreshProgress["phase"];
  percent: number;
}) {
  const isSyncing = phase === "syncing";
  const tone =
    phase === "error"
      ? "bg-destructive"
      : phase === "complete"
        ? "bg-emerald-500"
        : "bg-foreground";

  return (
    <div
      className="relative h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={isSyncing ? undefined : percent}
      aria-label="Inbox refresh progress"
    >
      {isSyncing ? (
        <div className="mail-refresh-comet absolute inset-y-0 left-0 w-2/5 rounded-full" />
      ) : (
        <div
          className={`h-full rounded-full ${tone} transition-[width] duration-500 ease-out ${
            phase === "triaging" ? "mail-refresh-streaming" : ""
          }`}
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  );
}

function RefreshMetric({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-medium tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}

function logDotClass(tone: MailRefreshLogEntry["tone"]): string {
  switch (tone) {
    case "success":
      return "bg-emerald-500";
    case "warning":
      return "bg-amber-500";
    case "error":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/55";
  }
}

function formatLogTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatEmailCount(count: number): string {
  return `${count} ${count === 1 ? "email" : "emails"}`;
}

function taskDetail(content: string, command: SweepTaskCommand): string {
  if (command.scheduled && command.dateLabel) {
    return `${content} (${command.dateLabel}, ${command.scheduled})`;
  }
  if (command.scheduled) {
    return `${content} (${command.scheduled})`;
  }
  return content;
}

function resourceDetail(title: string, url: string): string {
  return title ? `${title} (${url})` : url;
}

function taskCommandFromPlannedAction(
  action: SweepPlannedAction,
): SweepTaskCommand {
  const content = cleanPlannedText(action.content);
  const scheduled = cleanScheduledDate(action.scheduled);
  return {
    ...(content ? { content } : {}),
    ...(scheduled ? { scheduled } : {}),
  };
}

function cleanPlannedText(value?: string | null): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 240
    ? `${normalized.slice(0, 239)}…`
    : normalized;
}

function confirmationText(value?: string | null): string | undefined {
  // Confirmation and execution intentionally share one normalization path:
  // the model cannot hide a materially different value past the displayed
  // prefix and then execute the unabridged original.
  return cleanPlannedText(value);
}

function cleanPlannedTags(value?: string[]): string[] {
  if (!value) return [];
  return value
    .map((tag) => confirmationText(tag)?.replace(/^#/, "").slice(0, 80))
    .filter((tag): tag is string => Boolean(tag))
    .slice(0, 20);
}

function cleanScheduledDate(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? trimmed
    : undefined;
}

function UntriagedState({
  triaging,
  onTriage,
}: {
  triaging: boolean;
  onTriage: () => void;
}) {
  return (
    <div className="py-16 text-center">
      <p className="text-sm text-muted-foreground">
        This email hasn&apos;t been triaged yet.
      </p>
      <Button className="mt-3" onClick={onTriage} disabled={triaging}>
        {triaging ? "Triaging…" : "Triage now"}
      </Button>
    </div>
  );
}

function MailEmptyState({
  lane,
  laneCount,
  totalCount,
  refreshing,
  onRefresh,
  onBegin,
}: {
  lane: SweepStatus;
  laneCount: number;
  totalCount: number;
  refreshing: boolean;
  onRefresh: () => void;
  onBegin?: () => void;
}) {
  const label = SHORT_LANE_LABEL[lane];
  const hasCurrentLane = laneCount > 0;
  const headline = hasCurrentLane
    ? "Ready to review."
    : totalCount > 0
      ? "This lane is quiet."
      : "No local mail yet.";
  const body = hasCurrentLane
    ? `${laneCount} waiting in ${label}.`
    : totalCount > 0
      ? "Switch lanes or refresh when you are ready."
      : "Refresh when you want Motif to gather what needs attention.";
  // An envelope mark — a calm sealed envelope when the lane is empty, an
  // open one when there's mail ready or none gathered yet.
  const Icon = totalCount > 0 && !hasCurrentLane ? Mail : MailOpen;
  const panelMinHeight = "calc(100vh - 52px)";

  return (
    <div
      className="relative overflow-hidden"
      style={{ minHeight: panelMinHeight }}
    >
      <div
        className="relative flex items-center justify-center px-10 py-12"
        style={{ minHeight: panelMinHeight }}
      >
        <div className="flex w-full max-w-md flex-col items-center text-center">
          <div className="agent-msg-in mb-5 inline-flex size-12 items-center justify-center rounded-[15px] border border-border/70 bg-gradient-to-b from-muted/60 to-muted/25 text-foreground/70 shadow-sm dark:from-muted/40 dark:to-muted/10">
            <Icon className="size-6" strokeWidth={1.6} />
          </div>
          <h1 className="font-serif text-[26px] leading-tight tracking-tight text-foreground">
            {headline}
          </h1>
          <p className="mt-2 max-w-sm text-[13.5px] leading-relaxed text-muted-foreground">
            {body}
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {onBegin && (
              <Button
                onClick={onBegin}
                className="h-9 rounded-md px-3 text-sm"
              >
                <MailCheck className="h-4 w-4" strokeWidth={1.75} />
                Begin review
              </Button>
            )}
            <Button
              variant="outline"
              onClick={onRefresh}
              disabled={refreshing}
              title="Sync Gmail, then triage new mail with your configured Hermes agent"
              className="h-9 rounded-md px-3 text-sm"
            >
              <RefreshCw
                className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
                strokeWidth={1.75}
              />
              {refreshing ? "Refreshing & triaging" : "Refresh & triage"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

const SHORT_LANE_LABEL: Record<SweepStatus, string> = {
  to_review: "Review",
  queued: "Queued",
  working: "Working",
  done: "Done",
};

function shouldPlanSweepActions(instruction: string): boolean {
  const normalized = instruction.toLocaleLowerCase();
  const hasResourceSignal =
    /\b(?:resource|url|link|article|essay)\b/.test(normalized);
  const hasTaskSignal =
    /\b(?:task|tast|remind|reminder|reminded|reminding)\b/.test(normalized);
  const hasArchiveSignal =
    /\b(?:archive|archived|acrhive|achive)\b/.test(normalized);
  const hasTypoSignal = /\b(?:tast|acrhive|achive)\b/.test(normalized);
  const actionCount = [
    hasResourceSignal,
    hasTaskSignal,
    hasArchiveSignal,
  ].filter(Boolean).length;

  return hasResourceSignal || hasTypoSignal || actionCount > 1;
}

function normalizePlannedActionKind(kind: string): SweepPlannedAction["kind"] {
  const normalized = kind.trim().toLocaleLowerCase().replace(/-/g, "_");
  if (normalized === "resource") return "create_resource";
  if (normalized === "task") return "create_task";
  if (normalized === "archive") return "archive_email";
  return normalized;
}

function isArchiveInstruction(instruction: string): boolean {
  const normalized = instruction.toLocaleLowerCase();
  if (/\b(?:do not|don't|dont|not)\s+archive\b/.test(normalized)) {
    return false;
  }
  return normalized
    .split(/[^a-z0-9]+/)
    .some((word) => word === "archive" || word === "archived");
}

function cardWithTimelineEvents(
  card: SweepCard,
  status: SweepStatus,
  events: Array<{ actor: string; action: string; detail?: string | null }>,
): SweepCard {
  const at = new Date().toISOString();
  return {
    ...card,
    status,
    updated: at,
    timeline: [
      ...card.timeline,
      ...events.map((event) => ({
        at,
        actor: event.actor,
        action: event.action,
        detail: event.detail ?? null,
      })),
    ],
  };
}
