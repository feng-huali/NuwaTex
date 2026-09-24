import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, uploadProjectZip } from "../src/client/api";

describe("client API session handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps speculative unauthorized requests from changing the route", async () => {
    const windowTarget = new EventTarget();
    const dispatch = vi.spyOn(windowTarget, "dispatchEvent");
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "AUTH_REQUIRED" }, { status: 401 })));

    await expect(api("/api/projects/project-1", { suppressSessionExpired: true }))
      .rejects.toBeInstanceOf(ApiError);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("still reports unauthorized requests that require an authenticated route", async () => {
    const windowTarget = new EventTarget();
    const dispatch = vi.spyOn(windowTarget, "dispatchEvent");
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "AUTH_REQUIRED" }, { status: 401 })));

    await expect(api("/api/projects/project-1")).rejects.toBeInstanceOf(ApiError);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toBeInstanceOf(Event);
  });

  it("turns transport failures into a recoverable API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));

    await expect(api("/api/projects/project-1"))
      .rejects.toMatchObject({ name: "Error", status: 0, code: "NETWORK_ERROR" });
  });

  it("turns malformed JSON responses into a recoverable API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", {
      status: 200, headers: { "content-type": "application/json" }
    })));

    await expect(api("/api/projects/project-1"))
      .rejects.toMatchObject({ name: "Error", status: 200, code: "INVALID_RESPONSE" });
  });

  it("reports ZIP upload progress separately from server-side processing", async () => {
    class UploadRequest {
      upload = { onprogress: (_event: ProgressEvent) => undefined, onload: () => undefined };
      onload = () => undefined;
      onerror = () => undefined;
      onabort = () => undefined;
      responseType = "";
      withCredentials = false;
      status = 201;
      response = { project: { id: "project-1" } };
      open = vi.fn();
      setRequestHeader = vi.fn();
      send = vi.fn(() => {
        this.upload.onprogress({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
        this.upload.onprogress({ lengthComputable: true, loaded: 10, total: 10 } as ProgressEvent);
        this.upload.onload();
        this.onload();
      });
    }
    vi.stubGlobal("XMLHttpRequest", UploadRequest);
    const phases: string[] = [];
    const result = await uploadProjectZip<{ project: { id: string } }>(
      "/api/projects/import", new FormData(),
      (percent) => phases.push(`upload:${percent}`),
      () => phases.push("processing")
    );
    expect(phases).toEqual(["upload:50", "processing"]);
    expect(result.project.id).toBe("project-1");
  });
});
