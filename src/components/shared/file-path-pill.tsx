import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";

const FilePathContext = createContext<string | undefined>(undefined);

export function FilePathProvider({
  path,
  children,
}: {
  path?: string;
  children: ReactNode;
}) {
  return (
    <FilePathContext.Provider value={path}>
      {children}
    </FilePathContext.Provider>
  );
}

export function FilePathLine({ className }: { className?: string }) {
  // The path now lives in a persistent dock at the bottom-right of the
  // content panel. Keep this component as a compatibility shim for existing
  // record headers while avoiding duplicate path pills on the page.
  void className;
  return null;
}

export function FilePathDock() {
  const path = useContext(FilePathContext);
  const [open, setOpen] = useState(false);

  // A new page means a new path; start back at the unobtrusive dot.
  useEffect(() => {
    setOpen(false);
  }, [path]);

  if (!path) return null;

  return (
    <div className="pointer-events-none absolute bottom-3 right-4 z-20 max-w-[min(48vw,440px)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={open ? "Hide file path" : path}
        aria-label={open ? "Hide file path" : `Show file path: ${path}`}
        aria-expanded={open}
        className={cn(
          // Animating grid-template-columns (0fr -> 1fr) tracks the label's
          // real width, unlike a max-width tween which overshoots and snaps.
          "pointer-events-auto grid h-7 items-center overflow-hidden rounded-md border border-border/70 bg-muted/75 shadow-[0_1px_1px_hsl(0_0%_0%/0.06)] backdrop-blur transition-[grid-template-columns,background-color] duration-[450ms] [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] hover:bg-muted supports-[backdrop-filter]:bg-muted/65 focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15",
          open ? "grid-cols-[auto_1fr]" : "grid-cols-[auto_0fr]",
        )}
      >
        <span className="flex h-7 w-7 items-center justify-center">
          <FileText
            aria-hidden
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground/60 transition-colors duration-[450ms]",
              open && "text-muted-foreground",
            )}
          />
        </span>
        <span className="min-w-0 overflow-hidden">
          <span
            className={cn(
              "block max-w-[min(44vw,400px)] truncate pr-2.5 text-left font-mono text-[12px] leading-none text-foreground/75 transition-opacity duration-300",
              open ? "opacity-100 delay-100" : "opacity-0",
            )}
          >
            {path}
          </span>
        </span>
      </button>
    </div>
  );
}
