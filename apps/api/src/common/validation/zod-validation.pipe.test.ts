import { describe, expect, it } from "vitest";
import { z } from "zod";

import { zodDto, ZodValidationPipe } from "./zod-validation.pipe.js";
import { AppException, ERROR_CODES } from "../errors/error-codes.js";

import type { ArgumentMetadata } from "@nestjs/common";

const CreateProject = z.object({
  title: z.string().min(1),
  aspect: z.enum(["9:16", "16:9", "1:1", "4:5"]).default("9:16"),
});

class CreateProjectDto extends zodDto(CreateProject) {}

function metadata(metatype: unknown): ArgumentMetadata {
  return { type: "body", metatype: metatype as ArgumentMetadata["metatype"] };
}

describe("ZodValidationPipe", () => {
  const pipe = new ZodValidationPipe();

  it("returns the PARSED value, so defaults and coercions apply", () => {
    const out = pipe.transform({ title: "My reel" }, metadata(CreateProjectDto));
    expect(out).toEqual({ title: "My reel", aspect: "9:16" });
  });

  it("strips unknown keys rather than passing them through", () => {
    const out = pipe.transform(
      { title: "My reel", isAdmin: true },
      metadata(CreateProjectDto),
    ) as Record<string, unknown>;
    expect(out["isAdmin"]).toBeUndefined();
  });

  it("throws common/validation_failed with a path per issue", () => {
    let thrown: unknown;
    try {
      pipe.transform({ title: "", aspect: "3:2" }, metadata(CreateProjectDto));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppException);
    const error = thrown as AppException;
    expect(error.code).toBe(ERROR_CODES.validationFailed);
    expect(error.httpStatus).toBe(400);

    const details = error.details as { issues: { path: string; message: string }[] };
    expect(details.issues.map((issue) => issue.path).sort()).toEqual(["aspect", "title"]);
  });

  it("leaves parameters that are not Zod DTOs completely alone", () => {
    expect(pipe.transform("01JQ...", metadata(String))).toBe("01JQ...");
    expect(pipe.transform(7, metadata(Number))).toBe(7);
    expect(pipe.transform({ raw: true }, metadata(undefined))).toEqual({ raw: true });
    // A plain class with no schema is not ours to validate.
    class Plain {}
    expect(pipe.transform({ raw: true }, metadata(Plain))).toEqual({ raw: true });
  });
});

describe("zodDto", () => {
  it("hangs the schema off the class so Nest metadata can find it", () => {
    expect(CreateProjectDto.zodSchema).toBe(CreateProject);
  });
});
