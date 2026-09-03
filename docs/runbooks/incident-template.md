# Incident report template

Copy this into a new file (or the incident-tracking tool, once H-27 names one)
for every page that became a real incident — not every alert, only ones that
paged and mattered. For anything touching personal data, use
[breach-first-hour.md](breach-first-hour.md)'s own templates instead; this one
is for availability/performance/cost incidents (the `ops_incidents` table this
work package added is the public-facing summary of the same events —
`apps/api/src/ops/ops-incidents.service.ts`).

---

## Incident: `<short title>`

**Severity:** minor | major | critical (mirrors `OpsIncidentSeverity` —
`apps/api/prisma/schema.prisma`)
**Status:** investigating | monitoring | resolved
**Started:** `<UTC timestamp>` **Detected:** `<UTC timestamp>` **Resolved:** `<UTC timestamp or open>`
**Incident lead:** `<name>`
**Public status page entry:** `<link once posted via POST /admin/ops/incidents>`

### Impact

What broke, for whom, for how long. Numbers, not adjectives: "the render queue
stopped draining for 40 minutes, 230 jobs delayed" rather than "renders were
slow."

### Timeline (UTC)

| Time | Event                         |
| ---- | ----------------------------- |
|      | First alert / first report    |
|      | Incident declared, lead named |
|      | Root cause identified         |
|      | Mitigation applied            |
|      | Confirmed resolved            |

### Root cause

What actually happened, one level deeper than the symptom. "The render queue
stalled" is a symptom; "the GPU provider's API started returning 503 for
requests over 90 seconds after a silent rate-limit change" is a root cause.

### Detection

How was this found — an alert (name it), a user report, a manual check? If it
was a user report and should have been an alert, that gap is itself an action
item below.

### Mitigation

What was done to stop the bleeding, in what order, and by whom.

### Follow-up actions

| Action | Owner | Due |
| ------ | ----- | --- |
|        |       |     |

At minimum: does this need a new alert, a runbook update, or a code fix? An
incident that closes with zero follow-up actions either had none worth taking
(rare) or was not looked at hard enough (common).

### Customer communication

What was said, where (status page, email, in-app), and when. Copy the exact
text used, not a paraphrase — a future incident with the same shape will want
to reuse it.
