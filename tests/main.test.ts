import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import type { TaskNotesApi, TaskNote } from "../src/tasknotes";

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown>, notices: [] as string[] }));
vi.mock("obsidian", () => {
  class TAbstractFile { constructor(public path: string) {} }
  class TFile extends TAbstractFile {
    extension = "md";
    get basename() { return this.path.split("/").pop()!.replace(/\.md$/, ""); }
  }
  class TFolder extends TAbstractFile {}
  class Plugin {
    constructor(public app: unknown) {}
    async loadData() { return state.data; }
    async saveData(data: Record<string, unknown>) { state.data = structuredClone(data); }
    addSettingTab() {}
    addCommand() {}
    addRibbonIcon() {}
    registerEvent() {}
  }
  return { TAbstractFile, TFile, TFolder, Plugin,
    PluginSettingTab: class {}, Setting: class {},
    Notice: class { constructor(text: string) { state.notices.push(text); } },
  };
});
import { TFile, TFolder } from "obsidian";
import TaskifyPlugin from "../src/main";

function file(path: string): TFile {
  return new (TFile as unknown as new (path: string) => TFile)(path);
}

function fixture() {
  const source = file("Library/Example.md");
  const template = file("Templates/_Task.md");
  const destination = new (TFolder as unknown as new (path: string) => TFolder)("Projects/Review/Tasks");
  const project = file("Projects/Review/Review.md");
  const files = new Map<string, TFile | TFolder>([[source.path, source], [template.path, template], [destination.path, destination], [project.path, project]]);
  const caches = new Map<string, { frontmatter: Record<string, unknown> }>([
    [source.path, { frontmatter: { todo: true } }],
  ]);
  let changed: (file: TFile, data: string, cache: unknown) => void = () => {};
  let rename: (file: TFile | TFolder, oldPath: string) => void = () => {};
  const tasks = new Map<string, TaskNote>();
  const api: TaskNotesApi = {
    apiVersion: 1, hasCapability: () => true, lifecycle: { ready: async () => {} },
    settings: { snapshot: () => ({ fieldMapping: { projects: "projects" }, taskCreationDefaults: { useBodyTemplate: true, bodyTemplate: "Templates/_Task" } }) },
    tasks: {
      get: async (path) => tasks.get(path) ?? null,
      create: vi.fn(async (input) => {
        const path = "Projects/Review/Tasks/202610061500.md";
        const task = { path, archived: false, status: "open" };
        files.set(path, file(path)); tasks.set(path, task);
        caches.set(path, { frontmatter: { ...input.customFrontmatter, todo: true } });
        changed(files.get(path) as TFile, "", caches.get(path));
        return task;
      }),
      archive: vi.fn(async (path, archived) => {
        const task = { ...tasks.get(path)!, archived };
        tasks.set(path, task); return task;
      }),
      move: vi.fn(async (path, folder) => {
        const nextPath = `${folder}/${path.split("/").pop()}`;
        const task = { ...tasks.get(path)!, path: nextPath };
        const moved = files.get(path) as TFile;
        moved.path = nextPath;
        files.delete(path); files.set(nextPath, moved);
        caches.set(nextPath, caches.get(path)!); caches.delete(path);
        tasks.delete(path); tasks.set(nextPath, task);
        return task;
      }),
    },
  };
  const app = {
    plugins: { getPlugin: () => ({ api }) },
    workspace: { getActiveFile: () => source },
    metadataCache: {
      on: (_event: string, callback: typeof changed) => { changed = callback; return {}; },
      getFileCache: (target: TFile) => caches.get(target.path),
      getFirstLinkpathDest: (path: string) => files.get(`${path}.md`) ?? null,
    },
    vault: {
      on: (_event: string, callback: typeof rename) => { rename = callback; return {}; },
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      getMarkdownFiles: () => [...files.values()].filter((item) => item instanceof TFile),
      createFolder: async (path: string) => files.set(path, new (TFolder as unknown as new (path: string) => TFolder)(path)),
    },
  };
  const plugin = new TaskifyPlugin(app as unknown as App, {} as PluginManifest);
  const drain = async () => {
    // A creation can queue another metadata event while the original runs.
    for (let i = 0; i < 3; i++) await (plugin as unknown as { writeQueue: Promise<void> }).writeQueue;
  };
  return { plugin, source, api, caches, files, tasks, drain,
    emit: () => changed(source, "", caches.get(source.path)),
    rename: (target: TFile, oldPath: string) => rename(target, oldPath),
  };
}

beforeEach(() => { state.data = {}; state.notices = []; });

describe("Obsidian event integration", () => {
  it("repairs the old folder value to the explicitly selected Review project", async () => {
    state.data = { propertyName: "todo", projectNotePath: "Projects/Review/Tasks" };
    const f = fixture();
    await f.plugin.onload();
    expect(f.plugin.settings.taskFolderPath).toBe("Projects/Review/Tasks");
    expect(f.plugin.settings.projectNotePath).toBe("Projects/Review/Review.md");
    f.emit(); await f.drain();
    expect(f.api.tasks.create).toHaveBeenCalledTimes(1);
    expect(f.api.tasks.create).toHaveBeenCalledWith(expect.objectContaining({ projects: ["[[Projects/Review/Review]]"] }), expect.anything());
    expect(state.notices).toEqual([]);
  });

  it("uses the selected existing project and creates only its missing Tasks folder", async () => {
    const f = fixture();
    f.files.set("Projects/Other/Anchor.md", file("Projects/Other/Anchor.md"));
    await f.plugin.onload();
    await f.plugin.updateSettings({ projectNotePath: "Projects/Other/Anchor.md" });
    f.emit(); await f.drain();
    expect(f.files.get("Projects/Other/Tasks")).toBeInstanceOf(TFolder);
    expect(state.data.taskNoteRecords).toEqual([expect.objectContaining({ taskPath: "Projects/Other/Tasks/202610061500.md", taskFolder: "Projects/Other/Tasks" })]);
    expect(f.api.tasks.create).toHaveBeenCalledWith(expect.objectContaining({ projects: ["[[Projects/Other/Anchor]]"] }), expect.anything());
    expect(f.files.has("Projects/Other/Other.md")).toBe(false);
    expect(state.notices).toEqual([]);
  });

  it("refuses a missing project rather than creating a projectless task", async () => {
    const f = fixture();
    f.files.delete("Projects/Review/Review.md");
    await f.plugin.onload();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    f.emit(); await f.drain();
    expect(f.api.tasks.create).not.toHaveBeenCalled();
    expect(state.notices[0]).toContain("existing project note");
    errors.mockRestore();
  });

  it("preserves an explicitly cleared project selection after reload", async () => {
    state.data = { projectNotePath: "", taskFolderPath: "Projects/Review/Tasks" };
    const f = fixture();
    await f.plugin.onload();
    expect(f.plugin.settings.projectNotePath).toBe("");
  });

  it("reports a missing _Task template without creating any task", async () => {
    const f = fixture();
    f.files.delete("Templates/_Task.md");
    await f.plugin.onload();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    f.emit(); await f.drain();
    expect(f.api.tasks.create).not.toHaveBeenCalled();
    expect(state.notices[0]).toContain("Templates/_Task.md");
    errors.mockRestore();
  });
  it("does not bulk create at startup; serializes repeated checks and ignores generated-note events", async () => {
    const f = fixture();
    await f.plugin.onload();
    expect(f.api.tasks.create).not.toHaveBeenCalled();
    f.emit(); f.emit();
    await f.drain();
    expect(f.api.tasks.create).toHaveBeenCalledTimes(1);
    f.caches.get(f.source.path)!.frontmatter.todo = false;
    f.emit(); await f.drain();
    expect(f.api.tasks.archive).toHaveBeenCalledWith("Projects/Review/Tasks/202610061500.md", true, expect.anything());
    f.caches.get(f.source.path)!.frontmatter.todo = true;
    f.emit(); await f.drain();
    expect(f.api.tasks.archive).toHaveBeenLastCalledWith("Projects/Review/Tasks/202610061500.md", false, expect.anything());
    expect(f.api.tasks.create).toHaveBeenCalledTimes(1);
    expect(state.notices).toEqual([]);
  });

  it("preserves legacy settings/records and ignores checked templates", async () => {
    const legacy = { propertyName: "todo", taskFilePath: "ToDo/REVIEW.md", completedStatusSymbol: "r", taskRecords: [{ id: "legacy" }], extra: "keep" };
    state.data = structuredClone(legacy);
    const f = fixture();
    await f.plugin.onload();
    await f.plugin.updateSettings({ taskFolderPath: "Projects/Review/Tasks" });
    expect(state.data).toMatchObject(legacy);
    f.source.path = "Templates/Example.md";
    f.files.set(f.source.path, f.source);
    f.caches.set(f.source.path, { frontmatter: { todo: true } });
    f.emit(); await f.drain();
    expect(f.api.tasks.create).not.toHaveBeenCalled();
  });

  it("persists a source rename and archives the original task, not a new duplicate", async () => {
    const f = fixture();
    await f.plugin.onload();
    f.emit(); await f.drain();
    const oldPath = f.source.path;
    f.source.path = "Library/Renamed.md";
    f.files.delete(oldPath); f.files.set(f.source.path, f.source);
    f.caches.set(f.source.path, { frontmatter: { todo: false } });
    f.rename(f.source, oldPath); f.emit(); await f.drain();
    expect(state.data.taskNoteRecords).toEqual([expect.objectContaining({ sourcePath: f.source.path })]);
    expect(f.api.tasks.create).toHaveBeenCalledTimes(1);
    expect(f.api.tasks.archive).toHaveBeenCalledTimes(1);
  });

  it("leaves queued metadata work inactive after unload", async () => {
    const f = fixture();
    await f.plugin.onload();
    f.emit(); f.plugin.onunload(); await f.drain();
    expect(f.api.tasks.create).not.toHaveBeenCalled();
  });
});
