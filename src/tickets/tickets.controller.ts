import { Controller, Get } from '@nestjs/common';
import { TicketsService } from './tickets.service.js';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  list() {
    return this.tickets.list();
  }
}
