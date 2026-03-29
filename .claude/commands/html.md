---
description: Compile a markdown file to a styled, self-contained HTML report
argument-hint: <path-to-md-file>
allowed-tools: [Read, Write, Bash, Glob]
---

# Compile Markdown to HTML

The user wants to compile a markdown file into a polished, self-contained HTML document using pandoc.

**Input:** $ARGUMENTS (a markdown file path, relative to repo root or absolute)

## Instructions

1. If no argument given, check if you created or modified any `.md` files in the last few replies — if so, assume those. Otherwise, ask which file to compile.
2. Resolve the file path (relative to repo root if not absolute).
3. Ensure `build/` directory exists.
4. Create a CSS file at `build/.report.css` with GitHub-flavored styling if it doesn't already exist:
   - Clean, modern typography (system font stack)
   - Max-width ~900px, centered, `2rem` padding
   - Table styling: bordered, header background `#f6f8fa`, alternating rows `#f6f8fa`/`#fff`
   - Code blocks: `#f6f8fa` background, rounded corners
   - Blockquotes: left border `#d0d7de`
   - Text: `#24292f`, links `#0969da`, headings with bottom borders on h1/h2
   - Dark mode via `@media (prefers-color-scheme: dark)` — background `#0d1117`, text `#c9d1d9`, tables/code adjusted
   - Print-friendly `@media print` styles
5. Extract the title from the first `# heading` in the markdown file.
6. Run pandoc with `--metadata pagetitle=` (sets `<title>` in `<head>` without rendering a duplicate title in the body):
   ```
   pandoc <input.md> \
     --from gfm \
     --to html5 \
     --standalone \
     --embed-resources \
     --css build/.report.css \
     --metadata pagetitle="<title from first heading>" \
     --output build/<basename>.html
   ```
7. Open the output in the browser: `xdg-open <absolute-path>`.
8. Print the absolute path.

## Notes

- Use `--from gfm` for GitHub-flavored markdown (tables, task lists, strikethrough).
- Use `--embed-resources --standalone` to produce a single self-contained HTML file.
- The CSS file is written once and reused across invocations.
- Output goes to `build/` which is gitignored.
