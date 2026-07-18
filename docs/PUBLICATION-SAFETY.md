# Publication Safety

This document prevents private scholarship from being published with the TailorTeX source code.

## Data boundary

The application repository contains software only. Runtime research projects live under `projects/` and generated compilation data under `work/`. Both locations are excluded from Git.

The following content is private by default:

- unpublished or submitted manuscripts;
- downloaded papers and supplementary files;
- literature notes, review notes, and annotations;
- BibTeX libraries and citation-verification material;
- participant data or research artifacts;
- submission receipts, decision letters, and email drafts;
- AI inboxes, session identifiers, prompts, and replies;
- Firebase configuration, tokens, private keys, and local agent settings.

## Before the first public push

1. Run `npm run test:public`.
2. Review `git status --short` and `git ls-files` manually.
3. Review the complete Git history for research-like file names.
4. Confirm that screenshots use synthetic data.
5. Confirm that `.mcp.json` contains no credentials or personal absolute paths.
6. Select and add an open-source license.
7. Push to a new private remote first and inspect the repository as a fresh clone.
8. Only then change repository visibility to public.

Useful manual history check:

```bash
git log --all --name-only --pretty=format: | sort -u
```

If private material was ever committed, deleting the working-tree file is not enough. Stop publication and rewrite the affected Git history before pushing. Rotate any exposed credential even after history is rewritten.

## Safe examples

Tests and documentation should use invented titles, authors, citations, comments, and submission records. A bibliographic fact being public does not automatically grant permission to redistribute a downloaded paper.

## Current audit

Before the initial release preparation, the tracked tree and Git path history were checked for `projects/`, `work/`, PDF, TeX, BibTeX, DOCX, and archive files. No research-project files were found in Git history. This statement should be rechecked immediately before publication.
