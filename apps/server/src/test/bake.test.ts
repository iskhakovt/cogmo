import { describe, expect, it } from "vitest";
import { withArgDefaults } from "./bake.js";

const DOCKERFILE = `# syntax=docker/dockerfile:1
ARG TOOL_VERSION
FROM example/tool:\${TOOL_VERSION} AS tool
FROM example/base
ARG CLI_VERSION
ARG LOCALE=C.UTF-8
RUN install "cli@\${CLI_VERSION:?}"
`;

describe("withArgDefaults", () => {
  it("writes each value in as the ARG's default, global and stage-scoped alike", () => {
    const result = withArgDefaults(DOCKERFILE, { TOOL_VERSION: "0.12.18", CLI_VERSION: "2.1.280" });
    expect(result).toBe(
      DOCKERFILE.replace("ARG TOOL_VERSION\n", "ARG TOOL_VERSION=0.12.18\n").replace(
        "ARG CLI_VERSION\n",
        "ARG CLI_VERSION=2.1.280\n",
      ),
    );
  });

  it("replaces a default the way a build arg overrides it", () => {
    const result = withArgDefaults(DOCKERFILE, {
      TOOL_VERSION: "1",
      CLI_VERSION: "2",
      LOCALE: "en_GB.UTF-8",
    });
    expect(result).toContain("ARG LOCALE=en_GB.UTF-8\n");
    expect(result).not.toContain("C.UTF-8");
  });

  it("takes a digest as a value", () => {
    const digest = "sha256:3adc3706091ce7c2fe595e669628caedd6d951551b92b258b7e7dbe06d9440bc";
    const result = withArgDefaults(`ARG DIGEST\nFROM example/tool@\${DIGEST}\n`, {
      DIGEST: digest,
    });
    expect(result).toBe(`ARG DIGEST=${digest}\nFROM example/tool@\${DIGEST}\n`);
  });

  it("throws on an ARG left with no value", () => {
    expect(() => withArgDefaults(DOCKERFILE, { TOOL_VERSION: "0.12.18" })).toThrow(
      "ARG CLI_VERSION has no default and no value to fill in",
    );
  });

  it("throws on a value the Dockerfile declares no ARG for", () => {
    expect(() =>
      withArgDefaults(DOCKERFILE, { TOOL_VERSION: "1", CLI_VERSION: "2", NPM_VERSION: "3" }),
    ).toThrow("the Dockerfile declares no ARG for NPM_VERSION");
  });

  it("throws on a value that would need quoting", () => {
    expect(() =>
      withArgDefaults(DOCKERFILE, { TOOL_VERSION: "1", CLI_VERSION: "2 && curl evil" }),
    ).toThrow("ARG CLI_VERSION value 2 && curl evil needs quoting");
  });

  it("matches ARG only as an instruction, not inside a comment or RUN", () => {
    const source = "# ARG CLI_VERSION is set by bake\nARG CLI_VERSION\nRUN echo ARG CLI_VERSION\n";
    expect(withArgDefaults(source, { CLI_VERSION: "2" })).toBe(
      "# ARG CLI_VERSION is set by bake\nARG CLI_VERSION=2\nRUN echo ARG CLI_VERSION\n",
    );
  });
});
