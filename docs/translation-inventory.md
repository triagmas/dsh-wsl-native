# English translation inventory — merge gate

**Snapshot:** 2026-11-05, source tree at `f7bfac9`. This is a file-content audit of Markdown documents (counts are Unicode Han characters; a few characters may occur only inside literal quoted UI examples). It is **not** a complete source-comment audit.

## Canonical English documents already created or updated

- [README.md](../README.md)
- [AGENTS.md](../AGENTS.md)
- [project-context.md](project-context.md)
- [product-spec.md](product-spec.md)
- [architecture.md](architecture.md)
- [roadmap.md](roadmap.md)
- [status.md](status.md)
- [decisions.md](decisions.md)
- [documentation-policy.md](documentation-policy.md)
- [migration-0.8.0.md](migration-0.8.0.md)
- [r04-isolated-test.md](r04-isolated-test.md) — mostly English; one incidental Chinese glyph in a literal/example.
- [r04-local-test.md](r04-local-test.md) — mostly English; one incidental Chinese glyph in a literal/example.

## Explicitly localized Markdown — permitted exceptions

- [README.ru.md](../README.ru.md) — Russian.
- [README.zh-CN.md](../README.zh-CN.md) — Simplified Chinese.

These are translations. English `README.md` remains authoritative.

## Legacy documents needing English translation before main merge

| File | Approximate Han characters in this snapshot | Action |
| --- | ---: | --- |
| [CHANGELOG.md](../CHANGELOG.md) | 2,786 | Translate existing release history faithfully, preserve dates and provenance |
| [desktop.md](desktop.md) | 1,947 | Translate; correct stale package/installation examples and link to official fork |
| [inheritance.md](inheritance.md) | 1,096 | Translate; retain details and credential handling caveats |
| [research.md](research.md) | 1,185 | Translate; retain historical date and qualify untested claims |
| [third-party-notices.md](third-party-notices.md) | 21 | Translate heading/explanation; **leave original legal license text untouched** |
| [troubleshooting.md](troubleshooting.md) | 1,969 | Translate all user-help prose and warnings |
| [usage.md](usage.md) | 3,545 | Translate full tool/CLI references without modifying commands |
| [validation.md](validation.md) | 1,073 | Translate historical evidence; do not promote old results to v0.8.0 |
| [validation-0.2.0.md](validation-0.2.0.md) | 1,557 | Translate faithfully |
| [validation-0.3.0.md](validation-0.3.0.md) | 1,099 | Translate faithfully |
| [validation-0.4.0.md](validation-0.4.0.md) | 831 | Translate faithfully |
| [validation-0.5.0.md](validation-0.5.0.md) | 703 | Translate faithfully |
| [workspaces.md](workspaces.md) | 1,338 | Translate; retain historical version labels |

**Status: NOT DONE.** Do not merge to `main` while these maintained documents remain non-English, unless the owner explicitly changes the language requirement.

## Further required audit

- Check all maintained `src/`, `scripts/`, `test/`, `bin/`, `types/` and repository configuration text for Chinese/Russian **comments or non-localized prose**.
- Leave translation dictionaries in `src/i18n/en.ts`, `ru.ts`, `zh-CN.ts` intact and complete. Do not translate actual Russian or Chinese UI translations into English.
- Preserve raw fixtures, captured logs, historical quotations, paths, literal UI labels, third-party licenses and machine formats where their bytes or provenance are relevant.
- Verify every Markdown link, image, code block, language switch and path after translation.
- Remove links that incorrectly imply the triagmas 0.8.0 draft package has already been published on the original upstream's GitHub Releases page.
- Add a language/inventory validation gate before final merge; do not falsely claim existing CI proves English-language compliance.
- Re-run `npm run verify` and GitHub Actions after translation commits.

## Task assignment for the final documentation stage

Perform as a documentation/localization package, **not as an architecture change**: translate all remaining canonical prose into English; maintain the two optional localized README files; preserve all three application UI dictionaries. Keep the existing Draft PR unless asked otherwise. Report to the owner **in Russian** with changed-file and line counts and a complete list of any translation exceptions.
