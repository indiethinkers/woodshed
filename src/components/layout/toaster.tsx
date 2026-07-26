import { useEffect, useState } from "react";
import { Toaster as SonnerToaster } from "sonner";

/**
 * App-wide Sonner toaster. Mounts once in providers; call `toast(...)` from
 * anywhere via `import { toast } from "sonner"`.
 *
 * Theme tracks our DIY theme system (a `.dark` class on documentElement set
 * by `setThemePreference`). We listen for class mutations so the toaster
 * re-themes when the user flips Settings → Appearance or the OS appearance
 * changes.
 */
export function Toaster() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setTheme(root.classList.contains("dark") ? "dark" : "light");
    update();
    const obs = new MutationObserver(update);
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  return (
    <SonnerToaster
      position="bottom-right"
      theme={theme}
      richColors
      closeButton
    />
  );
}
