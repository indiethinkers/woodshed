import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BrandMark } from "@/components/shared/brand-mark";
import { tauriInvoke, isTauri } from "@/lib/tauri";

export const Route = createFileRoute("/welcome")({
  component: WelcomePage,
});

type Step = 1 | 2 | "scaffolding";
type VaultMode = "import" | "new";

const NEW_VAULT_STEPS = [
  "Creating folders…",
  "Seeding samples…",
  "Starting watcher…",
];
const IMPORT_STEPS = [
  "Preparing Woodshed records…",
  "Scanning Markdown…",
  "Building the local index…",
];

// Exported separately from the Route so the vitest suite can render
// the component without spinning up a TanStack RouterProvider.
export function WelcomePage() {
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>(1);
  const [vaultMode, setVaultMode] = useState<VaultMode>("import");
  const [vaultPath, setVaultPath] = useState<string>("");
  const [seedSamples, setSeedSamples] = useState(true);
  const [pathError, setPathError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  const [scaffoldStep, setScaffoldStep] = useState(0);
  const scaffoldSteps =
    vaultMode === "import" ? IMPORT_STEPS : NEW_VAULT_STEPS;

  useEffect(() => {
    let cancelled = false;
    tauriInvoke<string>("vault_path_default")
      .then((p) => {
        if (!cancelled && p) setVaultPath(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (step !== "scaffolding") return;
    const id = window.setInterval(() => {
      setScaffoldStep((s) => (s + 1) % scaffoldSteps.length);
    }, 250);
    return () => window.clearInterval(id);
  }, [scaffoldSteps.length, step]);

  const isIcloudPath = vaultPath.includes("/Library/Mobile Documents/");

  async function pickFolder() {
    // Native folder picker is a Tauri-only affordance. Plain browser mode
    // still accepts a typed path for tests and static previews.
    if (!isTauri()) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose vault folder",
      });
      if (typeof selected === "string") {
        setVaultPath(selected);
        setPathError(null);
      }
    } catch (e) {
      setPathError(`Could not open file picker: ${String(e)}`);
    }
  }

  function handleContinue() {
    if (!vaultPath.trim()) {
      setPathError("Pick a folder for your vault.");
      return;
    }
    setPathError(null);
    setStep(2);
  }

  function validateProfile(): boolean {
    let ok = true;
    if (!displayName.trim()) {
      setNameError("Required.");
      ok = false;
    } else {
      setNameError(null);
    }
    if (!email.trim() || !/.+@.+\..+/.test(email)) {
      setEmailError("Use a valid email.");
      ok = false;
    } else {
      setEmailError(null);
    }
    return ok;
  }

  async function handleGetStarted() {
    if (!validateProfile()) return;
    setStep("scaffolding");
    try {
      if (vaultMode === "import") {
        await tauriInvoke<void>("vault_import", { path: vaultPath });
      } else {
        await tauriInvoke<void>("vault_init", {
          path: vaultPath,
          seedSamples,
        });
      }
      await tauriInvoke<void>("vault_path_set", { path: vaultPath });
      await tauriInvoke<void>("profile_set", {
        profile: {
          display_name: displayName,
          email,
          theme: "system",
        },
      });
      await tauriInvoke<void>("watcher_start", { vaultPath });
      void navigate({ to: "/" });
    } catch (e) {
      setStep(2);
      setNameError(`Setup failed: ${String(e)}`);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-content overflow-y-auto">
      <div className="w-full max-w-[520px] px-6 py-12 transition-opacity duration-200">
        {step === 1 && (
          <Step1
            vaultPath={vaultPath}
            setVaultPath={setVaultPath}
            vaultMode={vaultMode}
            setVaultMode={setVaultMode}
            seedSamples={seedSamples}
            setSeedSamples={setSeedSamples}
            isIcloudPath={isIcloudPath}
            pathError={pathError}
            onPickFolder={pickFolder}
            onContinue={handleContinue}
          />
        )}
        {step === 2 && (
          <Step2
            displayName={displayName}
            email={email}
            nameError={nameError}
            emailError={emailError}
            onDisplayNameChange={setDisplayName}
            onEmailChange={setEmail}
            onBack={() => setStep(1)}
            onGetStarted={handleGetStarted}
          />
        )}
        {step === "scaffolding" && (
          <Scaffolding subText={scaffoldSteps[scaffoldStep]} />
        )}
      </div>
    </div>
  );
}

function StepIndicator({ current }: { current: 1 | 2 }) {
  return (
    <div className="font-mono text-xs text-muted-foreground tracking-wide">
      {current} of 2
    </div>
  );
}

function Logo() {
  return <BrandMark className="h-7 w-7 text-foreground" title="Woodshed" />;
}

function Step1({
  vaultPath,
  setVaultPath,
  vaultMode,
  setVaultMode,
  seedSamples,
  setSeedSamples,
  isIcloudPath,
  pathError,
  onPickFolder,
  onContinue,
}: {
  vaultPath: string;
  setVaultPath: (p: string) => void;
  vaultMode: VaultMode;
  setVaultMode: (mode: VaultMode) => void;
  seedSamples: boolean;
  setSeedSamples: (s: boolean) => void;
  isIcloudPath: boolean;
  pathError: string | null;
  onPickFolder: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Logo />
        <StepIndicator current={1} />
      </div>

      <div className="flex flex-col gap-3">
        <h1 className="text-[32px] leading-[1.1] font-semibold tracking-[-0.02em] text-foreground">
          Bring your files into Woodshed
        </h1>
        <p className="text-[15px] leading-[1.45] text-muted-foreground">
          Open an existing Markdown folder without moving anything, or create a
          clean vault for a fresh start.
        </p>
      </div>

      <div role="radiogroup" aria-label="Vault setup" className="grid grid-cols-2 gap-2">
        <SetupChoice
          active={vaultMode === "import"}
          title="Open Markdown folder"
          detail="Existing files appear in Notebook, in their current folders."
          onClick={() => setVaultMode("import")}
        />
        <SetupChoice
          active={vaultMode === "new"}
          title="Create new vault"
          detail="Start with Woodshed's native record structure."
          onClick={() => setVaultMode("new")}
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            type="text"
            aria-label="Vault location"
            className="flex-1 h-8 px-3 rounded-sm border border-border bg-background font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
            value={vaultPath}
            onChange={(e) => setVaultPath(e.target.value)}
          />
          <button
            type="button"
            onClick={onPickFolder}
            className="h-8 px-3 rounded-sm border border-border text-sm text-foreground hover:bg-muted"
          >
            Choose…
          </button>
        </div>
        {isIcloudPath && (
          <p className="font-mono text-xs text-muted-foreground">
            iCloud Drive detected. Sync may delay file writes. You can change
            this later in Settings.
          </p>
        )}
        {pathError && (
          <p role="alert" className="text-xs text-foreground">
            {pathError}
          </p>
        )}
      </div>

      {vaultMode === "new" && (
        <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={seedSamples}
            onChange={(e) => setSeedSamples(e.target.checked)}
            className="h-4 w-4 rounded-sm border-border"
          />
          <span>Seed with sample content (recommended for first-time users)</span>
        </label>
      )}

      <div className="flex flex-col gap-3 items-end">
        <button
          type="button"
          onClick={onContinue}
          className="h-8 px-4 rounded-sm bg-accent text-accent-foreground text-sm font-medium hover:opacity-90"
        >
          Continue
        </button>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={onPickFolder}
        >
          or restore an existing vault
        </button>
      </div>
    </div>
  );
}

function SetupChoice({
  active,
  title,
  detail,
  onClick,
}: {
  active: boolean;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`rounded-lg border p-3 text-left transition-colors ${
        active
          ? "border-foreground/30 bg-foreground/[0.045]"
          : "border-border bg-background/35 hover:bg-foreground/[0.025]"
      }`}
    >
      <span className="block text-[13px] font-semibold text-foreground">{title}</span>
      <span className="mt-1.5 block text-[11.5px] leading-snug text-muted-foreground">
        {detail}
      </span>
    </button>
  );
}

function Step2({
  displayName,
  email,
  nameError,
  emailError,
  onDisplayNameChange,
  onEmailChange,
  onBack,
  onGetStarted,
}: {
  displayName: string;
  email: string;
  nameError: string | null;
  emailError: string | null;
  onDisplayNameChange: (v: string) => void;
  onEmailChange: (v: string) => void;
  onBack: () => void;
  onGetStarted: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Logo />
        <StepIndicator current={2} />
      </div>

      <div className="flex flex-col gap-3">
        <h1 className="text-[32px] leading-[1.1] font-semibold tracking-[-0.02em] text-foreground">
          Tell us your name
        </h1>
        <p className="text-[15px] leading-[1.45] text-muted-foreground">
          Used as your identity in Cadence and local records.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="display_name" className="text-[13px] font-medium text-foreground">
            Display name
          </label>
          <input
            id="display_name"
            type="text"
            value={displayName}
            onChange={(e) => onDisplayNameChange(e.target.value)}
            className={`h-8 px-3 rounded-sm border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)] ${
              nameError ? "border-foreground" : "border-border"
            }`}
            autoFocus
          />
          {nameError && (
            <p role="alert" className="text-xs text-foreground">
              {nameError}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-[13px] font-medium text-foreground">
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            className={`h-8 px-3 rounded-sm border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)] ${
              emailError ? "border-foreground" : "border-border"
            }`}
          />
          {emailError && (
            <p role="alert" className="text-xs text-foreground">
              {emailError}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3 items-end">
        <button
          type="button"
          onClick={onGetStarted}
          className="h-8 px-4 rounded-sm bg-accent text-accent-foreground text-sm font-medium hover:opacity-90"
        >
          Get started
        </button>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={onBack}
        >
          Back
        </button>
      </div>
    </div>
  );
}

function Scaffolding({ subText }: { subText: string }) {
  return (
    <div className="flex flex-col gap-3 items-start">
      <Logo />
      <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-foreground">
        Setting up your vault…
      </h2>
      <p
        aria-live="polite"
        className="font-mono text-xs text-muted-foreground"
      >
        {subText}
      </p>
    </div>
  );
}
