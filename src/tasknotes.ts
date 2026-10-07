// Narrow structural contract for TaskNotes' documented runtime API v1.
// No HTTP server, credentials, or access to TaskNotes service internals is needed.
export type TaskNote = { path: string; archived: boolean; status: string };
export type MutationContext = { source: string; correlationId: string; reason: string };
export type TaskCreation = {
  title: string;
  details: string;
  projects: string[];
  customFrontmatter: Record<string, unknown>;
};

export interface TaskNotesApi {
  apiVersion: number;
  hasCapability(capability: string): boolean;
  lifecycle: { ready(): Promise<void> };
  settings: { snapshot(): { tasksFolder: string } };
  tasks: {
    get(path: string): Promise<TaskNote | null>;
    create(data: TaskCreation, context: MutationContext): Promise<TaskNote>;
    archive(path: string, archived: boolean, context: MutationContext): Promise<TaskNote>;
    move(path: string, folder: string, context: MutationContext): Promise<TaskNote>;
  };
}

export function requireTaskNotesApi(value: unknown): TaskNotesApi {
  const api = value as Partial<TaskNotesApi> | null | undefined;
  if (api?.apiVersion !== 1 || typeof api.hasCapability !== "function" ||
      !["tasks.read", "tasks.write", "tasks.move", "settings.snapshot"].every((capability) => api.hasCapability!(capability))) {
    throw new Error("Enable TaskNotes with runtime API v1 (tested with 4.13.8) before using Taskify.");
  }
  return api as TaskNotesApi;
}

export function notePath(value: string): string {
  const path = value.trim().replace(/\\/g, "/");
  if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..") || /[\[\]|#\r\n]/.test(path)) {
    throw new Error("Use a vault-relative Markdown note path without aliases, headings, or relative segments.");
  }
  return path.endsWith(".md") ? path : `${path}.md`;
}

export function projectTaskFolder(projectPath: string): string {
  const path = notePath(projectPath);
  const slash = path.lastIndexOf("/");
  if (slash < 0) throw new Error("The project note must be inside its project folder.");
  return `${path.slice(0, slash)}/Tasks`;
}

export function assertCreationFolder(template: string, projectPath: string): void {
  const path = notePath(projectPath);
  const folder = path.slice(0, path.lastIndexOf("/"));
  const expanded = template.trim().replace(/\{\{projectFolder\}\}/g, folder).replace(/\/+$/, "");
  if (expanded !== projectTaskFolder(path)) {
    throw new Error("Set TaskNotes’ task folder to {{projectFolder}}/Tasks (or this project's exact Tasks folder). Taskify will not create a task in another folder.");
  }
}

export function sourceLink(path: string, title: string): string {
  // Qualified target prevents same-title notes in different folders colliding.
  return `[[${path.replace(/\.md$/, "")}|${title.replace(/\|/g, "\\|")}]]`;
}

export type NoteSource = { path: string; title: string };
export type TaskNoteRecord = {
  sourcePath: string;
  taskPath: string;
  taskFolder: string;
  restorePending?: boolean;
};

export interface TaskNoteHost {
  records: TaskNoteRecord[];
  save(): Promise<void>;
  fileExists(path: string): boolean;
  findTask(sourcePath: string): Promise<TaskNoteRecord | null>;
  prepareProject(): Promise<{ path: string; folder: string }>;
  ensureFolder(path: string): Promise<void>;
}

/** Call through a serialized queue: one source note has one native task note. */
export async function synchronizeTaskNote(
  api: TaskNotesApi, host: TaskNoteHost, source: NoteSource, checked: boolean,
): Promise<void> {
  await api.lifecycle.ready();
  if (await api.tasks.get(source.path)) return; // Task notes cannot spawn tasks.

  let record = host.records.find((item) => item.sourcePath === source.path);
  if (!record || !host.fileExists(record.taskPath)) {
    const recovered = await host.findTask(source.path);
    if (recovered) {
      if (record) Object.assign(record, recovered);
      else { record = recovered; host.records.push(record); }
      await host.save();
    }
  }

  const task = record ? await api.tasks.get(record.taskPath) : null;
  if (!task && record && host.fileExists(record.taskPath)) {
    throw new Error(`TaskNotes has not indexed ${record.taskPath}. No duplicate was created; retry after indexing.`);
  }

  const context: MutationContext = {
    source: "taskify", correlationId: crypto.randomUUID(),
    reason: checked ? "Source checkbox checked" : "Source checkbox unchecked",
  };

  if (!checked) {
    if (task && record && !task.archived) {
      const archived = await api.tasks.archive(task.path, true, context);
      record.taskPath = archived.path;
      record.restorePending = false;
      await host.save();
    }
    return;
  }

  if (task && record) {
    if (task.archived) {
      await host.ensureFolder(record.taskFolder);
      record.restorePending = true;
      await host.save();
      const restored = await api.tasks.archive(task.path, false, context);
      record.taskPath = restored.path;
      await host.save(); // Persist before any optional move can fail.
    }
    // Unarchive can leave a note in the archive directory. Restore its folder,
    // but never overwrite a task, reopen a completed task, or discard history.
    if (record.restorePending && record.taskPath.slice(0, record.taskPath.lastIndexOf("/")) !== record.taskFolder) {
      await host.ensureFolder(record.taskFolder);
      const moved = await api.tasks.move(record.taskPath, record.taskFolder, context);
      record.taskPath = moved.path;
    }
    if (record.restorePending) { record.restorePending = false; await host.save(); }
    return;
  }

  const project = await host.prepareProject();
  assertCreationFolder(api.settings.snapshot().tasksFolder, project.path);
  const link = sourceLink(source.path, source.title);
  const created = await api.tasks.create({
    title: source.title,
    details: link,
    projects: [`[[${project.path.replace(/\.md$/, "")}]]`],
    customFrontmatter: { taskifySource: link },
  }, context);
  const next = { sourcePath: source.path, taskPath: created.path, taskFolder: project.folder };
  if (record) Object.assign(record, next);
  else host.records.push(next);
  await host.save(); // Retain ownership even if a postcondition fails.
  if (created.path.slice(0, created.path.lastIndexOf("/")) !== project.folder) {
    throw new Error(`TaskNotes created ${created.path} outside ${project.folder}. The task was retained and tracked; check TaskNotes folder settings.`);
  }
}

export function renamedPath(path: string, oldPath: string, newPath: string): string {
  return path === oldPath ? newPath : path.startsWith(`${oldPath}/`) ? newPath + path.slice(oldPath.length) : path;
}
