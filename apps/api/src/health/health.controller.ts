import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { Public } from "../auth/public.decorator.js";

export interface HealthResponse {
  status: "ok";
  uptime: number;
}

export interface ReadinessResponse {
  status: "ok";
  database: "up";
}

// Health/readiness probes MUST stay reachable by orchestrators and load
// balancers without a Clerk JWT, so the whole controller opts out of the global
// guard.
@Public()
@Controller("health")
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness endpoint. Intentionally has NO live database dependency so CI and
   * container orchestrators can probe the service without a reachable Postgres.
   */
  @Get()
  check(): HealthResponse {
    return { status: "ok", uptime: process.uptime() };
  }

  /**
   * Readiness endpoint. Unlike liveness, this DOES touch the database — it is
   * the first real use of the injected {@link PrismaService}. Returns 503 when
   * the database is unreachable so orchestrators can gate traffic.
   */
  @Get("ready")
  async ready(): Promise<ReadinessResponse> {
    try {
      await this.prisma.client.$queryRaw`SELECT 1`;
      return { status: "ok", database: "up" };
    } catch (err) {
      this.logger.error("Readiness check failed", err);
      throw new ServiceUnavailableException({
        status: "error",
        database: "down",
      });
    }
  }
}
