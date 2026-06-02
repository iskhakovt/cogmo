import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { ChatIndex, ChatSection } from "./chat/chat-section.js";
import { AgentScreen } from "./screens/AgentScreen.js";
import { SystemScreen } from "./screens/SystemScreen.js";
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

const memoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/memory",
  component: MemorySection,
});

const agentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agent",
  component: AgentScreen,
});

const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/system",
  component: SystemScreen,
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

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
