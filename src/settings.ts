import { App, PluginSettingTab, Setting } from "obsidian";
import type TaskifyPlugin from "./main";

export type TaskifySettings = {
  propertyName: "task" | "todo";
  taskFolderPath: string;
  projectNotePath: string;
};

export const DEFAULT_SETTINGS: TaskifySettings = {
  propertyName: "todo",
  taskFolderPath: "Projects/Review/Tasks",
  projectNotePath: "Projects/Review/Review.md",
};

export class TaskifySettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: TaskifyPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Taskify" });
    new Setting(containerEl).setName("Note property")
      .setDesc("Checking this Boolean property creates a native TaskNotes task. Unchecking archives it; rechecking restores the same task.")
      .addDropdown((dropdown) => dropdown.addOption("todo", "todo").addOption("task", "task")
        .setValue(this.plugin.settings.propertyName).onChange(async (value) => {
          if (value === "todo" || value === "task") await this.plugin.updateSettings({ propertyName: value });
        }));
    new Setting(containerEl).setName("Project note")
      .setDesc("Select the existing note that identifies the project. Tasks link to this note and are stored in its folder's Tasks subfolder. No task-store file is required.")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "Select a project note");
        for (const file of this.app.vault.getMarkdownFiles().filter((file) => !file.path.split("/").some((part) => part.toLowerCase() === "templates")).sort((a, b) => a.path.localeCompare(b.path))) {
          dropdown.addOption(file.path, file.path);
        }
        dropdown.setValue(this.plugin.settings.projectNotePath).onChange(async (value) => {
          await this.plugin.updateSettings({ projectNotePath: value });
        });
      });
    containerEl.createEl("p", { text: "Requires TaskNotes runtime API v1 (tested with 4.13.8). Enable its body template Templates/_Task.md and use {{projectFolder}}/Tasks as its task-folder setting. Taskify passes the selected project to TaskNotes and verifies placement without changing TaskNotes settings." });
    containerEl.createEl("p", { text: "Manage completion and custom statuses such as Read in TaskNotes settings. Taskify does not change completion statuses or the source checkbox when a task is completed." });
    containerEl.createEl("p", { text: "Archive behavior follows TaskNotes' archive settings, including any archive-folder movement. Existing checklist files and legacy Taskify settings are preserved but are no longer used." });
  }
}
