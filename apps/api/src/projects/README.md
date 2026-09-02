# `projects` — projects and folders (A06)

The unit of work everything else in the product hangs off: a project owns its
media, its transcript, its EDG document, its jobs and its exports, and its
retention date decides when all of that goes.

Design references: `docs/CONTRACTS.md` §0, §6 and §8; `docs/THREAT-MODEL.md` T4,
T5; `03-architecture/07-api-and-contracts.md` §Projects & media;
`06-data-model.md` (projects); `04-pricing-and-monetization.md` §Plans;
`12-redesign-decisions.md` D35, D47.

## Endpoints

| Method   | Path              | Who    | Notes                                                               |
| -------- | ----------------- | ------ | ------------------------------------------------------------------- |
| `GET`    | `/projects`       | viewer | Cursor pagination; filters `q`, `status`, `folder`, `clientTag`.    |
| `POST`   | `/projects`       | editor | Opens the plan's retention window on the new project.               |
| `POST`   | `/projects/batch` | editor | Up to 50, in one transaction. Rows only — orchestration is later.   |
| `GET`    | `/projects/{id}`  | viewer | Another tenant's id is a **404**.                                   |
| `PATCH`  | `/projects/{id}`  | editor | Title, folder, client tag, aspect, language, status.                |
| `DELETE` | `/projects/{id}`  | admin  | Soft delete; the objects go when retention runs.                    |
| `GET`    | `/folders`        | viewer | The whole tree, `position` then name.                               |
| `POST`   | `/folders`        | editor | Nests up to eight deep.                                             |
| `GET`    | `/folders/{id}`   | viewer |                                                                     |
| `PATCH`  | `/folders/{id}`   | editor | Rename, move, reorder. A cycle is `project/folder_cycle` (409).     |
| `DELETE` | `/folders/{id}`   | admin  | Refused while it still holds anything (`project/folder_not_empty`). |

`@Roles("editor")` admits `editor`, `admin` and `owner` — the ladder is
`viewer < editor < admin < owner` and a route names the lowest role that may call
it.

## The guard stack (THREAT-MODEL T4, T5)

Every route wears `JwtAuthGuard`, then `WorkspaceMemberGuard`, then `RolesGuard`.
There is no workspace id in any of these paths and there is deliberately no
`X-Workspace-Id` header (07 §Conventions): the workspace comes from the token's
`ws` claim and from nowhere else.

`WorkspaceMemberGuard` is A05's, and A06 widened its reach without changing
either of its rules. On a `/workspaces/:id` route it still proves the path id IS
the token's workspace; on a route with no `:id` — every route here — there is
nothing to compare, so it performs only its second check: **an active membership
still exists**, and the principal's `role` is replaced with the one in the
database. That is what makes a removal or a demotion bite on the next request
rather than at the end of a fifteen-minute token.

Before A06 the no-`:id` branch returned `true`, which was correct while the only
routes wearing the guard had one, and would have been a silent hole the moment
another controller wore it.

## 404, never 403

Every query is filtered by `workspaceId` — never by id alone — so a project id
belonging to another tenant matches nothing and answers **404**. A 403 would
confirm the id exists, which is the whole of T5. The one deliberate 403 is
`auth/not_a_member`, and that answers a question about the caller rather than
about a resource.

## Soft delete and retention (D47)

`DELETE /projects/{id}` marks `deleted_at` and archives the row. Nothing in the
object stores is touched: `retention_until` already says when the bytes go, and
`MediaService`'s sweep is the one place that deletes them. A delete that removed
objects synchronously would make an accidental click unrecoverable and would put
an S3 round trip inside a request.

The window opens when the project is created, at the plan's `retentionDays`, and
every completed upload pushes it out again — a project somebody is still adding
footage to is not a project to expire.

## Folders

`06-data-model.md` lists `projects.folder_id` but has no table for it, so A03 left
the column without a foreign key and A06 converts it
(`20260902050000_a06_folders_media_upload`). Two rules the database cannot state
and the service therefore must:

- **a folder never leaves its workspace** — every read and write is filtered by
  `workspaceId`, so a parent id from another tenant is a 404;
- **a folder is never its own ancestor** — re-parenting walks up from the proposed
  parent and refuses if it meets the folder being moved. A cycle would make every
  depth-first walk in the product hang, and `ON DELETE CASCADE` on a cyclic tree
  is worse than that.

Nesting is capped at eight, which is also what bounds that walk.

## Plan limits

`plan-limits.ts` reads `maxFileBytes`, `maxDurationMs` and `retentionDays` off
`EntitlementService`, which is A05's Free-plan stub until B02 computes it for
real. That is deliberately fine: the _shape_ is settled, so when B02 starts
returning a paid plan's entitlement nothing here changes. What the file must
never do is guess — a missing or malformed key falls back to the **Free** plan's
value, never to "unlimited", because a lookup failure must not widen a cap.
