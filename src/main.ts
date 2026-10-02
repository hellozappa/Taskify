import {
  App,
  CachedMetadata,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  Vault,
} from "obsidian";

import {
  DEFAULT_SETTINGS,
  TaskifySettingTab,
  type TaskifySettings,
} from "./settings";
import {
  appendManagedTask,
  findManagedTask,
  removeManagedTask,
  renderTaskStoreTitle,
  replaceManagedTaskStatus,
  synchronizeTaskStoreTitle,
  taskStoreTitleFromPath,
  type ManagedTask,
} from "./task-store";

type TaskRecord = {
  id: string;
  sourcePath: string;
  storagePath: string;
};

type StoredPluginData = Partial<TaskifySettings> & {
  taskRecords?: TaskRecord[];
};

type VaultWithConfiguration = Vault & {
  getConfig?: (key: string) => unknown;
};

export default class TaskifyPlugin extends Plugin {
  settings: TaskifySettings = DEFAULT_SETTINGS;
  private taskRecords: TaskRecord[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.addSettingTab(new TaskifySettingTab(this.app, this));
    this.addCommand({
      id: "add-taskify-property",
      name: "Add Taskify task property",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isMarkdownFile(file)) {
          return false;
        }

        if (!checking) {
          void this.addTaskProperty(file);
        }

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

    this.registerEvent(
      this.app.metadataCache.on(
        "changed",
        (file: TFile, _data: string, cache: CachedMetadata) => {
          this.enqueue(async () => {
            await this.handleMetadataChange(file, cache);
          });
        },
      ),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (isMarkdownFile(file)) {
          this.enqueue(async () => {
            await this.normalizeCompletedTasksInFile(file);
          });
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (isMarkdownFile(file)) {
          this.enqueue(async () => {
            await this.updateRenamedRecordPaths(file, oldPath);
          });
        }
      }),
    );
  }

  async updateSettings(changes: Partial<TaskifySettings>): Promise<void> {
    this.settings = { ...this.settings, ...changes };
    await this.savePluginData();
  }

  private async addTaskProperty(file: TFile): Promise<void> {
    const propertyName = this.settings.propertyName;
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache?.frontmatter?.[propertyName] !== undefined) {
      new Notice(`This note already has a ${propertyName} property.`);
      return;
    }

    try {
      await this.app.fileManager.processFrontMatter(
        file,
        (frontmatter: Record<string, unknown>) => {
          frontmatter[propertyName] = false;
        },
      );
      new Notice(`Added ${propertyName} to ${file.basename}.`);
    } catch (error) {
      this.reportError("Could not add the Taskify property", error);
    }
  }

  private async handleMetadataChange(
    file: TFile,
    cache: CachedMetadata,
  ): Promise<void> {
    if (this.isTaskStorageFile(file) || isTemplateFile(file)) {
      return;
    }

    const value = cache.frontmatter?.[this.settings.propertyName];
    if (value === true) {
      await this.ensureTaskForFile(file);
      return;
    }

    if (value === false) {
      await this.removeOpenTaskForFile(file);
    }
  }

  private async ensureTaskForFile(file: TFile): Promise<void> {
    const existingRecord = this.findRecordForSource(file.path);
    if (existingRecord !== null) {
      const storageFile = await this.getTaskStorageFile(existingRecord.storagePath);
      const existingMarkdown = await this.app.vault.read(storageFile);
      if (findManagedTask(existingMarkdown, existingRecord.id) !== null) {
        return;
      }

      const restored = appendManagedTask(
        existingMarkdown,
        this.createManagedTask(existingRecord.id, file),
      );
      await this.app.vault.modify(storageFile, restored);
      return;
    }

    const storagePath = this.taskStoragePath();
    const storageFile = await this.getTaskStorageFile(storagePath);
    const record: TaskRecord = {
      id: crypto.randomUUID(),
      sourcePath: file.path,
      storagePath,
    };
    const markdown = await this.app.vault.read(storageFile);
    await this.app.vault.modify(
      storageFile,
      appendManagedTask(markdown, this.createManagedTask(record.id, file)),
    );
    this.taskRecords.push(record);
    await this.savePluginData();
  }

  private async removeOpenTaskForFile(file: TFile): Promise<void> {
    const record = this.findRecordForSource(file.path);
    if (record === null) {
      return;
    }

    const storageFile = await this.getTaskStorageFile(record.storagePath);
    const markdown = await this.app.vault.read(storageFile);
    const task = findManagedTask(markdown, record.id);
    if (task === null || this.isCompletedStatus(task.statusSymbol)) {
      return;
    }

    await this.app.vault.modify(storageFile, removeManagedTask(markdown, record.id));
    this.taskRecords = this.taskRecords.filter((candidate) => candidate.id !== record.id);
    await this.savePluginData();
  }

  private async normalizeCompletedTasksInFile(file: TFile): Promise<void> {
    const records = this.taskRecords.filter(
      (record) => record.storagePath === file.path,
    );
    if (records.length === 0) {
      return;
    }

    const desiredStatus = this.completedStatusSymbol();
    if (desiredStatus === "x") {
      return;
    }

    const markdown = await this.app.vault.read(file);
    let updatedMarkdown = markdown;
    for (const record of records) {
      const task = findManagedTask(updatedMarkdown, record.id);
      if (task?.statusSymbol === "x") {
        updatedMarkdown = replaceManagedTaskStatus(
          updatedMarkdown,
          record.id,
          desiredStatus,
        );
      }
    }

    if (updatedMarkdown !== markdown) {
      await this.app.vault.modify(file, updatedMarkdown);
    }
  }

  private async getTaskStorageFile(storagePath: string): Promise<TFile> {
    const existing = this.app.vault.getAbstractFileByPath(storagePath);
    if (existing instanceof TFile) {
      await this.synchronizeTaskStorageTitle(existing);
      return existing;
    }

    if (existing !== null) {
      throw new Error(`Taskify storage path is not a Markdown file: ${storagePath}`);
    }

    await this.ensureParentFolders(storagePath);
    return this.app.vault.create(
      storagePath,
      renderTaskStoreTitle(
        taskStoreTitleFromPath(storagePath),
        this.inlineTitlesEnabled(),
      ),
    );
  }

  private async synchronizeTaskStorageTitle(file: TFile): Promise<void> {
    const markdown = await this.app.vault.read(file);
    const updatedMarkdown = synchronizeTaskStoreTitle(
      markdown,
      taskStoreTitleFromPath(file.path),
      this.inlineTitlesEnabled(),
    );
    if (updatedMarkdown !== markdown) {
      await this.app.vault.modify(file, updatedMarkdown);
    }
  }

  private async ensureParentFolders(storagePath: string): Promise<void> {
    const pathSegments = storagePath.split("/");
    pathSegments.pop();
    let parentPath = "";
    for (const segment of pathSegments) {
      parentPath = parentPath.length === 0 ? segment : `${parentPath}/${segment}`;
      const existing = this.app.vault.getAbstractFileByPath(parentPath);
      if (existing === null) {
        await this.app.vault.createFolder(parentPath);
      } else if (!(existing instanceof TFolder)) {
        throw new Error(`Taskify cannot create a folder at ${parentPath}.`);
      }
    }
  }

  private async updateRenamedRecordPaths(
    file: TFile,
    oldPath: string,
  ): Promise<void> {
    let changed = false;
    this.taskRecords = this.taskRecords.map((record) => {
      if (record.sourcePath === oldPath) {
        changed = true;
        return { ...record, sourcePath: file.path };
      }
      if (record.storagePath === oldPath) {
        changed = true;
        return { ...record, storagePath: file.path };
      }
      return record;
    });

    if (changed) {
      await this.savePluginData();
    }
  }

  private createManagedTask(id: string, file: TFile): ManagedTask {
    return {
      id,
      sourcePath: file.path,
      sourceTitle: file.basename,
      statusSymbol: " ",
    };
  }

  private findRecordForSource(sourcePath: string): TaskRecord | null {
    return (
      this.taskRecords.find((record) => record.sourcePath === sourcePath) ?? null
    );
  }

  private isCompletedStatus(statusSymbol: string): boolean {
    return statusSymbol === "x" || statusSymbol === this.completedStatusSymbol();
  }

  private isTaskStorageFile(file: TFile): boolean {
    return this.taskRecords.some((record) => record.storagePath === file.path) ||
      file.path === this.taskStoragePath();
  }

  private inlineTitlesEnabled(): boolean {
    const vault = this.app.vault as VaultWithConfiguration;
    return vault.getConfig?.("showInlineTitle") === true;
  }

  private taskStoragePath(): string {
    const configuredPath = this.settings.taskFilePath.trim();
    if (configuredPath.length === 0) {
      throw new Error("Set a Taskify task storage file in settings before creating tasks.");
    }

    const normalizedPath = configuredPath
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+/g, "/");
    if (normalizedPath.split("/").some((segment) => segment === "..")) {
      throw new Error("The Taskify task storage path cannot contain '..'.");
    }

    return normalizedPath.toLowerCase().endsWith(".md")
      ? normalizedPath
      : `${normalizedPath}.md`;
  }

  private completedStatusSymbol(): string {
    const statusSymbol = this.settings.completedStatusSymbol.trim();
    if (Array.from(statusSymbol).length !== 1) {
      throw new Error("The Taskify completed task status must be one character.");
    }

    return statusSymbol;
  }

  private async loadPluginData(): Promise<void> {
    const storedData = (await this.loadData()) as StoredPluginData | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      propertyName:
        storedData?.propertyName === "todo" ? "todo" : DEFAULT_SETTINGS.propertyName,
      taskFilePath: storedData?.taskFilePath ?? DEFAULT_SETTINGS.taskFilePath,
      completedStatusSymbol:
        storedData?.completedStatusSymbol ?? DEFAULT_SETTINGS.completedStatusSymbol,
    };
    this.taskRecords = storedData?.taskRecords ?? [];
  }

  private async savePluginData(): Promise<void> {
    await this.saveData({ ...this.settings, taskRecords: this.taskRecords });
  }

  private enqueue(operation: () => Promise<void>): void {
    this.writeQueue = this.writeQueue
      .then(operation)
      .catch((error: unknown) => {
        this.reportError("Taskify could not synchronize a task", error);
      });
  }

  private reportError(summary: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`${summary}: ${detail}`);
    new Notice(`${summary}: ${detail}`);
  }
}

function isMarkdownFile(file: TAbstractFile | null): file is TFile {
  return file instanceof TFile && file.extension === "md";
}

function isTemplateFile(file: TFile): boolean {
  return file.path.split("/").some((segment) => segment.toLowerCase() === "templates");
}
