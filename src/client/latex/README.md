# Internal LaTeX language module

NuwaTex uses an incremental Lezer LR parser for LaTeX editing. The grammar
and tokenizer derive from Overleaf's `lezer-latex` at revision
`e039ad26c5bf5422eb57b89fc7e57c75055e631d`; see `THIRD_PARTY_NOTICES.md`
for provenance and the AGPL-3.0 license notice.

- `latex.grammar` and `tokens.mjs` define the structural parser.
- `latex.mjs` and `latex.terms.mjs` are generated and checked in. Run
  `npm run generate:latex-parser` after editing the grammar. Web development,
  web builds and tests regenerate them automatically.
- `index.ts` integrates the parser with CodeMirror, including standard
  highlight tags and structural folding. Folding requires real matching
  environment closes and preserves multiline headings and opening names.
- `indentation.ts` aligns environments, groups and display math, keeps the
  document body at its margin, and preserves raw literal indentation.
- `context.ts` queries cursor-local regions and argument ownership for
  completions. Parsing catch-up is limited to five milliseconds; compatibility
  scans use at most 8,192 UTF-16 code units around a tree-identified command.
  Unavailable contexts defer completion instead of guessing literal state.

The parser accepts common whitespace and comments between command arguments,
starred definitions, internal `@` and expl3 command names, and the literal
environments listed in `shared/latexLiterals.ts`. Incomplete inline literals
stop at the newline. Completion preserves reference aliases, multi-argument
citations and existing environment closes without reading the complete source
prefix. `latexFolding.ts` retains a literal-aware scanner only for completion
and auto-pair end reuse; editor folds use the syntax tree.

Project indexes, reference navigation, math previews, formatting and writing
diagnostics remain separate. This parser does not expand macros, decide whether
a document compiles, or expose recovery nodes as compile diagnostics.

Run the parser regressions with:

```sh
npm test -- tests/latexParser.test.ts tests/latexContext.test.ts tests/latexSyntax.test.ts tests/latexCompletions.test.ts tests/latexIndentation.test.ts
```

Incremental tests compare fresh and `TreeFragment`-reused trees after insertions
and deletions, including node positions. Additional tests cover incomplete
arguments, comments, literal boundaries, folding and indentation.
