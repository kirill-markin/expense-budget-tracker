import { headers } from "next/headers";

import { extractWorkspaceIdFromHeaders } from "@/server/userId";
import { ChatPanel } from "@/ui/chat";

export default async function ChatPage() {
  const headersList = await headers();
  const workspaceId = extractWorkspaceIdFromHeaders(headersList);

  return (
    <main className="container" style={{ display: "flex", justifyContent: "center" }}>
      <ChatPanel key={`fullscreen-${workspaceId}`} mode="fullscreen" workspaceId={workspaceId} />
    </main>
  );
}
