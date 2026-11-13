import { startTelemetry } from '@cb/telemetry';

startTelemetry({ serviceName: process.env.SERVICE_NAME ?? 'ai-service' });
