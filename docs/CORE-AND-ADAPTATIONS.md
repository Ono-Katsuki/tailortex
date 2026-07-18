# Core Functions and Accessibility Adaptations

TailorTeX separates its interoperable core from its adaptable user experience. This boundary allows researchers to create deeply personal accessibility interfaces without making their projects incompatible with collaborators.

## Main functions: the interoperable core

The following are **main functions**. They are beta functionality, not fixed or presumed correct. Issues and improvements are welcome. Changes to their behavior, schemas, or guarantees should be proposed upstream through an issue or pull request before a fork depends on them, so the ecosystem can improve without silently fragmenting.

### 1. Document fidelity

- conversion between the visual document and `main.tex`;
- LaTeX import, export, compilation, and clean publication output;
- BibTeX storage, citation identifiers, and bibliography generation;
- preservation of unsupported or raw TeX without silent loss;
- separation of publication text from comments, AI metadata, and working links.

### 2. Project interoperability

- project directory structure and `project.json` semantics;
- the meaning and location of `main.tex`, `main.html`, `refs.bib`, `notes/`, and `attachments/`;
- file-link syntax and links between notes, papers, and document locations;
- project import, export, archive, and migration behavior.

### 3. Collaboration

- synchronization messages and paragraph-lock behavior;
- comments, anchored threads, replies, pointers, and presence data;
- stable identifiers used to reconnect a discussion to document text or a file;
- compatibility between collaborators using different accessibility forks.

### 4. Versions and submission evidence

- draft/version branch semantics and safe switching;
- automatic preservation of uncommitted work;
- frozen submission records, manifests, timestamps, commit references, and SHA-256 hashes;
- immutability and recovery guarantees for submitted artifacts.

### 5. Agent interoperability

- MCP tool names, inputs, outputs, and error behavior;
- placement rules for agent-created notes, sources, and bibliography data;
- browser-to-Mac request, reply, streaming, session, and pointer formats;
- backup behavior and separation of AI conversation from publication files.

### 6. Safety and data integrity

- atomic saves, rollback, recovery copies, and catastrophic-shrink protection;
- path validation and project-boundary enforcement;
- privacy boundaries between source code and research data;
- permission checks for collaboration, cloud storage, and local-only agent actions.

## Adaptation surface: freely changeable in a fork

Forks are encouraged to change the following when the underlying core meaning remains compatible:

- colors, contrast, typography, spacing, density, and dark-mode palettes;
- panel placement, default open/closed state, reading order, and responsive layout;
- pointer target size, gesture timing, long-press behavior, and animation;
- keyboard shortcuts, focus order, switch access, and alternative input methods;
- screen-reader wording, speech output, sound, haptics, and status presentation;
- simplified, expanded, or task-specific views over the same project data;
- local preferences and presets for a particular researcher or community.

An adaptation may replace the entire interface. It remains interoperable when it reads and writes the same project meanings and does not weaken the core safety guarantees.

## Quick decision test

A change belongs to the main core if **any** of these are true:

1. Another user's project may no longer open or mean the same thing.
2. Two collaborators may disagree about document, comment, version, or lock state.
3. TeX, citations, submissions, or agent links may be lost or changed silently.
4. An MCP client or another accessibility fork must change to remain compatible.
5. The change weakens privacy, recovery, integrity, or publication guarantees.

If none apply and the change only affects how a person perceives or operates the interface, it normally belongs to the adaptation surface.

When uncertain, open a proposal, issue, or draft pull request. The purpose is coordination, not gatekeeping. A report that only explains why the current behavior is inadequate is still a valuable contribution.
