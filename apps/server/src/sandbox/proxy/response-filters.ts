/**
 * What the proxy reads from a daemon response: the exec id an exec create
 * names, and the filters that keep a task to its own objects
 * (design/sandbox.md → Proxy Design → Route table, Lists and Events). A
 * container list keeps the containers whose rows the task owns. An event
 * stream keeps the lines of the task's own container, by `Actor.ID`, and of
 * its children, whose `Actor.Attributes["cogmo.parent"]` is that
 * container's id: the daemon copies a container's labels into its events,
 * and the create policy overwrites any `cogmo.*` label a task sends. A line
 * labelled only with the task's `cogmo.root_task` is dropped, since Cogmo's
 * other depth-0 containers for the task, such as salvage, carry it too, and
 * so are network and volume events, which carry no such attribute.
 */

import { Transform } from "node:stream";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { type ProxyRejection, unavailable } from "./rejection.js";

/**
 * Bound on one event line, in bytes. A container event carries the
 * container's labels, which the task chose but could not make larger than
 * its create body's 1 MiB. A line past this is dropped up to its newline,
 * whether it ends in the chunk that crossed the bound or a later one. The
 * stream is split on the newline byte, which no UTF-8 sequence contains.
 */
const MAX_EVENT_LINE_BYTES = 4 * 1024 * 1024;

const NEWLINE = 0x0a;
const NEWLINE_BYTES = Buffer.from([NEWLINE]);

const PARENT_ATTRIBUTE = "cogmo.parent";

const ContainerListSchema = z.array(z.looseObject({ Id: z.string() }));

const ExecCreatedSchema = z.object({ Id: z.string().regex(/^[0-9a-f]{64}$/) });

const EventSchema = z.looseObject({
  Actor: z.looseObject({
    ID: z.string().optional(),
    Attributes: z.record(z.string(), z.string()).nullable().optional(),
  }),
});

/** The `GET /containers/json` reply with only the owned containers, re-serialised. */
export function filterContainerList(
  raw: Buffer,
  owned: ReadonlySet<string>,
): Result<Buffer, ProxyRejection> {
  const parsed = ContainerListSchema.safeParse(parseJson(raw.toString("utf8")));
  if (!parsed.success) return err(unavailable("the daemon's container list is not a JSON list"));
  const kept = parsed.data.filter((entry) => owned.has(entry.Id));
  return ok(Buffer.from(JSON.stringify(kept), "utf8"));
}

/** The exec id a `POST /containers/{id}/exec` 201 names, or `null` for a body that names none. */
export function createdExecId(body: Buffer): string | null {
  const parsed = ExecCreatedSchema.safeParse(parseJson(body.toString("utf8")));
  return parsed.success ? parsed.data.Id : null;
}

/**
 * A transform over an NDJSON event stream that passes each line, newline
 * included, only when it is an event of the container `taskContainerId`
 * or of one of its children. A line that is not an event is dropped.
 */
export function taskEventFilter(taskContainerId: string): Transform {
  const keep = (line: Buffer): boolean => {
    const parsed = EventSchema.safeParse(parseJson(line.toString("utf8")));
    if (!parsed.success) return false;
    const { ID, Attributes } = parsed.data.Actor;
    return ID === taskContainerId || Attributes?.[PARENT_ATTRIBUTE] === taskContainerId;
  };
  // The partial line after the last newline, held as the chunks it came in
  // so that each line is copied once; `overlong` once it passed the bound,
  // until its newline.
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let overlong = false;
  /** The line that ends with `last`, with its newline, if it is kept. */
  const endLine = (last: Buffer): Buffer[] => {
    const parts = [...pending, last];
    const bytes = pendingBytes + last.length;
    const skipped = overlong;
    pending = [];
    pendingBytes = 0;
    overlong = false;
    if (skipped || bytes > MAX_EVENT_LINE_BYTES) return [];
    const line = Buffer.concat(parts, bytes);
    return keep(line) ? [line] : [];
  };
  const hold = (tail: Buffer): void => {
    if (overlong || tail.length === 0) return;
    pendingBytes += tail.length;
    if (pendingBytes <= MAX_EVENT_LINE_BYTES) {
      pending.push(tail);
      return;
    }
    pending = [];
    pendingBytes = 0;
    overlong = true;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const kept: Buffer[] = [];
      let start = 0;
      // A stateful scan: each newline ends the line the chunks before it began.
      for (let nl = chunk.indexOf(NEWLINE); nl !== -1; nl = chunk.indexOf(NEWLINE, start)) {
        kept.push(...endLine(chunk.subarray(start, nl)).flatMap((line) => [line, NEWLINE_BYTES]));
        start = nl + 1;
      }
      hold(chunk.subarray(start));
      callback(null, Buffer.concat(kept));
    },
    flush(callback) {
      // A last line the stream ends without a newline is passed as it came.
      callback(null, Buffer.concat(pendingBytes === 0 ? [] : endLine(Buffer.alloc(0))));
    },
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
