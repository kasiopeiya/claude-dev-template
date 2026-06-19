---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

When a question's answer can be narrowed to 3 or more concrete options, you MUST use the AskUserQuestion tool to present them.

If a question can be answered by exploring the codebase, explore the codebase instead.

When the plan implies documentation changes, ask which document's purpose (対象読者・目的) each piece of resulting content belongs to. Content that doesn't serve any existing document's purpose belongs elsewhere, or nowhere — surface this before it gets frozen into a task list. This catches purpose-mismatch at the source, since downstream sessions treat the issue's task list as ground truth.
