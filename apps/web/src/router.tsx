import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { ChatIndex, ChatSection } from "./chat/chat-section.js";
import { Shell } from "./shell/Shell.js";
import { StubSection } from "./shell/StubSection.js";

const rootRoute = createRootRoute({ component: Shell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/chat" });
  },
});

const chatIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat",
  component: ChatIndex,
});

const chatConversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat/$conversationId",
  component: ChatSection,
});

function MemorySection() {
  return (
    <StubSection title="Memory" note="Hindsight browser, search, and trust filters — Phase 4." />
  );
}

function AgentSection() {
  return (
    <StubSection title="Agent" note="Profiles, models, MCP servers, and skills — next slice." />
  );
}

function SystemSection() {
  return (
    <StubSection
      title="System"
      note="Scheduled tasks, coding tasks, and the evolution audit — next slice."
    />
  );
}

const memoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/memory",
  component: MemorySection,
});

const agentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agent",
  component: AgentSection,
});

const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/system",
  component: SystemSection,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  chatIndexRoute,
  chatConversationRoute,
  memoryRoute,
  agentRoute,
  systemRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

export { chatConversationRoute };

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
