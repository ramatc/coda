import { Controller, Get } from "@nestjs/common";

export interface HealthResponse {
  status: "ok";
  uptime: number;
}

/**
 * Liveness endpoint. Intentionally has NO live database dependency so CI and
 * container orchestrators can probe the service without a reachable Postgres.
 */
@Controller("health")
export class HealthController {
  @Get()
  check(): HealthResponse {
    return { status: "ok", uptime: process.uptime() };
  }
}
