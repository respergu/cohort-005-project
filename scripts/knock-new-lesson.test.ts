import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { notificationWorkflows } from "../app/lib/notification-workflows";
import { KNOCK_DIR } from "./knock-content";

// New lesson goes to the Notification Feed only, never by email, batched per
// course for each Student (PRD #37, row 9). It's most of Cadence's Knock
// volume (#34), so the batch is what keeps it under the Free plan.

const workflowFile = z.object({
  categories: z.array(z.string()),
  steps: z.array(
    z.object({
      ref: z.string(),
      type: z.string(),
      channel_key: z.string().optional(),
      settings: z.record(z.unknown()).optional(),
    })
  ),
});

const workflow = workflowFile.parse(
  JSON.parse(
    readFileSync(
      join(KNOCK_DIR, "workflows", "new-lesson", "workflow.json"),
      "utf8"
    )
  )
);

describe("the New lesson workflow", () => {
  it("batches, then sends to the Notification Feed only", () => {
    expect(workflow.steps.map((step) => step.type)).toEqual([
      "batch",
      "channel",
    ]);
    expect(workflow.steps[1]?.channel_key).toBe("in-app");
    expect(workflow.categories).toEqual(["new-lesson"]);
  });

  it("batches per course, for a fixed hour from the first lesson, with no early flush", () => {
    expect(workflow.steps[0]?.settings).toEqual({
      batch_key: "data.course_id",
      batch_window_type: "fixed",
      batch_window: { unit: "hours", value: 1 },
      batch_execution_mode: "accumulate",
      batch_order: "asc",
      workflow_version_mode: "latest",
    });
  });

  it("batches on a key every trigger carries", () => {
    const { shape } = notificationWorkflows["new-lesson"];

    expect(shape.course_id.isOptional()).toBe(false);
  });
});
