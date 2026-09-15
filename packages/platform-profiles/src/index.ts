import { TestProfileRegistrySchema } from "./schema.js";
import draftRegistry from "./test-profiles.v1.json";

export const TEST_PROFILE_REGISTRY = TestProfileRegistrySchema.parse(draftRegistry);

export {
  ActivationProofSchema,
  PLATFORM_PROFILE_SCHEMA_VERSION,
  PreparationBoundsSchema,
  ProfileSourceSchema,
  PUBLISH_MODES,
  PublishModeSchema,
  TEST_PROFILE_IDS,
  TestProfileIdSchema,
  TestProfileRegistrySchema,
  TestProfileSchema,
  type TestProfile,
  type TestProfileRegistry,
} from "./schema.js";
