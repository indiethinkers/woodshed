/**
 * Color palette for select-option pills. We use HSL strings so dark mode
 * inherits the same hues with adjusted lightness/saturation. Pills get a
 * tinted background and a darker foreground from the same hue band so the
 * eye reads them as a category, not as decoration.
 */
export function selectOptionColor(name: string): { bg: string; fg: string } {
  switch (name) {
    case "blue":
      return { bg: "210 100% 92%", fg: "210 80% 28%" };
    case "purple":
      return { bg: "270 80% 92%", fg: "270 60% 32%" };
    case "amber":
      return { bg: "40 90% 88%", fg: "30 70% 30%" };
    case "teal":
      return { bg: "175 60% 88%", fg: "180 60% 24%" };
    case "coral":
      return { bg: "10 90% 90%", fg: "10 70% 32%" };
    case "pink":
      return { bg: "330 80% 92%", fg: "330 60% 36%" };
    case "gray":
    default:
      return { bg: "0 0% 92%", fg: "0 0% 30%" };
  }
}
