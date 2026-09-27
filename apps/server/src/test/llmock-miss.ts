/**
 * Explains an llmock request no fixture matched: the request's match key and
 * the cassette fixtures closest to it, each with the fields where it differs.
 * Takes the request after `requestTransform`, which is what fixtures are
 * compared against. Under `src/` so it is tsc-checked; used by
 * `test/llmock-setup.ts`.
 */
import { type ChatCompletionRequest, type Fixture, getTextContent } from "@copilotkit/aimock";

export interface CassetteFixture {
  readonly fixture: Fixture;
  /** File the fixture was loaded from, relative to the cassette directory. */
  readonly file: string;
}

const EXCERPT = 60;
const CANDIDATES = 3;

function lastUserText(req: ChatCompletionRequest): string | undefined {
  const last = req.messages.findLast(
    (m) => m.role === "user" && getTextContent(m.content) !== null,
  );
  return last === undefined ? undefined : (getTextContent(last.content) ?? undefined);
}

function currentTurnHasToolResult(req: ChatCompletionRequest): boolean {
  const lastUser = req.messages.findLastIndex((m) => m.role === "user");
  return req.messages.slice(lastUser + 1).some((m) => m.role === "tool");
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** A window of `text` around `at`, JSON-quoted, with ellipses where it is cut. */
function quote(text: string, at: number): string {
  const start = Math.max(0, at - EXCERPT / 2);
  const slice = JSON.stringify(text.slice(start, start + EXCERPT));
  return `${start > 0 ? "…" : ""}${slice}${start + EXCERPT < text.length ? "…" : ""}`;
}

/** The text a fixture of this request's kind is keyed on. */
function keyText(req: ChatCompletionRequest): string | undefined {
  return req.embeddingInput ?? lastUserText(req);
}

function fixtureText(fixture: Fixture): string | undefined {
  const { userMessage, inputText } = fixture.match;
  const text = inputText ?? userMessage;
  return typeof text === "string" ? text : undefined;
}

function modelMatches(fixtureModel: string, requestModel: string): boolean {
  if (fixtureModel === requestModel) return true;
  return (
    requestModel.startsWith(fixtureModel) && /^-\d/.test(requestModel.slice(fixtureModel.length))
  );
}

function differences(req: ChatCompletionRequest, fixture: Fixture, text: string): string[] {
  const { match } = fixture;
  const diffs: string[] = [];
  const own = fixtureText(fixture);
  if (own !== undefined && own !== text) {
    const at = commonPrefix(own, text);
    diffs.push(`text differs at char ${at}: fixture ${quote(own, at)}, request ${quote(text, at)}`);
  }
  if (typeof match.model === "string" && !modelMatches(match.model, req.model)) {
    diffs.push(`model ${match.model}`);
  }
  if (match.hasToolResult !== undefined && match.hasToolResult !== currentTurnHasToolResult(req)) {
    diffs.push(`hasToolResult ${match.hasToolResult}`);
  }
  if (
    match.toolName !== undefined &&
    !(req.tools ?? []).some((t) => t.function.name === match.toolName)
  ) {
    diffs.push(`toolName ${match.toolName}`);
  }
  if (match.endpoint !== undefined && match.endpoint !== req._endpointType) {
    diffs.push(`endpoint ${match.endpoint}`);
  }
  return diffs;
}

/** One-paragraph account of a miss, for the 503 body and the failing test's report. */
export function describeMiss(
  req: ChatCompletionRequest,
  cassette: ReadonlyArray<CassetteFixture>,
): string {
  const text = keyText(req) ?? "";
  const tools = (req.tools ?? []).map((t) => t.function.name);
  const key = [
    `endpoint=${req._endpointType ?? "chat"}`,
    `model=${req.model}`,
    `turn=${req.messages.filter((m) => m.role === "assistant").length}`,
    `hasToolResult=${currentTurnHasToolResult(req)}`,
    ...(tools.length > 0
      ? [`tools=${tools.slice(0, 5).join(",")}${tools.length > 5 ? ",…" : ""}`]
      : []),
    // A turn's user message opens with its turn context; the words that
    // tell requests apart are at the end.
    `text=(${text.length} chars) ${quote(text, text.length - EXCERPT / 2)}`,
  ].join(" ");

  const ranked = cassette
    .map((c) => {
      const own = fixtureText(c.fixture);
      const modelOk =
        typeof c.fixture.match.model !== "string" || modelMatches(c.fixture.match.model, req.model);
      return { c, prefix: own === undefined ? -1 : commonPrefix(own, text), modelOk };
    })
    .filter((r) => r.prefix >= 0)
    .toSorted((a, b) => b.prefix - a.prefix || Number(b.modelOk) - Number(a.modelOk))
    .slice(0, CANDIDATES);

  const closest =
    cassette.length === 0
      ? "  the cassette is empty"
      : ranked.length === 0
        ? "  no fixture in the cassette is keyed on text"
        : ranked
            .map(
              ({ c }) =>
                `  ${c.file}: ${differences(req, c.fixture, text).join("; ") || "no difference found"}`,
            )
            .join("\n");
  return `no fixture matched ${key}\nclosest of ${cassette.length} in the cassette:\n${closest}`;
}
