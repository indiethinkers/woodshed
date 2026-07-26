// Theme helpers used by the appearance settings page AND by the app-shell
// boot path (so the user's stored theme paints on first frame, not after
// settings is opened for the first time).
//
// globals.css uses `.dark` on <html> as the dark-mode selector. "system"
// follows the OS via prefers-color-scheme.

export type Theme = "system" | "light" | "dark";

const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

let removeSystemThemeListener: (() => void) | null = null;

export function applyThemeToRoot(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
    root.style.colorScheme = "dark";
  } else if (theme === "light") {
    root.classList.remove("dark");
    root.style.colorScheme = "light";
  } else {
    const prefersDark = systemPrefersDark();
    root.classList.toggle("dark", prefersDark);
    root.style.colorScheme = prefersDark ? "dark" : "light";
  }
}

export function setThemePreference(theme: Theme) {
  clearSystemThemeWatcher();
  applyThemeToRoot(theme);

  if (theme !== "system") return;

  const media = systemThemeMedia();
  if (!media) return;

  const syncSystemTheme = () => applyThemeToRoot("system");

  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", syncSystemTheme);
    removeSystemThemeListener = () => {
      media.removeEventListener("change", syncSystemTheme);
    };
    return;
  }

  if (typeof media.addListener !== "function") return;

  media.addListener(syncSystemTheme);
  removeSystemThemeListener = () => {
    media.removeListener(syncSystemTheme);
  };
}

export function clearSystemThemeWatcher() {
  removeSystemThemeListener?.();
  removeSystemThemeListener = null;
}

function systemPrefersDark(): boolean {
  return systemThemeMedia()?.matches ?? false;
}

function systemThemeMedia(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(SYSTEM_DARK_QUERY);
}
