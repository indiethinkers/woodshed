import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useChat } from "@ai-sdk/react";
import type {
  ChatAddToolApproveResponseFunction,
  ChatStatus,
  FileUIPart,
  UIMessage,
} from "ai";
import {
  ArrowUp,
  Bot,
  CheckCircle2,
  ChevronDown,
  Circle,
  Copy,
  FileText,
  History,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Settings,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { nanoid } from "nanoid";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from "@/components/ai-elements/artifact";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  Checkpoint,
  CheckpointIcon,
  CheckpointTrigger,
} from "@/components/ai-elements/checkpoint";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationCarousel,
  InlineCitationCarouselContent,
  InlineCitationCarouselHeader,
  InlineCitationCarouselIndex,
  InlineCitationCarouselItem,
  InlineCitationCarouselNext,
  InlineCitationCarouselPrev,
  InlineCitationQuote,
  InlineCitationSource,
  InlineCitationText,
} from "@/components/ai-elements/inline-citation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@/components/ai-elements/sources";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Markdown } from "@/components/shared/markdown";
import {
  ListSidebarPrimaryAction,
  ListSidebarSectionHeader,
} from "@/components/shared/list-sidebar";
import {
  PromptInput,
  PromptInputButton,
  PromptInputHeader,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputAttachments,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ListPanel } from "@/components/layout/list-panel";
import {
  agentToolDescriptor,
  messageTextFromMessage,
  toolNameFromPart,
  toolPartsFromMessage,
  toolStatusFromPart,
  type AgentToolPart,
} from "@/lib/agent/message-parts";
import {
  attachmentContextFromFiles,
  attachmentLabel,
  parsePersistedAttachmentContext,
} from "@/lib/agent/attachment-context";
import {
  type AgentRun,
  createAgentChatTransport,
} from "@/lib/agent/transport";
import {
  captureAgentPageContext,
  formatAgentPageContext,
  formatAgentVaultContext,
} from "@/lib/agent/page-context";
import { isEditableElement } from "@/lib/dom/is-editable";
import { useToday } from "@/lib/hooks/use-today";
import { useVaultPath } from "@/lib/hooks/use-vault-path";
import { cn } from "@/lib/utils";
import { tauriInvoke } from "@/lib/tauri";

interface AgentConfig {
  displayName: string;
  baseUrl: string;
  model: string;
  sessionKey: string;
  hasApiKey: boolean;
}

const LAST_AGENT_CHAT_STORAGE_KEY = "woodshed:agent:last-chat-id";
const RECENT_AGENT_CHAT_WINDOW_MS = 5 * 60 * 1000;
const AGENT_AREA_REFERENCE_LABELS: Record<string, string> = {
  woodshed: "Woodshed",
  "indie-thinkers": "Indie Thinkers",
  "tech-twitter": "Tech Twitter",
  "post-in-black": "Post In Black",
  personal: "Personal",
};
const AGENT_AREA_REFERENCE_RE = new RegExp(
  `([—-]\\s+)(${Object.keys(AGENT_AREA_REFERENCE_LABELS)
    .map(escapeRegExp)
    .join("|")})(?=$|[.,;:!?)\\]]|\\s+[—-])`,
  "gi",
);
const AGENT_AREA_LABEL_PATTERN = Object.values(AGENT_AREA_REFERENCE_LABELS)
  .map(escapeRegExp)
  .join("|");
const AREA_QUALIFIED_ENTRY_RE = new RegExp(
  `\\s+[—-]\\s+(${AGENT_AREA_LABEL_PATTERN})(?=$|\\s+[A-Z0-9"“'])`,
  "g",
);
const AGENT_LIST_LINE_RE =
  /^(new tasks|tasks|action items|next steps|follow-ups|recommendations):\s+(.+)$/i;
const AGENT_ARTIFACT_HEADER_RE =
  /^(new tasks|tasks|action items|next steps|follow-ups|recommendations):$/i;

interface AgentVaultMessage {
  id: string;
  role: "system" | "user" | "assistant";
  createdAt: string;
  content: string;
}

interface AgentChatContext {
  title: string;
  route: string;
}

interface AgentChatRecord {
  id: string;
  path: string;
  title: string;
  agent: string;
  model: string;
  created: string;
  updated: string;
  pinned: boolean;
  tags: string[];
  context?: AgentChatContext | null;
  messages: AgentVaultMessage[];
}

interface AgentChatSummary {
  id: string;
  path: string;
  title: string;
  agent: string;
  model: string;
  created: string;
  updated: string;
  lastMessageCreated?: string | null;
  pinned: boolean;
  messageCount: number;
  preview: string;
  context?: AgentChatContext | null;
}

interface PendingAgentSend {
  text: string;
  files: FileUIPart[];
}

interface AgentSurfaceProps {
  variant?: "page" | "sidebar";
  contextPathname?: string;
  contextTitle?: string;
}

export function AgentSurface(props: AgentSurfaceProps = {}) {
  return <AgentSurfaceInner {...props} />;
}

function AgentSurfaceInner({
  variant = "page",
  contextPathname = "/",
  contextTitle = "Woodshed",
}: AgentSurfaceProps) {
  const pageMode = variant === "page";
  const navigate = useNavigate();
  const today = useToday();
  const { data: vaultRoot } = useVaultPath();
  const href = useRouterState({ select: (s) => s.location.href });
  const urlChatId = useMemo(() => {
    if (!pageMode) return null;
    try {
      return new URL(href, "http://woodshed.local").searchParams.get("chat");
    } catch {
      return null;
    }
  }, [href, pageMode]);

  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [chats, setChats] = useState<AgentChatSummary[]>([]);
  const [activeChat, setActiveChat] = useState<AgentChatRecord | null>(null);
  const [activeId, setActiveId] = useState<string | null>(urlChatId);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingSend, setPendingSend] = useState<PendingAgentSend | null>(null);
  const hydratingRef = useRef(false);
  const messageTimesRef = useRef<Map<string, string>>(new Map());
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const pageContextRef = useRef({
    pathname: contextPathname,
    title: contextTitle,
    vaultRoot: vaultRoot ?? null,
  });
  pageContextRef.current = {
    pathname: contextPathname,
    title: contextTitle,
    vaultRoot: vaultRoot ?? null,
  };

  const transport = useMemo(
    () =>
      createAgentChatTransport({
        getSystemContext: () => {
          const context = pageContextRef.current;
          // The full Agent view has no open record (the panel is the chat), so
          // hand over the vault root and let the agent find files itself. The
          // sidebar agent names the record the user is looking at.
          if (pageMode) {
            return formatAgentVaultContext({ vaultRoot: context.vaultRoot });
          }
          return formatAgentPageContext(
            captureAgentPageContext(context.pathname, context.title),
            { vaultRoot: context.vaultRoot },
          );
        },
        onRunChange: (run) => {
          if (!run || run.conversationId === activeIdRef.current) {
            setActiveRun(run);
          }
        },
      }),
    [pageMode],
  );
  const { textInput } = usePromptInputController();
  const {
    addToolApprovalResponse,
    messages,
    sendMessage,
    regenerate,
    setMessages,
    status,
    stop,
    resumeStream,
    error,
  } = useChat({
    id: activeId ?? "agent-draft",
    messages: [],
    transport,
    onError(error) {
      setLastError(error.message);
    },
  });
  const messagesRef = useRef<UIMessage[]>(messages);
  messagesRef.current = messages;

  const displayName = config?.displayName?.trim() || activeChat?.agent || "Agent";
  // `config` is null until agent_config_get resolves. Until then we don't know
  // whether the agent is configured, so config-dependent composer chrome (the
  // disabled textarea, the "connect in settings" helper, the dimmed send
  // button) must not render — otherwise it flashes the not-configured state
  // and the input visibly shifts when the real config lands.
  const configResolved = config !== null;
  const configured = Boolean(config?.hasApiKey);
  const runActive =
    activeRun?.status === "queued" || activeRun?.status === "running";
  const effectiveStatus: ChatStatus =
    runActive && status === "ready" ? "submitted" : status;
  const busy =
    effectiveStatus === "submitted" || effectiveStatus === "streaming";
  const canSubmit = configured && !busy;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [nextConfig, summaries] = await Promise.all([
          tauriInvoke<AgentConfig>("agent_config_get"),
          tauriInvoke<AgentChatSummary[]>("agent_chats_all"),
        ]);
        if (cancelled) return;
        setConfig(nextConfig);
        const nextSummaries = sortChatsByDate(summaries ?? []);
        setChats(nextSummaries);
        const restoredChatId =
          urlChatId ?? readRecentAgentChatId(nextSummaries);
        setActiveId(restoredChatId);
        if (pageMode && !urlChatId && restoredChatId) {
          void navigate({
            href: `/agent?chat=${encodeURIComponent(restoredChatId)}`,
            replace: true,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setLastError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [navigate, pageMode, urlChatId]);

  useEffect(() => {
    if (pageMode && urlChatId && urlChatId !== activeId) {
      setActiveId(urlChatId);
    }
  }, [activeId, pageMode, urlChatId]);

  useEffect(() => {
    if (!activeId) {
      setActiveRun(null);
      setActiveChat(null);
      messageTimesRef.current = new Map();
      setMessages([]);
      return;
    }
    if (activeChat?.id === activeId) return;
    let cancelled = false;
    setActiveRun(null);
    hydratingRef.current = true;
    tauriInvoke<AgentChatRecord>("agent_chat_get", { id: activeId })
      .then((chat) => {
        if (cancelled) return;
        if (!chat) {
          forgetRecentAgentChatId(activeId);
          setActiveId(null);
          if (pageMode) {
            void navigate({ href: "/agent", replace: true });
          }
          return;
        }
        setActiveChat(chat);
        messageTimesRef.current = new Map(
          chat.messages.map((message) => [message.id, message.createdAt]),
        );
        const nextMessages = toUiMessages(chat.messages);
        setMessages(nextMessages);
        void resumeStream().catch((error) => {
          if (!cancelled) {
            setLastError(error instanceof Error ? error.message : String(error));
          }
        });
      })
      .catch((error) => {
        if (!cancelled) {
          setLastError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        window.requestAnimationFrame(() => {
          hydratingRef.current = false;
        });
      });
    return () => {
      cancelled = true;
    };
  }, [activeChat?.id, activeId, navigate, pageMode, resumeStream, setMessages]);

  useEffect(() => {
    if (!pendingSend || !activeId || hydratingRef.current) return;
    sendMessage({ files: pendingSend.files, text: pendingSend.text });
    textInput.clear();
    setPendingSend(null);
  }, [activeId, pendingSend, sendMessage, textInput]);

  useEffect(() => {
    if (error) setLastError(error.message);
  }, [error]);

  useEffect(() => {
    if (!activeRun || activeRun.status === "queued" || activeRun.status === "running") {
      return;
    }
    let cancelled = false;
    tauriInvoke<AgentChatRecord>("agent_chat_get", {
      id: activeRun.conversationId,
    })
      .then((chat) => {
        if (cancelled || !chat || chat.id !== activeIdRef.current) return;
        setActiveChat(chat);
        setChats((current) => upsertSummary(current, recordToSummary(chat)));
        if (
          activeRun.status === "completed" &&
          status === "ready" &&
          !messagesRef.current.some(
            (message) => message.id === activeRun.assistantMessageId,
          )
        ) {
          messageTimesRef.current = new Map(
            chat.messages.map((message) => [message.id, message.createdAt]),
          );
          setMessages(toUiMessages(chat.messages));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLastError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeRun, setMessages, status]);

  async function saveActiveChat(
    chat: AgentChatRecord,
    vaultMessages: AgentVaultMessage[],
  ) {
    try {
      const next = await tauriInvoke<AgentChatRecord>("agent_chat_update", {
        input: {
          id: chat.id,
          title: chat.title,
          agent: displayName,
          model: config?.model ?? chat.model,
          pinned: chat.pinned,
          messages: vaultMessages,
        },
      });
      if (!next) return;
      setActiveChat(next);
      setChats((current) => upsertSummary(current, recordToSummary(next)));
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }

  async function startNewChat() {
    setLastError(null);
    setActiveRun(null);
    forgetRecentAgentChatId();
    setActiveId(null);
    setActiveChat(null);
    setMessages([]);
    if (pageMode) void navigate({ href: "/agent" });
  }

  // ⌘N (Ctrl+N) starts a new chat anywhere on the agent page. A ref keeps
  // the listener stable so it doesn't rebind on every streaming re-render.
  const startNewChatRef = useRef(startNewChat);
  startNewChatRef.current = startNewChat;
  useEffect(() => {
    if (!pageMode) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) {
        return;
      }
      if (event.key !== "n" && event.key !== "N") return;
      event.preventDefault();
      void startNewChatRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pageMode]);

  function restoreCheckpoint(messageIndex: number) {
    setLastError(null);
    setMessages((current) => {
      const next = current.slice(0, messageIndex + 1);
      const nextIds = new Set(next.map((message) => message.id));
      messageTimesRef.current = new Map(
        [...messageTimesRef.current].filter(([id]) => nextIds.has(id)),
      );
      if (activeChat) {
        void saveActiveChat(
          activeChat,
          toVaultMessages(next, messageTimesRef.current),
        );
      }
      return next;
    });
  }

  function selectChat(id: string) {
    setLastError(null);
    setActiveRun(null);
    rememberRecentAgentChatId(id);
    if (pageMode) {
      void navigate({ href: `/agent?chat=${id}` });
      return;
    }
    setActiveId(id);
  }

  async function togglePinned(chat: AgentChatSummary) {
    try {
      const record =
        activeChat?.id === chat.id
          ? activeChat
          : await tauriInvoke<AgentChatRecord>("agent_chat_get", { id: chat.id });
      if (!record) return;
      const nextPinned = !chat.pinned;
      const next = await tauriInvoke<AgentChatRecord>("agent_chat_update", {
        input: {
          id: record.id,
          title: record.title,
          agent: record.agent,
          model: record.model,
          pinned: nextPinned,
          messages: record.messages,
        },
      });
      if (!next) return;
      if (activeChat?.id === next.id) {
        setActiveChat(next);
      }
      setChats((current) => upsertSummary(current, recordToSummary(next)));
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }

  async function renameChat(chat: AgentChatSummary, title: string) {
    const nextTitle = title.trim();
    if (!nextTitle || nextTitle === chat.title) return;
    // Optimistically retitle so the row updates the instant the edit commits;
    // the server round-trip reconciles below. Keep activeChat in sync too —
    // the autosave effect reads its title, so a stale title here would revert
    // the rename on the next message.
    setChats((current) =>
      sortChatsByDate(
        current.map((entry) =>
          entry.id === chat.id ? { ...entry, title: nextTitle } : entry,
        ),
      ),
    );
    if (activeChat?.id === chat.id) {
      setActiveChat((current) =>
        current ? { ...current, title: nextTitle } : current,
      );
    }
    try {
      const record =
        activeChat?.id === chat.id
          ? activeChat
          : await tauriInvoke<AgentChatRecord>("agent_chat_get", { id: chat.id });
      if (!record) return;
      const next = await tauriInvoke<AgentChatRecord>("agent_chat_update", {
        input: {
          id: record.id,
          title: nextTitle,
          agent: record.agent,
          model: record.model,
          pinned: record.pinned,
          messages: record.messages,
        },
      });
      if (!next) return;
      if (activeChat?.id === next.id) {
        setActiveChat(next);
      }
      setChats((current) => upsertSummary(current, recordToSummary(next)));
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }

  async function deleteChat(chat: AgentChatSummary) {
    // Optimistically drop the row; if it was the open chat, fall back to the
    // empty new-chat state. The file delete reconciles below.
    setChats((current) => current.filter((entry) => entry.id !== chat.id));
    forgetRecentAgentChatId(chat.id);
    if (activeId === chat.id) {
      setActiveId(null);
      setActiveChat(null);
      setMessages([]);
      if (pageMode) void navigate({ href: "/agent" });
    }
    try {
      await tauriInvoke("agent_chat_delete", { id: chat.id });
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }

  function handleSubmit(message: PromptInputMessage) {
    const text = message.text.trim();
    if ((!text && message.files.length === 0) || !canSubmit) return;
    setLastError(null);
    if (!activeId) {
      void createChatAndSend(text, message.files, message.text.trim());
      return;
    }
    rememberRecentAgentChatId(activeId);
    sendMessage({ files: message.files, text });
    textInput.clear();
  }

  function cancelRun() {
    const run = activeRun;
    if (run && (run.status === "queued" || run.status === "running")) {
      void tauriInvoke<AgentRun>("agent_run_cancel", { runId: run.id })
        .then((cancelled) => {
          if (cancelled && cancelled.conversationId === activeIdRef.current) {
            setActiveRun(cancelled);
          }
        })
        .catch((error) => {
          setLastError(error instanceof Error ? error.message : String(error));
        });
    }
    stop();
  }

  function retryRun() {
    setLastError(null);
    void regenerate().catch((error) => {
      setLastError(error instanceof Error ? error.message : String(error));
    });
  }

  async function createChatAndSend(
    text: string,
    files: FileUIPart[],
    titleText: string,
  ) {
    try {
      // Sidebar chats are started from a specific page; persist that page's
      // label + route so the full Agent view can show what's attached as
      // context. Page mode has no attached page, so context stays null.
      const context = pageMode
        ? null
        : {
            title: pageContextRef.current.title,
            route: canonicalAgentRoute(pageContextRef.current.pathname, today),
          };
      const created = await tauriInvoke<AgentChatRecord>("agent_chat_create", {
        input: {
          title: titleFromText(titleText || attachmentTitleFromFiles(files)),
          context,
        },
      });
      if (!created) return;
      setChats((current) => upsertSummary(current, recordToSummary(created)));
      setActiveChat(created);
      setActiveId(created.id);
      rememberRecentAgentChatId(created.id);
      setPendingSend({ files, text });
      if (pageMode) void navigate({ href: `/agent?chat=${created.id}` });
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }

  // Sidebar chats are pinned to the page they were started from (context.route).
  // Surface that page's history in the header dropdown so a prior conversation
  // for this page is one click away instead of buried in the full Agent view.
  const sidebarPageChats = useMemo(
    () =>
      pageMode
        ? []
        : sortChatsByDate(
            chats.filter(
              (chat) =>
                chat.context?.route ===
                canonicalAgentRoute(contextPathname, today),
            ),
          ),
    [chats, contextPathname, pageMode, today],
  );

  return (
    <>
      {pageMode && (
        <ListPanel>
          <AgentConversationList
            activeId={activeId}
            chats={chats}
            loading={loading}
            onDelete={deleteChat}
            onNewChat={startNewChat}
            onRename={renameChat}
            onSelect={selectChat}
            onTogglePinned={togglePinned}
          />
        </ListPanel>
      )}
      <section
        className={cn(
          "relative isolate flex min-w-0 flex-1 flex-col text-foreground",
          pageMode ? "bg-content" : "h-full bg-list",
        )}
      >
        {/* isolate makes this section a stacking context so the -z-10 texture
            layer paints above bg-content (not behind it) but below the messages. */}
        <div
          aria-hidden
          className="wd-agent-canvas pointer-events-none absolute inset-0 -z-10"
        />
        {pageMode ? (
          <AgentHeader
            configResolved={configResolved}
            configured={configured}
            context={activeChat?.context}
            displayName={displayName}
            status={effectiveStatus}
          />
        ) : (
          <AgentSidebarHeader
            activeId={activeId}
            contextTitle={contextTitle}
            displayName={displayName}
            onNewChat={startNewChat}
            onSelectChat={selectChat}
            pageChats={sidebarPageChats}
          />
        )}
        {activeRun && (
          <AgentRunBanner
            onRetry={configured ? retryRun : undefined}
            run={activeRun}
          />
        )}
        {messages.length === 0 ? (
          <AgentEmptyState
            canSubmit={canSubmit}
            configResolved={configResolved}
            configured={configured}
            displayName={displayName}
            lastError={lastError}
            compact={!pageMode}
            contextTitle={contextTitle}
            onSubmit={handleSubmit}
            status={effectiveStatus}
            stop={cancelRun}
          />
        ) : (
          <AgentConversationView
            onRestoreCheckpoint={restoreCheckpoint}
            canSubmit={canSubmit}
            configResolved={configResolved}
            configured={configured}
            displayName={displayName}
            lastError={lastError}
            messages={messages}
            compact={!pageMode}
            onSubmit={handleSubmit}
            onToolApprovalResponse={addToolApprovalResponse}
            status={effectiveStatus}
            stop={cancelRun}
          />
        )}
      </section>
    </>
  );
}

function AgentConversationList({
  activeId,
  chats,
  loading,
  onDelete,
  onNewChat,
  onRename,
  onSelect,
  onTogglePinned,
}: {
  activeId: string | null;
  chats: AgentChatSummary[];
  loading: boolean;
  onDelete: (chat: AgentChatSummary) => void;
  onNewChat: () => void;
  onRename: (chat: AgentChatSummary, title: string) => void;
  onSelect: (id: string) => void;
  onTogglePinned: (chat: AgentChatSummary) => void;
}) {
  const sortedChats = useMemo(() => sortChatsByDate(chats), [chats]);
  const pinnedChats = sortedChats.filter((chat) => chat.pinned);
  const recentChats = sortedChats.filter((chat) => !chat.pinned);
  return (
    <div className="flex min-h-full flex-col px-4 py-4">
      <ListSidebarPrimaryAction label="New chat" onClick={onNewChat} />
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="px-1 text-sm text-muted-foreground">Loading...</div>
        ) : chats.length === 0 ? (
          <div className="px-1 text-sm text-muted-foreground">No chats yet.</div>
        ) : (
          <div className="space-y-4">
            {pinnedChats.length > 0 && (
              <AgentConversationSection
                activeId={activeId}
                chats={pinnedChats}
                label="Pinned"
                onDelete={onDelete}
                onRename={onRename}
                onSelect={onSelect}
                onTogglePinned={onTogglePinned}
              />
            )}
            {recentChats.length > 0 && (
              <AgentConversationSection
                activeId={activeId}
                chats={recentChats}
                label="Recents"
                onDelete={onDelete}
                onRename={onRename}
                onSelect={onSelect}
                onTogglePinned={onTogglePinned}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentConversationSection({
  activeId,
  chats,
  label,
  onDelete,
  onRename,
  onSelect,
  onTogglePinned,
}: {
  activeId: string | null;
  chats: AgentChatSummary[];
  label: string;
  onDelete: (chat: AgentChatSummary) => void;
  onRename: (chat: AgentChatSummary, title: string) => void;
  onSelect: (id: string) => void;
  onTogglePinned: (chat: AgentChatSummary) => void;
}) {
  return (
    <section>
      <ListSidebarSectionHeader label={label} count={chats.length} />
      <div className="space-y-px">
        {chats.map((chat) => (
          <AgentConversationRow
            active={chat.id === activeId}
            chat={chat}
            key={chat.id}
            onDelete={onDelete}
            onRename={onRename}
            onSelect={onSelect}
            onTogglePinned={onTogglePinned}
          />
        ))}
      </div>
    </section>
  );
}

function AgentConversationRow({
  active,
  chat,
  onDelete,
  onRename,
  onSelect,
  onTogglePinned,
}: {
  active: boolean;
  chat: AgentChatSummary;
  onDelete: (chat: AgentChatSummary) => void;
  onRename: (chat: AgentChatSummary, title: string) => void;
  onSelect: (id: string) => void;
  onTogglePinned: (chat: AgentChatSummary) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chat.title);
  // Two-step delete confirm lives inside the menu; reset when it closes.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Escape cancels without saving; commit() runs on blur, so flag the abort
  // here and let the single blur path read it.
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    // Defer focus past Base UI restoring focus to the menu trigger on close.
    const frame = window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editing]);

  function startRename() {
    setDraft(chat.title);
    cancelRef.current = false;
    setEditing(true);
  }

  function commit() {
    setEditing(false);
    if (cancelRef.current) {
      cancelRef.current = false;
      return;
    }
    onRename(chat, draft);
  }

  if (editing) {
    return (
      <div className="flex h-7 min-w-0 items-center gap-2.5 rounded-lg bg-muted px-1.5 text-[13px]">
        <Circle
          className="size-2 shrink-0 text-muted-foreground/40"
          strokeWidth={2}
        />
        <input
          className="min-w-0 flex-1 truncate bg-transparent text-foreground outline-none"
          onBlur={commit}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              inputRef.current?.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelRef.current = true;
              inputRef.current?.blur();
            }
          }}
          ref={inputRef}
          value={draft}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group relative flex h-7 min-w-0 items-center rounded-lg text-[13px] transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-foreground/75 hover:bg-muted/50 hover:text-foreground",
      )}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-1 pl-1.5 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-foreground/20"
        onClick={() => onSelect(chat.id)}
        onDoubleClick={startRename}
        title={chat.title}
        type="button"
      >
        <Circle
          className="size-2 shrink-0 text-muted-foreground/40"
          strokeWidth={2}
        />
        <span className="min-w-0 flex-1 truncate">{chat.title}</span>
      </button>
      {/* Overlaid (not in flow) so the title can use the row's full width and
          only truncate at the real edge; fades in over a scrim on hover/open. */}
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) setConfirmingDelete(false);
        }}
      >
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center bg-gradient-to-l from-list from-60% to-transparent pl-10 pr-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100">
        <DropdownMenuTrigger
          aria-label={`Actions for ${chat.title}`}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-background/70 hover:text-foreground data-[popup-open]:bg-background/70 data-[popup-open]:text-foreground"
        >
          <MoreHorizontal className="size-4" strokeWidth={1.8} />
        </DropdownMenuTrigger>
        </div>
        <DropdownMenuContent align="end" className="min-w-36" sideOffset={4}>
          <DropdownMenuItem
            className="cursor-pointer gap-2 text-[14px]"
            onClick={startRename}
          >
            <Pencil className="size-3.5" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer gap-2 text-[14px]"
            onClick={() => onTogglePinned(chat)}
          >
            <Pin
              className="size-3.5"
              fill={chat.pinned ? "currentColor" : "none"}
            />
            {chat.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          {confirmingDelete ? (
            <DropdownMenuItem
              className="cursor-pointer gap-2 text-[14px] text-destructive focus:text-destructive"
              onClick={() => onDelete(chat)}
            >
              <Trash2 className="size-3.5" />
              Yes, delete
            </DropdownMenuItem>
          ) : (
            // closeOnClick={false}: Base UI Menu closes on click even when the
            // handler preventDefaults, which would reset confirmingDelete via
            // onOpenChange. Keep the menu open across the confirm step.
            <DropdownMenuItem
              closeOnClick={false}
              className="cursor-pointer gap-2 text-[14px] text-destructive focus:text-destructive"
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 className="size-3.5" />
              Delete…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function AgentHeader({
  configResolved,
  configured,
  context,
  displayName,
  status,
}: {
  configResolved: boolean;
  configured: boolean;
  context?: AgentChatContext | null;
  displayName: string;
  status: ChatStatus;
}) {
  const busy = status === "submitted" || status === "streaming";
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-6">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="shrink-0 text-[15px] font-semibold leading-none tracking-tight">
          {displayName}
        </div>
        {context?.title && (
          // The page this chat was started from (sidebar mode). A link back to
          // it — clicking returns to the source page.
          <Link
            to={context.route}
            className="flex min-w-0 items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            title={`Attached page: ${context.title}`}
          >
            <FileText className="size-3 shrink-0" />
            <span className="truncate">{context.title}</span>
          </Link>
        )}
      </div>
      <div className="flex items-center gap-2">
        {/* Hold the status pill until config resolves so it doesn't flash
            "Setup needed" → "Ready" on every navigation to the page. */}
        {configResolved && (
          <div
            className={cn(
              "hidden items-center gap-1.5 rounded-full border px-2 py-1 text-xs sm:flex",
              configured
                ? "border-[#9fcdb8] bg-[#f4fbf7] text-[#116342] dark:border-[#245940] dark:bg-[#13231b] dark:text-[#8fd3ad]"
                : "border-border bg-muted text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                busy ? "bg-[#c46a3a]" : configured ? "bg-[#14845f]" : "bg-muted-foreground",
              )}
            />
            {busy ? "Working" : configured ? "Ready" : "Setup needed"}
          </div>
        )}
        <Button
          nativeButton={false}
          render={<Link to="/settings/agent" />}
          size="sm"
          variant="outline"
        >
          <Settings className="size-3.5" />
          Settings
        </Button>
      </div>
    </header>
  );
}

function AgentSidebarHeader({
  activeId,
  contextTitle,
  displayName,
  onNewChat,
  onSelectChat,
  pageChats,
}: {
  activeId: string | null;
  contextTitle: string;
  displayName: string;
  onNewChat: () => void;
  onSelectChat: (id: string) => void;
  pageChats: AgentChatSummary[];
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border/70 px-4">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold leading-4">
          {displayName}
        </div>
        <div className="truncate text-[11px] leading-4 text-muted-foreground">
          {contextTitle}
        </div>
      </div>
      {pageChats.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Previous chats for this page"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground data-[popup-open]:bg-foreground/[0.06] data-[popup-open]:text-foreground"
            title="Previous chats for this page"
          >
            <History className="size-4" strokeWidth={1.8} />
          </DropdownMenuTrigger>
          {/* align="start" so the menu opens rightward from the trigger (over
              the main content), never leftward over the outer nav rail. */}
          <DropdownMenuContent align="start" className="w-[268px] p-1.5" sideOffset={6}>
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex items-center justify-between px-1.5 pb-1.5 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
                <span>Chats on this page</span>
                <span className="tabular-nums">{pageChats.length}</span>
              </DropdownMenuLabel>
              <div className="space-y-0.5">
                {pageChats.map((chat) => {
                  const active = chat.id === activeId;
                  return (
                    <DropdownMenuItem
                      className={cn(
                        "cursor-pointer flex-col items-stretch gap-0.5 rounded-md px-2 py-1.5",
                        active && "bg-muted/60",
                      )}
                      key={chat.id}
                      onClick={() => onSelectChat(chat.id)}
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        {chat.pinned && (
                          <Pin
                            className="size-3 shrink-0 text-muted-foreground/70"
                            fill="currentColor"
                          />
                        )}
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-[13px] leading-5",
                            active
                              ? "font-medium text-foreground"
                              : "text-foreground/85",
                          )}
                        >
                          {chat.title}
                        </span>
                        {active && (
                          <span
                            aria-hidden
                            className="size-1.5 shrink-0 rounded-full bg-foreground/55"
                          />
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground/65">
                        <span className="tabular-nums">
                          {formatChatTimestamp(
                            chat.lastMessageCreated ?? chat.updated,
                          )}
                        </span>
                        <span aria-hidden className="text-muted-foreground/35">
                          ·
                        </span>
                        <span className="tabular-nums">
                          {messageCountLabel(chat.messageCount)}
                        </span>
                      </div>
                    </DropdownMenuItem>
                  );
                })}
              </div>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <button
        aria-label="New chat"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        onClick={onNewChat}
        title="New chat"
        type="button"
      >
        <SquarePen className="size-4" strokeWidth={1.8} />
      </button>
    </header>
  );
}

export function AgentRunBanner({
  onRetry,
  run,
}: {
  onRetry?: () => void;
  run: AgentRun;
}) {
  const active = run.status === "queued" || run.status === "running";
  const label =
    run.status === "queued"
      ? "Queued"
      : run.status === "running"
        ? "Running in the background"
        : run.status === "completed"
          ? "Completed"
          : run.status === "cancelled"
            ? "Cancelled"
            : "Failed";
  return (
    <div
      aria-live="polite"
      className={cn(
        "flex min-h-8 shrink-0 items-center gap-2 border-b border-border/50 px-6 text-[12px]",
        run.status === "failed"
          ? "bg-destructive/5 text-destructive"
          : "bg-muted/20 text-muted-foreground",
      )}
    >
      {run.status === "completed" ? (
        <CheckCircle2 className="size-3.5" />
      ) : run.status === "failed" || run.status === "cancelled" ? (
        <X className="size-3.5" />
      ) : (
        <Circle
          className={cn("size-2.5", active && "animate-pulse")}
          fill="currentColor"
        />
      )}
      <span className="font-medium text-foreground/80">{label}</span>
      {run.status === "failed" && run.error && (
        <span className="min-w-0 truncate">{run.error}</span>
      )}
      {run.status === "failed" && onRetry && (
        <button
          className="ml-auto shrink-0 rounded-md px-2 py-1 font-medium text-foreground transition-colors hover:bg-muted"
          onClick={onRetry}
          type="button"
        >
          Retry
        </button>
      )}
    </div>
  );
}

function AgentEmptyState({
  canSubmit,
  compact = false,
  configResolved,
  configured,
  contextTitle,
  displayName,
  lastError,
  onSubmit,
  status,
  stop,
}: {
  canSubmit: boolean;
  compact?: boolean;
  configResolved: boolean;
  configured: boolean;
  contextTitle?: string;
  displayName: string;
  lastError: string | null;
  onSubmit: (message: PromptInputMessage) => void;
  status: ChatStatus;
  stop: () => void;
}) {
  // New session: a quiet branded canvas (Cadence mark + serif wordmark)
  // fills the void, with the composer kept pinned to the bottom so the
  // switch from empty → active conversation stays seamless.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "flex flex-1 flex-col items-center justify-center text-center",
          compact ? "gap-3 px-5" : "gap-4 px-6",
        )}
      >
        {!compact && (
          <CadenceAvatar className="agent-msg-in" size="lg" />
        )}
        <div className="agent-msg-in space-y-1.5">
          <h1
            className={cn(
              "leading-tight tracking-tight text-foreground/90",
              compact
                ? "text-[15px] font-semibold"
                : "font-serif text-[26px]",
            )}
          >
            {compact ? "Chat about this page" : displayName}
          </h1>
          <p
            className={cn(
              "text-muted-foreground",
              compact ? "text-[12px] leading-5" : "text-[13.5px]",
            )}
          >
            {compact
              ? (contextTitle ?? "The current page")
              : "Ask anything about your vault."}
          </p>
        </div>
      </div>
      <div className={cn("shrink-0", compact ? "px-3 pb-4" : "px-6 pb-5")}>
        <div className="mx-auto w-full max-w-[720px]">
          <AgentComposer
            canSubmit={canSubmit}
            configResolved={configResolved}
            configured={configured}
            displayName={displayName}
            lastError={lastError}
            compact={compact}
            onSubmit={onSubmit}
            placeholder={compact ? "" : "How can I help you today?"}
            status={status}
            stop={stop}
          />
        </div>
      </div>
    </div>
  );
}

function AgentConversationView({
  canSubmit,
  compact = false,
  configResolved,
  configured,
  displayName,
  lastError,
  messages,
  onRestoreCheckpoint,
  onSubmit,
  onToolApprovalResponse,
  status,
  stop,
}: {
  canSubmit: boolean;
  compact?: boolean;
  configResolved: boolean;
  configured: boolean;
  displayName: string;
  lastError: string | null;
  messages: UIMessage[];
  onRestoreCheckpoint: (messageIndex: number) => void;
  onSubmit: (message: PromptInputMessage) => void;
  onToolApprovalResponse: ChatAddToolApproveResponseFunction;
  status: ChatStatus;
  stop: () => void;
}) {
  const busy = status === "submitted" || status === "streaming";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Conversation className="min-h-0 flex-1" initial="instant">
        <ConversationContent
          className={cn(
            "mx-auto w-full gap-2",
            // 768 = 720 (composer max-width) + px-6 gutters, so the message
            // content area lines up edge-for-edge with the input box below.
            compact ? "max-w-none px-3 py-5" : "max-w-[768px] px-6 py-10",
          )}
        >
          {messages.map((message, index) => {
            const isLastMessage = index === messages.length - 1;
            const canRestore =
              !busy && message.role === "assistant" && !isLastMessage;

            return (
              <Fragment key={message.id}>
                <AgentMessage
                  displayName={displayName}
                  isFirst={index === 0}
                  isLastMessage={isLastMessage}
                  isStreaming={status === "streaming"}
                  message={message}
                  compact={compact}
                  onToolApprovalResponse={onToolApprovalResponse}
                />
                {canRestore && (
                  <AgentCheckpoint
                    onRestore={() => onRestoreCheckpoint(index)}
                  />
                )}
              </Fragment>
            );
          })}
          {status === "submitted" && (
            <AgentWorkIndicator displayName={displayName} />
          )}
        </ConversationContent>
        <AgentConversationAutoScroll messages={messages} />
        {!compact && <ConversationScrollButton />}
      </Conversation>
      <div className={cn("shrink-0", compact ? "px-3 pb-4" : "px-6 pb-5")}>
        <div className="mx-auto w-full max-w-[720px]">
          <AgentComposer
            canSubmit={canSubmit}
            configResolved={configResolved}
            configured={configured}
            displayName={displayName}
            lastError={lastError}
            compact={compact}
            onSubmit={onSubmit}
            placeholder={compact ? "" : "Send follow-up"}
            status={status}
            stop={stop}
          />
        </div>
      </div>
    </div>
  );
}

function AgentConversationAutoScroll({ messages }: { messages: UIMessage[] }) {
  const { scrollToBottom } = useStickToBottomContext();
  const scrolledUserMessageRef = useRef<string | null>(null);
  const newestUserMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") return messages[i].id;
    }
    return null;
  }, [messages]);

  useLayoutEffect(() => {
    if (!newestUserMessageId) return;
    if (scrolledUserMessageRef.current === newestUserMessageId) return;
    scrolledUserMessageRef.current = newestUserMessageId;
    const raf = window.requestAnimationFrame(() => {
      void scrollToBottom({
        animation: "instant",
        duration: 250,
        ignoreEscapes: true,
      });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [newestUserMessageId, scrollToBottom]);

  return null;
}

function AgentCheckpoint({ onRestore }: { onRestore: () => void }) {
  return (
    <div className="mx-auto w-full max-w-none">
      <Checkpoint className="-my-1 text-muted-foreground/70">
        <CheckpointIcon className="ml-1 size-3.5" />
        <CheckpointTrigger
          className="h-7 px-2 text-[12px] text-muted-foreground hover:text-foreground"
          onClick={onRestore}
          tooltip="Restore the conversation to this point"
        >
          Restore checkpoint
        </CheckpointTrigger>
      </Checkpoint>
    </div>
  );
}

export function AgentWorkIndicator({
  displayName = "Cadence",
}: {
  displayName?: string;
}) {
  const elapsedSeconds = useElapsedSeconds();

  // A lightweight, transient "working" chip shown while the request is
  // submitted; streamed assistant text then takes its place. It occupies the
  // eventual response position, so the handoff reads as one continuous turn.
  // Theme tokens keep it correct in light/dark.
  return (
    <Message aria-live="polite" className="max-w-full agent-msg-in" from="assistant">
      <MessageContent className="w-full max-w-none px-4">
        <div className="flex items-center gap-2.5 text-[13px]">
          <Shimmer
            as="span"
            className="font-medium text-foreground/80"
            duration={1.2}
            spread={1.3}
          >
            {`${displayName} is working`}
          </Shimmer>
          <span className="tabular-nums text-[12px] text-muted-foreground/70">
            {formatElapsed(elapsedSeconds)}
          </span>
        </div>
      </MessageContent>
    </Message>
  );
}

function useElapsedSeconds(): number {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return elapsedSeconds;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * Cadence's mark: a bot glyph in a softly lit tile (matching the Agent
 * icon in the nav rail). When `animated`, the glyph gently breathes — a
 * quiet, branded stand-in for a spinner while the agent works. Monochrome
 * and built from theme tokens, so it reads correctly in light and dark.
 */
function CadenceAvatar({
  animated = false,
  className,
  size = "md",
}: {
  animated?: boolean;
  className?: string;
  size?: "md" | "lg";
}) {
  const lg = size === "lg";
  return (
    <div
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center border border-border/70 bg-gradient-to-b from-muted/60 to-muted/25 text-foreground/75 shadow-sm dark:from-muted/40 dark:to-muted/10",
        lg ? "size-12 rounded-[15px]" : "size-7 rounded-[9px]",
        animated && "cadence-animated",
        className,
      )}
    >
      <Bot className={cn("cadence-icon", lg ? "size-6" : "size-4")} strokeWidth={1.8} />
    </div>
  );
}

function AgentMessage({
  compact = false,
  displayName,
  isFirst,
  isLastMessage,
  isStreaming,
  message,
  onToolApprovalResponse,
}: {
  compact?: boolean;
  displayName: string;
  isFirst: boolean;
  isLastMessage: boolean;
  isStreaming: boolean;
  message: UIMessage;
  onToolApprovalResponse: ChatAddToolApproveResponseFunction;
}) {
  const text = messageText(message);
  const isUser = message.role === "user";
  const fileParts = isUser ? filePartsFromMessage(message) : [];
  const responseText = isUser ? text : normalizeAgentResponseMarkdown(text);
  const reasoningText = isUser ? "" : reasoningTextFromMessage(message);
  const sourceParts = isUser ? [] : sourcePartsFromMessage(message);
  const toolParts = isUser ? [] : toolPartsFromMessage(message);
  const responseArtifact = isUser ? null : agentArtifactFromResponse(responseText);
  const lastPart = message.parts.at(-1);
  const reasoningStreaming =
    isLastMessage && isStreaming && lastPart?.type === "reasoning";
  // The turn whose chain-of-thought is live: the last assistant message while
  // the run is still streaming. Its activity log auto-expands and ticks a timer.
  const active = !isUser && isLastMessage && isStreaming;
  const hasActivity = reasoningText.length > 0 || toolParts.length > 0;
  // Show the activity log when there's real reasoning/tool work to surface, or
  // while the active turn is still waiting for its first token (so the wait
  // isn't blank). A plain answer that streams straight through skips it — the
  // streaming text is its own feedback.
  const showChainOfThought = !isUser && (hasActivity || (active && !responseText));

  // Don't render a bare avatar for an assistant turn that has nothing to show
  // yet — unless it's the active turn, whose chain-of-thought stands in with a
  // live "working" header while we wait for the first token.
  if (
    !isUser &&
    !active &&
    !responseText &&
    !reasoningText &&
    toolParts.length === 0 &&
    sourceParts.length === 0 &&
    !responseArtifact
  ) {
    return null;
  }

  return (
    <Message
      className={cn(
        "agent-msg-in",
        isUser ? "max-w-[80%]" : "max-w-full",
        isUser && !isFirst && "mt-8",
      )}
      from={message.role}
    >
      <MessageContent
        className={cn(
          compact ? "text-[13px] leading-5" : "text-[15px] leading-7",
          isUser
            ? "group-[.is-user]:rounded-2xl group-[.is-user]:bg-muted group-[.is-user]:px-4 group-[.is-user]:py-2.5"
            : "w-full max-w-none px-0",
        )}
      >
        {isUser ? (
          // The user's turn reads as a right-aligned chat bubble (the gray
          // surface comes from MessageContent), offset from the assistant's
          // full-width prose so the two speakers are easy to tell apart.
          <div
            className={cn(
              "text-foreground",
              compact
                ? "text-[13px] leading-[1.5]"
                : "text-[14.5px] leading-[1.55]",
            )}
          >
            {text && <MessageResponse>{text}</MessageResponse>}
            {fileParts.length > 0 && (
              <AgentAttachmentList
                className={text ? "mt-2" : undefined}
                files={fileParts}
              />
            )}
          </div>
        ) : (
          // Assistant reply: bare full-width prose, no avatar or bubble — a
          // small px-4 inset keeps it off the hard left edge and aligns the
          // chain-of-thought, response, and sources in one column.
          <div
            className={cn(
              "min-w-0 max-w-none text-foreground [&_li]:pl-1 [&_ol]:marker:text-muted-foreground/70 [&_p:first-child]:!mt-0 [&_p:last-child]:!mb-0",
              compact
                ? "px-2 text-[13px] leading-[1.65] [&_blockquote]:!my-3 [&_ol]:!my-3 [&_p]:!my-3 [&_ul]:!my-3"
                : "px-4 text-[15px] leading-[1.7] [&_blockquote]:!my-3.5 [&_ol]:!my-3.5 [&_p]:!my-3.5 [&_ul]:!my-3.5",
            )}
            data-agent-response
          >
            {showChainOfThought && (
              <AgentChainOfThought
                active={active}
                displayName={displayName}
                hasText={Boolean(responseText)}
                onToolApprovalResponse={onToolApprovalResponse}
                reasoningStreaming={reasoningStreaming}
                reasoningText={reasoningText}
                toolParts={toolParts}
              />
            )}
            {responseText && (
              <Markdown preserveSoftBreaks text={responseText} />
            )}
            {responseArtifact && (
              <AgentResponseArtifact artifact={responseArtifact} />
            )}
            {sourceParts.length > 0 && (
              <AgentInlineCitations sources={sourceParts} />
            )}
            {sourceParts.length > 0 && (
              <Sources className="mt-6 mb-0 text-muted-foreground">
                <SourcesTrigger
                  className="rounded-md border border-border bg-muted/25 px-2.5 py-1.5 text-[12px] transition-colors hover:bg-muted/45 hover:text-foreground"
                  count={sourceParts.length}
                />
                <SourcesContent className="w-full gap-1.5">
                  {sourceParts.map((source, index) => (
                    <Source
                      className="rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground"
                      href={source.url}
                      key={`${source.url}-${index}`}
                      title={source.title || source.url}
                    />
                  ))}
                </SourcesContent>
              </Sources>
            )}
          </div>
        )}
      </MessageContent>
    </Message>
  );
}

interface AgentResponseArtifactData {
  title: string;
  description: string;
  body: string;
}

function AgentResponseArtifact({
  artifact,
}: {
  artifact: AgentResponseArtifactData;
}) {
  const [copied, setCopied] = useState(false);

  async function copyArtifact() {
    try {
      await navigator.clipboard.writeText(artifact.body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Artifact className="mt-6 rounded-md bg-muted/15 shadow-none">
      <ArtifactHeader className="bg-muted/25 px-3 py-2">
        <div className="min-w-0">
          <ArtifactTitle>{artifact.title}</ArtifactTitle>
          <ArtifactDescription className="mt-0.5 text-[12px]">
            {artifact.description}
          </ArtifactDescription>
        </div>
        <ArtifactActions>
          <ArtifactAction
            icon={Copy}
            label={copied ? "Copied" : "Copy"}
            onClick={copyArtifact}
            tooltip={copied ? "Copied" : "Copy artifact"}
          />
        </ArtifactActions>
      </ArtifactHeader>
      <ArtifactContent className="max-h-64 px-3 py-3 text-[14px] leading-6">
        <Markdown text={artifact.body} />
      </ArtifactContent>
    </Artifact>
  );
}

function AgentInlineCitations({ sources }: { sources: SourceUrlPart[] }) {
  const citationSources = sources
    .map((source) => toCitationSource(source))
    .filter((source): source is CitationSource => Boolean(source));

  if (citationSources.length === 0) return null;

  return (
    <div className="mt-5 text-[13px] text-muted-foreground">
      <InlineCitation>
        <InlineCitationText>Referenced sources</InlineCitationText>
        <InlineCitationCard>
          <InlineCitationCardTrigger
            className="border border-border bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            sources={citationSources.map((source) => source.url)}
          />
          <InlineCitationCardBody>
            <InlineCitationCarousel>
              <InlineCitationCarouselHeader>
                <InlineCitationCarouselPrev className="rounded-sm p-1 hover:bg-background/70" />
                <InlineCitationCarouselIndex />
                <InlineCitationCarouselNext className="rounded-sm p-1 hover:bg-background/70" />
              </InlineCitationCarouselHeader>
              <InlineCitationCarouselContent>
                {citationSources.map((source) => (
                  <InlineCitationCarouselItem key={source.url}>
                    <InlineCitationSource
                      description={source.description}
                      title={source.title}
                      url={source.url}
                    />
                    <InlineCitationQuote>{source.quote}</InlineCitationQuote>
                  </InlineCitationCarouselItem>
                ))}
              </InlineCitationCarouselContent>
            </InlineCitationCarousel>
          </InlineCitationCardBody>
        </InlineCitationCard>
      </InlineCitation>
    </div>
  );
}

function AgentChainOfThought({
  active,
  displayName,
  hasText,
  onToolApprovalResponse,
  reasoningStreaming,
  reasoningText,
  toolParts,
}: {
  active: boolean;
  displayName: string;
  hasText: boolean;
  onToolApprovalResponse?: ChatAddToolApproveResponseFunction;
  reasoningStreaming: boolean;
  reasoningText: string;
  toolParts: AgentToolPart[];
}) {
  const hasReasoning = reasoningText.trim().length > 0;
  // The "Worked for Ns · K steps" tally counts the real reasoning + tool work,
  // not the always-on "sent context" baseline step.
  const stepCount = toolParts.length + (hasReasoning ? 1 : 0);
  // The run is live but nothing has streamed yet — show a generic "working
  // remotely" beat so the wait isn't a blank shimmer.
  const showScaffold = active && stepCount === 0 && !hasText;

  return (
    <ChainOfThought active={active} className="mb-5">
      <ChainOfThoughtHeader displayName={displayName} stepCount={stepCount} />
      <ChainOfThoughtContent>
        <ChainOfThoughtStep label="Sent context to Hermes" status="complete" />
        {hasReasoning && (
          <ChainOfThoughtStep
            label="Reasoned through it"
            status={reasoningStreaming ? "active" : "complete"}
          >
            <div className="max-h-44 overflow-y-auto pr-1 text-[12.5px] leading-5 text-muted-foreground [&_p:first-child]:!mt-0 [&_p:last-child]:!mb-0 [&_p]:!my-2">
              <Markdown text={reasoningText} />
            </div>
          </ChainOfThoughtStep>
        )}
        {toolParts.map((part) => (
          <AgentThoughtTool
            key={part.toolCallId}
            onToolApprovalResponse={onToolApprovalResponse}
            part={part}
          />
        ))}
        {showScaffold && (
          <ChainOfThoughtStep
            description="Reading context and deciding what to do…"
            label="Working remotely"
            status="active"
          />
        )}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

export function AgentThoughtTool({
  onToolApprovalResponse,
  part,
}: {
  onToolApprovalResponse?: ChatAddToolApproveResponseFunction;
  part: AgentToolPart;
}) {
  const toolName = toolNameFromPart(part);
  const title = "title" in part ? part.title ?? undefined : undefined;
  const input = "input" in part ? part.input : undefined;
  const descriptor = agentToolDescriptor(toolName, title, input);
  const status = toolStatusFromPart(part);
  const approval = toolApprovalFromPart(part);
  const hasInput = input !== undefined;
  const hasOutput = "output" in part && part.output !== undefined;
  const errorText = "errorText" in part ? part.errorText : undefined;
  const needsAttention = part.state === "approval-requested" || status === "error";
  const hasDetail = hasInput || hasOutput || Boolean(errorText) || Boolean(approval);
  const [open, setOpen] = useState(needsAttention);

  // Pop the detail open the moment an approval prompt or error arrives so it
  // isn't buried inside a collapsed step.
  useEffect(() => {
    if (needsAttention) setOpen(true);
  }, [needsAttention]);

  return (
    <ChainOfThoughtStep
      description={descriptor.description}
      label={
        hasDetail ? (
          <button
            className="inline-flex items-center gap-1 text-left text-current transition-colors hover:text-foreground"
            onClick={() => setOpen((value) => !value)}
            type="button"
          >
            <span>{descriptor.label}</span>
            <ChevronDown
              className={cn(
                "size-3 text-muted-foreground/50 transition-transform",
                open && "rotate-180",
              )}
            />
          </button>
        ) : (
          descriptor.label
        )
      }
      status={status}
    >
      {hasDetail && open && (
        <div className="space-y-3 rounded-md border border-border/60 bg-muted/15 p-2.5">
          {approval && (
            <Confirmation
              approval={approval}
              className="border-border bg-background/60"
              state={part.state}
            >
              <ConfirmationTitle className="font-medium text-foreground">
                Tool approval
              </ConfirmationTitle>
              <ConfirmationRequest>
                <div className="text-sm text-muted-foreground">
                  Hermes wants to run{" "}
                  <span className="font-mono text-foreground">{toolName}</span>.
                </div>
              </ConfirmationRequest>
              <ConfirmationAccepted>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="size-4 text-[#14845f]" />
                  Approved.
                </div>
              </ConfirmationAccepted>
              <ConfirmationRejected>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <X className="size-4 text-destructive" />
                  Rejected.
                </div>
              </ConfirmationRejected>
              <ConfirmationActions>
                <ConfirmationAction
                  disabled={!onToolApprovalResponse}
                  onClick={() =>
                    void onToolApprovalResponse?.({
                      approved: false,
                      id: approval.id,
                    })
                  }
                  variant="outline"
                >
                  Reject
                </ConfirmationAction>
                <ConfirmationAction
                  disabled={!onToolApprovalResponse}
                  onClick={() =>
                    void onToolApprovalResponse?.({
                      approved: true,
                      id: approval.id,
                    })
                  }
                >
                  Approve
                </ConfirmationAction>
              </ConfirmationActions>
            </Confirmation>
          )}
          {hasInput && <ToolInput input={input} />}
          <ToolOutput
            errorText={errorText}
            output={hasOutput ? part.output : undefined}
          />
        </div>
      )}
    </ChainOfThoughtStep>
  );
}

type AgentToolApproval = NonNullable<
  Parameters<typeof Confirmation>[0]["approval"]
>;

function toolApprovalFromPart(part: AgentToolPart): AgentToolApproval | null {
  if (!("approval" in part)) return null;
  const approval = part.approval;
  if (
    !approval ||
    typeof approval !== "object" ||
    !("id" in approval) ||
    typeof approval.id !== "string"
  ) {
    return null;
  }
  return approval as AgentToolApproval;
}

function AgentAttachmentList({
  className,
  files,
  onRemove,
}: {
  className?: string;
  files: (FileUIPart & { id: string })[];
  onRemove?: (id: string) => void;
}) {
  if (files.length === 0) return null;

  return (
    <Attachments className={className} variant="inline">
      {files.map((file) => (
        <Attachment
          className="max-w-full bg-background/45 text-[12px]"
          data={file}
          key={file.id}
          onRemove={onRemove ? () => onRemove(file.id) : undefined}
        >
          <AttachmentPreview />
          <AttachmentInfo className="max-w-[180px]" />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
  );
}

function AgentComposer({
  canSubmit,
  className,
  compact = false,
  configResolved,
  configured,
  displayName,
  lastError,
  onSubmit,
  placeholder,
  status,
  stop,
}: {
  canSubmit: boolean;
  className?: string;
  compact?: boolean;
  configResolved: boolean;
  configured: boolean;
  displayName: string;
  lastError: string | null;
  onSubmit: (message: PromptInputMessage) => void;
  placeholder?: string;
  status: ChatStatus;
  stop: () => void;
}) {
  // Only treat the agent as "needs setup" once config has actually resolved.
  // Before that we render the optimistic configured-looking composer so there's
  // no flash/shift when the real config lands (the common case is configured).
  const showUnconfigured = configResolved && !configured;
  const textareaPlaceholder = showUnconfigured
    ? `Connect ${displayName} in settings`
    : (placeholder ?? `Message ${displayName}`);
  // ChatGPT shows an up-arrow when idle and swaps to spinner/stop while
  // generating. The shared default stop control is intentionally high-contrast;
  // keep the agent composer quieter so the button stays inside the dark input.
  const generating = status === "submitted" || status === "streaming";
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachments = usePromptInputAttachments();
  const { textInput } = usePromptInputController();
  const hasText = textInput.value.trim().length > 0;

  useEffect(() => {
    if (compact) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;

      if (event.key === "Escape") {
        if (document.activeElement === textareaRef.current) {
          event.preventDefault();
          textareaRef.current?.blur();
        }
        return;
      }

      if (event.key !== "Enter") return;
      if (showUnconfigured) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      if (document.activeElement === textareaRef.current) return;
      if (isEditableElement(event.target)) return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          "button, a, summary, [role='button'], [role='menuitem'], [role='option']",
        )
      ) {
        return;
      }

      event.preventDefault();
      textareaRef.current?.focus();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [compact, showUnconfigured]);

  return (
    <div>
      {/* The full Agent uses a slim single-row composer. In the narrow page
          chat, the textarea keeps its own row above the attachment control. */}
      <PromptInput
        className={cn(
          // className lands on the form; the visible box + border come from the
          // inner InputGroup (data-slot="input-group"), so neutralize its border,
          // bg, and focus ring there and let the form provide the surface.
          // !ring-0 beats InputGroup's focus-visible ring-3. A modest 14px
          // radius reads as a text field (not a search pill); the full surface
          // stays opaque while the compact sidebar variant blends into bg-list.
          "border border-border bg-background p-2 shadow-[0_1px_2px_rgba(0,0,0,0.03),0_8px_22px_-18px_rgba(0,0,0,0.18)] transition-[border-color,box-shadow] duration-150 hover:border-foreground/20 focus-within:border-foreground/30 focus-within:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_30px_-16px_rgba(0,0,0,0.26)] [&>[data-slot=input-group]]:h-auto [&>[data-slot=input-group]]:border-0 [&>[data-slot=input-group]]:!bg-transparent [&>[data-slot=input-group]]:!ring-0",
          compact
            ? "rounded-[16px] border-foreground/25 bg-muted/45 p-2 shadow-none hover:border-foreground/30 focus-within:border-foreground/35 focus-within:shadow-none"
            : "rounded-[14px]",
          className,
        )}
        maxFiles={4}
        maxFileSize={2 * 1024 * 1024}
        onSubmit={onSubmit}
      >
        {attachments.files.length > 0 && (
          <PromptInputHeader className="px-2 pb-1.5 pt-1">
            <AgentAttachmentList
              files={attachments.files}
              onRemove={attachments.remove}
            />
          </PromptInputHeader>
        )}
        <div
          className={cn(
            "flex w-full gap-1",
            compact ? "flex-wrap items-center" : "items-center",
          )}
        >
          <PromptInputButton
            aria-label="Add attachment"
            className={cn(
              "size-8 shrink-0 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground",
              compact && "order-2",
            )}
            onClick={attachments.openFileDialog}
            tooltip="Add attachment"
          >
            <Plus className="size-4" strokeWidth={2} />
          </PromptInputButton>
          <PromptInputTextarea
            className={cn(
              "max-h-32 bg-transparent leading-6",
              compact
                ? "order-1 min-h-[36px] basis-full px-2 py-1.5 text-[13.5px]"
                : "min-h-[32px] flex-1 px-1.5 py-1.5 text-[14px]",
            )}
            disabled={showUnconfigured}
            placeholder={textareaPlaceholder}
            ref={textareaRef}
          />
          {compact && <div aria-hidden className="order-3 flex-1" />}
          {!compact && (
            generating ? (
              <PromptInputSubmit
                className="size-8 shrink-0 rounded-full border border-border bg-background/45 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onStop={stop}
                status={status}
                variant="ghost"
              >
                <span className="size-2.5 rounded-[2px] bg-current" />
              </PromptInputSubmit>
            ) : (
              <PromptInputSubmit
                className="size-8 shrink-0 rounded-full bg-foreground text-background transition-colors hover:bg-foreground/90"
                disabled={!hasText || (configResolved && !canSubmit)}
                onStop={stop}
                status={status}
              >
                <ArrowUp className="size-4" strokeWidth={2.2} />
              </PromptInputSubmit>
            )
          )}
        </div>
      </PromptInput>
      {!compact && (
        <p className="mt-2 px-2 text-center text-[11px] leading-relaxed text-muted-foreground/70">
          {displayName} is AI and can make mistakes. Please double-check responses.
        </p>
      )}
      {showUnconfigured && (
        <div
          className={cn(
            "mt-3 text-center text-muted-foreground",
            compact ? "text-xs" : "text-sm",
          )}
        >
          Add a bearer key in{" "}
          <Link className="text-foreground underline underline-offset-4" to="/settings/agent">
            Agent settings
          </Link>
          .
        </div>
      )}
      {lastError && (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {lastError}
        </div>
      )}
    </div>
  );
}

export function toUiMessages(messages: AgentVaultMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== "user") {
      return {
        id: message.id,
        role: message.role,
        parts: [{ type: "text" as const, text: message.content }],
      };
    }

    const { files, text } = parsePersistedAttachmentContext(message.content);
    return {
      id: message.id,
      role: message.role,
      parts: [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...files,
      ],
    };
  });
}

function toVaultMessages(
  messages: UIMessage[],
  times: Map<string, string>,
): AgentVaultMessage[] {
  return messages
    .map((message) => {
      const content = messageContentForVault(message).trim();
      if (!content) return null;
      const createdAt = times.get(message.id) ?? new Date().toISOString();
      times.set(message.id, createdAt);
      return {
        id: message.id || `msg-${nanoid()}`,
        role: message.role as AgentVaultMessage["role"],
        createdAt,
        content,
      };
    })
    .filter((message): message is AgentVaultMessage => Boolean(message));
}

function messageText(message: UIMessage): string {
  return messageTextFromMessage(message);
}

function messageContentForVault(message: UIMessage): string {
  const files = filePartsFromMessage(message);
  return [messageText(message).trim(), attachmentContextFromFiles(files)]
    .filter(Boolean)
    .join("\n\n");
}

function filePartsFromMessage(message: UIMessage): (FileUIPart & { id: string })[] {
  return message.parts.filter(isFilePart).map((part, index) => ({
    ...part,
    id:
      "id" in part && typeof part.id === "string"
        ? part.id
        : `${message.id}-file-${index}`,
  }));
}

function isFilePart(
  part: UIMessage["parts"][number],
): part is UIMessage["parts"][number] & FileUIPart {
  return part.type === "file";
}

function attachmentTitleFromFiles(files: FileUIPart[]): string {
  if (files.length === 0) return "";
  if (files.length === 1) return attachmentLabel(files[0]);
  return `${files.length} attachments`;
}

function reasoningTextFromMessage(message: UIMessage): string {
  return message.parts
    .filter(isReasoningPart)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

type ReasoningPart = UIMessage["parts"][number] & {
  type: "reasoning";
  text: string;
};

function isReasoningPart(part: UIMessage["parts"][number]): part is ReasoningPart {
  return part.type === "reasoning" && "text" in part && typeof part.text === "string";
}

type SourceUrlPart = UIMessage["parts"][number] & {
  type: "source-url";
  url: string;
  title?: string;
};

function sourcePartsFromMessage(message: UIMessage): SourceUrlPart[] {
  return message.parts.filter(isSourceUrlPart);
}

function isSourceUrlPart(part: UIMessage["parts"][number]): part is SourceUrlPart {
  return part.type === "source-url" && "url" in part && typeof part.url === "string";
}

interface CitationSource {
  url: string;
  title: string;
  description: string;
  quote: string;
}

function toCitationSource(source: SourceUrlPart): CitationSource | null {
  if (!isValidCitationUrl(source.url)) return null;
  const title = source.title?.trim() || hostnameFromUrl(source.url) || source.url;
  return {
    url: source.url,
    title,
    description: "Referenced by the assistant response.",
    quote: title,
  };
}

function isValidCitationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function hostnameFromUrl(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function agentArtifactFromResponse(text: string): AgentResponseArtifactData | null {
  const lines = text.split("\n");
  const headerIndex = lines.findIndex((line) =>
    AGENT_ARTIFACT_HEADER_RE.test(line.trim()),
  );
  if (headerIndex < 0) return null;

  const remaining = lines.slice(headerIndex);
  const bulletCount = remaining.filter((line) => /^[-*]\s+\S/.test(line.trim())).length;
  if (bulletCount < 2) return null;

  const title = remaining[0]?.trim().replace(/:$/, "") || "Artifact";
  const body = remaining.join("\n").trim();
  if (!body) return null;

  return {
    title,
    description: `${bulletCount} structured items from this response`,
    body,
  };
}

function recordToSummary(chat: AgentChatRecord): AgentChatSummary {
  const last = chat.messages.at(-1)?.content ?? "";
  return {
    id: chat.id,
    path: chat.path,
    title: chat.title,
    agent: chat.agent,
    model: chat.model,
    created: chat.created,
    updated: chat.updated,
    lastMessageCreated: chat.messages.at(-1)?.createdAt ?? null,
    pinned: chat.pinned,
    messageCount: chat.messages.length,
    preview: last.replace(/\s+/g, " ").trim().slice(0, 96),
    context: chat.context ?? null,
  };
}

function upsertSummary(
  chats: AgentChatSummary[],
  next: AgentChatSummary,
): AgentChatSummary[] {
  const filtered = chats.filter((chat) => chat.id !== next.id);
  return sortChatsByDate([next, ...filtered]);
}

// Today's Cadence renders at `/`, but the same day is also reachable at the
// dated route `/cadence/<today>` — and a chat can be started from either. Map
// `/` to the dated route so both collapse to one key when scoping a page's
// chat history. Concrete routes (anything but `/`) pass through unchanged, so
// this stays idempotent and doesn't drift a stored route across days.
function canonicalAgentRoute(pathname: string, today: string): string {
  return pathname === "/" ? `/cadence/${today}` : pathname;
}

// Compact "when" for the page-chat history: time-of-day if today, "Yesterday",
// a weekday within the past week, else "Mon D". Mirrors the mail sweep list.
function formatChatTimestamp(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function messageCountLabel(count: number): string {
  return `${count} message${count === 1 ? "" : "s"}`;
}

function sortChatsByDate(chats: AgentChatSummary[]): AgentChatSummary[] {
  return [...chats].sort((a, b) => {
    const byDate = chatSortDate(b).localeCompare(chatSortDate(a));
    if (byDate !== 0) return byDate;
    return a.title.localeCompare(b.title);
  });
}

function chatSortDate(chat: AgentChatSummary): string {
  return chat.lastMessageCreated || chat.updated || chat.created || "";
}

function readRecentAgentChatId(chats: AgentChatSummary[]): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_AGENT_CHAT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown; at?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.at !== "number") {
      return null;
    }
    if (Date.now() - parsed.at > RECENT_AGENT_CHAT_WINDOW_MS) {
      forgetRecentAgentChatId(parsed.id);
      return null;
    }
    return chats.some((chat) => chat.id === parsed.id) ? parsed.id : null;
  } catch {
    return null;
  }
}

function rememberRecentAgentChatId(id: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      LAST_AGENT_CHAT_STORAGE_KEY,
      JSON.stringify({ id, at: Date.now() }),
    );
  } catch {
    // Ignore storage failures; chat selection still works in memory.
  }
}

function forgetRecentAgentChatId(id?: string) {
  if (typeof window === "undefined") return;
  try {
    if (id) {
      const raw = window.localStorage.getItem(LAST_AGENT_CHAT_STORAGE_KEY);
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as { id?: unknown };
        if (parsed.id !== id) return;
      } catch {
        return;
      }
    }
    window.localStorage.removeItem(LAST_AGENT_CHAT_STORAGE_KEY);
  } catch {
    // Ignore storage failures; starting a new chat still clears local state.
  }
}

function normalizeAgentResponseMarkdown(text: string): string {
  return text
    .split("\n")
    .map(normalizeAgentResponseLine)
    .join("\n");
}

function normalizeAgentResponseLine(line: string): string {
  return linkAgentAreaReferences(
    splitTimestampEntries(line) ?? splitAreaQualifiedEntries(line) ?? line,
  );
}

function splitAreaQualifiedEntries(line: string): string | null {
  const match = line.match(AGENT_LIST_LINE_RE);
  if (!match) return null;

  const prefix = match[1];
  const body = match[2];
  const suffixes = [...body.matchAll(AREA_QUALIFIED_ENTRY_RE)];
  if (suffixes.length < 2) return null;

  const entries = suffixes
    .map((suffix, index) => {
      const entryStart =
        index === 0 ? 0 : (suffixes[index - 1].index ?? 0) + suffixes[index - 1][0].length;
      const entryEnd = (suffix.index ?? 0) + suffix[0].length;
      return body.slice(entryStart, entryEnd).trim();
    })
    .filter(Boolean);

  if (entries.length < 2) return null;
  return `${toSentenceCase(prefix)}:\n${entries.map((entry) => `- ${entry}`).join("\n")}`;
}

function toSentenceCase(value: string): string {
  if (!value) return value;
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}`;
}

function linkAgentAreaReferences(line: string): string {
  return line.replace(AGENT_AREA_REFERENCE_RE, (_, prefix: string, id: string) => {
    const label = AGENT_AREA_REFERENCE_LABELS[id.toLowerCase()];
    return label ? `${prefix}[[${label}]]` : `${prefix}${id}`;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitTimestampEntries(line: string): string | null {
  const matches = [...line.matchAll(/\b\d{1,2}:\d{2}\s+[—-]\s+/g)];
  if (matches.length < 2) return null;

  return matches
    .map((match, index) => {
      const start = match.index ?? 0;
      const end = matches[index + 1]?.index ?? line.length;
      return `- ${line.slice(start, end).trim()}`;
    })
    .join("\n");
}

function titleFromText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "New chat";
  return collapsed.length > 58 ? `${collapsed.slice(0, 55)}...` : collapsed;
}
