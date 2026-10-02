import { describe, expect, it } from "vitest";

import {
  appendManagedTask,
  findManagedTask,
  removeManagedTask,
  replaceManagedTaskStatus,
  renderTaskStoreTitle,
  synchronizeTaskStoreTitle,
  taskStoreTitleFromPath,
} from "../src/task-store";

const task = {
  id: "4b2016c6-29c8-4d9e-92b1-4e9d6e5a3e4f",
  sourcePath: "Articles/Example Note.md",
  sourceTitle: "Example Note",
  statusSymbol: " ",
};

describe("task-store", () => {
  it("writes a standard Tasks line with an invisible ownership marker", () => {
    expect(appendManagedTask("", task)).toBe(
      "- [ ] [[Example Note]]\n%%taskify:4b2016c6-29c8-4d9e-92b1-4e9d6e5a3e4f%%\n",
    );
  });

  it("finds and changes only the matching managed task", () => {
    const markdown = appendManagedTask("", task);
    const changed = replaceManagedTaskStatus(markdown, task.id, "r");

    expect(findManagedTask(changed, task.id)?.statusSymbol).toBe("r");
    expect(changed).toContain("- [r] [[Example Note]]");
  });

  it("keeps Tasks metadata that is added when a task is completed", () => {
    const completed = "- [x] [[Example Note]] ✅ 2026-10-01\n%%taskify:4b2016c6-29c8-4d9e-92b1-4e9d6e5a3e4f%%\n";

    expect(findManagedTask(completed, task.id)?.statusSymbol).toBe("x");
    expect(replaceManagedTaskStatus(completed, task.id, "r")).toBe(
      "- [r] [[Example Note]] ✅ 2026-10-01\n%%taskify:4b2016c6-29c8-4d9e-92b1-4e9d6e5a3e4f%%\n",
    );
  });

  it("removes the task and its ownership marker together", () => {
    const markdown = appendManagedTask("# Taskify Tasks\n", task);

    expect(removeManagedTask(markdown, task.id)).toBe("# Taskify Tasks\n");
  });

  it("uses the file name as the task-store title", () => {
    expect(taskStoreTitleFromPath("Planning/My Taskify Tasks.md")).toBe(
      "My Taskify Tasks",
    );
  });

  it("adds an H1 only when inline titles are disabled", () => {
    expect(renderTaskStoreTitle("My Taskify Tasks", false)).toBe(
      "# My Taskify Tasks\n",
    );
    expect(renderTaskStoreTitle("My Taskify Tasks", true)).toBe("");
    expect(
      synchronizeTaskStoreTitle("- [ ] [[Example Note]]\n", "My Taskify Tasks", false),
    ).toBe("# My Taskify Tasks\n\n- [ ] [[Example Note]]\n");
  });

  it("removes its own H1 when inline titles are enabled", () => {
    expect(
      synchronizeTaskStoreTitle(
        "# My Taskify Tasks\n\n- [ ] [[Example Note]]\n",
        "My Taskify Tasks",
        true,
      ),
    ).toBe("- [ ] [[Example Note]]\n");
  });
});
