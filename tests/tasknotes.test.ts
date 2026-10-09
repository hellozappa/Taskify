import { describe, expect, it, vi } from "vitest";
import {
  assertTaskTemplate, folderPath, migrateTaskFolder, renamedPath, requireTaskNotesApi,
  sourceLink, synchronizeTaskNote, type TaskNote, type TaskNoteHost, type TaskNotesApi,
} from "../src/tasknotes";

const source = { path: "Library/Example.md", title: "Example" };
const folder = "Projects/Review/Tasks";

function fixture() {
  const tasks = new Map<string, TaskNote>();
  const files = new Set<string>();
  const api: TaskNotesApi = {
    apiVersion: 1, hasCapability: () => true,
    lifecycle: { ready: vi.fn(async () => {}) },
    settings: { snapshot: () => ({ fieldMapping: { projects: "projects" }, taskCreationDefaults: { useBodyTemplate: true, bodyTemplate: "Templates/_Task" } }) },
    tasks: {
      get: vi.fn(async (path) => tasks.get(path) ?? null),
      create: vi.fn(async () => {
        const task = { path: `${folder}/202610061400.md`, status: "open", archived: false };
        tasks.set(task.path, task); files.add(task.path);
        return task;
      }),
      archive: vi.fn(async (path, archived) => {
        const before = tasks.get(path)!;
        const task = { ...before, archived, path: archived ? `Tasks/Archive/${path.split("/").pop()}` : path };
        tasks.delete(path); files.delete(path); tasks.set(task.path, task); files.add(task.path);
        return task;
      }),
      move: vi.fn(async (path, target) => {
        const task = { ...tasks.get(path)!, path: `${target}/${path.split("/").pop()}` };
        tasks.delete(path); files.delete(path); tasks.set(task.path, task); files.add(task.path);
        return task;
      }),
    },
  };
  const host: TaskNoteHost = {
    records: [], save: vi.fn(async () => {}), fileExists: (path) => files.has(path),
    findTask: vi.fn(async () => null), ensureFolder: vi.fn(async () => {}),
    prepareTaskFolder: vi.fn(async () => folder),
    projectLink: () => "[[Projects/Review/Review]]",
  };
  return { api, host, tasks, files };
}

describe("native TaskNotes synchronization", () => {
  it("restores using the actual moved file path when TaskNotes returns a stale archive path", async () => {
    const { api, host, tasks, files } = fixture();
    await synchronizeTaskNote(api, host, source, true);
    await synchronizeTaskNote(api, host, source, false);
    let actualPath = host.records[0].taskPath;
    host.watchTaskPath = () => () => actualPath;
    api.tasks.archive = vi.fn(async (path) => {
      const before = tasks.get(path)!;
      actualPath = "Tasks/202610061400.md";
      tasks.delete(path); files.delete(path);
      tasks.set(actualPath, { ...before, path: actualPath, archived: false }); files.add(actualPath);
      return { ...before, archived: false }; // TaskNotes' stale returned path.
    });
    await synchronizeTaskNote(api, host, source, true);
    expect(api.tasks.move).toHaveBeenCalledWith("Tasks/202610061400.md", folder, expect.anything());
    expect(host.records[0].taskPath).toBe(`${folder}/202610061400.md`);
    expect(api.tasks.create).toHaveBeenCalledTimes(1);
  });
  it("creates a linked task with logical project fields and TaskNotes defaults", async () => {
    const { api, host } = fixture();
    await synchronizeTaskNote(api, host, source, true);
    expect(api.lifecycle.ready).toHaveBeenCalled();
    expect(api.tasks.create).toHaveBeenCalledWith({
      title: "Example", details: "[[Library/Example|Example]]",
      projects: ["[[Projects/Review/Review]]"],
      customFrontmatter: { projects: ["[[Projects/Review/Review]]"], taskifySource: "[[Library/Example|Example]]" },
    }, expect.objectContaining({ source: "taskify", reason: "Source checkbox checked" }));
    expect(host.records).toEqual([{ sourcePath: source.path, taskPath: `${folder}/202610061400.md`, taskFolder: folder }]);
    expect(api.tasks.move).not.toHaveBeenCalled();
  });

  it("does not duplicate tasks on repeated note updates or after restoring persisted records", async () => {
    const { api, host } = fixture();
    await synchronizeTaskNote(api, host, source, true);
    const reloadedHost = { ...host, records: structuredClone(host.records) };
    await synchronizeTaskNote(api, reloadedHost, source, true);
    await synchronizeTaskNote(api, reloadedHost, source, true);
    expect(api.tasks.create).toHaveBeenCalledTimes(1);
    expect(api.tasks.archive).not.toHaveBeenCalled();
  });

  it("archives once on uncheck and tracks the returned archive path", async () => {
    const { api, host } = fixture();
    await synchronizeTaskNote(api, host, source, true);
    await synchronizeTaskNote(api, host, source, false);
    await synchronizeTaskNote(api, host, source, false);
    expect(api.tasks.archive).toHaveBeenCalledTimes(1);
    expect(host.records[0].taskPath).toBe("Tasks/Archive/202610061400.md");
  });

  it("restores the same completed task to its original project folder without reopening it", async () => {
    const { api, host, tasks } = fixture();
    await synchronizeTaskNote(api, host, source, true);
    tasks.get(host.records[0].taskPath)!.status = "read";
    await synchronizeTaskNote(api, host, source, false);
    await synchronizeTaskNote(api, host, source, true);
    expect(api.tasks.create).toHaveBeenCalledTimes(1);
    expect(api.tasks.archive).toHaveBeenLastCalledWith("Tasks/Archive/202610061400.md", false, expect.anything());
    expect(api.tasks.move).toHaveBeenCalledWith("Tasks/Archive/202610061400.md", folder, expect.anything());
    expect(tasks.get(host.records[0].taskPath)?.status).toBe("read");
  });

  it("does nothing when an unchecked note never had a task", async () => {
    const { api, host } = fixture();
    await synchronizeTaskNote(api, host, source, false);
    expect(api.tasks.create).not.toHaveBeenCalled();
    expect(api.tasks.archive).not.toHaveBeenCalled();
    expect(host.prepareTaskFolder).not.toHaveBeenCalled();
  });

  it("does not undo a user's manual move of an active task on a source-note edit", async () => {
    const { api, host } = fixture();
    await synchronizeTaskNote(api, host, source, true);
    const moved = await api.tasks.move(host.records[0].taskPath, "Manual", { source: "user", correlationId: "move", reason: "manual" });
    host.records[0].taskPath = moved.path;
    vi.mocked(api.tasks.move).mockClear();
    await synchronizeTaskNote(api, host, source, true);
    expect(api.tasks.move).not.toHaveBeenCalled();
    expect(host.records[0].taskPath).toBe("Manual/202610061400.md");
  });

  it("recovers ownership before archiving when plugin records are missing", async () => {
    const { api, host } = fixture();
    await synchronizeTaskNote(api, host, source, true);
    const record = host.records.pop()!;
    host.findTask = vi.fn(async () => record);
    await synchronizeTaskNote(api, host, source, false);
    expect(api.tasks.create).toHaveBeenCalledTimes(1);
    expect(host.records[0].taskPath).toBe("Tasks/Archive/202610061400.md");
  });

  it("does not create recursively from an existing TaskNotes task", async () => {
    const { api, host, tasks } = fixture();
    tasks.set(source.path, { path: source.path, archived: false, status: "open" });
    await synchronizeTaskNote(api, host, source, true);
    expect(api.tasks.create).not.toHaveBeenCalled();
  });

  it("refuses a different template before task creation", async () => {
    const { api, host } = fixture();
    api.settings.snapshot = () => ({ fieldMapping: { projects: "projects" }, taskCreationDefaults: { useBodyTemplate: true, bodyTemplate: "Templates/Other" } });
    await expect(synchronizeTaskNote(api, host, source, true)).rejects.toThrow("Templates/_Task.md");
    expect(api.tasks.create).not.toHaveBeenCalled();
  });

  it("does not duplicate a file whose TaskNotes indexing is temporarily missing", async () => {
    const { api, host, tasks } = fixture();
    await synchronizeTaskNote(api, host, source, true);
    tasks.clear();
    await expect(synchronizeTaskNote(api, host, source, true)).rejects.toThrow("not indexed");
    expect(api.tasks.create).toHaveBeenCalledTimes(1);
  });

  it("writes the selected project using the live mapped property, not a null template default", async () => {
    const { api, host } = fixture();
    api.settings.snapshot = () => ({ fieldMapping: { projects: "project_links" }, taskCreationDefaults: { useBodyTemplate: true, bodyTemplate: "Templates/_Task" } });
    await synchronizeTaskNote(api, host, source, true);
    expect(api.tasks.create).toHaveBeenCalledWith(expect.objectContaining({ customFrontmatter: { project_links: ["[[Projects/Review/Review]]"], taskifySource: "[[Library/Example|Example]]" } }), expect.anything());
  });

  it("moves the native task from TaskNotes' creation folder to the selected folder", async () => {
    const { api, host, tasks, files } = fixture();
    api.tasks.create = vi.fn(async () => {
      const task = { path: "Other/new.md", status: "open", archived: false };
      tasks.set(task.path, task); files.add(task.path); return task;
    });
    await synchronizeTaskNote(api, host, source, true);
    expect(api.tasks.move).toHaveBeenCalledWith("Other/new.md", folder, expect.anything());
    expect(host.records[0].taskPath).toBe(`${folder}/new.md`);
    expect(host.save).toHaveBeenCalled();
  });

  it("tracks a creation before a failed placement and retries placement without a duplicate", async () => {
    const { api, host } = fixture();
    host.prepareTaskFolder = async () => "Review Tasks";
    const move = api.tasks.move;
    api.tasks.move = vi.fn(async () => { throw new Error("Collision"); });
    await expect(synchronizeTaskNote(api, host, source, true)).rejects.toThrow("Collision");
    expect(host.records[0].restorePending).toBe(true);
    api.tasks.move = move;
    await synchronizeTaskNote(api, host, source, true);
    expect(api.tasks.create).toHaveBeenCalledTimes(1);
    expect(host.records[0].taskPath).toBe("Review Tasks/202610061400.md");
    expect(host.records[0].restorePending).toBe(false);
  });

  it("retains the unarchive path when the return move fails, then retries without creating a duplicate", async () => {
    const { api, host } = fixture();
    await synchronizeTaskNote(api, host, source, true);
    await synchronizeTaskNote(api, host, source, false);
    const move = api.tasks.move;
    api.tasks.move = vi.fn(async () => { throw new Error("Collision"); });
    await expect(synchronizeTaskNote(api, host, source, true)).rejects.toThrow("Collision");
    expect(host.records[0].taskPath).toBe("Tasks/Archive/202610061400.md");
    api.tasks.move = move;
    await synchronizeTaskNote(api, host, source, true);
    expect(api.tasks.create).toHaveBeenCalledTimes(1);
    expect(host.records[0].taskPath).toBe(`${folder}/202610061400.md`);
  });
});

describe("API and path guards", () => {
  it("requires an available compatible API and task-write capabilities", () => {
    expect(() => requireTaskNotesApi(undefined)).toThrow("Enable TaskNotes");
    expect(() => requireTaskNotesApi({ apiVersion: 2 })).toThrow("Enable TaskNotes");
    const { api } = fixture();
    api.hasCapability = (name) => name !== "tasks.write";
    expect(() => requireTaskNotesApi(api)).toThrow("Enable TaskNotes");
  });
  it("rejects traversal, absolute paths and link-shaped paths", () => {
    for (const path of ["../Review", "/Review", "Projects/../Review", "[[Review]]", "Review#Heading", "Projects//Review"]) {
      expect(() => folderPath(path)).toThrow();
    }
    expect(folderPath("Projects/Review/Tasks/")).toBe(folder);
    expect(folderPath("Tasks")).toBe("Tasks");
  });
  it("requires the enabled exact _Task template with or without the extension", () => {
    expect(() => assertTaskTemplate({ useBodyTemplate: true, bodyTemplate: "Templates/_Task" })).not.toThrow();
    expect(() => assertTaskTemplate({ useBodyTemplate: true, bodyTemplate: "Templates/_Task.md" })).not.toThrow();
    expect(() => assertTaskTemplate({ useBodyTemplate: false, bodyTemplate: "Templates/_Task" })).toThrow();
    expect(() => assertTaskTemplate({ useBodyTemplate: true, bodyTemplate: "Templates/_Tasks" })).toThrow();
  });
  it("migrates verified old folder or project-note settings without guessing nonexistent paths", () => {
    const kind = (path: string) => path === folder ? "folder" as const : path === "Projects/Review/Review.md" ? "file" as const : null;
    expect(migrateTaskFolder({ projectNotePath: folder }, kind)).toBe(folder);
    expect(migrateTaskFolder({ projectNotePath: `${folder}.md` }, kind)).toBe(folder);
    expect(migrateTaskFolder({ projectNotePath: "Projects/Review/Review.md" }, kind)).toBe(folder);
    expect(migrateTaskFolder({ projectNotePath: "Missing/Project.md" }, kind)).toBe("");
    expect(migrateTaskFolder({ projectNotePath: "../Outside" }, kind)).toBe("");
    expect(migrateTaskFolder({ projectNotePath: "" }, kind)).toBe("");
    expect(migrateTaskFolder({ taskFolderPath: "Chosen/Folder", projectNotePath: folder }, kind)).toBe("Chosen/Folder");
  });
  it("qualifies same-title links and tracks note and folder renames without prefix collisions", () => {
    expect(sourceLink("Other/Example.md", "Example")).toBe("[[Other/Example|Example]]");
    expect(renamedPath("Library/Example.md", "Library", "Reading")).toBe("Reading/Example.md");
    expect(renamedPath("Library2/Example.md", "Library", "Reading")).toBe("Library2/Example.md");
  });
});
