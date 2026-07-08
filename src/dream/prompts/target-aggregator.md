The memory filesystem also carries a maintained doc at {{docPath}}.
{{guidance}}

When batch diffs touch this doc, synthesize their edits into it like any other memory file — one cohesive revision, not concatenation. Keep its YAML frontmatter block (--- ... ---) intact and edit only the body. If no batch touched it and it does not exist, do not create it.
