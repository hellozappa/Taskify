import { App, PluginSettingTab, Setting } from "obsidian";
import type TaskifyPlugin from "./main";

export type TaskifySettings = {
  propertyName: "task" | "todo";
  projectNotePath: string;
};

export const DEFAULT_SETTINGS: TaskifySettings = {
  propertyName: "todo",
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
      .setDesc("Exact vault-relative path to an existing project note. Tasks are created in that project's Tasks subfolder.")
      .addText((text) => text.setPlaceholder("Projects/Review/Review.md")
        .setValue(this.plugin.settings.projectNotePath).onChange(async (value) => {
          await this.plugin.updateSettings({ projectNotePath: value.trim() });
        }));
    containerEl.createEl("p", { text: "Requires TaskNotes runtime API v1 (tested with 4.13.8). In TaskNotes, set the task folder to {{projectFolder}}/Tasks. Taskify uses TaskNotes' template, filename, status, priority, and date defaults." });
    containerEl.createEl("p", { text: "Manage completion and custom statuses such as Read in TaskNotes settings. Taskify does not change completion statuses or the source checkbox when a task is completed." });
    containerEl.createEl("p", { text: "Archive behavior follows TaskNotes' archive settings, including any archive-folder movement. Existing checklist files and legacy Taskify settings are preserved but are no longer used." });
  }
}
