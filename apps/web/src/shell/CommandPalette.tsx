import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { useApp } from "../app-context.js";
import { createConversation } from "../chat/chat-api.js";
import { SECTIONS } from "./sections.js";

const itemClass =
  "flex cursor-pointer items-center rounded px-3 py-2 text-sm text-muted data-[selected=true]:bg-accent-wash data-[selected=true]:text-ink";

/** Cmd/Ctrl+K command palette — jump to a section or run an action. */
export function CommandPalette({
  toggleTheme,
  logout,
}: {
  toggleTheme: () => void;
  logout: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { tab } = useApp();

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function run(action: () => void | Promise<void>): void {
    setOpen(false);
    Promise.resolve()
      .then(action)
      .catch((err) => {
        console.error("Command palette action failed:", err);
      });
  }

  async function newChat(): Promise<void> {
    const conversationId = await createConversation(tab);
    await navigate({ to: "/chat/$conversationId", params: { conversationId } });
  }

  if (!open) return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss; focus + Esc live on the palette.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard dismiss is the global Esc listener, not a per-element handler.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[18vh]"
      onClick={() => setOpen(false)}
    >
      <Command
        label="Command palette"
        className="w-full max-w-lg overflow-hidden rounded-lg border border-line-strong bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Command.Input
          autoFocus
          placeholder="Jump to a section or run an action…"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-ink outline-none placeholder:text-faint"
        />
        <Command.List className="max-h-80 overflow-y-auto p-2">
          <Command.Empty className="px-3 py-6 text-center text-sm text-muted">
            No matches.
          </Command.Empty>
          <Command.Group heading="Sections">
            {SECTIONS.map((section) => (
              <Command.Item
                key={section.to}
                className={itemClass}
                onSelect={() => run(() => navigate({ to: section.to }))}
              >
                {section.label}
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading="Actions">
            <Command.Item className={itemClass} onSelect={() => run(newChat)}>
              New chat
            </Command.Item>
            <Command.Item className={itemClass} onSelect={() => run(toggleTheme)}>
              Toggle theme
            </Command.Item>
            <Command.Item className={itemClass} onSelect={() => run(logout)}>
              Log out
            </Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
