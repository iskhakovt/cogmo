// Browser-mode assertion matchers (`expect.element(...).toBeVisible()`, etc.) and
// the `@vitest/browser/context` globals. Ambient so the `.test.tsx` tier type-checks
// under the app's `tsc --noEmit` without each file re-referencing them.
/// <reference types="@vitest/browser/context" />
