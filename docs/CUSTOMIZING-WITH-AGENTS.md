# Customizing TailorTeX with Codex or Claude Code

You do not need to design your ideal interface all at once. Start with one barrier, ask an agent to change it, try the result yourself, and continue from what you learn.

This guide uses Codex and Claude Code as examples. The same approach can work with another coding agent that can edit the repository and run its tests.

## 1. Make a personal fork

Fork the TailorTeX repository on your Git hosting service, then clone your fork to the Mac where you write.

```bash
git clone <your-fork-url>
cd tailortex
npm install
npm start
```

Keep real manuscripts outside the application repository. TailorTeX runtime projects belong under the ignored `projects/` directory. Never add a paper, downloaded PDF, bibliography, submission record, or research note to a source-code commit.

## 2. Open the repository with an agent

Open the cloned `tailortex` directory in Codex or Claude Code. Ask the agent to read these files before making a substantial change:

- `README.md`
- `docs/DESIGN-PHILOSOPHY.md`
- `docs/CORE-AND-ADAPTATIONS.md`
- `CONTRIBUTING.md`

You can begin with:

```text
Read the TailorTeX design philosophy and core/adaptation boundary. I am making a
personal accessibility fork. Help me change the interface around my needs
without changing project-file meanings or collaboration protocols.
```

## 3. Describe the barrier, not only the feature

Agents make better choices when they understand what is difficult, where it happens, and what a successful interaction would feel like. You do not need to disclose a diagnosis.

Useful details include:

- the device, screen size, input method, or assistive technology;
- the exact task you were trying to complete;
- what was hard to perceive, reach, remember, time, or confirm;
- what you currently do as a workaround;
- whether the change is only for your fork or should be proposed upstream.

Example:

```text
On iPad I lose track of the file tree when several folders are open. In my
personal fork, start every project with all folders closed, make folder rows
taller, and keep the selected path visible. Do not change the project format.
Show me the result at iPad width and run the existing tests.
```

## 4. Ask for one observable change at a time

Small changes are easier to evaluate with your own body and workflow. Ask the agent to keep unrelated behavior unchanged.

Examples:

```text
Increase every primary touch target to at least 52 CSS pixels on screens below
800 pixels wide. Preserve desktop density. Check the AI chat, file tree, and
version panel in both light and dark mode.
```

```text
I read more comfortably when the current action stays near the bottom edge.
Move the comment composer and AI composer to a persistent bottom area in my
fork. Keep focus order logical and do not cover content when the iPad keyboard
opens.
```

```text
Add a low-stimulation mode that removes nonessential animation, reduces visual
separators, and keeps status changes textual. Respect prefers-reduced-motion,
but also provide a manual setting because my preference is not device-wide.
```

```text
Create a keyboard-only workflow for switching between the document, PDF,
comments, and file tree. Reuse existing focus-management conventions and tell
me the final shortcuts before changing them.
```

## 5. Let the agent point, then judge for yourself

Ask the agent to show exactly what changed and where to test it.

```text
After implementing this, open the interface at 1024x768 and 1366x1024. Point
me to each changed control, explain the expected interaction, and leave the
server running so I can try it myself. Do not decide that it is accessible only
because an automated check passes.
```

Your experience is the acceptance test. If the result is worse, say so directly and describe what you noticed. Iteration is expected.

## 6. Require preservation and verification

Use a safety ending in modification prompts:

```text
Preserve my existing changes and research projects. Do not edit files under
projects/ except when I explicitly ask for a project operation. Run syntax,
regression, and publication-safety checks. Summarize changed files and any
remaining uncertainty.
```

The standard checks are:

```bash
npm run test:syntax
npm test
npm run test:public
```

For interface changes, also ask for keyboard, dark-mode, zoom, reduced-motion, screen-reader naming, touch-target, and iPad viewport checks when relevant.

## 7. Know when to keep a fork and when to open a pull request

It is normally safe to keep a change only in your fork when it changes presentation or operation while preserving the same underlying meaning. Examples include:

- contrast, typography, spacing, density, and panel layout;
- default open or closed states;
- gestures, timing, keyboard shortcuts, sound, or haptics;
- simplified or specialized views over the same data;
- screen-reader wording and alternative navigation.

Ask the agent to prepare an upstream issue or pull request when a change affects:

- LaTeX conversion or publication output;
- project files, directories, links, import, or export;
- comments, locks, synchronization, or shared identifiers;
- version branches or frozen submission evidence;
- MCP tools, AI request formats, or pointer semantics;
- backup, privacy, recovery, path safety, or data integrity.

Use this prompt when uncertain:

```text
Classify this change using docs/CORE-AND-ADAPTATIONS.md. Explain whether another
TailorTeX fork or collaborator would need to change. If it touches the shared core,
prepare it as a focused pull request instead of making a fork-only protocol.
```

## 8. Ask an agent to prepare the pull request

For a core improvement:

```text
Turn this into an upstream-ready change. Keep the patch focused, preserve
backward compatibility where possible, add regression tests, document any
migration, and draft a pull-request description explaining the accessibility
need without requiring private medical information.
```

Do not include a real manuscript or private screenshot in the pull request. Use synthetic fixtures.

## 9. Keep a short customization record

Create a small document in your fork, for example `docs/MY-ACCESS-SETUP.md`, containing:

- the barriers the fork addresses;
- important preferences and why they exist;
- the commands used to test the fork;
- intentional differences from upstream;
- core pull requests that the fork depends on.

This helps a future agent preserve choices that are easy to mistake for arbitrary styling.

Example instruction:

```text
Read docs/MY-ACCESS-SETUP.md before changing the interface. Treat its decisions
as user requirements. If a new request conflicts with it, show me the conflict
instead of silently restoring the upstream design.
```

## 10. Example first conversation

```text
You are helping me adapt my personal TailorTeX fork.

My current barrier:
On iPad, dense side panels and small controls make it difficult to confirm what
I selected. I prefer fewer simultaneous choices and large stable targets.

Please:
1. Read the project philosophy and core/adaptation boundary.
2. Inspect the current file tree, comments, versions, and AI chat.
3. Propose three small interface changes without changing shared data formats.
4. Implement only the lowest-risk proposal first.
5. Test it in light and dark mode at iPad width.
6. Leave the app running and tell me exactly where to try it.
7. Preserve all existing projects and unrelated changes.

I will judge whether it is actually easier and then tell you what to change
next.
```

The aim is not to make your interface look like the upstream interface. The aim is to keep the shared foundation reliable while making the experience genuinely yours.
