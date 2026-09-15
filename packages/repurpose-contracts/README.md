# Aksharo repurposing contracts

`@montaj/repurpose-contracts` is a schema-only, off-by-default starting point
for REP-001. It does not register an API route, queue, database model, worker,
or provider connection. `REPURPOSE_SCHEMA_VERSION` and
`REPURPOSE_CONFIG_VERSION` are both `1`; payloads reject unknown versions and
unknown object fields.

The JSON examples in `fixtures/` cover URL and upload run creation, frozen run
setup, AI and manual candidate shapes, and a materialized clip. Unit tests also
exercise variant editor links, stage progress, safe errors, range limits, and
privacy-conscious aggregate candidate signals.

Before runtime integration, owners must review these provisional shapes for
API/web/AI/media parity. In particular, `ExistingUploadTicketSchema` mirrors
the current API `UploadTicket` and needs a direct parity test when the create-run
endpoint reuses the existing multipart upload flow. A rights-attestation
boolean in a payload is not proof of rights; acquisition and publishing still
require the Wave 0 provider, license, test-account, and audit gates.
