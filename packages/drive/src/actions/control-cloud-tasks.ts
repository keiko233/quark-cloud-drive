import type {
  QuarkTaskOperation,
  QuarkUpdateTaskResult,
} from "@quark/contract/schemas";
import { log } from "@quark/config";
import { getQuarkTransport } from "./quark-session.ts";
import { updateQuarkTasks } from "../api/task-api.ts";

export interface ControlCloudTasksInput {
  taskIds: string[];
  operation: QuarkTaskOperation;
  raw?: boolean;
}

/**
 * Apply `resume` (also retries) or `delete` to cloud tasks through
 * `POST /1/clouddrive/task/status`. Quark's cloud API has no pause code.
 */
export async function controlCloudTasks(
  input: ControlCloudTasksInput,
): Promise<QuarkUpdateTaskResult> {
  const taskIds = input.taskIds.map((taskId) => taskId.trim()).filter(
    (taskId) => taskId !== "",
  );
  if (taskIds.length === 0) throw new Error("controlCloudTasks: taskIds is required");

  const transport = getQuarkTransport();
  const result = await updateQuarkTasks(
    transport,
    taskIds,
    input.operation,
  );
  log.debug(`controlCloudTasks: ${input.operation} ${taskIds.length} task(s)`);

  return {
    success: true,
    taskIds,
    operation: input.operation,
    ...(input.raw === true ? { raw: result.raw } : {}),
  };
}
