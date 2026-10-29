# Providers and Skills

Keep model configurations and reusable instructions together in Library.

## Providers

Define a provider ID, an API adapter, a base URL and a catalog of models. API keys are stored separately and excluded from resource exports. Configuration follows [OpenCode](https://opencode.ai/docs/providers/).

This version manages configuration. Model execution, OAuth and connection testing are planned.

## Skills

Write a name, description and Markdown instructions. Import and export use the standard [Agent Skills](https://agentskills.io/specification) `SKILL.md` format with YAML frontmatter. Skills are saved as Markdown files.

## Native Library

Both collections use the shared cards, groups, action menus and settings forms. The plugin requires no global permissions.
