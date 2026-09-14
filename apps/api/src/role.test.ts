import { describe, expect, it } from "vitest";

import { IMPLEMENTED_ROLES, parseRole, UnimplementedRoleError } from "./role.js";

describe("parseRole", () => {
  it("defaults to the api role when no flag is given", () => {
    expect(parseRole([])).toBe("api");
    expect(parseRole(["--inspect", "dist/main.js"])).toBe("api");
  });

  it("accepts every role the image implements", () => {
    for (const role of IMPLEMENTED_ROLES) {
      expect(parseRole([`--role=${role}`])).toBe(role);
    }
  });

  /**
   * The chart shipped `--role=realtime` and `--role=scheduler` against a binary
   * that never read the flag, so both "roles" booted the full API on the wrong
   * port and the realtime Service pointed at nothing. A refused boot is what
   * makes that mismatch impossible to ship again.
   */
  it("refuses a role it does not implement rather than starting the wrong process", () => {
    expect(() => parseRole(["--role=realtime"])).toThrow(UnimplementedRoleError);
    expect(() => parseRole(["--role=scheduler"])).toThrow(UnimplementedRoleError);
    expect(() => parseRole(["--role="])).toThrow(UnimplementedRoleError);
  });

  it("names the offending role and what to do about it", () => {
    expect(() => parseRole(["--role=realtime"])).toThrow(/--role=realtime is not implemented/);
    expect(() => parseRole(["--role=realtime"])).toThrow(/\/realtime path/);
  });

  it("reads the flag wherever it appears in argv", () => {
    expect(() => parseRole(["dist/main.js", "--role=scheduler"])).toThrow(UnimplementedRoleError);
  });
});
