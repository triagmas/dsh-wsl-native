# Documentation and language policy

## Mandatory default for merge into main

**English is the canonical language of this repository.**

Before `feat/r01-typescript` can merge, the following maintained, human-readable source material must be in English:

- Root `README.md` and ordinary repository `*.md` files.
- `docs/*.md`, including architecture, installation, usage, troubleshooting, validations, research and the historical changelog.
- `AGENTS.md` and contributor/developer instructions.
- Source code comments, public-facing technical docs, human-readable scripts and non-localized messages.

Translate **meaning**, keeping functionality, command syntax, anchors/links, code, filenames and technical accuracy. Update stale version/path references in the same review. Do not silently discard older validation evidence.

### Deliberate exceptions

These must **not** be forcibly converted into English:

- The actual `ru` and `zh-CN` application locale dictionaries: these translations are required.
- Explicitly localized documentation, e.g. `README.ru.md`, `README.zh-CN.md` or `docs/i18n/ru/` and `docs/i18n/zh-CN/`.
- Licenses and third-party legal notices where original legal wording must remain verbatim.
- User-supplied data, snapshots, historical logs, test fixtures, machine-readable formats and external quotations where modifying original bytes would change evidence.
- Identifiers, API keys in *sample names only*, CLI parameters, paths, schemas and command output.

Do not localize program logic. All product UI translations live in the established `src/i18n/` source dictionaries with EN as fallback. Translation checks must remain green.

## README convention

- `README.md`: authoritative English overview and installation/status references.
- `README.ru.md`: Russian translation for readers.
- `README.zh-CN.md`: Simplified Chinese translation for readers.
- Link the alternatives at the top of all three and keep factual product/installation warnings aligned.
- Do not link to a nonexistent fork release. A draft package in CI or on a developer machine is **not** a published GitHub Release.

## Communication convention

**Pi and other agents must always respond to the owner in Russian** unless the owner explicitly requests another response language. This is independent of the English-canonical repository rule.

## Audit/merge gate

Use a textual inventory of all maintained files. Record for each: English complete / localized exception / immutable evidence / needs translation. Do not infer that passing TypeScript or i18n tests proves prose comments are English. Full translation may need a dedicated documentation-only PR/commit before release.

## Documentation hierarchy

1. [Project context](project-context.md) — motivation and scope.
2. [Product specification](product-spec.md) — requirements.
3. [Architecture](architecture.md) — existing design; keep it consistent with actual code.
4. [Roadmap](roadmap.md) — staged work and acceptance gates.
5. [Current status](status.md) — verified progress and blockers.
6. [Decisions](decisions.md) — explicit scope/technology decisions.
7. Operational guides and historical validation reports.

A source-code behavior that contradicts this documentation should be reported and corrected. Avoid speculative claims of current integrations that have not run in the Desktop.
