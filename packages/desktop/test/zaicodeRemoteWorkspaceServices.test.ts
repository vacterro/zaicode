import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveZaicodeRemoteWorkspaceServices,
  ZAICODE_REMOTE_UNAVAILABLE_MESSAGE,
} from "../src/host/zaicodeRemoteWorkspaceServices.js";

test("remote workspace uses registered ZAICODE services when available", () => {
  const agentService = {} as never;
  const jobService = {} as never;
  const services = resolveZaicodeRemoteWorkspaceServices({
    zaicodeAgentService: agentService,
    zaicodeJobService: jobService,
  });

  assert.strictEqual(services.zaicodeAgentService, agentService);
  assert.strictEqual(services.zaicodeJobService, jobService);
});

test("remote workspace registers explicit unavailable ZAICODE services when absent", async () => {
  const services = resolveZaicodeRemoteWorkspaceServices({});

  await assert.rejects(
    Reflect.apply(services.zaicodeAgentService.list, services.zaicodeAgentService, []),
    new RegExp(ZAICODE_REMOTE_UNAVAILABLE_MESSAGE),
  );
  await assert.rejects(
    Reflect.apply(services.zaicodeJobService.dispatch, services.zaicodeJobService, []),
    new RegExp(ZAICODE_REMOTE_UNAVAILABLE_MESSAGE),
  );
});
