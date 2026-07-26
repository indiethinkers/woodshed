import { AvatarColor } from "@/lib/types";

type AvatarColorPair = { bg: string; text: string };

const avatarColorMap: Record<AvatarColor, AvatarColorPair> = {
  teal: { bg: "#E1F5EE", text: "#085041" },
  purple: { bg: "#EEEDFE", text: "#3C3489" },
  blue: { bg: "#E6F1FB", text: "#0C447C" },
  coral: { bg: "#FAECE7", text: "#712B13" },
  pink: { bg: "#FBEAF0", text: "#72243E" },
  amber: { bg: "#FAEEDA", text: "#633806" },
  gray: { bg: "#F1EFE8", text: "#444441" },
};

export function getAvatarColor(color: AvatarColor): AvatarColorPair {
  return avatarColorMap[color] ?? avatarColorMap.gray;
}
