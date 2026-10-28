# Built-in Library items

Providers use a Library JSON export in `providers.json`.
Skills are standard `skills/<name>/SKILL.md` documents: YAML frontmatter with name and description, then a Markdown instruction. `skills/index.json` lists their directory names.

The app imports built-ins once on first use. They can then be edited or deleted. **Restore built-in items** (after a confirmation) adds the missing items and overwrites the ones that are in the Library already (same kind and name) with the built-in version.

To add a skill, create its directory and SKILL.md, then add its name to skills/index.json. No nodes ship with the app (see `docs/signal-engine.md`).
