import { App, PluginSettingTab, Setting } from "obsidian";

import type TaskifyPlugin from "./main";

export type TaskifySettings = {
  propertyName: "task" | "todo";
  taskFilePath: string;
  completedStatusSymbol: string;
};

export const DEFAULT_SETTINGS: TaskifySettings = {
  propertyName: "task",
  taskFilePath: "Taskify Tasks.md",
  completedStatusSymbol: "x",
};

export class TaskifySettingTab extends PluginSettingTab {
  private readonly plugin: TaskifyPlugin;

  constructor(app: App, plugin: TaskifyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Taskify" });

    new Setting(containerEl)
      .setName("Note property")
      .setDesc("A checked property creates a task. You can also add it with Taskify’s command or ribbon action.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("task", "task")
          .addOption("todo", "todo")
          .setValue(this.plugin.settings.propertyName)
          .onChange(async (value) => {
            if (value === "task" || value === "todo") {
              await this.plugin.updateSettings({ propertyName: value });
            }
          });
      });

    new Setting(containerEl)
      .setName("Task storage file")
      .setDesc("Vault-relative path for Taskify’s Markdown task store. Its filename is its displayed note title. The file is created when Taskify first creates a task.")
      .addText((text) => {
        text
          .setPlaceholder("Planning/Taskify Tasks.md")
          .setValue(this.plugin.settings.taskFilePath)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ taskFilePath: value });
          });
      });

    new Setting(containerEl)
      .setName("Completed task status")
      .setDesc("One Tasks status symbol, such as x or r. For a custom symbol, first add it in Tasks settings with status type Done. Taskify does not modify Tasks settings.")
      .addText((text) => {
        text
          .setPlaceholder("x")
          .setValue(this.plugin.settings.completedStatusSymbol)
          .onChange(async (value) => {
            const symbol = value.trim();
            if (Array.from(symbol).length === 1) {
              await this.plugin.updateSettings({ completedStatusSymbol: symbol });
            }
          });
      });
  }
}
