export type ManagedTask = {
  id: string;
  sourcePath: string;
  sourceTitle: string;
  statusSymbol: string;
};

export type ManagedTaskMatch = ManagedTask & {
  end: number;
  start: number;
};

const TASK_BLOCK_PATTERN = /^- \[([^\]\r\n])\] \[\[([^\]]+)\]\]([^\r\n]*)\r?\n%%taskify:([a-zA-Z0-9-]+)%%$/gm;

export function appendManagedTask(markdown: string, task: ManagedTask): string {
  const taskBlock = renderManagedTask(task);
  if (markdown.trim().length === 0) {
    return `${taskBlock}\n`;
  }

  return `${markdown.trimEnd()}\n\n${taskBlock}\n`;
}

export function findManagedTask(
  markdown: string,
  taskId: string,
): ManagedTaskMatch | null {
  for (const match of markdown.matchAll(TASK_BLOCK_PATTERN)) {
    const [block, statusSymbol, sourceTitle, _taskMetadata, id] = match;
    if (id === taskId && block !== undefined && statusSymbol !== undefined && sourceTitle !== undefined) {
      return {
        end: match.index + block.length,
        id,
        sourcePath: "",
        sourceTitle,
        start: match.index,
        statusSymbol,
      };
    }
  }

  return null;
}

export function removeManagedTask(markdown: string, taskId: string): string {
  const task = findManagedTask(markdown, taskId);
  if (task === null) {
    return markdown;
  }

  const remainingAfterTask = markdown.slice(task.end);
  if (remainingAfterTask.trim().length === 0) {
    return `${markdown.slice(0, task.start).trimEnd()}\n`;
  }

  const before = markdown.slice(0, task.start).replace(/\n{2}$/, "\n");
  const after = remainingAfterTask.replace(/^\n{2}/, "\n");
  return `${before}${after}`;
}

export function replaceManagedTaskStatus(
  markdown: string,
  taskId: string,
  statusSymbol: string,
): string {
  const task = findManagedTask(markdown, taskId);
  if (task === null || task.statusSymbol === statusSymbol) {
    return markdown;
  }

  const statusStart = task.start + 3;
  return `${markdown.slice(0, statusStart)}${statusSymbol}${markdown.slice(statusStart + 1)}`;
}

export function renderTaskStoreTitle(
  title: string,
  inlineTitlesEnabled: boolean,
): string {
  return inlineTitlesEnabled ? "" : `# ${title}\n`;
}

export function synchronizeTaskStoreTitle(
  markdown: string,
  title: string,
  inlineTitlesEnabled: boolean,
): string {
  const heading = `# ${title}`;
  if (inlineTitlesEnabled) {
    if (markdown === heading) {
      return "";
    }

    if (markdown.startsWith(`${heading}\n\n`)) {
      return markdown.slice(heading.length + 2);
    }

    if (markdown.startsWith(`${heading}\n`)) {
      return markdown.slice(heading.length + 1);
    }

    return markdown;
  }

  if (markdown.startsWith(heading)) {
    return markdown;
  }

  return markdown.length === 0 ? `${heading}\n` : `${heading}\n\n${markdown}`;
}

export function taskStoreTitleFromPath(path: string): string {
  const pathSegments = path.split("/");
  const filename = pathSegments[pathSegments.length - 1] ?? path;
  return filename.replace(/\.md$/i, "");
}

function renderManagedTask(task: ManagedTask): string {
  return `- [${task.statusSymbol}] [[${escapeWikilinkText(task.sourceTitle)}]]\n%%taskify:${task.id}%%`;
}

function escapeWikilinkText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}
