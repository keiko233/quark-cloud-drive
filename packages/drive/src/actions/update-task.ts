import type {
  QuarkTaskOperation,
  QuarkUpdateTaskResult,
} from "@quark/contract/schemas";
import { log } from "@quark/config";
import { getQuarkPage } from "./browser-session.ts";
import { updateQuarkTasksInBrowser } from "./task-api.ts";

export interface UpdateTaskInput {
  taskIds: string[];
  operation: QuarkTaskOperation;
  raw?: boolean;
}

/**
 * Apply `resume` (also retries) or `delete` to cloud tasks through
 * `POST /1/clouddrive/task/status`. Quark's cloud API has no pause code.
 */
export async function updateTask(
  input: UpdateTaskInput,
): Promise<QuarkUpdateTaskResult> {
  const taskIds = input.taskIds.map((taskId) => taskId.trim()).filter(
    (taskId) => taskId !== "",
  );
  if (taskIds.length === 0) throw new Error("updateTask: taskIds is required");

  const page = await getQuarkPage();
  const result = await updateQuarkTasksInBrowser(
    page,
    taskIds,
    input.operation,
  );
  log.debug(`updateTask: ${input.operation} ${taskIds.length} task(s)`);

  return {
    success: true,
    taskIds,
    operation: input.operation,
    ...(input.raw === true ? { raw: result.raw } : {}),
  };
}
