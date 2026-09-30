import { Injectable } from "@nestjs/common";

import { ClipPostsService } from "./clip-posts.service.js";
import { WHAT_WORKS_MAX_POSTS } from "./performance.constants.js";
import { loadPostFacts, timeZoneFor } from "./post-facts.js";
import { STEERING_WINDOW_MS } from "./steering-signal.js";
import {
  CLEAR_LIFT,
  MIN_GROUP,
  MIN_POSTS,
  STEERING_MIN_POSTS,
  describeSignal,
  insightsOf,
  steeringSignalOf,
} from "./what-works.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";

import type { WhatWorksView } from "./performance.dto.js";

const DAY_MS = 24 * 60 * 60_000;

/**
 * "What works" for a workspace (2026-10-05): its best clips, what they share,
 * and what its next runs' picks lean toward. Reads only; the maths is
 * `what-works.ts`'s, the steering signal the same one `ai.highlights` gets.
 */
@Injectable()
export class WhatWorksService {
  /** A field so a test can set the clock. */
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: ClipPostsService,
  ) {}

  async whatWorks(workspaceId: string, days: number): Promise<WhatWorksView> {
    await this.posts.assertEnabled(workspaceId);
    const now = this.now();
    const windowMs = days * DAY_MS;
    const longest = Math.max(windowMs, STEERING_WINDOW_MS);
    // One read covers both: the view's window, and the year the steering reads.
    const [all, timeZone] = await Promise.all([
      loadPostFacts(
        this.prisma,
        workspaceId,
        new Date(now.getTime() - longest),
        WHAT_WORKS_MAX_POSTS,
      ),
      timeZoneFor(this.prisma, workspaceId),
    ]);
    const since = now.getTime() - windowMs;
    const inWindow = all.filter((post) => post.at.getTime() >= since);
    const insights = insightsOf(inWindow, timeZone);

    const steeringPosts = all.filter(
      (post) => post.at.getTime() >= now.getTime() - STEERING_WINDOW_MS,
    );
    const signal = steeringSignalOf(steeringPosts, insightsOf(steeringPosts, timeZone));

    return {
      enabled: true,
      days,
      timeZone,
      generatedAt: now.toISOString(),
      ...insights,
      thresholds: {
        minPosts: MIN_POSTS,
        minGroup: MIN_GROUP,
        clearLift: CLEAR_LIFT,
        steeringMinPosts: STEERING_MIN_POSTS,
      },
      steering: signal === null ? null : { basis: signal.basis, lines: describeSignal(signal) },
    };
  }
}
