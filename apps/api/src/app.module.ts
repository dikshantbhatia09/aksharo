import { Module } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";

import { AdminModule } from "./admin/admin.module.js";
import { AffiliatesModule } from "./affiliates/affiliates.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { BillingModule } from "./billing/billing.module.js";
import { CommonModule } from "./common/common.module.js";
import { ConsentsModule } from "./consents/consents.module.js";
import { CreditsModule } from "./credits/credits.module.js";
import { DevicesModule } from "./devices/devices.module.js";
import { EdgModule } from "./edg/edg.module.js";
import { ExportsModule } from "./exports/exports.module.js";
import { FontsModule } from "./fonts/fonts.module.js";
import { HealthModule } from "./health/health.module.js";
import { InternalModule } from "./internal/internal.module.js";
import { InvoicesModule } from "./invoices/invoices.module.js";
import { JobsModule } from "./jobs/jobs.module.js";
import { LicensingModule } from "./licensing/licensing.module.js";
import { MediaModule } from "./media/media.module.js";
import { NotifyModule } from "./notify/notify.module.js";
import { OffersModule } from "./offers/offers.module.js";
import { PrivacyModule } from "./privacy/privacy.module.js";
import { ProjectsModule } from "./projects/projects.module.js";
import { RealtimeModule } from "./realtime/realtime.module.js";
import { ReferralsModule } from "./referrals/referrals.module.js";
import { StylesModule } from "./styles/styles.module.js";
import { TaxModule } from "./tax/tax.module.js";
import { ScriptsModule } from "./transcripts/scripts/scripts.module.js";
import { TranscriptsModule } from "./transcripts/transcripts.module.js";
import { UsersModule } from "./users/users.module.js";
import { TeamsModule } from "./workspaces/teams/teams.module.js";
import { WorkspacesModule } from "./workspaces/workspaces.module.js";

/**
 * Root module of the modular monolith. One feature module per work package
 * (05-system-architecture, section 3): `auth`, `users`, `workspaces`, `projects`,
 * `media`, `transcripts`, `edg`, `jobs`, `exports`, `billing`, `credits`, ...
 *
 * A03 wired `common` (config, logging, Prisma, Redis, validation, scheduler) and
 * `health`; A04 adds `auth` and the minimal `users` it needs; A08 adds `credits`
 * (the no-op facade), `realtime`, `jobs` and the signed `internal` surface; A08b
 * adds `admin`, the platform-staff surface behind `AdminGuard`; A05 fills out
 * `users` and adds `workspaces`, `consents` and `privacy`; A25 adds `notify`
 * (mail delivery and the in-app bell); A12 adds `edg`, the editing document and
 * its op batches; A06 adds `projects` (with folders) and `media` (upload,
 * derived URLs, import, retention); A11 adds `transcripts` — the
 * `ai.transcribe` producer, the completion that writes the transcript and
 * initialises the document, and the read and export surface; A18b adds
 * `fonts`, the bundled open-licence catalogue and a workspace's own uploads
 * with their licence warranty; A14 adds `styles` (the catalogue `GET /styles`
 * reads, plus a workspace's own presets) for the web shell's Home and Projects
 * screens; A22 adds `transcripts/scripts` — the `ai.transliterate`/
 * `ai.translate` producers, their completion handlers and the internal write
 * path transliteration needed of its own; B01 adds `billing`: the
 * `BillingProvider` port, checkout, webhooks and subscription management.
 * B04 adds `offers`: the real signup-gift/₹9-pass/week-pass/top-up backing
 * (`ExportsModule` and `BillingModule` both import it for the
 * `NINE_PASS_LEDGER` binding and checkout-time eligibility respectively — it
 * is listed here too because it owns its own `/offers/*` routes). Later work
 * packages append to `imports`.
 *
 * `NotifyModule` sits after `JobsModule` because it takes the `notify` queue from
 * that module's registry, and it is `@Global()` because `AuthModule` — declared
 * earlier and `@Global()` itself — injects `NotifyService` to send its links.
 *
 * `ProjectsModule` precedes `MediaModule` because media resolves a project
 * through `ProjectsService`, and both come after `JobsModule`: completing an
 * upload is a producer for `media.probe`, `media.proxy` and `ai.align`.
 *
 * Order matters only in that `CommonModule` must come first: everything else
 * depends on the global providers it brings. `AuthModule` follows it because it
 * is `@Global()` too — it binds the token `JwtAuthGuard` resolves.
 *
 * B05 adds `EventEmitterModule.forRoot()` (global by default — no other module
 * imports it) so `billing/webhooks.service.ts` can publish the payment/refund
 * events `invoices/listeners/billing-events.listener.ts` subscribes to
 * (`invoices/billing-events.ts` explains why this lives in `billing/` rather
 * than being forked); `TaxModule` (place of supply, Rule 35, FX) and
 * `InvoicesModule` (numbering, PDF, signature, credit notes, e-invoicing hook,
 * FIRC, tax registrations) come after `BillingModule`, which they listen to.
 */
@Module({
  imports: [
    CommonModule,
    EventEmitterModule.forRoot(),
    UsersModule,
    AuthModule,
    WorkspacesModule,
    ConsentsModule,
    PrivacyModule,
    CreditsModule,
    RealtimeModule,
    JobsModule,
    NotifyModule,
    ProjectsModule,
    MediaModule,
    StylesModule,
    InternalModule,
    AdminModule,
    EdgModule,
    TranscriptsModule,
    ScriptsModule,
    FontsModule,
    ExportsModule,
    ReferralsModule,
    HealthModule,
    BillingModule,
    OffersModule,
    TaxModule,
    InvoicesModule,
    // B08: team/agency seat + pooled-credit sync, ownership transfer, client
    // tags (`TeamsModule`), device registration/management (`DevicesModule`),
    // licence keys and the plugin activate/heartbeat surface
    // (`LicensingModule`). `TeamsModule` comes after `BillingModule` because it
    // imports it (`SeatBillingService` calls `SubscriptionService.changePlan`).
    DevicesModule,
    TeamsModule,
    LicensingModule,
    AffiliatesModule,
  ],
})
export class AppModule {}
