import type { GreetingService } from './greeting.service.js';
import { toDto, type GreetingDto } from './greeting.schemas.js';

/** Maps HTTP input to use cases and results to DTOs. No business logic here. */
export class GreetingController {
  constructor(private readonly service: GreetingService) {}

  async create(authorId: string, body: { message: string }): Promise<GreetingDto> {
    return toDto(await this.service.create(authorId, body.message));
  }

  async get(id: string): Promise<GreetingDto> {
    return toDto(await this.service.get(id));
  }
}
