---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use for "grill me", 「仕様を詰めたい」「壁打ちして」。
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

If the caller passed an explicit stopping condition in the arguments (another Skill may invoke this one), honor it: once that condition is met, end the interview and hand control back, instead of continuing indefinitely.

When a question's answer can be narrowed to 3 or more concrete options, you MUST use the AskUserQuestion tool to present them.

If a question can be answered by exploring the codebase, explore the codebase instead.

Before and during the interview, read the requirements (docs/requirements.md — the SSOT of requirements, including SLO/SLI), but never in full: it grows large, so locate the headings (`grep -n '^## ' docs/requirements.md`) and read only the 非機能要件 section (which contains SLI/SLO) by line range, plus the specific 機能要件 / スコープ外 subsection whenever the interview touches that feature or boundary (the YAGNI check below needs it). Hold each design decision against them. In particular, a demanding SLO (e.g. tight latency) constrains structural choices — synchronous vs asynchronous, the number of network hops, redundancy — so surface any conflict between the proposed design and the requirements before it freezes into the plan.

When the plan implies documentation changes, ask which document's purpose (対象読者・目的) each piece of resulting content belongs to. Content that doesn't serve any existing document's purpose belongs elsewhere, or nowhere — surface this before it gets frozen into a task list. This catches purpose-mismatch at the source, since downstream sessions treat the issue's task list as ground truth.

As you interview, hold each answer and proposed direction against the refined engineer judgment principles (docs/policy/refined-engineer-judgment-principles.md — the judgment north star). When an answer violates a principle, name the principle and push back before it freezes into the plan. Apply the whole set — e.g. premature tech lock-in (決定を遅らせる), needless complexity (Less is more), drifting from the stated purpose (目的を見失えば、速く進むほど遠ざかる). The most common case: wanting to build something not in the agreed requirements — probe whether it is actually needed (what present need drives it, what breaks if omitted); speculative "we might need it later" additions are YAGNI violations.
