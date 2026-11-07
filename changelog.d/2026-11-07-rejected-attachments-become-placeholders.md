Append-only step 4c: an attachment the model provider refuses fails only the turn that sent it; later turns send it as a placeholder.

- **Marking.** When the provider refuses a turn's first count or first iteration with a 400 or 413, `handle-message`'s `onFailure` marks the originals in that turn's rows `rejected` in `attachment_originals`, with why (`bad_request` or `too_large`; migration 0083), before it tells the user to try again.
- **The next turn.** A rejected original loads as `[Document: <name>. The model provider refused this file; ask for it another way.]` in the failed turn's row and arrives as the same placeholder in the re-batched row, documents and images alike. The wording was pinned in 4a, so no epoch opens.
