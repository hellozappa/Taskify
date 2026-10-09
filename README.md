# Taskify

Taskify creates a native [TaskNotes](https://tasknotes.dev/obsidian/javascript-api/) task when a Boolean property on an Obsidian note is checked. The task's title is the source note's name, and a qualified wikilink connects it to the source note. No task line is added to the source note.

## Setup

1. Enable TaskNotes with runtime API v1 (tested with TaskNotes 4.13.8; Obsidian 1.12.2 or newer).
2. In TaskNotes settings, enable the task body template and select `Templates/_Task.md` (the singular filename). Taskify checks that this file exists and that TaskNotes is configured to use it before creating a task. It will not silently substitute another template.
3. In Taskify settings, select `todo` (default) or `task` and an existing **Project note**, such as `Projects/Review/Review.md`. This note identifies the project; it is not a checklist/task-store file. A folder alone does not establish project membership. Taskify creates only a missing `Tasks` subfolder, never a project note or scaffold.
4. Set TaskNotes' task-folder template to `{{projectFolder}}/Tasks` for standard project routing. Taskify passes the project link to the supported creation service and verifies that the resulting task is in that project's `Tasks` folder, moving it there if necessary. Taskify never overrides or saves TaskNotes settings.
5. Add the property manually, through a template, or with **Add Taskify task property** in the command palette or ribbon. Check it to create a task.

TaskNotes handles task identification, property mappings, template content, timestamps, collision-safe filenames, and configured status, priority, and date defaults. Taskify does not change TaskNotes settings or require its HTTP API.

## Behavior

- Checking the property creates one task per source note linked to the selected project and stored in its `Tasks` subfolder. Editing the source note again does not create duplicates.
- Unchecking the property archives the generated task, including completed tasks. Archive tags and folder movement follow TaskNotes settings; no task is deleted.
- Rechecking restores the same task to its original destination folder. Its status, completion history, body, and other properties remain intact. A completed task is not reopened.
- Completion is managed in TaskNotes. Configure a custom status such as **Read** there. Taskify does not translate status characters or change the source checkbox on completion.
- Taskify tracks source and task renames, including folder moves. Generated notes contain a `taskifySource` wikilink property for ownership recovery as well as a source link in the body when the configured template permits it.
- Generated notes and existing TaskNotes tasks cannot spawn more tasks. Notes in folders named `Templates` are ignored.
- A missing dependency, required template, invalid destination folder, or temporarily unindexed tracked task produces a notice instead of silently falling back or creating a duplicate. A failed placement (such as a filename collision) leaves the task tracked in its current location and retries placement on the next checked-note update; existing files are never overwritten.
- Taskify does not scan all checked notes on startup. Check a note's property to begin using the new workflow; this avoids an automatic bulk migration on upgrade.
- Changing the project affects new tasks, not previously generated tasks. Changing the property setting does not migrate existing properties.

## Upgrading from the project-note setting

Version 0.2.1 corrects project selection: select an existing project note, not its task-storage folder. The previously chosen Review destination resolves to the existing `Projects/Review/Review.md`; other ambiguous or missing paths require explicit project selection. Existing task tracking and legacy settings are preserved; loading settings does not move notes or bulk-reassign existing tasks.

## Upgrading from the checklist version

The old Markdown task store, its checklist entries, and legacy saved settings are preserved. Version 0.2.0 no longer writes checklist tasks or normalizes Obsidian Tasks status symbols. Existing checklist entries are not automatically converted into TaskNotes notes. New tasks are displayed in TaskNotes views/Bases rather than Obsidian Tasks queries.

## Development

```bash
npm install
npm test
npm run build
```

The original checklist-format helpers/tests remain as legacy source coverage and are not part of the runtime entry point. Native TaskNotes synchronization has its own regression suite. Build checks do not prove installed Obsidian behavior; installation/reload and a vault smoke test are separate steps.
