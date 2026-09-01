import { HttpStatus, Injectable, type ArgumentMetadata, type PipeTransform } from "@nestjs/common";
import { z, type ZodType } from "zod";

import { AppException, ERROR_CODES } from "../errors/error-codes.js";

/**
 * A DTO class that carries its own Zod schema.
 *
 * `nestjs-zod` does the same thing with more machinery and a peer dependency on a
 * Zod major we do not control; this is the whole idea in twenty lines. The class
 * exists purely so Nest's parameter metadata (`design:paramtypes`) has something
 * to hand the pipe — it is never instantiated.
 */
export interface ZodDto<T = unknown> {
  new (): T;
  readonly zodSchema: ZodType<T>;
}

/**
 * Build a DTO class from a schema:
 *
 * ```ts
 * const CreateProject = z.object({ title: z.string().min(1) });
 * class CreateProjectDto extends zodDto(CreateProject) {}
 *
 * @Post() create(@Body() body: CreateProjectDto) { ... }   // already validated
 * ```
 */
export function zodDto<T>(schema: ZodType<T>): ZodDto<T> {
  class Dto {
    static readonly zodSchema = schema;
  }
  return Dto as unknown as ZodDto<T>;
}

function isZodDto(metatype: unknown): metatype is ZodDto {
  return (
    typeof metatype === "function" &&
    "zodSchema" in metatype &&
    (metatype as { zodSchema?: unknown }).zodSchema instanceof z.ZodType
  );
}

/**
 * Global validation pipe.
 *
 * Only acts on parameters whose type is a {@link zodDto} class; everything else
 * passes through untouched, so route params and primitives are unaffected. A
 * failure becomes `common/validation_failed` with the Zod issues as `details`,
 * which the exception filter renders into the CONTRACTS §8 envelope.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const { metatype } = metadata;
    if (!isZodDto(metatype)) return value;

    const result = metatype.zodSchema.safeParse(value);
    if (result.success) return result.data;

    throw new AppException(
      ERROR_CODES.validationFailed,
      "Request validation failed.",
      HttpStatus.BAD_REQUEST,
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
}
