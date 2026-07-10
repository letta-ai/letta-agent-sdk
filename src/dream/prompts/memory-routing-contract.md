## Memory routing contract

- `system/` is always-on context. Keep only critical identity, preferences, rules, and conventions that improve nearly every future turn.
- `skills/` contains conditionally loaded capabilities distilled from experience. Put durable user feedback, intent, decision criteria, corrections, workflows, judgment, and non-obvious failure lessons here when they improve work under a definable task, domain, tool, repository subsystem, or failure condition. A skill must not be a generic knowledge bucket or a substitute for searching the repository.
- Generic reference memory is for durable experiential context with no reliable activation condition. It must not duplicate `system/`, a skill, or information readily discoverable from the relevant repository or ordinary search.
- Persist nothing when the content is ephemeral, already captured, generic model knowledge, unsupported speculation, raw transcript restatement, an inventory of code/files/symbols, readily discoverable implementation detail, or specific to one completed instance with no future value.

Use these tests:

- **System test:** Would omitting this information make the agent meaningfully worse on most turns? If not, keep it out of `system/`.
- **Skill test:** Can you state precisely what experience taught the agent, what it should do differently, and when a future agent should load that guidance? Would it improve that class of future work? If yes, it is a skill candidate.
- **Reference test:** Is the context durable and non-obvious, but genuinely lacks a task, domain, tool, subsystem, or situation that can serve as a reliable trigger? If not, route it elsewhere or do not persist it.

The highest-value evidence is explicit user feedback: corrections, intent, preferences, rationale, and criteria for a good result. Preserve the generalized lesson behind that feedback. Generalize only as far as the evidence supports: do not turn a request for one task into a global preference or invent a broader rule. A skill does not need to be a rigid workflow; it may teach judgment or package resources when they serve its triggered capability. One strong conversation, correction, code review, or resolved failure can justify a skill when the evidence is strong and the lesson generalizes; repeated evidence is not required.

For every proposed memory, identify the **experiential delta**: what became known through interaction or reflection that repository search alone would not reveal. Judge content sentence by sentence. User feedback can justify the lesson, but it does not justify preserving the surrounding repository exploration. A corrected mistake at the start of a skill is not permission to attach an implementation guide.

Write memories around future behavior: what the user wants, why it matters, what mistake to avoid, and how to decide or act next time. Code paths and symbol names may appear only as a short pointer when the lesson cannot be applied without one. Do not persist file maps, implementation tours, API inventories, current schemas, or descriptions of what the current code does merely because they were discussed in a session. When the user explicitly establishes an architecture or implementation constraint, preserve the constraint and rationale; omit incidental mechanics that repository search can recover.

### Skill identity and activation

For every skill:

- Define the concrete condition under which a future agent should load it, the experiential lesson it preserves, and what capability or judgment it improves.
- Use a concise, lowercase, hyphenated, action- or capability-led name. Good names include `running-ci-cd`, `adding-new-secrets`, `optimizing-prompts`, and `searching-messages`; avoid passive containers such as `project-reference` and `user-memory`.
- Treat the frontmatter `description` as the activation mechanism. Phrase it imperatively (for example, "Use when...") and name the concrete trigger; optionally state the capability it enables.
- Keep the directory name, frontmatter `name`, description, and body aligned to the same scope.
- Merge skills with the same or substantially similar activation conditions. Preserve separate skills when their triggers are genuinely distinct, and keep each fact or instruction in one canonical location.
- Do not add a skill catalog or index to `system/`. Skill descriptions are the activation and discovery mechanism; use a cross-reference only where the surrounding memory genuinely needs that specific detail.

Route each candidate in this order: nearly every turn → `system/`; definable activation condition → a skill; durable general context with no reliable activation condition → generic reference memory; otherwise → no persistence.
