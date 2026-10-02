# Taskify

Taskify creates a Tasks-plugin-compatible task from a Boolean frontmatter property on an Obsidian note.

When the configured property is checked, Taskify writes a task such as this to its own Markdown task-store file:

```markdown
- [ ] [[Example Note]]
```

The task is then available to any existing Tasks query. The source note is never given a task line.

## Setup

1. Enable the Tasks plugin.
2. In **Taskify** settings, choose either `task` or `todo` as the source property.
3. Set the vault-relative task-store path, such as `Planning/Taskify Tasks.md`.
   - Its filename is its title.
   - With Obsidian inline titles enabled, Obsidian displays that filename as the title.
   - With inline titles disabled, Taskify writes the same title as an H1.
4. Add the property to a note with the **Add Taskify task property** command or the ribbon action, or add it manually in Properties.
5. Check the property to create the task.

Taskify does not create a dashboard or a Tasks query. Point an existing query at the task-store file if you want a dedicated view.

## Completion statuses

Tasks controls the normal status transition when a task checkbox is clicked. Taskify defaults to the standard completed status, `[x]`.

To use a custom completed status, such as `[r]` for Read:

1. In Tasks settings, add `r` as a custom status with type **Done**.
2. Configure Tasks so the status transition you want ends in `r`.
3. Set Taskify’s **Completed task status** to `r`.

If Tasks first writes `[x]`, Taskify changes only its own generated task to the configured symbol. Taskify deliberately does not alter Tasks’ settings or custom-status definitions.

## Behavior

- Existing Notes can gain the property manually or through Taskify’s command and ribbon action.
- Notes in any folder named `Templates` are ignored when their property changes; templates can still contain an unchecked property for future notes.
- Clearing the source property removes its open generated task.
- Completed generated tasks remain in the task-store note as history.
- Taskify tracks only tasks it created. It does not alter manually written tasks.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
