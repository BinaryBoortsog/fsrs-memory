# Contributing to fsrs-memory

Thanks for considering contributing! This document provides a lightweight set of rules to keep contributions high quality and consistent.

- Follow Standard JavaScript style (ESLint recommended). Keep code readable and well-structured.
- Run tests and make sure they pass before opening a PR:

```bash
npm test
```

- Create a feature branch named `feat/short-descriptive-name` or `fix/short-description`.
- Open a Pull Request against `main` with a clear title and short summary of changes.
- Include or update unit tests for new behavior.
- Keep changes focused: small PRs are reviewed faster.
- Use conventional commit messages where possible (e.g., `feat: add backup_diff tool`).

Review process

- CI must pass on the PR before merging.
- Reviewers may request changes; please respond promptly.

Coding guidelines

- Prefer clarity over cleverness.
- Avoid large unrelated refactors in the same PR as a feature.

Security and responsible disclosure

- If you discover a security issue, please see `SECURITY.md` for reporting instructions.

Thank you — maintainers will do their best to review promptly.