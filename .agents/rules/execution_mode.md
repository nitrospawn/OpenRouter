# Rule: Q&A vs. Execution Mode

**1. Question Mode (Informational):**
When the user asks a question (e.g., "Does this file exist?", "How does this work?", "What do you think?"): 
- Your goal is purely informational. 
- You may use tools to investigate (read files, list directories, search).
- You must **NOT** write files, edit code, or execute implementation commands. 
- Answer the question and end your turn.

**2. Execution Mode (Implementation):**
When the user explicitly requests implementation or action (e.g., "Proceed", "Implement this", "Fix the bug", "Go ahead"): 
- You have full authorization to execute. 
- Proceed autonomously with writing code, creating files, and running necessary commands to achieve the goal.
- Do not stop or pause to ask trivial questions (e.g., missing standard documentation folders). Only halt execution if you encounter a critical, destructive blocker that requires the user's explicit safety approval.
