import { Global, Module } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { DERIVED_STORE, RAW_STORE } from "./object-store.js";
import { S3ObjectStore } from "./s3-object-store.js";
import { ENV } from "../../config/config.module.js";

/**
 * The two object stores of CONTRACTS §6, as injectable singletons.
 *
 * ```ts
 * constructor(@Inject(RAW_STORE) private readonly raw: ObjectStore) {}
 * ```
 *
 * They are separate providers rather than one store with a bucket argument
 * because they are separate *systems*: raw media lives on AWS S3 in `ap-south-1`
 * and must stay there (THREAT-MODEL T24), while derived objects live on
 * Cloudflare R2 with an APAC location hint, where egress is free. Making the
 * caller name the store means a proxy can never be written into the residency
 * bucket by a typo, and it is why `media_assets.bucket` exists.
 *
 * `@Global()`, like the other `common` modules, so a feature module injects a
 * store without importing anything.
 */
@Global()
@Module({
  providers: [
    {
      provide: RAW_STORE,
      inject: [ENV],
      useFactory: (env: Env) =>
        new S3ObjectStore({
          kind: "s3",
          bucket: env.S3_BUCKET_RAW,
          endpoint: env.S3_ENDPOINT,
          region: env.S3_REGION,
          accessKeyId: env.S3_ACCESS_KEY,
          secretAccessKey: env.S3_SECRET_KEY,
        }),
    },
    {
      provide: DERIVED_STORE,
      inject: [ENV],
      useFactory: (env: Env) =>
        new S3ObjectStore({
          kind: "r2",
          bucket: env.R2_BUCKET_DERIVED,
          endpoint: env.R2_ENDPOINT,
          ...(env.R2_PUBLIC_ENDPOINT === undefined
            ? {}
            : { publicEndpoint: env.R2_PUBLIC_ENDPOINT }),
          // R2 has one region and calls it `auto`; MinIO takes whatever it is
          // given. Reusing `S3_REGION` keeps SigV4 happy against both.
          region: env.S3_REGION,
          accessKeyId: env.R2_ACCESS_KEY,
          secretAccessKey: env.R2_SECRET_KEY,
        }),
    },
  ],
  exports: [RAW_STORE, DERIVED_STORE],
})
export class StorageModule {}
