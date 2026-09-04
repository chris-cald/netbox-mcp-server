import axios from "axios";
import { describe, expect, it } from "vitest";

import { NetBoxClient } from "../../src/client.js";
import type { NetBoxConfig } from "../../src/config.js";

const config: NetBoxConfig = {
  baseUrl: "https://netbox.example.com",
  apiUrl: "https://netbox.example.com/api",
  credentials: { getToken: () => Promise.resolve("test-token") },
  insecure: false,
};

describe("NetBoxClient semantic detail action transport", () => {
  it("sends the native GET path and schema-confirmed query parameters", async () => {
    const requests: Array<{
      url: string | undefined;
      params: unknown;
      data: unknown;
    }> = [];
    const http = axios.create({
      adapter: (request) => {
        requests.push({ url: request.url, params: request.params, data: request.data });
        return Promise.resolve({
          data: [],
          status: 200,
          statusText: "OK",
          headers: {},
          config: request,
        });
      },
    });

    await new NetBoxClient(config, { http }).detailAction(
      "ipam/prefixes",
      42,
      "available-ips",
      "get",
      undefined,
      { brief: true, fields: "id,address" },
    );

    expect(requests).toEqual([
      {
        url: "/ipam/prefixes/42/available-ips/",
        params: { brief: true, fields: "id,address" },
        data: undefined,
      },
    ]);
  });

  it("sends the native POST path and array request body unchanged", async () => {
    const requests: Array<{
      url: string | undefined;
      params: unknown;
      data: unknown;
    }> = [];
    const http = axios.create({
      adapter: (request) => {
        requests.push({ url: request.url, params: request.params, data: request.data });
        return Promise.resolve({
          data: [],
          status: 201,
          statusText: "Created",
          headers: {},
          config: request,
        });
      },
    });
    const body = [{ prefix_length: 31, description: "allocated by MCP" }];

    await new NetBoxClient(config, { http }).detailAction(
      "ipam/prefixes",
      42,
      "available-ips",
      "post",
      body,
    );

    expect(requests).toEqual([
      {
        url: "/ipam/prefixes/42/available-ips/",
        params: undefined,
        data: JSON.stringify(body),
      },
    ]);
  });
});
