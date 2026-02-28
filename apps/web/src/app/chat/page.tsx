import { ChatPanel } from "@/ui/chat/ChatPanel";

export default function ChatPage() {
  return (
    <main className="container" style={{ display: "flex", justifyContent: "center" }}>
      <ChatPanel mode="fullscreen" />
    </main>
  );
}
