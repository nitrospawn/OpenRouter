# Project Operational Rules & Agent Behaviors

## Discovery & Proactive File Resolution
- **Never claim a file is missing without searching first**: If a user or prompt references a file name or path (e.g. `prd.md`, `schema.prisma`, `config.json`) and it cannot immediately be found at the root path or in open editors:
  1. **Do NOT bail out or immediately respond** claiming the file doesn't exist or asking the user to open/paste/type it.
  2. **Silently execute a workspace search first**: Use directory listing, ripgrep/grep search, or a terminal search (e.g. `dir /s /b *<filename>*` or `find`) to locate matches across subdirectories (e.g., `Docs/PRD.md`, `specs/`, `documentation/`).
  3. Check for case variations, alternative extensions, or similar names in the workspace.
  4. Only if all automated search attempts return zero results should you notify the user or request clarification.

---

## Mandatory Execution & Verification Order (No Hallucinated Passes)
- **Environment & Dependency Gate Before Any Work**:
  1. Before making assumptions, generating code plans, or claiming build viability, ensure the environment and dependencies are actively resolved.
  2. Never assume `pub get`, `npm install`, or dependency sync succeeded without actual execution proof.
- **Physical Test Execution is Mandatory**:
  1. **NEVER** write or announce that tests passed ("All green", "All tests passed", "Build succeeded") unless the relevant test command (e.g. `flutter test`, `npm test`, `pytest`) was physically run in the terminal during the active task and returned an exit code of 0.
  2. Fabricating test outcomes, pre-emptively writing pass/fail summaries before running commands, or skipping test execution is strictly forbidden.
- **Implementation & Walkthrough Artifacts Are Final Deliverables**:
  1. Walkthrough, results documentation, and implementation completion reports MUST be generated as the **very last step** — ONLY after all test commands and static analyzers have physically completed and succeeded on the terminal.
  2. If tests fail, dependencies cannot resolve, or network errors occur, the agent must halt, diagnose the failure, and present the raw error to the user rather than entering blind retry loops or writing completion summaries.
