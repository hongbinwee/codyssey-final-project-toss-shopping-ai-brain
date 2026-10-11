import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join, sep } from "node:path";

// Reserve one new capture directory atomically. Existing run paths are never
// reused; a collision throws before the caller can perform cart mutations.
export async function reserveCaptureOutput(
  root: string,
  runId: string = randomUUID(),
): Promise<string> {
  if (!/^[a-zA-Z0-9-]+$/.test(runId))
    throw new Error("invalid capture run id");
  await mkdir(root, { recursive: true });
  const dir = join(root, "run-" + runId);
  await mkdir(dir); // exclusive: EEXIST means fail closed
  if ((await readdir(dir)).length !== 0)
    throw new Error("capture output directory is not empty");
  return dir + sep;
}
