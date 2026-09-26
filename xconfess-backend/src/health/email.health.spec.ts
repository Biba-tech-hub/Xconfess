import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HealthCheckError } from '@nestjs/terminus';
import { EmailHealthIndicator } from './email.health';
import * as net from 'net';

jest.mock('net');

const mockSocket = {
  once: jest.fn(),
  connect: jest.fn(),
  destroy: jest.fn(),
};

describe('EmailHealthIndicator', () => {
  let indicator: EmailHealthIndicator;
  let configValues: Record<string, unknown>;

  beforeEach(async () => {
    configValues = {};
    (net.Socket as unknown as jest.Mock).mockImplementation(() => mockSocket);
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailHealthIndicator,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => configValues[key] },
        },
      ],
    }).compile();

    indicator = module.get<EmailHealthIndicator>(EmailHealthIndicator);
  });

  it('returns disabled when MAIL_HOST is not set', async () => {
    configValues['MAIL_HOST'] = undefined;
    const result = await indicator.isHealthy('email');
    expect(result['email'].status).toBe('disabled');
    expect(result['email'].mode).toBe('disabled');
  });

  it('returns disabled when MAIL_HOST is empty string', async () => {
    configValues['MAIL_HOST'] = '';
    const result = await indicator.isHealthy('email');
    expect(result['email'].status).toBe('disabled');
    expect(result['email'].mode).toBe('disabled');
  });

  it('returns up with latencyMs when TCP connection succeeds', async () => {
    configValues['MAIL_HOST'] = 'smtp.example.com';
    configValues['MAIL_PORT'] = 587;

    // Simulate successful connect event
    mockSocket.once.mockImplementation((event: string, cb: () => void) => {
      if (event === 'connect') setTimeout(cb, 0);
      return mockSocket;
    });

    const result = await indicator.isHealthy('email');
    expect(result['email'].status).toBe('up');
    expect(typeof result['email'].latencyMs).toBe('number');
  });

  it('throws HealthCheckError when TCP connection fails', async () => {
    configValues['MAIL_HOST'] = 'smtp.bad.host';
    configValues['MAIL_PORT'] = 587;

    mockSocket.once.mockImplementation((event: string, cb: (err?: Error) => void) => {
      if (event === 'error') setTimeout(() => cb(new Error('ECONNREFUSED')), 0);
      return mockSocket;
    });

    await expect(indicator.isHealthy('email')).rejects.toThrow(HealthCheckError);
  });
});
