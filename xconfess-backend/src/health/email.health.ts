import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as net from 'net';

export interface EmailHealthDetail {
  status: 'up' | 'down' | 'disabled';
  mode?: 'disabled';
  host?: string;
  port?: number;
  latencyMs?: number;
  error?: string;
  hint?: string;
}

/**
 * EmailHealthIndicator
 *
 * Checks SMTP reachability by opening a TCP socket to MAIL_HOST:MAIL_PORT
 * and waiting for the greeting banner (or just a successful connection).
 *
 * This is a *reachability* check, not a full SMTP authentication round-trip,
 * to keep probe latency low and avoid consuming SMTP session resources on
 * every readiness poll.
 *
 * When MAIL_HOST is not configured the indicator reports `disabled` (not
 * `down`) so that environments without email can still pass readiness.
 */
@Injectable()
export class EmailHealthIndicator extends HealthIndicator {
  private readonly logger = new Logger(EmailHealthIndicator.name);
  private static readonly CONNECT_TIMEOUT_MS = 3_000;

  constructor(private readonly configService: ConfigService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const host = this.configService.get<string>('MAIL_HOST');
    const port = this.configService.get<number>('MAIL_PORT') ?? 587;

    if (!host || host.trim() === '') {
      // Email is not configured — report disabled, not down
      return this.getStatus(key, true, {
        mode: 'disabled',
        status: 'disabled',
        reason: 'MAIL_HOST is not set; email health check skipped',
      });
    }

    const detail: EmailHealthDetail = { status: 'down', host, port };

    try {
      const latencyMs = await this.tcpReachable(host, port);
      detail.status = 'up';
      detail.latencyMs = latencyMs;
      return this.getStatus(key, true, detail);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Email health check failed (${host}:${port}): ${message}`);
      detail.error = message;
      detail.hint = this.resolveHint(message, host, port);
      throw new HealthCheckError(
        `SMTP ${host}:${port} is unreachable`,
        this.getStatus(key, false, detail),
      );
    }
  }

  /**
   * Open a TCP socket to `host:port` and resolve with the elapsed milliseconds
   * once the connection is established. Rejects on error or timeout.
   */
  private tcpReachable(host: string, port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const start = Date.now();
      const socket = new net.Socket();

      const onError = (err: Error) => {
        socket.destroy();
        reject(err);
      };

      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new Error(
            `TCP connection to ${host}:${port} timed out after ${EmailHealthIndicator.CONNECT_TIMEOUT_MS}ms`,
          ),
        );
      }, EmailHealthIndicator.CONNECT_TIMEOUT_MS);

      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(Date.now() - start);
      });

      socket.once('error', (err) => {
        clearTimeout(timer);
        onError(err);
      });

      socket.connect(port, host);
    });
  }

  private resolveHint(message: string, host: string, port: number): string {
    const lower = message.toLowerCase();
    if (lower.includes('econnrefused')) {
      return `SMTP server is not accepting connections on ${host}:${port}. Verify MAIL_HOST and MAIL_PORT.`;
    }
    if (lower.includes('timeout') || lower.includes('timed out')) {
      return `TCP connection to ${host}:${port} timed out. Check network firewall rules and that MAIL_PORT is correct.`;
    }
    if (lower.includes('enotfound') || lower.includes('dns')) {
      return `Cannot resolve hostname "${host}". Verify MAIL_HOST in the environment.`;
    }
    return `Check MAIL_HOST (${host}) and MAIL_PORT (${port}) are correct and the SMTP server is running.`;
  }
}
