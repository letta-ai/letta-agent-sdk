## Memory routing contract

- `system/` is always-on context. Keep only critical identity, preferences, rules, and conventions that improve nearly every future turn.
- `skills/` contains conditionally loaded capability packages. Put durable workflows, judgment, specialized facts, reference material, scripts, templates, and assets here when they improve work under a definable task, domain, tool, repository subsystem, or failure condition. A skill must not be a generic knowledge bucket with an ambiguous trigger.
- Generic reference memory is for durable context with no reliable activation condition. It must not duplicate `system/`, a skill, or facts and documentation readily discoverable from the relevant repository or ordinary search. Persist only distilled, non-obvious value learned from past experience.
- Persist nothing when the content is ephemeral, already captured, generic model knowledge, unsupported speculation, raw transcript restatement, readily discoverable source material, or specific to one completed instance with no future value.

Use these tests:

- **System test:** Would omitting this information make the agent meaningfully worse on most turns? If not, keep it out of `system/`.
- **Skill test:** Can you state precisely what the knowledge enables and when a future agent should load it? Would it improve that class of future work? If yes, it is a skill candidate.
- **Reference test:** Is the context durable and non-obvious, but genuinely lacks a task, domain, tool, subsystem, or situation that can serve as a reliable trigger? If not, route it elsewhere or do not persist it.

A skill does not need to be a rigid multi-step workflow. It may teach judgment or package specialized facts and resources when they serve its triggered capability. One strong conversation, correction, code review, resolved failure, or concrete artifact can justify a skill when the evidence is strong and the capability generalizes; repeated evidence is not required.

### Skill identity and activation

For every skill:

- Define the concrete condition under which a future agent should load it and the capability it provides under that condition.
- Use a concise, lowercase, hyphenated, action- or capability-led name. Good names include `running-ci-cd`, `adding-new-secrets`, `optimizing-prompts`, and `searching-messages`; avoid passive containers such as `project-reference` and `user-memory`.
- Treat the frontmatter `description` as the activation mechanism. Phrase it imperatively (for example, "Use when...") and name the concrete trigger; optionally state the capability it enables.
- Keep the directory name, frontmatter `name`, description, and body aligned to the same scope.
- Merge skills with the same or substantially similar activation conditions. Preserve separate skills when their triggers are genuinely distinct, and keep each fact or instruction in one canonical location.

Route each candidate in this order: nearly every turn → `system/`; definable activation condition → a skill; durable general context with no reliable activation condition → generic reference memory; otherwise → no persistence.
