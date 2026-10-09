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
  settings: { snapshot(): {
    fieldMapping: { projects: string };
    taskCreationDefaults: { useBodyTemplate: boolean; bodyTemplate: string };
  } };
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

export const TASK_TEMPLATE_PATH = "Templates/_Task.md";

export function folderPath(value: string): string {
  const path = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..") || /[\[\]|#\r\n]/.test(path)) {
    throw new Error("Use a vault-relative folder path without aliases, headings, or relative segments.");
  }
  return path;
}

export function migrateTaskFolder(
  data: { taskFolderPath?: unknown; projectNotePath?: unknown },
  kind: (path: string) => "folder" | "file" | null,
): string {
  if (typeof data.taskFolderPath === "string") return data.taskFolderPath;
  if (typeof data.projectNotePath !== "string") return "Projects/Review/Tasks";
  let legacy: string;
  try { legacy = folderPath(data.projectNotePath); }
  catch { return ""; } // Keep the settings screen usable for an invalid legacy value.
  // Preserve an actual folder entered into the old, incorrectly note-only UI.
  if (kind(legacy) === "folder") return legacy;
  const stem = legacy.replace(/\.md$/i, "");
  if (kind(stem) === "folder") return stem;
  // A verified old project note maps to its existing parent's Tasks folder.
  if (kind(legacy.endsWith(".md") ? legacy : `${legacy}.md`) === "file") {
    const slash = legacy.lastIndexOf("/");
    if (slash >= 0) return `${legacy.slice(0, slash)}/Tasks`;
  }
  return ""; // Ambiguous/missing paths require a setting, never a guessed destination.
}

export function assertTaskTemplate(defaults: { useBodyTemplate: boolean; bodyTemplate: string }): void {
  const path = defaults.bodyTemplate.trim().replace(/\\/g, "/").replace(/\.md$/i, "");
  if (!defaults.useBodyTemplate || path !== TASK_TEMPLATE_PATH.replace(/\.md$/, "")) {
    throw new Error(`Enable TaskNotes' body template and select ${TASK_TEMPLATE_PATH}. Taskify will not create a task using a different template.`);
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
  prepareTaskFolder(): Promise<string>;
  projectLink(): string;
  ensureFolder(path: string): Promise<void>;
  watchTaskPath?(path: string): () => string;
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
      const actualPath = host.watchTaskPath?.(task.path);
      const archived = await api.tasks.archive(task.path, true, context);
      record.taskPath = actualPath?.() ?? archived.path;
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
      const actualPath = host.watchTaskPath?.(task.path);
      const restored = await api.tasks.archive(task.path, false, context);
      record.taskPath = actualPath?.() ?? restored.path;
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

  const settings = api.settings.snapshot();
  assertTaskTemplate(settings.taskCreationDefaults);
  const folder = await host.prepareTaskFolder();
  const projects = [host.projectLink()];
  const link = sourceLink(source.path, source.title);
  const created = await api.tasks.create({
    title: source.title,
    details: link,
    projects,
    // Override the template's empty relationship with the selected project,
    // using the live mapped property as well as the logical API field.
    customFrontmatter: { [settings.fieldMapping.projects]: projects, taskifySource: link },
  }, context);
  const next: TaskNoteRecord = { sourcePath: source.path, taskPath: created.path, taskFolder: folder };
  if (created.path.slice(0, created.path.lastIndexOf("/")) !== folder) next.restorePending = true;
  if (record) Object.assign(record, next);
  else host.records.push(next);
  await host.save(); // Retain ownership even if a postcondition fails.
  if (next.restorePending) {
    const moved = await api.tasks.move(created.path, folder, context);
    // Keep the same record object: vault rename events may run while moving.
    const tracked = record ?? host.records[host.records.length - 1];
    tracked.taskPath = moved.path;
    tracked.restorePending = moved.path.slice(0, moved.path.lastIndexOf("/")) !== folder;
    await host.save();
    if (tracked.restorePending) {
      throw new Error(`TaskNotes did not move the task to ${folder}. The existing task remains tracked; no duplicate was created.`);
    }
  }
}

export function renamedPath(path: string, oldPath: string, newPath: string): string {
  return path === oldPath ? newPath : path.startsWith(`${oldPath}/`) ? newPath + path.slice(oldPath.length) : path;
}
