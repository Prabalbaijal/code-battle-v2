import { signInternalToken } from '@cb/auth';
import { calibrationResultSchema, type CalibrationRequest, type CalibrationResult } from '@cb/contracts';
import { createHttpClient, type HttpClient } from '@cb/http-client';

/** The part of judge-service that calibration needs. An interface so tests can use a stub. */
export interface JudgeClient {
  startCalibration(req: CalibrationRequest): Promise<CalibrationResult>;
  calibration(id: string): Promise<CalibrationResult>;
}

export class HttpJudgeClient implements JudgeClient {
  private readonly http: HttpClient;

  constructor(private readonly o: { baseUrl: string; secret: string; service: string }) {
    this.http = createHttpClient({
      name: 'judge-service',
      baseUrl: o.baseUrl,
      timeoutMs: 10_000,
      retries: 2,
    });
  }

  private async auth() {
    return { authorization: `Bearer ${await signInternalToken(this.o.secret, this.o.service, 60)}` };
  }

  async startCalibration(req: CalibrationRequest): Promise<CalibrationResult> {
    // idempotent on the judge side (requestKey), so retrying a POST is safe here
    const r = await this.http.request({
      method: 'POST',
      path: '/internal/calibrations',
      body: req,
      headers: await this.auth(),
      schema: calibrationResultSchema,
      retry: true,
    });
    return r.data;
  }

  async calibration(id: string): Promise<CalibrationResult> {
    const r = await this.http.request({
      path: `/internal/calibrations/${id}`,
      headers: await this.auth(),
      schema: calibrationResultSchema,
    });
    return r.data;
  }
}
