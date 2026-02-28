import { cookies } from "next/headers";

const CHAT_OPEN_COOKIE = "chat-open";
const CHAT_WIDTH_COOKIE = "chat-width";
const MIN_WIDTH = 280;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 360;

type ChatCookies = Readonly<{
  chatOpen: boolean;
  chatWidth: number;
}>;

const clampWidth = (value: number): number =>
  Math.max(MIN_WIDTH, Math.min(value, MAX_WIDTH));

/** Read chat layout cookies. For Server Components. */
export const readChatCookies = async (): Promise<ChatCookies> => {
  const cookieStore = await cookies();
  const chatOpenRaw = cookieStore.get(CHAT_OPEN_COOKIE)?.value;
  const chatOpen = chatOpenRaw !== "false";

  const rawWidth = cookieStore.get(CHAT_WIDTH_COOKIE)?.value;
  const parsed = rawWidth !== undefined ? Number(rawWidth) : NaN;
  const chatWidth = Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_WIDTH;

  return { chatOpen, chatWidth };
};
