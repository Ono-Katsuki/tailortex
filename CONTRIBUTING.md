# Contributing to TailorTeX

Thank you for helping make research writing more accessible.

TailorTeX is in beta. Its current behavior is not assumed to be correct, complete, or easy to use. Issues and pull requests are welcome for both accessibility adaptations and main functions. Identifying a problem is useful even when you do not yet have a proposed implementation.

## Accessibility adaptations are welcome

Accessibility is contextual. A workflow that works well for one person may create a barrier for another. You are welcome to fork the project and substantially adapt the interface to your own body, disability, assistive technology, language, device, or research practice.

Please document the access need and design reasoning when practical. Lived experience is valid evidence; contributors are not required to disclose a diagnosis or private medical information.

The project treats personal usability as a legitimate design objective, not as a temporary exception to a supposedly universal interface. See the [Design Philosophy](docs/DESIGN-PHILOSOPHY.md).

Researchers who are new to repository customization can use [Customizing TailorTeX with Codex or Claude Code](docs/CUSTOMIZING-WITH-AGENTS.md) for a step-by-step agent-assisted workflow.

## Keep the shared core interoperable

Researchers must still be able to exchange projects and collaborate across different interface forks. The shared core is open to improvement; it simply needs coordination. Please open an issue or pull request when changing shared core behavior, including:

- project directory structure or metadata schemas;
- `main.tex`, BibTeX, Markdown, or linked-file semantics;
- collaboration messages, locks, comments, or synchronization;
- MCP tool names, inputs, outputs, or safety guarantees;
- branch/version and frozen-submission behavior;
- backup, recovery, path validation, and data-loss protection.

The normative list, adaptation surface, and five-question decision test are in [Core Functions and Accessibility Adaptations](docs/CORE-AND-ADAPTATIONS.md). Review that document before changing a shared format or protocol. Its purpose is to make core contributions safer and easier to merge, not to discourage them.

## Issues are welcome

Open an issue for a bug, confusing workflow, inaccessible assumption, missing capability, interoperability problem, or concern about the project's direction. First-hand experience is sufficient; you do not need automated accessibility results or a complete technical diagnosis.

For a main-function proposal, describe the current behavior, desired outcome, compatibility impact if known, and any project data that must be preserved. Never attach a real manuscript or private research material.

An interface fork may present the core differently, but should avoid silently producing an incompatible project. If incompatibility is necessary, use an explicit format version and provide a migration path.

## Pull requests

1. Explain the user need and affected workflow.
2. Keep unrelated changes separate.
3. Preserve existing user files and dirty worktrees.
4. Add or update regression tests for shared behavior.
5. Run the checks below.
6. Never include a real paper, research note, downloaded PDF, bibliography, submission record, credential, or agent conversation.

```bash
npm run test:syntax
npm test
npm run test:public
```

For a major core change, describe compatibility risks, migration behavior, and how collaborators on older forks are affected.

## Accessibility review

Where relevant, test with keyboard-only operation, zoom and reflow, dark mode, reduced motion, visible focus, screen-reader names/status messages, touch targets, and an iPad-sized viewport. Automated checks are useful but do not replace use by disabled researchers.

## Research privacy

Use synthetic fixtures in tests and screenshots. Do not submit third-party papers or copyrighted PDFs, even if they are publicly downloadable. Do not include unpublished findings, participant data, review correspondence, or submission-system exports.
