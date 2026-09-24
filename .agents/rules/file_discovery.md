# Project Operational Rules & Agent Behaviors

## Discovery & Proactive File Resolution
- **Never claim a file is missing without searching first**: If a user or prompt references a file name or path (e.g. `prd.md`, `schema.prisma`, `config.json`) and it cannot immediately be found at the root path or in open editors:
  1. **Do NOT bail out or immediately respond** claiming the file doesn't exist or asking the user to open/paste/type it.
  2. **Silently execute a workspace search first**: Use directory listing, ripgrep/grep search, or a terminal search (e.g. `dir /s /b *<filename>*` or `find`) to locate matches across subdirectories (e.g., `Docs/PRD.md`, `specs/`, `documentation/`).
  3. Check for case variations, alternative extensions, or similar names in the workspace.
  4. Only if all automated search attempts return zero results should you notify the user or request clarification.
