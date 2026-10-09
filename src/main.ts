import { Notice, Plugin, TAbstractFile, TFile, TFolder } from "obsidian";
import { DEFAULT_SETTINGS, TaskifySettingTab, type TaskifySettings } from "./settings";
import {
  folderPath, migrateTaskFolder, TASK_TEMPLATE_PATH, renamedPath, requireTaskNotesApi, synchronizeTaskNote,
  type TaskNoteRecord, type TaskNotesApi,
} from "./tasknotes";

type StoredPluginData = Record<string, unknown> & Partial<TaskifySettings> & {
  taskNoteRecords?: TaskNoteRecord[];
};

export default class TaskifyPlugin extends Plugin {
  settings: TaskifySettings = { ...DEFAULT_SETTINGS };
  private records: TaskNoteRecord[] = [];
  private storedData: StoredPluginData = {};
  private writeQueue: Promise<void> = Promise.resolve();
  private stopped = false;

  async onload(): Promise<void> {
    await this.loadPluginData();
    this.addSettingTab(new TaskifySettingTab(this.app, this));
    this.addCommand({
      id: "add-taskify-property", name: "Add Taskify task property",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isMarkdownFile(file)) return false;
        if (!checking) void this.addTaskProperty(file);
        return true;
      },
    });
    this.addRibbonIcon("list-checks", "Add Taskify task property", () => {
      const file = this.app.workspace.getActiveFile();
      if (!isMarkdownFile(file)) {
        new Notice("Open a Markdown note before adding a Taskify property.");
        return;
      }
      void this.addTaskProperty(file);
    });
    this.registerEvent(this.app.metadataCache.on("changed", (file, _data, cache) => {
      if (cache.frontmatter?.[this.settings.propertyName] === true ||
          cache.frontmatter?.[this.settings.propertyName] === false) {
        this.enqueue(() => this.handleMetadataChange(file));
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.enqueue(() => this.updateRenamedPaths(file, oldPath));
    }));
    // Deliberately no startup scan: enabling/upgrading Taskify is not a bulk migration.
  }

  onunload(): void { this.stopped = true; }

  async updateSettings(changes: Partial<TaskifySettings>): Promise<void> {
    this.settings = { ...this.settings, ...changes };
    if (changes.projectNotePath !== undefined) this.settings.taskFolderPath = this.projectTaskFolder();
    await this.savePluginData();
  }

  private async addTaskProperty(file: TFile): Promise<void> {
    const propertyName = this.settings.propertyName;
    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        if (frontmatter[propertyName] === undefined) frontmatter[propertyName] = false;
      });
      new Notice(`The ${propertyName} property is ready on ${file.basename}.`);
    } catch (error) { this.reportError("Could not add the Taskify property", error); }
  }

  private taskNotesApi(): TaskNotesApi {
    const app = this.app as typeof this.app & {
      plugins: { getPlugin(id: string): { api?: unknown } | null };
    };
    return requireTaskNotesApi(app.plugins.getPlugin("tasknotes")?.api);
  }

  private async handleMetadataChange(file: TFile): Promise<void> {
    if (this.stopped || !isMarkdownFile(file) || !this.app.vault.getAbstractFileByPath(file.path)) return;
    const cache = this.app.metadataCache.getFileCache(file);
    if (isTemplateFile(file) || cache?.frontmatter?.taskifySource !== undefined) return;
    const value = cache?.frontmatter?.[this.settings.propertyName];
    if (value !== true && value !== false) return;
    if (value === false && !this.records.some((record) => record.sourcePath === file.path) &&
        this.sourceTaskFiles(file.path).length === 0) return;
    const api = this.taskNotesApi();
    await api.lifecycle.ready();
    if (this.stopped) return;
    await synchronizeTaskNote(api, {
      records: this.records,
      save: () => this.savePluginData(),
      fileExists: (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile,
      findTask: (path) => this.findTaskBySource(api, path),
      prepareTaskFolder: () => this.prepareTaskFolder(),
      projectLink: () => `[[${this.settings.projectNotePath.replace(/\.md$/, "")}]]`,
      ensureFolder: (path) => this.ensureFolder(path),
      watchTaskPath: (path) => {
        const taskFile = this.app.vault.getAbstractFileByPath(path);
        if (!isMarkdownFile(taskFile)) throw new Error(`Task file not found: ${path}`);
        // Obsidian updates this object's path even if TaskNotes returns a stale
        // archive path after moving to a project-template fallback folder.
        return () => taskFile.path;
      },
    }, { path: file.path, title: file.basename }, value);
  }

  private async findTaskBySource(api: TaskNotesApi, sourcePath: string): Promise<TaskNoteRecord | null> {
    const matches = this.sourceTaskFiles(sourcePath);
    if (matches.length > 1) throw new Error(`Multiple Taskify tasks link to ${sourcePath}; resolve the duplicate task notes first.`);
    const file = matches[0];
    if (!file) return null;
    if (!await api.tasks.get(file.path)) {
      throw new Error(`TaskNotes has not indexed ${file.path}; no duplicate was created.`);
    }
    const taskFolder = folderPath(this.settings.taskFolderPath);
    return { sourcePath, taskPath: file.path, taskFolder };
  }

  private sourceTaskFiles(sourcePath: string): TFile[] {
    const matches: TFile[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (isTemplateFile(file)) continue;
      const link = this.app.metadataCache.getFileCache(file)?.frontmatter?.taskifySource;
      if (typeof link !== "string") continue;
      const match = /^\[\[([^|\]]+)(?:\|[^\]]*)?\]\]$/.exec(link);
      if (!match) continue;
      const source = this.app.metadataCache.getFirstLinkpathDest(match[1], file.path);
      if (source?.path === sourcePath) matches.push(file);
    }
    return matches;
  }

  private async prepareTaskFolder(): Promise<string> {
    if (!isMarkdownFile(this.app.vault.getAbstractFileByPath(TASK_TEMPLATE_PATH))) {
      throw new Error(`The required task template ${TASK_TEMPLATE_PATH} is missing.`);
    }
    const project = this.app.vault.getAbstractFileByPath(this.settings.projectNotePath);
    if (!isMarkdownFile(project) || isTemplateFile(project)) {
      throw new Error("Select an existing project note in Taskify settings first (for Review, Projects/Review/Review.md). A folder is not a project note.");
    }
    const folder = this.projectTaskFolder();
    await this.ensureFolder(folder);
    return folder;
  }

  private projectTaskFolder(): string {
    const path = this.settings.projectNotePath;
    const slash = path.lastIndexOf("/");
    return slash < 0 ? "Tasks" : folderPath(`${path.slice(0, slash)}/Tasks`);
  }

  private async ensureFolder(path: string): Promise<void> {
    // Validate before creating folders; tracking records are persisted user data.
    path = folderPath(path);
    let current = "";
    for (const part of path.split("/")) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing === null) await this.app.vault.createFolder(current);
      else if (!(existing instanceof TFolder)) throw new Error(`Cannot create a task folder at ${current}.`);
    }
  }

  private async updateRenamedPaths(file: TAbstractFile, oldPath: string): Promise<void> {
    let changed = false;
    for (const record of this.records) {
      for (const key of ["sourcePath", "taskPath", "taskFolder"] as const) {
        const next = renamedPath(record[key], oldPath, file.path);
        if (next !== record[key]) { record[key] = next; changed = true; }
      }
    }
    const destination = renamedPath(this.settings.taskFolderPath, oldPath, file.path);
    if (destination !== this.settings.taskFolderPath) {
      this.settings.taskFolderPath = destination;
      changed = true;
    }
    const project = renamedPath(this.settings.projectNotePath, oldPath, file.path);
    if (project !== this.settings.projectNotePath) {
      this.settings.projectNotePath = project;
      changed = true;
    }
    if (changed) await this.savePluginData();
  }

  private async loadPluginData(): Promise<void> {
    this.storedData = (await this.loadData()) as StoredPluginData | null ?? {};
    this.settings = {
      propertyName: this.storedData.propertyName === "task" ? "task" : "todo",
      taskFolderPath: migrateTaskFolder(this.storedData, (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFolder ? "folder" : file instanceof TFile ? "file" : null;
      }),
      projectNotePath: "",
    };
    const savedProject = typeof this.storedData.projectNotePath === "string"
      ? this.storedData.projectNotePath.replace(/\.md$/, "") + ".md" : "";
    if (isMarkdownFile(this.app.vault.getAbstractFileByPath(savedProject))) {
      this.settings.projectNotePath = savedProject;
    } else if ((this.storedData.projectNotePath === undefined ||
      this.storedData.projectNotePath === DEFAULT_SETTINGS.taskFolderPath ||
      this.storedData.projectNotePath === `${DEFAULT_SETTINGS.taskFolderPath}.md`) &&
      this.settings.taskFolderPath === DEFAULT_SETTINGS.taskFolderPath &&
      isMarkdownFile(this.app.vault.getAbstractFileByPath(DEFAULT_SETTINGS.projectNotePath))) {
      // Review was explicitly selected for this integration; never infer a
      // different project from a folder's name or arbitrary note ordering.
      this.settings.projectNotePath = DEFAULT_SETTINGS.projectNotePath;
    }
    if (this.settings.projectNotePath) this.settings.taskFolderPath = this.projectTaskFolder();
    this.records = Array.isArray(this.storedData.taskNoteRecords)
      ? this.storedData.taskNoteRecords.filter((record) =>
        typeof record?.sourcePath === "string" && typeof record?.taskPath === "string" &&
        typeof record?.taskFolder === "string") : [];
  }

  private async savePluginData(): Promise<void> {
    // Preserve unknown/legacy settings and checklist records; never migrate them silently.
    await this.saveData({ ...this.storedData, ...this.settings, taskNoteRecords: this.records });
  }

  private enqueue(operation: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(async () => {
      if (!this.stopped) await operation();
    }).catch((error: unknown) => this.reportError("Taskify could not synchronize a task", error));
  }

  private reportError(summary: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`${summary}: ${detail}`);
    if (!this.stopped) new Notice(`${summary}: ${detail}`);
  }
}

function isMarkdownFile(file: TAbstractFile | null): file is TFile {
  return file instanceof TFile && file.extension === "md";
}
function isTemplateFile(file: TFile): boolean {
  return file.path.split("/").some((segment) => segment.toLowerCase() === "templates");
}
