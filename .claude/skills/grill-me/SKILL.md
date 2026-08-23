---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use for "grill me", 「仕様を詰めたい」「壁打ちして」。Pass --small to keep the resulting spec to the thinnest end-to-end slice and defer the rest.
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

If the caller passed an explicit stopping condition in the arguments (another Skill may invoke this one), honor it: once that condition is met, end the interview and hand control back, instead of continuing indefinitely.

When a question's answer can be narrowed to 3 or more concrete options, you MUST use the AskUserQuestion tool to present them.

If a question can be answered by exploring the codebase, explore the codebase instead.

Before and during the interview, read the requirements (docs/requirements.md — the SSOT of requirements, including SLO/SLI), but never in full: it grows large, so locate the headings (`grep -n '^## ' docs/requirements.md`) and read only the 非機能要件 section (which contains SLI/SLO) by line range, plus the specific 機能要件 / スコープ外 subsection whenever the interview touches that feature or boundary (the YAGNI check below needs it). Hold each design decision against them. In particular, a demanding SLO (e.g. tight latency) constrains structural choices — synchronous vs asynchronous, the number of network hops, redundancy — so surface any conflict between the proposed design and the requirements before it freezes into the plan.

When the plan implies documentation changes, ask which document's purpose (対象読者・目的) each piece of resulting content belongs to. Content that doesn't serve any existing document's purpose belongs elsewhere, or nowhere — surface this before it gets frozen into a task list. This catches purpose-mismatch at the source, since downstream sessions treat the issue's task list as ground truth.

As you interview, hold each answer and proposed direction against the refined engineer judgment principles (docs/policy/refined-engineer-judgment-principles.md — the judgment north star). When an answer violates a principle, name the principle and push back before it freezes into the plan. Apply the whole set — e.g. premature tech lock-in (決定を遅らせる), needless complexity (Less is more), drifting from the stated purpose (目的を見失えば、速く進むほど遠ざかる). The most common case: wanting to build something not in the agreed requirements — probe whether it is actually needed (what present need drives it, what breaks if omitted); speculative "we might need it later" additions are YAGNI violations.

## `--small` — start small

Everything in this section applies **only if the arguments contain `--small`**. Without it, ignore this section entirely and interview as above.

`--small` does not make the interview shallower. It keeps the depth and cuts the width: you still resolve the first slice exhaustively, but you stop walking branches that lie outside it.

**First question, always.** Before anything else, ask:

> 「これが動いた」と言える、入口から出口まで通る一番薄い一本道は何ですか？

That is the 曳光弾（薄い縦スライス）which docs/policy/new-development-policy.md declares the default. When the work is not code — a Skill definition, a policy, a guide — read it as「目的を満たす最小の変更」. Restate the answer as one sentence and get an explicit yes before asking anything else. That sentence is the scope of this interview.

**Default: don't ask.** A question is allowed only about an element that actually appears on the agreed one-line slice. Inside the slice, grill as relentlessly as ever.

Ask about something outside the slice only when one of these holds — the list is exhaustive:

1. The topic is one of these three and the slice touches it: how data is stored and shaped, an interface exposed outside the system, the authn/authz or billing boundary. (Getting these wrong later throws away what the first slice produced.)
2. `docs/requirements.md` states a constraint on what the agreed slice touches (especially SLI/SLO in 非機能要件).
3. The user raised the topic themselves.

These are never reasons to ask:「後で困るから今決めておく」「ついでに聞いておく」「網羅的に詰めるのが本Skillの役目」「エラー処理・拡張性・エッジケースも詰めないと不完全」.

**Not-now list.** Every topic you did not ask about goes on a Not-now list — one line each, in the form `<論点> — <何が起きたら決める必要が出るか>`. Present it at the end alongside the confirmed decisions, and tell the user it carries into the Plan's スコープ「やらないこと」. It records a deferral, not a rejection.

**Stop** once every element of the agreed one-line sentence has a decision. If the caller passed a stopping condition in the arguments, that one wins.
